import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer, type ChatServerOptions } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { InMemoryMessageStore, InMemorySyncQueue, streamIdOf } from '../../src/ports/index.js';
import type { ConversationId, DeliverFrame, MsgAckFrame } from '../../src/protocol.js';
import { idAt, type SyncOptions } from '../../src/sync/index.js';

/** Heartbeat intervals far beyond any fake-time advance, so `advance()` fires only B3's timers. */
const QUIET_HEARTBEAT = { connection: { pingMs: 1e12, deadAfterMs: 1e12, sweepMs: 1e12 } };

describe('B3 sync queue and replay (design §4.2, §4.4, §4.7; scenario S2)', () => {
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
  /** Sends one `msg` through the real send path and returns its message id. */
  const sendMsg = async (from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> => {
    const client_msg_id = `cid-${(seq += 1)}`;
    from.send({ t: 'msg', conversation_id, client_msg_id, body });
    const ack = (await from.expect((f) => f.t === 'msg_ack' && f.client_msg_id === client_msg_id)) as MsgAckFrame;
    return ack.message_id;
  };
  const queueRows = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'queue').map((r) => r.text);
  const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const phaseOf = (device_id: string): string | undefined => server!.ctx.connections.byDevice(device_id)?.phase;
  /** Connects, receives one live message from `from`, acks it by hand: the device now owns a cursor. */
  const prime = async (device: FixtureDevice, from: ScriptedClient, opts: Partial<ScriptedClientOptions> = {}): Promise<{ client: ScriptedClient; primed: MessageId }> => {
    const client = await connect(device, { autoAck: false, ...opts });
    const primed = await sendMsg(from, 'c1', 'prime');
    await client.expect((f) => f.t === 'deliver' && f.message.message_id === primed);
    client.ack(streamIdOf(primed));
    return { client, primed };
  };
  /** Clean close and wait until the server has dropped the connection. */
  const goOffline = async (client: ScriptedClient): Promise<void> => {
    client.closeCleanly();
    await until(() => server!.ctx.connections.byDevice(client.device.device_id) === undefined, 2000, `${client.device.name} gone`);
  };
  const deliveredIds = (c: ScriptedClient): MessageId[] => delivers(c).map((d) => d.message.message_id);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  describe('append, third in the write order (design §4.2)', () => {
    test('a stored and acked message lands in the stream of every recipient device, never the sender\'s', async () => {
      const srv = await start();
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(phone, 'c2', 'to the group');
      await khanh.expect('deliver');

      const entry = { id: streamIdOf(id), m: id, c: 'c2' };
      for (const device of ['A2', 'B1', 'C1', 'D1', 'E1']) {
        expect(await srv.ctx.ports.syncQueue.xrange(device, null, 100), device).toEqual([entry]);
      }
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
  });

  describe('hello without a cursor (design §4.7: new or wiped device)', () => {
    test('a null cursor takes the slow path: hello_ack{slow_path}, nothing replayed even if the stream has entries', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'while the phone was away');
      expect(await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).toHaveLength(1);

      const phone = new ScriptedClient(DEVICES.trucPhone, { url: srv.url, trace: srv.ctx.trace, mirrorRule: false, reconnect: false });
      clients.push(phone);
      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBe(true);
      await settle();
      expect(delivers(phone)).toHaveLength(0);
      expect(srv.ctx.connections.byDevice('A1')?.phase).toBe('live');
      expect(queueRows()).toContain('sq:A1: no cursor → slow path (new device)');
      // The entry is still there for a later hello that does carry a cursor.
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([id]);
    });
  });

  describe('S2: replay from the cursor, in batches, before live traffic (design §4.2, §4.4)', () => {
    test('offline for N messages across 3 conversations → exactly N delivers, in id order, none duplicated, bodies from the store', async () => {
      const srv = await start({ batchSize: 4 });
      const khanh = await connect(DEVICES.khanhPhone);
      const linh = await connect(DEVICES.linhBot);
      // The phone auto-acks (real timers): batches of 4 are acked at once, the last short batch after the 20 ms gap.
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh, { autoAck: true, ackBatchSize: 4 });
      await goOffline(phone);

      const expected: MessageId[] = [];
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(khanh, 'c1', `dm ${i}`));
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(khanh, 'c2', `group ${i}`));
      for (let i = 1; i <= 3; i += 1) expected.push(await sendMsg(linh, 'c3', `linh ${i}`));
      expected.push(await sendMsg(linh, 'c2', 'group 4'));
      expect(expected).toHaveLength(10);

      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBeUndefined();
      await until(() => phaseOf('A1') === 'live', 2000, 'phone live after the drain');

      expect(deliveredIds(phone)).toEqual([primed, ...expected]);
      expect(phone.delivered.map((m) => m.message_id)).toEqual([primed, ...expected]);
      expect(phone.duplicatesDropped).toBe(0);
      expect(phone.cursor).toBe(streamIdOf(expected[9]!));
      const refs = phone.delivered.slice(1).map((m) => ({ conversation_id: m.conversation_id, message_id: m.message_id }));
      expect(phone.delivered.slice(1)).toEqual(await srv.ctx.ports.messages.getMany(refs));
      expect(delivers(phone).slice(1).map((d) => d.stream_id)).toEqual(expected.map(streamIdOf));

      const c = streamIdOf;
      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toEqual([
        `XRANGE sq:A1 (${c(primed)} + → 4 entries, join bodies from the store`,
        `XRANGE sq:A1 (${c(expected[3]!)} + → 4 entries, join bodies from the store`,
        `XRANGE sq:A1 (${c(expected[7]!)} + → 2 entries, join bodies from the store`,
      ]);
      expect(queueRows().filter((r) => r.startsWith('Truc·phone ack'))).toEqual([
        `Truc·phone ack sid=${c(primed)} (device-owned cursor; server stores nothing)`,
        `Truc·phone ack sid=${c(expected[3]!)} (device-owned cursor; server stores nothing)`,
        `Truc·phone ack sid=${c(expected[7]!)} (device-owned cursor; server stores nothing)`,
        `Truc·phone ack sid=${c(expected[9]!)} (device-owned cursor; server stores nothing)`,
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
      await until(() => phaseOf('A1') === 'live', 2000, 'live');
      expect(deliveredIds(phone)).toEqual([m1, m2]);
    });

    test('a cursor sent backwards re-delivers on the wire; the client drops the duplicates by message id', async () => {
      await start({ batchSize: 2 });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh, { autoAck: true, ackBatchSize: 2 });
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');
      await phone.connect();
      await phone.hello();
      await until(() => phaseOf('A1') === 'live' && phone.cursor === streamIdOf(m3), 2000, 'first drain');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3]);

      // The device lies backwards (design §4.7): it gets duplicates, which it dedups.
      await goOffline(phone);
      phone.cursor = streamIdOf(primed);
      await phone.connect();
      await phone.hello();
      await until(() => phaseOf('A1') === 'live' && phone.cursor === streamIdOf(m3), 2000, 'second drain');

      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m1, m2, m3]);
      expect(phone.delivered.map((m) => m.message_id)).toEqual([primed, m1, m2, m3]);
      expect(phone.duplicatesDropped).toBe(3);
      const dedup = server!.ctx.trace.rows().filter((r) => r.tag === 'dedup').map((r) => r.text);
      expect(dedup).toEqual([m1, m2, m3].map((m) => `Truc·phone already has sid ${streamIdOf(m)} (#${m}), dropped`));
    });

    test('a message sent during the replay (between batches) arrives once, through the replay, never as a direct push', async () => {
      const srv = await start({ batchSize: 2 });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');
      const fanout: Array<{ message_id: MessageId; pushed: string[] }> = [];
      srv.ctx.events.on('message_fanout', ({ message, pushed }) => { fanout.push({ message_id: message.message_id, pushed }); });

      await phone.connect();
      await phone.hello();
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m2);
      expect(phaseOf('A1')).toBe('replay');
      // The server now waits for the ack of [m1, m2]. A message lands meanwhile: queued, not pushed.
      const m4 = await sendMsg(khanh, 'c1', 'four, during the replay');
      await settle();
      expect(fanout).toEqual([{ message_id: m4, pushed: [] }]);
      expect(deliveredIds(phone)).toEqual([primed, m1, m2]);

      phone.ack(streamIdOf(m2));
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m4);
      phone.ack(streamIdOf(m4));
      await until(() => phaseOf('A1') === 'live', 2000, 'live');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m4]);
      expect(phone.duplicatesDropped).toBe(0);

      // Live again: the next message is a direct push, not a replay.
      const m5 = await sendMsg(khanh, 'c1', 'five, live');
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m5);
      expect(fanout[1]).toEqual({ message_id: m5, pushed: ['A1'] });
      expect(queueRows().filter((r) => r.startsWith('XRANGE'))).toHaveLength(3);
    });

    test('no ack within ackTimeoutMs: the replay stops with a lost row, the connection goes live, the device keeps its cursor and replays again next time', async () => {
      const time = new FakeTime(Date.now());
      const srv = await start({ batchSize: 2, ackTimeoutMs: 5000 }, { clock: time, timers: time, moduleOptions: QUIET_HEARTBEAT });
      const khanh = await connect(DEVICES.khanhPhone);
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      const m3 = await sendMsg(khanh, 'c1', 'three');

      await phone.connect();
      await phone.hello();
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m2);
      await time.advance(4999);
      expect(phaseOf('A1')).toBe('replay');
      await time.advance(1);
      await until(() => phaseOf('A1') === 'live', 2000, 'live after the timeout');
      expect(deliveredIds(phone)).toEqual([primed, m1, m2]);
      expect(phone.cursor).toBe(streamIdOf(primed));
      const lost = srv.ctx.trace.rows().filter((r) => r.tag === 'lost').map((r) => r.text);
      expect(lost).toEqual([`replay sq:A1 → Truc·phone: no ack for the batch up to ${streamIdOf(m2)} within 5 s, stopped; the device keeps its cursor`]);

      await goOffline(phone);
      await phone.connect();
      await phone.hello();
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m2 && delivers(phone).length === 5);
      phone.ack(streamIdOf(m2));
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m3);
      phone.ack(streamIdOf(m3));
      await until(() => phaseOf('A1') === 'live', 2000, 'live after the second drain');
      expect(phone.delivered.map((m) => m.message_id)).toEqual([primed, m1, m2, m3]);
      expect(phone.duplicatesDropped).toBe(2);
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
      const { client: phone, primed } = await prime(DEVICES.trucPhone, khanh);
      await goOffline(phone);
      const m1 = await sendMsg(khanh, 'c1', 'one');
      const m2 = await sendMsg(khanh, 'c1', 'two');
      await goOffline(khanh);
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([primed, m1, m2]);

      // Six sweeps: at +60 s the boundary is t0, nothing is older; at +70 s the boundary is t0 + 10 s and all three are.
      await time.advance(60_000);
      expect(queueRows().filter((r) => r.startsWith('XTRIM'))).toEqual([]);
      expect(await srv.ctx.ports.syncQueue.first('A1')).toBe(streamIdOf(primed));
      await time.advance(10_000);
      const boundary = streamIdOf(idAt(t0 + 10_000));
      // A1 and A2 (Truc's laptop, registered by the seed) each held the three ids; Khanh's own stream had nothing.
      expect(queueRows().filter((r) => r.startsWith('XTRIM'))).toEqual([`XTRIM MINID ${boundary} : 6 entries across 2 streams`]);
      expect(await srv.ctx.ports.syncQueue.first('A1')).toBeNull();

      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBe(true);
      await until(() => phaseOf('A1') === 'live', 2000, 'live');
      expect(deliveredIds(phone)).toEqual([primed]);
      expect(queueRows()).toContain(`sq:A1: cursor ${streamIdOf(primed)} behind the trim boundary ${boundary} (oldest retained none) → slow path`);
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
      await time.advance(30_000);
      const fresh = await sendMsg(khanh, 'c1', 'fresh');
      await goOffline(khanh);
      // +70 s: boundary t0 + 10 s drops `primed` and `old`, keeps `fresh` (minted at t0 + 30 s).
      await time.advance(40_000);
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([fresh]);

      // A cursor at `old`, below the boundary: entries between `old` and the boundary may have been dropped. Slow path.
      phone.cursor = streamIdOf(old);
      await phone.connect();
      expect((await phone.hello()).slow_path).toBe(true);
      await goOffline(phone);

      // A cursor at the boundary itself is fine: everything retained is above it.
      phone.cursor = streamIdOf(idAt(t0 + 10_000));
      await phone.connect();
      expect((await phone.hello()).slow_path).toBeUndefined();
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === fresh);
      phone.ack(streamIdOf(fresh));
      await until(() => phaseOf('A1') === 'live', 2000, 'live');
      expect(deliveredIds(phone)).toEqual([primed, fresh]);
      await srv.close();
      server = undefined;
    });
  });

  describe('server crash mid-replay (design §4.7: the ack is the only thing that moves the cursor)', () => {
    test('restart on the same ports without the ack: the replay restarts from the last acked batch; nothing lost, nothing duplicated after dedup', async () => {
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
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m2);
      phone.ack(streamIdOf(m2));
      await phone.expect((f) => f.t === 'deliver' && f.message.message_id === m4);
      expect(deliveredIds(phone)).toEqual([primed, m1, m2, m3, m4]);
      // No ack for [m3, m4]. The server dies.
      await srv1.close();
      server = undefined;
      await until(() => !phone.connected, 2000, 'phone sees the close');
      expect(phone.cursor).toBe(streamIdOf(m2));

      const srv2 = await start({ batchSize: 2 }, { ports: shared, serverId: 'srv-2' });
      // Same device, same state: the cursor it owns and what it has rendered.
      const again = new ScriptedClient(DEVICES.trucPhone, { url: srv2.url, trace: srv2.ctx.trace, mirrorRule: false, reconnect: false, autoAck: false });
      clients.push(again);
      again.cursor = phone.cursor;
      for (const id of phone.seen) again.seen.add(id);
      await again.connect();
      expect((await again.hello()).slow_path).toBeUndefined();
      await again.expect((f) => f.t === 'deliver' && f.message.message_id === m4);
      again.ack(streamIdOf(m4));
      await again.expect((f) => f.t === 'deliver' && f.message.message_id === m5);
      again.ack(streamIdOf(m5));
      await until(() => srv2.ctx.connections.byDevice('A1')?.phase === 'live', 2000, 'live on the second server');

      expect(deliveredIds(again)).toEqual([m3, m4, m5]);
      expect(again.duplicatesDropped).toBe(2);
      expect(again.delivered.map((m) => m.message_id)).toEqual([m5]);
      const rendered = [...phone.delivered, ...again.delivered].map((m) => m.message_id);
      expect(rendered).toEqual([primed, m1, m2, m3, m4, m5]);
      expect(again.cursor).toBe(streamIdOf(m5));
    });
  });
});
