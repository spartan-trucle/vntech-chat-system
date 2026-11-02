import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { ErrorFrame, MsgAckFrame, MsgFrame, ServerReceiptFrame } from '../../src/protocol.js';
import { InMemoryPushGateway } from '../../src/receipts/PushGateway.js';
import type { ReceiptsOptions } from '../../src/receipts/index.js';

const msg = (over: Partial<MsgFrame> & Pick<MsgFrame, 'client_msg_id'>): MsgFrame => ({
  t: 'msg', conversation_id: 'c1', body: 'hi', ...over,
});

describe('B5 receipts: read cursors, multi-device read state, open set (design §3.4, §3.5)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let gateway: InMemoryPushGateway;

  const start = async (receipts: Partial<ReceiptsOptions> = {}): Promise<ChatServer> => {
    gateway = new InMemoryPushGateway();
    server = await createChatServer({ port: 0, seed: true, moduleOptions: { receipts: { pushGateway: gateway, ...receipts } } });
    return server;
  };
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  /** `from` sends one message to `conversation_id`; returns its id once every listed reader has the deliver. */
  const post = async (from: ScriptedClient, conversation_id: string, client_msg_id: string, readers: ScriptedClient[], body = 'hi'): Promise<string> => {
    from.send(msg({ client_msg_id, conversation_id, body }));
    const id = ((await from.expect('msg_ack')) as MsgAckFrame).message_id;
    for (const r of readers) await r.expect((f) => f.t === 'deliver' && f.message.message_id === id);
    return id;
  };
  const receipts = (c: ScriptedClient): ServerReceiptFrame[] => c.received.filter((f): f is ServerReceiptFrame => f.t === 'receipt');
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  const traceRows = (tags: string[]): string[] => server!.ctx.trace.rows().filter((r) => tags.includes(r.tag)).map((r) => `${r.tag} ${r.text}`);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('a receipt writes the reader\'s cursor for the conversation; a non-member is refused and nothing is written', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const id = await post(khanh, 'c1', 'k1', [phone]);

    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: id });
    await settle();
    expect(await srv.ctx.ports.cursors.readCursor('c1', 'truc')).toBe(id);

    khanh.send({ t: 'receipt', conversation_id: 'c3', last_read_id: id });
    const err = (await khanh.expect('error')) as ErrorFrame;
    expect(err.code).toBe('not_member');
    expect(await srv.ctx.ports.cursors.readCursor('c3', 'khanh')).toBeUndefined();
  });

  test('read on the phone → the laptop gets the cursor (its badge clears); the reading device itself gets nothing back', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const laptop = await connect(DEVICES.trucLaptop);
    const khanh = await connect(DEVICES.khanhPhone);
    const id = await post(khanh, 'c1', 'k1', [phone, laptop]);

    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: id });
    const frame = (await laptop.expect('receipt')) as ServerReceiptFrame;
    expect(frame).toEqual({ t: 'receipt', conversation_id: 'c1', user_id: 'truc', last_read_id: id });
    await settle();
    expect(receipts(phone)).toHaveLength(0);
    expect(receipts(khanh)).toHaveLength(0); // Khanh never said he has c1 open
    expect(traceRows(['receipt', 'push'])).toContain(`receipt read_cursors[c1][truc] = max(prev,#${id})`);
    expect(traceRows(['push'])).toContain('push read_cursor → Truc·laptop (clears their badge)');
    void srv;
  });

  test('a late or duplicate receipt is a no-op: cursor unchanged, no frame to anyone, one trace row', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const laptop = await connect(DEVICES.trucLaptop);
    const khanh = await connect(DEVICES.khanhPhone);
    const first = await post(khanh, 'c1', 'k1', [phone, laptop]);
    const second = await post(khanh, 'c1', 'k2', [phone, laptop]);

    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: second });
    await laptop.expect('receipt');
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: second }); // duplicate
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: first });  // late
    await settle();

    expect(await srv.ctx.ports.cursors.readCursor('c1', 'truc')).toBe(second);
    expect(receipts(laptop)).toHaveLength(1);
    expect(receipts(khanh)).toHaveLength(0);
    expect(traceRows(['receipt']).filter((r) => r.includes('no-op'))).toEqual([
      `receipt read_cursors[c1][truc] no-op: #${second} ≤ #${second} (late or duplicate)`,
      `receipt read_cursors[c1][truc] no-op: #${first} ≤ #${second} (late or duplicate)`,
    ]);
  });

  test('members with the chat open get the cursor: Khanh opens c1 by sending a receipt for it, then sees Truc\'s cursor', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const t1 = await post(phone, 'c1', 't1', [khanh]);
    const k1 = await post(khanh, 'c1', 'k1', [phone]);

    khanh.send({ t: 'receipt', conversation_id: 'c1', last_read_id: t1 }); // Khanh has c1 open
    await settle();
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k1 });
    const frame = (await khanh.expect('receipt')) as ServerReceiptFrame;
    expect(frame).toEqual({ t: 'receipt', conversation_id: 'c1', user_id: 'truc', last_read_id: k1 });
    expect(traceRows(['receipt'])).toContain('receipt cursors c1 → Khanh·phone (devices with the chat open)');
    void srv;
  });

  test('a receipt for another conversation closes the first; a disconnect closes it too', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const linh = await connect(DEVICES.linhBot);
    const c1 = await post(phone, 'c1', 't1', [khanh]);
    const c2 = await post(phone, 'c2', 't2', [khanh, linh]);
    const k1 = await post(khanh, 'c1', 'k1', [phone]);
    const k2 = await post(khanh, 'c1', 'k2', [phone]);
    const k3 = await post(khanh, 'c1', 'k3', [phone]);

    linh.send({ t: 'receipt', conversation_id: 'c2', last_read_id: c2 }); // Linh has c2 open
    await settle();
    khanh.send({ t: 'receipt', conversation_id: 'c1', last_read_id: c1 });
    khanh.send({ t: 'receipt', conversation_id: 'c2', last_read_id: c2 }); // c1 no longer open on Khanh·phone
    await settle();
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k1 });
    await settle();
    expect(receipts(khanh)).toHaveLength(0);
    expect(receipts(linh).map((f) => f.user_id)).toEqual(['khanh']); // Linh has c2 open and saw Khanh's c2 cursor

    khanh.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k1 }); // c1 open again (own cursor: no-op push-wise)
    await settle();
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k2 });
    await khanh.expect('receipt');

    khanh.closeCleanly();
    await settle();
    expect(srv.ctx.connections.byDevice('B1')).toBeUndefined();
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k3 });
    await settle();
    expect(receipts(khanh)).toHaveLength(1);
  });

  test('each connection gets at most one frame per receipt: the reader\'s laptop with the chat open is not told twice', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const laptop = await connect(DEVICES.trucLaptop);
    const khanh = await connect(DEVICES.khanhPhone);
    const k1 = await post(khanh, 'c1', 'k1', [phone, laptop]);
    const k2 = await post(khanh, 'c1', 'k2', [phone, laptop]);

    laptop.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k1 }); // laptop has c1 open
    await phone.expect('receipt');
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: k2 });
    await laptop.expect((f) => f.t === 'receipt' && f.last_read_id === k2);
    await settle();
    expect(receipts(laptop).map((f) => f.last_read_id)).toEqual([k2]);
    void srv;
  });

  test('the trace reads like docs/prototype/index.html: the sender\'s cursors on store, delivered by each device, cursor write, badge clear, cursors to the open chat', async () => {
    const srv = await start();
    // Truc's devices send `delivered` by hand here so the two rows come in a fixed order (two sockets race otherwise).
    const phone = await connect(DEVICES.trucPhone, { autoDelivered: false });
    const laptop = await connect(DEVICES.trucLaptop, { autoDelivered: false });
    const khanh = await connect(DEVICES.khanhPhone);
    const t0 = await post(phone, 'c1', 't0', [khanh, laptop]);
    khanh.send({ t: 'receipt', conversation_id: 'c1', last_read_id: t0 }); // Khanh has c1 open
    await settle();
    srv.ctx.trace.clear();

    const id = await post(khanh, 'c1', 'k1', [phone, laptop]);
    await settle();
    phone.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: id });
    await settle();
    laptop.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: id });
    await settle();
    phone.send({ t: 'receipt', conversation_id: 'c1', last_read_id: id });
    await laptop.expect('receipt');
    await khanh.expect('receipt');

    // The harness logs its own client-side rows under the frame type (`Truc·phone → …`, `← Truc·laptop: …`); keep the server's.
    const serverRows = traceRows(['receipt', 'push', 'apns']).filter((r) => !/^\w+ (←|\S+·\S+ →)/.test(r));
    expect(serverRows).toEqual([
      `push #${id} → Truc·phone, Truc·laptop over the socket`,
      `receipt delivery_cursors[c1] ← #${id} for Khanh·phone (sender)`,
      `receipt delivered c1 ≤ #${id} by Truc·phone`,
      `receipt delivered c1 ≤ #${id} by Truc·laptop`,
      `receipt read_cursors[c1][truc] = max(prev,#${id})`,
      'push read_cursor → Truc·laptop (clears their badge)',
      'receipt cursors c1 → Khanh·phone (devices with the chat open)',
    ]);
  });
});

