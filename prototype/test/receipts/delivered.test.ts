import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { ErrorFrame, Message, MsgAckFrame } from '../../src/protocol.js';
import { FakeTime, until } from '../harness/FakeTime.js';
import { bucketOf } from '../../src/ids.js';

/**
 * B11 · the delivered receipt (ADR 2026-11-02 `delivered-receipt-device-stored`; design §3.3,
 * §3.4). *Delivered* means the device stored the message: the client says so with
 * `delivered{conversation_id, up_to_message_id}` in replay mode and live mode alike, the
 * server runs `max()` on `delivery_cursors` and keeps no per-connection state. The old rule
 * (advance the cursor when the push is handed to the socket) is gone: see receipts.test.ts.
 */

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('B11 server: delivered{conversation_id, up_to_message_id} → max() on delivery_cursors, no per-connection state', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  /** The automatic frame is off: these tests drive the cursor by hand. */
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, autoDelivered: false, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const post = async (from: ScriptedClient, conversation_id: string, client_msg_id: string): Promise<string> => {
    from.send({ t: 'msg', client_msg_id, conversation_id, body: 'hi' });
    return ((await from.expect('msg_ack')) as MsgAckFrame).message_id;
  };
  const serverRows = (): string[] =>
    server!.ctx.trace.rows().filter((r) => r.tag === 'receipt' && r.text.startsWith('delivered ')).map((r) => r.text);
  const cursorOf = async (conversation_id: string, device_id: string): Promise<string | undefined> =>
    (await server!.ctx.ports.cursors.deliveryCursors(conversation_id)).get(device_id);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  test('a non-member is refused with error{not_member} and nothing is written', async () => {
    await start();
    const khanh = await connect(DEVICES.khanhPhone);
    khanh.send({ t: 'delivered', conversation_id: 'c3', up_to_message_id: '41' });
    const err = (await khanh.expect('error')) as ErrorFrame;
    expect(err.code).toBe('not_member');
    expect(await cursorOf('c3', 'B1')).toBeUndefined();
    expect(serverRows()).toEqual([]);
  });

  test('the frame advances the device\'s cursor with the page\'s trace row; a late or duplicate frame is a no-op: cursor unchanged, one trace row, nothing else', async () => {
    await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const first = await post(phone, 'c1', 't1');
    const second = await post(phone, 'c1', 't2');
    await khanh.expect((f) => f.t === 'deliver' && f.message.message_id === second);
    await settle();
    expect(await cursorOf('c1', 'B1')).toBeUndefined(); // the push alone moved nothing

    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: second });
    await settle();
    expect(await cursorOf('c1', 'B1')).toBe(second);

    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: second }); // duplicate
    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: first });  // late
    await settle();
    expect(await cursorOf('c1', 'B1')).toBe(second);
    expect(khanh.received.filter((f) => f.t === 'error')).toHaveLength(0);
    expect(serverRows()).toEqual([
      `delivered c1 ≤ #${second} by Khanh·phone`,
      `delivered c1 ≤ #${second} by Khanh·phone: no-op, cursor at #${second} (late or duplicate)`,
      `delivered c1 ≤ #${first} by Khanh·phone: no-op, cursor at #${second} (late or duplicate)`,
    ]);
  });

  test('no per-connection state: a delivered on a fresh connection that replayed nothing and was pushed nothing still moves the cursor', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const id = await post(phone, 'c1', 't1'); // Khanh is offline: a push hint, no deliver anywhere
    await settle();

    const khanh = await connect(DEVICES.khanhPhone); // no cursor → slow path: nothing replayed on this connection
    expect(khanh.received.some((f) => f.t === 'hello_ack' && f.slow_path === true)).toBe(true);
    expect(khanh.received.filter((f) => f.t === 'deliver')).toHaveLength(0);
    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: id });
    await settle();
    expect(await cursorOf('c1', 'B1')).toBe(id);
    const res = await fetch(`${srv.httpUrl}/conversations/c1/messages/${id}/status?user_id=truc`);
    expect(await res.json()).toEqual({ status: 'delivered', read_by: [], delivered_to: ['B1'] });
  });
});

