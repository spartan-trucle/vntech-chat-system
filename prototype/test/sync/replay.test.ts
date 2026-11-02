import { afterEach, describe, expect, test } from 'vitest';
import type { Socket } from 'node:net';
import { createChatServer, type ChatServer, type ChatServerOptions, type ServerEvents } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { InMemoryMessageStore, InMemorySyncQueue, streamIdJustBelow } from '../../src/ports/index.js';
import type { ConversationId, DeliverFrame, MsgAckFrame, StreamId } from '../../src/protocol.js';
import type { SyncOptions } from '../../src/sync/index.js';

/** Heartbeat intervals far beyond any fake-time advance, so `advance()` fires only B3's timers. */
const QUIET_HEARTBEAT = { connection: { pingMs: 1e12, deadAfterMs: 1e12, sweepMs: 1e12 } };

describe('B3 sync queue and replay (design §4.2, §4.4, §4.7; scenario S2; live-first and replay-mode ADRs)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let seq = 0;

  const start = async (sync: Partial<SyncOptions> = {}, over: Partial<ChatServerOptions> = {}): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, ...over, moduleOptions: { sync, ...(over.moduleOptions ?? {}) } });
    return server;
  };
  /** Connects and says hello; the client shares the server's trace so the log interleaves like the page. */
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');
  const replayDones = (c: ScriptedClient): number => c.received.filter((f) => f.t === 'replay_done').length;
  /** Sends one `msg` through the real send path and returns its message id. */
  const sendMsg = async (from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> => {
    const client_msg_id = `cid-${(seq += 1)}`;
    from.send({ t: 'msg', conversation_id, client_msg_id, body });
    const ack = (await from.expect((f) => f.t === 'msg_ack' && f.client_msg_id === client_msg_id)) as MsgAckFrame;
    return ack.message_id;
  };
  const queueRows = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'queue').map((r) => r.text);
  const lostRows = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'lost').map((r) => r.text);
  const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const modeOf = (device_id: string): string | undefined => server!.ctx.connections.byDevice(device_id)?.mode;
  /** The stream id of `device`'s entry for `message_id`, read through the port. */
  const sidOf = async (device_id: string, message_id: MessageId): Promise<StreamId> => {
    const entry = (await server!.ctx.ports.syncQueue.xrange(device_id, null, 100_000)).find((e) => e.m === message_id);
    if (!entry) throw new Error(`no entry for #${message_id} in sq:${device_id}`);
    return entry.id;
  };
  /** Connects, receives one live message from `from` and acks it (by hand unless `autoAck` is on): the device now owns a cursor. */
  const prime = async (device: FixtureDevice, from: ScriptedClient, opts: Partial<ScriptedClientOptions> = {}): Promise<{ client: ScriptedClient; primed: MessageId; sid: StreamId }> => {
    const client = await connect(device, { autoAck: false, ...opts });
    await until(() => !client.inReplay, 2000, 'replay_done after hello');
    const primed = await sendMsg(from, 'c1', 'prime');
    const frame = (await client.expect((f) => f.t === 'deliver' && f.message.message_id === primed)) as DeliverFrame;
    expect(frame.replay).toBe(false);
    // Live mode: the frame's stream id is applied to the cursor at once; the ack goes out on the cadence (or by hand).
    expect(client.cursor).toBe(frame.stream_id);
    if (!opts.autoAck) client.ack(frame.stream_id);
    return { client, primed, sid: frame.stream_id };
  };
  /** Clean close and wait until the server has dropped the connection. */
  const goOffline = async (client: ScriptedClient): Promise<void> => {
    client.closeCleanly();
    await until(() => server!.ctx.connections.byDevice(client.device.device_id) === undefined, 2000, `${client.device.name} gone`);
  };
  const deliveredIds = (c: ScriptedClient): MessageId[] => delivers(c).map((d) => d.message.message_id);
  const renderedIds = (c: ScriptedClient): MessageId[] => c.rendered().map((m) => m.message_id);
  /**
   * Holds the reply of the `n`-th XRANGE on `device` (1-based) until released, so a test can act
   * "during the replay": the loop runs beside the frame chain and never waits for an ack.
   */
  const holdXrange = (device_id: string, n: number): { released: Promise<void>; release: () => void; reached: Promise<void> } => {
    const queue = server!.ctx.ports.syncQueue;
    const xrange = queue.xrange.bind(queue);
    let release!: () => void;
    let reachedResolve!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { reachedResolve = r; });
    let calls = 0;
    queue.xrange = async (d, after, count) => {
      const out = await xrange(d, after, count);
      if (d === device_id && (calls += 1) === n) {
        reachedResolve();
        await released;
        queue.xrange = xrange;
      }
      return out;
    };
    return { released, release, reached };
  };
  const cork = (device_id: string): Socket => {
    const s = (server!.ctx.connections.byDevice(device_id)!.socket as unknown as { _socket: Socket })._socket;
    s.cork();
    return s;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  describe('append, third in the write order (design §4.2, XADD … *)', () => {
    test('a stored and acked message lands in the stream of every recipient device with a store-assigned id, never the sender\'s; the live deliver carries that id', async () => {
      const srv = await start();
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(phone, 'c2', 'to the group');
      const deliver = (await khanh.expect('deliver')) as DeliverFrame;

      for (const device of ['A2', 'B1', 'C1', 'D1', 'E1']) {
        const entries = await srv.ctx.ports.syncQueue.xrange(device, null, 100);
        expect(entries, device).toEqual([{ id: expect.stringMatching(/^\d+-\d+$/), m: id, c: 'c2' }]);
      }
      expect(deliver.stream_id).toBe(await sidOf('B1', id));
      expect(deliver.replay).toBe(false);
      expect(await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).toEqual([]);
      expect(queueRows()).toContain(`XADD sq:{device} #${id} × 5 devices`);
    });

    test('the append runs after the sender\'s ack and before the push (write order asserted, not assumed)', async () => {
      const srv = await start();
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);
      const seqLog: string[] = [];
      const queue = srv.ctx.ports.syncQueue;
      const xadd = queue.xadd.bind(queue);
      queue.xadd = async (d, e) => { seqLog.push(`xadd:${d}`); return xadd(d, e); };
      const tap = (device_id: string, label: string): void => {
        const socket = srv.ctx.connections.byDevice(device_id)!.socket as unknown as { send: (...args: unknown[]) => void };
        const send = socket.send.bind(socket);
        socket.send = (...args: unknown[]) => { seqLog.push(label); send(...args); };
      };
      tap('A1', 'ack');
      tap('B1', 'push');

      await sendMsg(phone, 'c1', 'order');
      await khanh.expect('deliver');
      expect(seqLog).toEqual(['ack', 'xadd:A2', 'xadd:B1', 'push']);
    });

    test('retry path (§4.2): an XADD that times out is followed by a tail read; present → skipped, absent → retried; one entry either way', async () => {
      const queue = new InMemorySyncQueue({ xaddTimeoutMs: 20 });
      const srv = await start({}, { ports: { syncQueue: queue } });
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);

      // Every XADD lands but answers late: the appender sees a timeout, reads the tail, finds the id, skips.
      queue.faults.xaddDelayMs = 50;
      const slow = await sendMsg(phone, 'c1', 'slow redis');
      await khanh.expect((f) => f.t === 'deliver' && f.message.message_id === slow);
      expect((await queue.xrange('B1', null, 100)).map((e) => e.m)).toEqual([slow]);
      expect(queueRows()).toContain(`XADD sq:B1 #${slow} timed out → XREVRANGE tail: present as ${await sidOf('B1', slow)}, append skipped`);
      queue.faults.xaddDelayMs = 0;

      // The XADD is lost outright: the tail has nothing, the append is retried and lands once.
      queue.faults.loseNextXadd = true;
      const lost = await sendMsg(phone, 'c1', 'lost xadd');
      await khanh.expect((f) => f.t === 'deliver' && f.message.message_id === lost);
      expect((await queue.xrange('B1', null, 100)).map((e) => e.m)).toEqual([slow, lost]);
      expect(queueRows()).toContain(`XADD sq:A2 #${lost} timed out → XREVRANGE tail: absent, retried`);
      void srv;
    });
  });

  describe('hello without a cursor (design §4.7: new or wiped device)', () => {
    test('a null cursor takes the slow path: hello_ack{slow_path}, replay_done at once, nothing replayed even if the stream has entries', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'while the phone was away');
      expect(await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).toHaveLength(1);

      const phone = new ScriptedClient(DEVICES.trucPhone, { url: srv.url, trace: srv.ctx.trace, mirrorRule: false, reconnect: false });
      clients.push(phone);
      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBe(true);
      await phone.expect('replay_done');
      await settle();
      expect(delivers(phone)).toHaveLength(0);
      expect(phone.inReplay).toBe(false);
      expect(modeOf('A1')).toBe('live');
      expect(queueRows()).toContain('sq:A1: no cursor → slow path (new device)');
      expect(queueRows()).toContain('sq:A1: nothing to replay → replay_done to Truc·phone');
      // The entry is still there for a later hello that does carry a cursor.
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([id]);
    });
  });

  describe('S2: replay from the cursor, in batches, beside live traffic (design §4.2, §4.4)', () => {
    test('offline for N messages across 3 conversations → exactly N delivers with replay: true, in stream order, bodies from the store, then replay_done; the client acks on its cadence', async () => {
      const srv = await start({ batchSize: 4 });
      const khanh = await connect(DEVICES.khanhPhone);
      const linh = await connect(DEVICES.linhBot);
      const { client: phone, primed, sid } = await prime(DEVICES.trucPhone, khanh, { autoAck: true, ackEvery: 4 });
      await goOffline(phone);

      const expected: MessageId[] = [];
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(khanh, 'c1', `dm ${i}`));
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(khanh, 'c2', `group ${i}`));
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(linh, 'c3', `linh ${i}`));
      expected.push(await sendMsg(linh, 'c2', 'group 4'));
      expect(expected).toHaveLength(10);
      const sids = await Promise.all(expected.map((m) => sidOf('A1', m)));

      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBeUndefined();
      await until(() => replayDones(phone) === 2, 2000, 'replay_done after the drain');

      expect(deliveredIds(phone)).toEqual([primed, ...expected]);
      expect(delivers(phone).slice(1).every((d) => d.replay)).toBe(true);
      expect(renderedIds(phone)).toEqual([primed, ...expected]);
      expect(phone.duplicatesDropped).toBe(0);
      expect(phone.inReplay).toBe(false);
      expect(modeOf('A1')).toBe('live');
      expect(phone.cursor).toBe(sids[9]);
      const refs = phone.rendered().slice(1).map((m) => ({ conversation_id: m.conversation_id, message_id: m.message_id }));
      expect(phone.rendered().slice(1)).toEqual(await srv.ctx.ports.messages.getMany(refs));
      expect(delivers(phone).slice(1).map((d) => d.stream_id)).toEqual(sids);

      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toEqual([
        `XRANGE sq:A1 (${sid} + → 4 entries, join bodies from the store`,
        `XRANGE sq:A1 (${sids[3]} + → 4 entries, join bodies from the store`,
        `XRANGE sq:A1 (${sids[7]} + → 2 entries, join bodies from the store`,
      ]);
      expect(queueRows()).toContain('replay_done → Truc·phone after 10 entries; live frames may advance the cursor again');
      // Every 4 replay frames, then the flush at replay_done; the server only traces them. (The primed
      // live frame's ack was still on the device's 500 ms timer when it closed: the cursor was applied anyway.)
      const ackRows = (): string[] => queueRows().filter((r) => r.startsWith('Truc·phone ack'));
      await until(() => ackRows().length === 3, 2000, 'three acks on the server');
      expect(ackRows()).toEqual([
        `Truc·phone ack sid=${sids[3]} (device-owned cursor; server stores nothing)`,
        `Truc·phone ack sid=${sids[7]} (device-owned cursor; server stores nothing)`,
        `Truc·phone ack sid=${sids[9]} (device-owned cursor; server stores nothing)`,
      ]);
    });

    test('a cursor equal to the oldest retained entry, or older with nothing ever trimmed, replays (nothing can have been lost)', async () => {
      await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const phone = new ScriptedClient(DEVICES.trucPhone, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false });
      clients.push(phone);
      phone.cursor = '0-0';
      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBeUndefined();
      await until(() => !phone.inReplay, 2000, 'replay_done');
      expect(deliveredIds(phone)).toEqual([m1, m2]);
    });

    test('a cursor sent backwards re-delivers on the wire; the client drops the duplicates by message id', async () => {
      await start({ batchSize: 2 });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed, sid } = await prime(DEVICES.trucPhone, khanh, { autoAck: true, ackEvery: 2 });
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');
      await phone.connect();
      await phone.hello();
      await until(() => !phone.inReplay, 2000, 'first drain');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3]);
      expect(phone.cursor).toBe(await sidOf('A1', m3));

      // The device lies backwards (design §4.7): it gets duplicates, which it dedups.
      await goOffline(phone);
      phone.cursor = sid;
      await phone.connect();
      await phone.hello();
      await until(() => !phone.inReplay, 2000, 'second drain');

      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m1, m2, m3]);
      expect(renderedIds(phone)).toEqual([primed, m1, m2, m3]);
      expect(phone.duplicatesDropped).toBe(3);
      expect(phone.cursor).toBe(await sidOf('A1', m3));
      const dedup = server!.ctx.trace.rows().filter((r) => r.tag === 'dedup').map((r) => r.text);
      expect(dedup).toEqual(await Promise.all([m1, m2, m3].map(async (m) => `Truc·phone already has #${m} (sid ${await sidOf('A1', m)} replay), dropped`)));
    });

    test('live first: a message sent during the replay is pushed live and replayed again; stored once, rendered in message order, and its live stream id never touches the cursor before replay_done', async () => {
      const srv = await start({ batchSize: 2 });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed, sid } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');
      const fanout: Array<{ message_id: MessageId; pushed: string[] }> = [];
      srv.ctx.events.on('message_fanout', ({ message, pushed }) => { fanout.push({ message_id: message.message_id, pushed }); });
      const hold = holdXrange('A1', 2);

      await phone.connect();
      await phone.hello();
      await hold.reached;
      expect(modeOf('A1')).toBe('replay');
      // The first batch was handed to the socket before the second read; let it land on the device.
      await until(() => delivers(phone).length === 3, 2000, 'first batch at the phone');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2]);
      // The loop is between batches. A message lands meanwhile: pushed live at once, and queued.
      const m4 = await sendMsg(khanh, 'c1', 'four, during the replay');
      const live = (await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m4)) as DeliverFrame;
      expect(live.replay).toBe(false);
      expect(fanout).toEqual([{ message_id: m4, pushed: ['A1'] }]);
      expect(phone.cursor).toBe(sid); // replay mode: a live frame is stored, its stream id is not applied
      expect(renderedIds(phone)).toEqual([primed, m1, m2, m4]);

      hold.release();
      await until(() => !phone.inReplay, 2000, 'replay_done');
      // Socket order was not message order; the store is.
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m4, m3, m4]);
      expect(renderedIds(phone)).toEqual([primed, m1, m2, m3, m4]);
      expect(phone.duplicatesDropped).toBe(1);
      expect(delivers(phone).at(-1)).toMatchObject({ message: { message_id: m4 }, replay: true });
      // No ack was sent by hand (autoAck off): the cursor stays where the device last acked.
      expect(phone.cursor).toBe(sid);
      // The held read's reply predates m4, so m3 came alone and m4 in one more read; the loop ends on the empty one.
      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toEqual([
        `XRANGE sq:A1 (${sid} + → 2 entries, join bodies from the store`,
        `XRANGE sq:A1 (${await sidOf('A1', m2)} + → 1 entries, join bodies from the store`,
        `XRANGE sq:A1 (${await sidOf('A1', m3)} + → 1 entries, join bodies from the store`,
      ]);

      // Live again: the next message is a direct push, applied to the cursor at once.
      const m5 = await sendMsg(khanh, 'c1', 'five, live');
      const frame = (await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m5)) as DeliverFrame;
      expect(fanout[1]).toEqual({ message_id: m5, pushed: ['A1'] });
      expect(phone.cursor).toBe(frame.stream_id);
    });

    test('the replay never waits for an ack (the B3 deadlock case): with no ack at all the whole stream is delivered and replay_done sent; an ack arriving mid-replay is traced and nothing else', async () => {
      const srv = await start({ batchSize: 2 });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');
      const hold = holdXrange('A1', 2);

      await phone.connect();
      await phone.hello();
      await hold.reached;
      await until(() => delivers(phone).length === 3, 2000, 'first batch at the phone');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2]);
      // An ack during the replay: handled on the frame chain while the loop is between reads.
      const sid2 = await sidOf('A1', m2);
      phone.ack(sid2);
      await until(() => queueRows().includes(`Truc·phone ack sid=${sid2} (device-owned cursor; server stores nothing)`), 2000, 'ack traced');
      hold.release();
      await until(() => !phone.inReplay, 2000, 'replay_done');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3]);
      expect(phone.cursor).toBe(sid2);
      expect(lostRows()).toEqual([]);
      expect(srv.ctx.connections.byDevice('A1')?.mode).toBe('live');
    });
  });

  describe('backpressure and re-replay (replay-mode ADR; design §5.8.3)', () => {
    test('a live push the budget drops: live pushes to that connection stop, the buffer drains, the stream is re-replayed alone from the dropped entry, replay_done, then live resumes; no reconnect', async () => {
      const srv = await start({}, { push: { maxPending: 2, pushTimeoutMs: 60_000 } });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      const fanout: Array<{ message_id: MessageId; pushed: string[] }> = [];
      srv.ctx.events.on('message_fanout', ({ message, pushed }) => { fanout.push({ message_id: message.message_id, pushed }); });
      const dropped: Array<{ message_id: MessageId; stream_id: StreamId; reason: string }> = [];
      srv.ctx.events.on('push_dropped', ({ conn, message, stream_id, reason }) => { dropped.push({ message_id: message.message_id, stream_id, reason }); expect(conn.device_id).toBe('A1'); });

      // The phone stops reading: its server-side socket is corked, so nothing flushes until uncorked.
      const tcp = cork('A1');
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three, dropped');
      await settle();
      expect(fanout.map((f) => f.pushed)).toEqual([['A1'], ['A1'], []]);
      const sid3 = await sidOf('A1', m3);
      expect(dropped).toEqual([{ message_id: m3, stream_id: sid3, reason: 'full' }]);
      expect(lostRows()).toEqual([`#${m3} → Truc·phone: buffer full (2 pending), left to the queue`]);
      expect(srv.ctx.connections.byDevice('A1')!.pushes.liveSuspended).toBe(true);
      expect(modeOf('A1')).toBe('replay');
      expect(queueRows()).toContain(`sq:A1: live push dropped at ${sid3} → live frames to Truc·phone suspended, re-replay from ${sid3} once the buffer drains`);

      // Another message while the re-replay waits: not pushed, not dropped; it waits in the stream for the loop.
      const m4 = await sendMsg(khanh, 'c1', 'four, while suspended');
      await settle();
      expect(fanout[3]).toEqual({ message_id: m4, pushed: [] });
      expect(dropped).toHaveLength(1);
      expect(queueRows()).toContain(`#${m4} → Truc·phone: live pushes suspended during a re-replay, left to the stream`);
      expect(deliveredIds(phone)).toEqual([primed]);

      tcp.uncork();
      await until(() => !phone.inReplay && replayDones(phone) === 2, 3000, 'replay_done after the re-replay');
      // m1 and m2 arrived live (applied to the cursor), m3 and m4 by the re-replay alone.
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m4]);
      expect(delivers(phone).map((d) => d.replay)).toEqual([false, false, false, true, true]);
      expect(renderedIds(phone)).toEqual([primed, m1, m2, m3, m4]);
      expect(phone.duplicatesDropped).toBe(0);
      expect(phone.reconnects).toBe(0);
      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toEqual([
        `XRANGE sq:A1 (${streamIdJustBelow(sid3)} + → 2 entries, join bodies from the store`,
      ]);
      expect(queueRows()).toContain('sq:A1: re-replay done → live pushes to Truc·phone resumed');
      expect(srv.ctx.connections.byDevice('A1')!.pushes.liveSuspended).toBe(false);
      expect(modeOf('A1')).toBe('live');

      // Live again.
      const m5 = await sendMsg(khanh, 'c1', 'five, live');
      const frame = (await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m5)) as DeliverFrame;
      expect(frame.replay).toBe(false);
      expect(fanout[4]).toEqual({ message_id: m5, pushed: ['A1'] });
      expect(phone.cursor).toBe(frame.stream_id);
    });

    test('a further drop during the re-replay extends it: pushes that time out while the loop waits lower its start; the loop ends only on an empty read', async () => {
      const time = new FakeTime(Date.now());
      const srv = await start({}, { clock: time, timers: time, moduleOptions: QUIET_HEARTBEAT, push: { maxPending: 2, pushTimeoutMs: 1000 } });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      const tcp = cork('A1');
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three, dropped');
      await settle();
      expect(modeOf('A1')).toBe('replay');
      const [sid1, sid3] = [await sidOf('A1', m1), await sidOf('A1', m3)];

      // The two accepted pushes never flush: at the timeout they are dropped too, and the re-replay must start below them.
      await time.advance(1000);
      await settle();
      expect(lostRows()).toEqual([
        `#${m3} → Truc·phone: buffer full (2 pending), left to the queue`,
        `#${m1} → Truc·phone: not taken within 1 s, left to the queue`,
        `#${m2} → Truc·phone: not taken within 1 s, left to the queue`,
      ]);
      expect(queueRows()).toContain(`sq:A1: another live push dropped at ${sid1} during the re-replay → loop extended`);

      tcp.uncork();
      await until(() => !phone.inReplay && replayDones(phone) === 2, 3000, 'replay_done');
      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toEqual([
        `XRANGE sq:A1 (${streamIdJustBelow(sid1)} + → 3 entries, join bodies from the store`,
      ]);
      // The timed-out bytes still went out at the uncork: the client saw m1 and m2 twice and kept one of each.
      expect(renderedIds(phone)).toEqual([primed, m1, m2, m3]);
      expect(phone.duplicatesDropped).toBe(2);
      expect(delivers(phone).filter((d) => d.replay).map((d) => d.stream_id)).toEqual([sid1, await sidOf('A1', m2), sid3]);
      await srv.close();
      server = undefined;
      expect(time.pending()).toBe(0);
    });
  });

  describe('trim and the slow path (design §4.2, §4.5, §4.7)', () => {
    test('the hourly sweeper trims entries older than the window; a cursor behind the trim boundary takes the slow path with no replay', async () => {
      const t0 = Date.now();
      const time = new FakeTime(t0);
      const srv = await start({ windowMs: 60_000, sweepMs: 10_000 }, { clock: time, timers: time, moduleOptions: QUIET_HEARTBEAT });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed, sid } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      await goOffline(khanh);
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([primed, m1, m2]);

      // Six sweeps: at +60 s the boundary is t0, nothing is older; at +70 s the boundary is t0 + 10 s and all three are.
      await time.advance(60_000);
      expect(queueRows().filter((r) => r.startsWith('XTRIM'))).toEqual([]);
      expect(await srv.ctx.ports.syncQueue.first('A1')).toBe(sid);
      await time.advance(10_000);
      const boundary = `${t0 + 10_000}-0`;
      // A1 and A2 (Truc's laptop, registered by the seed) each held the three ids; Khanh's own stream had nothing.
      expect(queueRows().filter((r) => r.startsWith('XTRIM'))).toEqual([`XTRIM MINID ${boundary} : 6 entries across 2 streams`]);
      expect(await srv.ctx.ports.syncQueue.first('A1')).toBeNull();

      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBe(true);
      await until(() => !phone.inReplay, 2000, 'replay_done');
      expect(deliveredIds(phone)).toEqual([primed]);
      expect(queueRows()).toContain(`sq:A1: cursor ${sid} behind the trim boundary ${boundary} (oldest retained none) → slow path`);
      // The device uses B4: the list answers, charged to the slow-path bucket.
      const res = await fetch(`${srv.httpUrl}/conversations?user_id=truc&device_id=A1`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { conversations: unknown[] }).conversations).toHaveLength(1);

      await srv.close();
      server = undefined;
      expect(time.pending()).toBe(0);
    });

    test('a cursor at or past the trim boundary still replays what is retained', async () => {
      const t0 = Date.now();
      const time = new FakeTime(t0);
      const srv = await start({ windowMs: 60_000, sweepMs: 10_000 }, { clock: time, timers: time, moduleOptions: QUIET_HEARTBEAT });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const old = await sendMsg(khanh, 'c1', 'old');
      const oldSid = await sidOf('A1', old);
      await time.advance(30_000);
      const fresh = await sendMsg(khanh, 'c1', 'fresh');
      await goOffline(khanh);
      // +70 s: boundary t0 + 10 s drops `primed` and `old`, keeps `fresh` (appended at t0 + 30 s).
      await time.advance(40_000);
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([fresh]);

      // A cursor at `old`, below the boundary: entries between `old` and the boundary may have been dropped. Slow path.
      phone.cursor = oldSid;
      await phone.connect();
      expect((await phone.hello()).slow_path).toBe(true);
      await goOffline(phone);

      // A cursor at the boundary itself is fine: everything retained is above it.
      phone.cursor = `${t0 + 10_000}-0`;
      await phone.connect();
      expect((await phone.hello()).slow_path).toBeUndefined();
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === fresh);
      await until(() => !phone.inReplay, 2000, 'replay_done');
      expect(deliveredIds(phone)).toEqual([primed, fresh]);
      await srv.close();
      server = undefined;
    });
  });

  describe('server crash mid-replay (design §4.7: the ack is the only thing that moves the cursor)', () => {
    test('restart on the same ports: the replay restarts from the last acked id; nothing lost, nothing duplicated after dedup', async () => {
      const shared = { syncQueue: new InMemorySyncQueue(), messages: new InMemoryMessageStore() };
      const srv1 = await start({ batchSize: 2 }, { ports: shared });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const ids: MessageId[] = [];
      for (let i = 1; i <= 5; i += 1) ids.push(await sendMsg(khanh, 'c1', `m${i}`));
      const [m1, m2, m3, m4, m5] = ids as [MessageId, MessageId, MessageId, MessageId, MessageId];

      await phone.connect();
      await phone.hello();
      await until(() => !phone.inReplay, 2000, 'first drain');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m4, m5]);
      // The device acked only up to m2 before the server died (autoAck off: the ack is by hand).
      const sid2 = await sidOf('A1', m2);
      phone.ack(sid2);
      await srv1.close();
      server = undefined;
      await until(() => !phone.connected, 2000, 'phone sees the close');
      expect(phone.cursor).toBe(sid2);

      const srv2 = await start({ batchSize: 2 }, { ports: shared, serverId: 'srv-2' });
      // Same device, same state: the cursor it owns and what it has rendered.
      const again = new ScriptedClient(DEVICES.trucPhone, { url: srv2.url, trace: srv2.ctx.trace, mirrorRule: false, reconnect: false });
      clients.push(again);
      again.cursor = phone.cursor;
      for (const m of phone.rendered()) again.store.set(m.message_id, m);
      await again.connect();
      expect((await again.hello()).slow_path).toBeUndefined();
      await until(() => !again.inReplay, 2000, 'drained on the second server');

      expect(deliveredIds(again)).toEqual([m3, m4, m5]);
      expect(again.duplicatesDropped).toBe(3);
      expect(renderedIds(again)).toEqual([primed, m1, m2, m3, m4, m5]);
      expect(again.cursor).toBe(await sidOf('A1', m5));
      const events: Array<keyof ServerEvents> = ['message_fanout'];
      void events;
    });
  });
});