describe('B5 fan-out hooks: delivery cursors and push hints without the body (design §3.3, §3.6)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let gateway: InMemoryPushGateway;

  const start = async (receipts: Partial<ReceiptsOptions> = {}): Promise<ChatServer> => {
    gateway = new InMemoryPushGateway();
    server = await createChatServer({ port: 0, seed: true, moduleOptions: { receipts: { pushGateway: gateway, ...receipts } } });
    return server;
  };
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  const traceRows = (tag: string): string[] => server!.ctx.trace.rows().filter((r) => r.tag === tag).map((r) => r.text);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('a deliver handed to a live socket does not advance that device\'s delivery cursor (B11: the push-to-socket rule is withdrawn); the sender\'s own cursors advance on store; the device\'s cursor moves when it says delivered; an offline device\'s does not', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone, { autoDelivered: false });
    phone.send(msg({ client_msg_id: 'd1', body: 'hello' }));
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await khanh.expect('deliver');
    await settle();

    expect(await srv.ctx.ports.cursors.deliveryCursors('c1')).toEqual(new Map([['A1', id]]));
    expect(await srv.ctx.ports.cursors.readCursors('c1')).toEqual(new Map([['truc', id]]));
    expect(traceRows('receipt')).toEqual([`delivery_cursors[c1] ← #${id} for Truc·phone (sender)`]);

    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: id }); // the device stored it: now it is delivered
    await settle();
    expect(await srv.ctx.ports.cursors.deliveryCursors('c1')).toEqual(new Map([['A1', id], ['B1', id]]));
    expect(traceRows('receipt')).toEqual([`delivery_cursors[c1] ← #${id} for Truc·phone (sender)`, `delivered c1 ≤ #${id} by Khanh·phone`]);
  });

  test('a registered device without a socket gets a push hint: conversation, message id, sender display name; never the body', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const body = 'the secret body text that must not leave our boundary';
    phone.send(msg({ client_msg_id: 'p1', body }));
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await khanh.expect('deliver');
    await settle();

    expect(gateway.recorded()).toEqual([
      { device_id: 'A2', hint: { conversation_id: 'c1', message_id: id, sender_display_name: 'Truc' } },
    ]);
    const recorded = gateway.recorded()[0]!;
    expect('body' in recorded.hint).toBe(false);
    expect(JSON.stringify(recorded)).not.toContain(body);
    expect(JSON.stringify(recorded)).not.toContain('secret');
    expect(traceRows('apns')).toEqual([`#${id} → Truc·laptop: no route → push hint {conv, id, from}, no body`]);
    void srv;
  });

  test('group: every recipient device without a socket gets one hint, in recipient order; live ones get none', async () => {
    await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    khanh.send(msg({ client_msg_id: 'g1', conversation_id: 'c2', body: 'group' }));
    const id = ((await khanh.expect('msg_ack')) as MsgAckFrame).message_id;
    await phone.expect('deliver');
    await settle();

    expect(gateway.recorded().map((r) => r.device_id)).toEqual(['A2', 'C1', 'D1', 'E1']);
    for (const r of gateway.recorded()) expect(r.hint).toEqual({ conversation_id: 'c2', message_id: id, sender_display_name: 'Khanh' });
  });

  test('a device with a route but no push (its live lane suspended by a re-replay) gets no hint: the queue carries the message', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    srv.ctx.connections.byDevice('B1')!.pushes.suspendLive();

    phone.send(msg({ client_msg_id: 'r1' }));
    await phone.expect('msg_ack');
    await settle();
    expect(gateway.recorded().map((r) => r.device_id)).toEqual(['A2']);
    expect(khanh.received.filter((f) => f.t === 'deliver')).toHaveLength(0);
  });

  test('the mute hook runs per conversation per user before the push: a muted device gets no hint', async () => {
    await start({ isMuted: (conversation_id, user_id) => conversation_id === 'c1' && user_id === 'truc' });
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    phone.send(msg({ client_msg_id: 'm1' }));
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await khanh.expect('deliver');
    await settle();
    expect(gateway.recorded()).toEqual([]);
    expect(traceRows('apns')).toEqual([`#${id} → Truc·laptop: muted, no push`]);

    phone.send(msg({ client_msg_id: 'm2', conversation_id: 'c3' })); // c3 is not muted: the laptop and Linh's bot get hints
    await phone.expect('msg_ack');
    await settle();
    expect(gateway.recorded().map((r) => r.device_id)).toEqual(['A2', 'C1']);
  });

  test('a sender outside the fixture directory is named by id in the hint', async () => {
    const srv = await start();
    await srv.ctx.ports.conversations.create({ conversation_id: 'cz', type: 'dm', members: ['zed', 'truc'], created_bucket: 202601 });
    const zed = await connect({ device_id: 'Z1', user_id: 'zed', kind: 'phone', name: 'Zed·phone' });
    zed.send(msg({ client_msg_id: 'z1', conversation_id: 'cz' }));
    const id = ((await zed.expect('msg_ack')) as MsgAckFrame).message_id;
    await settle();
    expect(gateway.recorded()).toEqual([
      { device_id: 'A1', hint: { conversation_id: 'cz', message_id: id, sender_display_name: 'zed' } },
      { device_id: 'A2', hint: { conversation_id: 'cz', message_id: id, sender_display_name: 'zed' } },
    ]);
  });
});