describe('B11 client (ScriptedClient): delivered after the store write, coalesced per conversation per window, in both modes', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let time: FakeTime;

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  /** Truc·phone on fake client timers (the window closes only when the test says so), hello with a cursor so replay_done comes at once. */
  const connect = async (opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    time = new FakeTime(0);
    const c = new ScriptedClient(DEVICES.trucPhone, { url: server!.url, trace: server!.ctx.trace, timers: time, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    c.cursor = '0-0';
    await c.connect();
    await c.hello();
    await until(() => !c.inReplay, 1000, 'replay_done after hello');
    return c;
  };
  const message = (conversation_id: string, message_id: string): Message => ({
    conversation_id, bucket: bucketOf(message_id), message_id, sender_id: 'khanh', client_msg_id: `cid-${message_id}`,
    body: `m${message_id}`, reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 0,
  });
  /** Writes a `deliver` straight to the device's socket, as the replay loop or a live push would. */
  const deliver = (conversation_id: string, message_id: string, stream_id: string, replay = false): void => {
    server!.ctx.send(server!.ctx.connections.byDevice('A1')!, { t: 'deliver', message: message(conversation_id, message_id), stream_id, replay });
  };
  const replayDone = (): void => { server!.ctx.send(server!.ctx.connections.byDevice('A1')!, { t: 'replay_done' }); };
  const delivers = (c: ScriptedClient): number => c.received.filter((f) => f.t === 'deliver').length;
  /** The frames the device sent, as the harness traces them. */
  const sent = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'delivered' && r.text.startsWith('Truc·phone →')).map((r) => r.text.slice('Truc·phone → '.length));
  const cursorOf = async (conversation_id: string): Promise<string | undefined> =>
    (await server!.ctx.ports.cursors.deliveryCursors(conversation_id)).get('A1');

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  test('the first stored message of a conversation goes out at once; inside the 2 s window nothing more; at its end one frame with the highest id stored; the two maps track', async () => {
    await start();
    const c = await connect();
    deliver('c1', '101', '1-0');
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    expect(sent()).toEqual(['c1 delivered ≤ #101']);
    expect(c.storedUpTo.get('c1')).toBe('101');
    expect(c.deliveredUpTo.get('c1')).toBe('101');

    deliver('c1', '103', '1-1');
    deliver('c1', '102', '1-2');
    await until(() => delivers(c) === 3, 1000, 'three delivers');
    expect(sent()).toEqual(['c1 delivered ≤ #101']);
    expect(c.storedUpTo.get('c1')).toBe('103');
    expect(c.deliveredUpTo.get('c1')).toBe('101');

    await time.advance(1999);
    expect(sent()).toEqual(['c1 delivered ≤ #101']);
    await time.advance(1);
    expect(sent()).toEqual(['c1 delivered ≤ #101', 'c1 delivered ≤ #103']);
    expect(c.deliveredUpTo.get('c1')).toBe('103');
    await until(() => server!.ctx.trace.rows().some((r) => r.tag === 'receipt' && r.text === 'delivered c1 ≤ #103 by Truc·phone'), 1000, 'the server traced it');
    expect(await cursorOf('c1')).toBe('103');
  });

  test('conversations are coalesced independently: a second conversation gets its own frame at once', async () => {
    await start();
    const c = await connect();
    deliver('c1', '101', '1-0');
    deliver('c1', '102', '1-1');
    deliver('c2', '50', '1-2');
    await until(() => delivers(c) === 3, 1000, 'three delivers');
    expect(sent()).toEqual(['c1 delivered ≤ #101', 'c2 delivered ≤ #50']);
    await time.advance(2000);
    expect(sent()).toEqual(['c1 delivered ≤ #101', 'c2 delivered ≤ #50', 'c1 delivered ≤ #102']);
  });

  test('a replay frame triggers it like a live one: the device is in replay mode when the frame leaves', async () => {
    await start();
    const c = await connect();
    deliver('c1', '201', '2-0', true); // a replay frame after replay_done: replay mode again
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    expect(c.inReplay).toBe(true);
    expect(sent()).toEqual(['c1 delivered ≤ #201']);
    replayDone();
    await until(() => !c.inReplay, 1000, 'replay_done');
    deliver('c1', '202', '2-1');
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    await time.advance(2000);
    expect(sent()).toEqual(['c1 delivered ≤ #201', 'c1 delivered ≤ #202']);
  });

  test('a duplicate deliver (already in the store) triggers nothing: the window ends quietly', async () => {
    await start();
    const c = await connect();
    deliver('c1', '101', '1-0');
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    deliver('c1', '101', '1-1', true);
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(c.duplicatesDropped).toBe(1);
    await time.advance(2000);
    await time.advance(2000);
    expect(sent()).toEqual(['c1 delivered ≤ #101']);
    expect(c.storedUpTo.get('c1')).toBe('101');
  });

  test('deliveredWindowMs changes the window; autoDelivered: false sends nothing and only storedUpTo moves', async () => {
    await start();
    const c = await connect({ deliveredWindowMs: 500 });
    deliver('c1', '101', '1-0');
    deliver('c1', '102', '1-1');
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    await time.advance(499);
    expect(sent()).toEqual(['c1 delivered ≤ #101']);
    await time.advance(1);
    expect(sent()).toEqual(['c1 delivered ≤ #101', 'c1 delivered ≤ #102']);

    c.stop();
    server!.ctx.trace.clear();
    const manual = await connect({ autoDelivered: false });
    deliver('c1', '103', '1-2');
    await until(() => delivers(manual) === 1, 1000, 'one deliver');
    await time.advance(4000);
    expect(sent()).toEqual([]);
    expect(manual.storedUpTo.get('c1')).toBe('103');
    expect(manual.deliveredUpTo.get('c1')).toBeUndefined();
  });

  test('stop() leaves no window timer armed', async () => {
    await start();
    const c = await connect();
    deliver('c1', '101', '1-0');
    deliver('c1', '102', '1-1');
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(time.pending()).toBeGreaterThan(0);
    c.stop();
    expect(time.pending()).toBe(0);
  });
});

