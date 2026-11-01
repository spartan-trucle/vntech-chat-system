import { afterEach, describe, expect, test } from 'vitest';
import type { Socket } from 'node:net';
import { createChatServer, type ChatServer, type ServerEvents } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { bucketOf } from '../../src/ids.js';
import { streamIdOf } from '../../src/ports/index.js';
import type { DeliverFrame, ErrorFrame, MsgAckFrame, MsgFrame } from '../../src/protocol.js';
import type { MessagingOptions } from '../../src/messaging/index.js';

const msg = (over: Partial<MsgFrame> & Pick<MsgFrame, 'client_msg_id'>): MsgFrame => ({
  t: 'msg', conversation_id: 'c1', body: 'hi', ...over,
});

describe('B2 send path: store, ids, dedup, write order, fan-out (design §2.2, §1.4, §4.2)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (messaging: Partial<MessagingOptions> = {}): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, moduleOptions: { messaging } });
    return server;
  };
  /** Connects and says hello; the client shares the server's trace so the log interleaves like the page. */
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('a msg from a member is stored as one row, acked to the sender, delivered to the other member with a stream id', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const before = srv.ctx.clock.now();

    phone.send(msg({ client_msg_id: 'cid-1', body: 'hello khanh', reply_to: '42', media_key: 'vn/2026/11/k1' }));

    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    expect(ack.client_msg_id).toBe('cid-1');
    const id = ack.message_id;
    const rows = await srv.ctx.ports.messages.readPartition('c1', bucketOf(id), { limit: 10 });
    expect(rows).toEqual([{
      conversation_id: 'c1',
      bucket: bucketOf(id),
      message_id: id,
      sender_id: 'truc',
      client_msg_id: 'cid-1',
      body: 'hello khanh',
      reply_to: '42',
      media_key: 'vn/2026/11/k1',
      media_size: null,
      media_mime: null,
      created_at: expect.any(Number),
    }]);
    expect(rows[0]!.created_at).toBeGreaterThanOrEqual(before);

    const deliver = (await khanh.expect('deliver')) as DeliverFrame;
    expect(deliver.message).toEqual(rows[0]);
    expect(deliver.stream_id).toBe(streamIdOf(id));
    expect(delivers(phone)).toHaveLength(0);
  });

  test('reply_to and media_key are null when the frame carries none', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    phone.send(msg({ client_msg_id: 'cid-2' }));
    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    const row = await srv.ctx.ports.messages.get('c1', ack.message_id);
    expect(row).toMatchObject({ reply_to: null, media_key: null, media_size: null, media_mime: null });
  });

  test('a msg to a conversation the sender is not a member of is refused and nothing is stored', async () => {
    const srv = await start();
    const linh = await connect(DEVICES.linhBot);
    const khanh = await connect(DEVICES.khanhPhone);
    linh.send(msg({ client_msg_id: 'cid-3', conversation_id: 'c1' }));
    const err = (await linh.expect('error')) as ErrorFrame;
    expect(err.code).toBe('not_member');
    expect(await srv.ctx.ports.messages.findByClientMsgId('linh', 'cid-3')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(delivers(khanh)).toHaveLength(0);
  });

  test('S3: the same client_msg_id sent twice stores one row, answers both with the same id, delivers once', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    let stored = 0;
    srv.ctx.events.on('message_stored', () => { stored += 1; });

    phone.send(msg({ client_msg_id: 'cid-dup', body: 'once' }));
    const first = (await phone.expect('msg_ack')) as MsgAckFrame;
    phone.send(msg({ client_msg_id: 'cid-dup', body: 'once' }));
    const second = (await phone.expect('msg_ack')) as MsgAckFrame;

    expect(second.message_id).toBe(first.message_id);
    expect(await srv.ctx.ports.messages.readPartition('c1', bucketOf(first.message_id), { limit: 10 })).toHaveLength(1);
    expect(stored).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(delivers(khanh)).toHaveLength(1);
    const dedup = srv.ctx.trace.rows().filter((r) => r.tag === 'dedup').map((r) => r.text);
    expect(dedup).toEqual([`(truc, cid-dup) already stored as #${first.message_id} → same ack, no second row`]);
  });

  test('write order, instrumented: store, then the ack on the wire, then the push on the wire; each event after its step', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const seq: string[] = [];
    const store = srv.ctx.ports.messages;
    const insert = store.insert.bind(store);
    store.insert = async (m) => { seq.push('store'); await insert(m); };
    /** Taps the server-side socket of a device so every byte written to it is logged under `label`. */
    const tapWire = (device_id: string, label: string): void => {
      const socket = srv.ctx.connections.byDevice(device_id)!.socket as unknown as { send: (...args: unknown[]) => void };
      const send = socket.send.bind(socket);
      socket.send = (...args: unknown[]) => { seq.push(label); send(...args); };
    };
    tapWire('A1', 'ack');
    tapWire('B1', 'push');
    for (const name of ['message_stored', 'message_acked', 'message_fanout'] as const) {
      srv.ctx.events.on(name, () => { seq.push(`event:${name}`); });
    }

    phone.send(msg({ client_msg_id: 'cid-order' }));
    await khanh.expect('deliver');
    expect(seq).toEqual(['store', 'event:message_stored', 'ack', 'event:message_acked', 'push', 'event:message_fanout']);
  });

  test('fan-out on write: 3 members × 2 devices, all live → 5 deliver frames, the sender\'s other device included', async () => {
    const srv = await start();
    await srv.ctx.ports.conversations.create({ conversation_id: 'g3', type: 'group', name: 'three', members: ['truc', 'khanh', 'linh'], created_bucket: 202601 });
    const devices: FixtureDevice[] = [
      DEVICES.trucPhone, DEVICES.trucLaptop,
      DEVICES.khanhPhone, { device_id: 'B2', user_id: 'khanh', kind: 'laptop', name: 'Khanh·laptop' },
      DEVICES.linhBot, { device_id: 'C2', user_id: 'linh', kind: 'phone', name: 'Linh·phone' },
    ];
    const conns: ScriptedClient[] = [];
    for (const d of devices) conns.push(await connect(d));
    const [sender, ...others] = conns as [ScriptedClient, ...ScriptedClient[]];
    const fanout: ServerEvents['message_fanout'][] = [];
    srv.ctx.events.on('message_fanout', (p) => { fanout.push(p); });

    sender.send(msg({ client_msg_id: 'cid-g3', conversation_id: 'g3', body: 'to all' }));
    const id = ((await sender.expect('msg_ack')) as MsgAckFrame).message_id;
    for (const c of others) await c.expect('deliver');

    expect(others.flatMap(delivers).map((d) => d.message.message_id)).toEqual([id, id, id, id, id]);
    expect(delivers(sender)).toHaveLength(0);
    expect(fanout).toHaveLength(1);
    expect(fanout[0]).toMatchObject({ recipient_devices: ['A2', 'B1', 'B2', 'C1', 'C2'], pushed: ['A2', 'B1', 'B2', 'C1', 'C2'] });
    const push = srv.ctx.trace.rows().filter((r) => r.tag === 'push').map((r) => r.text);
    expect(push).toEqual([`#${id} → Truc·laptop, Khanh·phone, Khanh·device, Linh·bot, Linh·device over the socket`]);
  });

  test('a recipient device without a socket gets nothing here: it is listed for the queue (B3), not pushed', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const fanout: ServerEvents['message_fanout'][] = [];
    const acked: ServerEvents['message_acked'][] = [];
    srv.ctx.events.on('message_acked', (p) => { acked.push(p); });
    srv.ctx.events.on('message_fanout', (p) => { fanout.push(p); });

    phone.send(msg({ client_msg_id: 'cid-c2', conversation_id: 'c2', body: 'group' }));
    await khanh.expect('deliver');

    expect(acked[0]).toMatchObject({ sender: srv.ctx.connections.byDevice('A1'), recipient_devices: ['A2', 'B1', 'C1', 'D1', 'E1'] });
    expect(fanout[0]).toMatchObject({ recipient_devices: ['A2', 'B1', 'C1', 'D1', 'E1'], pushed: ['B1'] });
  });

  test('a connection still in the replay phase gets no direct push; the queue carries the message', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    srv.ctx.events.on('device_connected', async ({ conn }) => { if (conn.device_id === 'B1') await held; });
    const khanh = new ScriptedClient(DEVICES.khanhPhone, { url: srv.url, trace: srv.ctx.trace });
    clients.push(khanh);
    await khanh.connect();
    await khanh.hello();
    expect(srv.ctx.connections.byDevice('B1')?.phase).toBe('replay');
    const fanout: ServerEvents['message_fanout'][] = [];
    srv.ctx.events.on('message_fanout', (p) => { fanout.push(p); });

    phone.send(msg({ client_msg_id: 'cid-replay' }));
    await phone.expect('msg_ack');
    await new Promise((r) => setTimeout(r, 30));
    expect(fanout[0]).toMatchObject({ recipient_devices: ['A2', 'B1'], pushed: [] });
    expect(delivers(khanh)).toHaveLength(0);
    release();
  });

  test('backpressure: a destination that does not take pushes within budget loses them to the queue; sender and other recipients unaffected', async () => {
    const srv = await start({ maxPending: 1, pushTimeoutMs: 200 });
    const phone = await connect(DEVICES.trucPhone);
    const laptop = await connect(DEVICES.trucLaptop);
    const khanh = await connect(DEVICES.khanhPhone);
    // The laptop goes dark: radio off, nothing read. On loopback the kernel buffers would still
    // absorb hundreds of KB before the server's writes stop flushing, so its server-side TCP
    // socket is corked as well: from here on no push to the laptop is ever taken.
    laptop.blackhole();
    (srv.ctx.connections.byDevice('A2')!.socket as unknown as { _socket: Socket })._socket.cork();
    const fanout: Array<{ message_id: string; pushed: string[] }> = [];
    srv.ctx.events.on('message_fanout', ({ message, pushed }) => { fanout.push({ message_id: message.message_id, pushed }); });

    phone.send(msg({ client_msg_id: 'cid-bp1', body: 'first' }));
    const first = (await phone.expect('msg_ack')) as MsgAckFrame;
    // Khanh's socket took the first push (ws reports a flush on the next tick, so two sends in
    // one tick would count as two pending even on a healthy socket); the laptop never does.
    await khanh.expect('deliver');
    await new Promise((r) => setTimeout(r, 20));
    phone.send(msg({ client_msg_id: 'cid-bp2', body: 'second' }));
    const second = (await phone.expect('msg_ack')) as MsgAckFrame;
    await khanh.expect('deliver');

    expect(fanout).toEqual([
      { message_id: first.message_id, pushed: ['A2', 'B1'] },
      { message_id: second.message_id, pushed: ['B1'] },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    const lost = srv.ctx.trace.rows().filter((r) => r.tag === 'lost' && r.text.startsWith('#')).map((r) => r.text);
    expect(lost).toEqual([
      `#${second.message_id} → Truc·laptop: buffer full (1 pending), left to the queue`,
      `#${first.message_id} → Truc·laptop: not taken within 200 ms, left to the queue`,
    ]);
    expect(delivers(khanh).map((d) => d.message.body)).toEqual(['first', 'second']);
  });

  test('the trace reads like docs/prototype/index.html: store, ack and push rows', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    phone.send(msg({ client_msg_id: 'cid-trace-1', reply_to: '7', media_key: 'vn/2026/11/pic' }));
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await khanh.expect('deliver');
    const rows = srv.ctx.trace.rows().filter((r) => ['store', 'ack', 'push'].includes(r.tag)).map((r) => `${r.tag} ${r.text}`);
    expect(rows).toEqual([
      `store INSERT messages(c1, dm) #${id} from truc reply_to=#7 media_key=vn/2026/11/pic`,
      `ack → Truc·phone {cid:cid-trac, id:#${id}}`,
      `push #${id} → Khanh·phone over the socket`,
    ]);
  });
});
