import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
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
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
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
});