describe('B11 resend after reconnect: one delivered per conversation where stored ≠ sent, at the first replay_done after a hello', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let time: FakeTime;

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  const client = (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): ScriptedClient => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    return c;
  };
  const post = async (from: ScriptedClient, to: ScriptedClient, conversation_id: string, client_msg_id: string): Promise<string> => {
    from.send({ t: 'msg', client_msg_id, conversation_id, body: 'hi' });
    const id = ((await from.expect('msg_ack')) as MsgAckFrame).message_id;
    await until(() => to.store.has(id), 2000, `#${id} stored at ${to.device.name}`);
    return id;
  };
  const sentByKhanh = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'delivered' && r.text.startsWith('Khanh·phone →')).map((r) => r.text.slice('Khanh·phone → '.length));
  const notes = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'note' && r.text.includes('delivered resent')).map((r) => r.text);
  const lost = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'lost' && r.text.startsWith('delivered from Khanh·phone')).map((r) => r.text);
  const cursorOf = async (conversation_id: string): Promise<string | undefined> =>
    (await server!.ctx.ports.cursors.deliveryCursors(conversation_id)).get('B1');

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  test('a gap inside the window, the connection drops, reconnect, replay_done → one delivered for the conversation with a gap, none for the one without; the server cursor reaches the stored id', async () => {
    await start();
    const truc = client(DEVICES.trucPhone);
    await truc.connect();
    await truc.hello();
    time = new FakeTime(0);
    const khanh = client(DEVICES.khanhPhone, { timers: time });
    await khanh.connect();
    await khanh.hello();
    await until(() => !khanh.inReplay, 1000, 'replay_done after hello');

    const c1first = await post(truc, khanh, 'c1', 't1');  // first of c1: delivered at once
    const c2only = await post(truc, khanh, 'c2', 't2');   // first of c2: delivered at once
    const c1gap = await post(truc, khanh, 'c1', 't3');    // inside c1's window: held
    await settle();
    expect(sentByKhanh()).toEqual([`c1 delivered ≤ #${c1first}`, `c2 delivered ≤ #${c2only}`]);
    expect(khanh.storedUpTo.get('c1')).toBe(c1gap);
    expect(khanh.deliveredUpTo.get('c1')).toBe(c1first);
    expect(await cursorOf('c1')).toBe(c1first);
    expect(await cursorOf('c2')).toBe(c2only);

    khanh.destroyWithoutClose(); // the window never fired: the receipt for c1gap is lost with the connection
    await until(() => server!.ctx.connections.byDevice('B1') === undefined, 2000, 'the server dropped Khanh');
    await time.advance(2000); // where the old window would have ended: it is gone with the connection, nothing leaves, nothing is traced as lost
    expect(sentByKhanh()).toHaveLength(2);
    expect(lost()).toEqual([]);

    await khanh.connect();
    await khanh.hello(); // the cursor is at c1gap's stream id (applied live): nothing to replay
    await until(() => !khanh.inReplay, 1000, 'replay_done after the reconnect');
    await settle();
    expect(sentByKhanh().slice(2)).toEqual([`c1 delivered ≤ #${c1gap}`]);
    expect(notes()).toEqual([`Khanh·phone: replay_done on a new connection → delivered resent for 1 conversation(s) where stored ≠ sent (c1 ≤ #${c1gap})`]);
    expect(khanh.deliveredUpTo.get('c1')).toBe(c1gap);
    expect(await cursorOf('c1')).toBe(c1gap);
    expect(await cursorOf('c2')).toBe(c2only);

    // The old window is gone with the old connection; the resend is not repeated by a later replay_done.
    await time.advance(2000);
    await settle();
    expect(sentByKhanh()).toHaveLength(3);
  });

  test('nothing is resent when the two ids agree in every conversation', async () => {
    await start();
    const truc = client(DEVICES.trucPhone);
    await truc.connect();
    await truc.hello();
    time = new FakeTime(0);
    const khanh = client(DEVICES.khanhPhone, { timers: time });
    await khanh.connect();
    await khanh.hello();
    await until(() => !khanh.inReplay, 1000, 'replay_done after hello');

    const id = await post(truc, khanh, 'c1', 't1');
    await settle();
    expect(sentByKhanh()).toEqual([`c1 delivered ≤ #${id}`]);

    khanh.destroyWithoutClose();
    await until(() => server!.ctx.connections.byDevice('B1') === undefined, 2000, 'the server dropped Khanh');
    await khanh.connect();
    await khanh.hello();
    await until(() => !khanh.inReplay, 1000, 'replay_done after the reconnect');
    await settle();
    expect(sentByKhanh()).toEqual([`c1 delivered ≤ #${id}`]);
    expect(notes()).toEqual([]);
    expect(await cursorOf('c1')).toBe(id);
  });
});
