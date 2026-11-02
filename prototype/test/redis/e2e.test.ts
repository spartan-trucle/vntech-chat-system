/**
 * B9 · the real server over real Redis: `createChatServer({ports: createRedisPorts(…)})`
 * with the presence bus on Redis pub/sub, driven by the B1 ScriptedClient on real timers.
 * Rewritten by B10 for the live-first and replay-mode ADRs (2026-11-02):
 *
 *   1. S2's core: Khanh offline, Truc sends three across c1/c2, Khanh reconnects with its
 *      cursor and gets exactly those three, in order, once, then replay_done; the trace shows
 *      `XRANGE sq:B1` and the stream in Redis holds the Redis-assigned ids the frames carried.
 *   2. Live first: a message sent while Khanh is replaying is pushed live at once and
 *      replayed again; the phone stores it once and its live stream id never touches the
 *      cursor before replay_done.
 *   3. The B9 race, closed: a message appended after the replay's last read and before
 *      replay_done (the reply of the empty read held to model its latency) is pushed live and
 *      stored once; nothing waits for a reconnect. "Late, not lost" survives as over-replay: a
 *      reconnect with the older cursor delivers it again and the phone drops the copy.
 *   4. Presence over the Redis bus: a watcher sees offline after the debounce, the lease
 *      and the route keys are Redis keys.
 *
 * Skipped without REDIS_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEVICES } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import type { ConversationId, DeviceId } from '../../src/protocol.js';
import { createRedisPorts, RedisPresenceBus, type RedisPorts } from '../../src/redis/index.js';
import { flushPrefix } from '../../src/redis/client.js';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { until } from '../harness/FakeTime.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { acksOf, delivers, presenceOf, replayDones, sidOf } from '../scenarios/helpers.js';
import { explainSkip, REDIS_URL, redisAvailable, testPrefix } from './support.js';

explainSkip('test/redis/e2e.test.ts');

describe.skipIf(!redisAvailable)('the chat server over real Redis (B9, B10)', () => {
  const prefix = testPrefix();
  let ports: RedisPorts;
  let bus: RedisPresenceBus;
  let server: ChatServer;
  const clients: ScriptedClient[] = [];

  beforeAll(async () => {
    ports = createRedisPorts({ url: REDIS_URL!, prefix });
    bus = new RedisPresenceBus(ports.redis, { prefix });
    server = await createChatServer({
      port: 0,
      serverId: 'srv-1',
      seed: true,
      ports: { syncQueue: ports.syncQueue, routes: ports.routes, presence: ports.presence },
      moduleOptions: { presence: { bus, debounceMs: 100 } },
    });
  });

  afterAll(async () => {
    for (const c of clients) c.stop();
    await server.close();
    await bus.close();
    await flushPrefix(ports.redis, prefix);
    await ports.close();
  });

  const client = (device: (typeof DEVICES)[keyof typeof DEVICES], over: Partial<ScriptedClientOptions> = {}): ScriptedClient => {
    const c = new ScriptedClient(device, { url: server.url, trace: server.ctx.trace, mirrorRule: false, reconnect: false, watchBatchMs: 5, ...over });
    clients.push(c);
    return c;
  };
  const connect = async (device: (typeof DEVICES)[keyof typeof DEVICES], over: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = client(device, over);
    await c.connect();
    await c.hello();
    await until(() => !c.inReplay, 3000, `replay_done for ${c.device.name}`);
    return c;
  };
  const send = async (from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> => {
    const frame = from.sendMessage({ conversation_id, body });
    await until(() => acksOf(from, frame).length > 0, 3000, `msg_ack for ${from.device.name}`);
    return acksOf(from, frame)[0]!.message_id;
  };
  const gone = (device_id: DeviceId): Promise<void> => until(() => server.ctx.connections.byDevice(device_id) === undefined, 3000, `${device_id} gone`);
  const mode = (device_id: DeviceId) => server.ctx.connections.byDevice(device_id)?.mode;
  const rows = (tag: string): string[] => server.ctx.trace.rows().filter((r) => r.tag === tag).map((r) => r.text);
  const ids = (c: ScriptedClient): MessageId[] => c.rendered().map((m) => m.message_id);
  /**
   * Holds the `n`-th XRANGE on `device` (1-based, from now) until released. Plain: the read itself
   * waits, so the loop sits between two reads. `empty`: only empty replies count and the reply is
   * held after Redis answered, a real round trip stretched: the window B9 found.
   */
  const holdXrange = (device_id: DeviceId, n: number, empty = false): { reached: Promise<void>; release: () => void } => {
    const queue = server.ctx.ports.syncQueue;
    const xrange = queue.xrange.bind(queue);
    let release!: () => void;
    let reachedResolve!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { reachedResolve = r; });
    let calls = 0;
    queue.xrange = async (d, after, count) => {
      if (d !== device_id) return xrange(d, after, count);
      if (!empty) {
        if ((calls += 1) === n) {
          queue.xrange = xrange;
          reachedResolve();
          await released;
        }
        return xrange(d, after, count);
      }
      const out = await xrange(d, after, count);
      if (out.length === 0 && (calls += 1) === n) {
        queue.xrange = xrange;
        reachedResolve();
        await released;
      }
      return out;
    };
    return { reached, release };
  };

  let truc: ScriptedClient;
  /** Khanh's cursor after test 1, the starting point of the later tests. */
  let khanhCursor: string;

  test('S2 core: Khanh reconnects with its cursor and replays exactly the three it missed, from sq:B1 in Redis, then replay_done', async () => {
    truc = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    expect(await ports.routes.get('khanh', 'B1')).toBe('srv-1');
    expect(await ports.redis.smembers(ports.routes.devicesKey('khanh'))).toEqual(['B1']);

    const primed = await send(truc, 'c1', 'Before you go');
    await until(() => delivers(khanh).length === 1, 3000, 'primed deliver at Khanh');
    expect(khanh.cursor).toBe(sidOf(khanh, primed));
    const cursor = khanh.cursor!;

    khanh.closeCleanly();
    await gone('B1');
    expect(await ports.routes.get('khanh', 'B1')).toBeUndefined();
    expect(await ports.redis.exists(ports.routes.routeKey('khanh', 'B1'))).toBe(0);

    const expected: MessageId[] = [];
    let fanouts = 0;
    const offFanout = server.ctx.events.on('message_fanout', () => { fanouts += 1; });
    for (const [conversation, body] of [['c1', 'While you were away 1'], ['c2', 'While you were away 2'], ['c1', 'While you were away 3']] as const) {
      expected.push(await send(truc, conversation, body));
    }
    // The sender's ack precedes the queue append (write order), so the stream is read once the fan-out of all three is done.
    await until(() => fanouts === 3, 3000, 'fan-out of the three');
    offFanout();
    // The stream is a real Redis key with the design's entries and Redis-assigned ids.
    const raw = await ports.redis.xrange(ports.syncQueue.keyOf('B1'), '-', '+');
    expect(raw.map(([id]) => id)).toEqual([cursor, ...raw.slice(1).map(([id]) => id)]);
    expect(raw.map(([id]) => id).every((id) => /^\d{13}-\d+$/.test(id))).toBe(true);
    expect(raw.map(([, fields]) => fields)).toEqual([
      ['m', primed, 'c', 'c1'], ['m', expected[0]!, 'c', 'c1'], ['m', expected[1]!, 'c', 'c2'], ['m', expected[2]!, 'c', 'c1'],
    ]);

    await khanh.connect();
    const ack = await khanh.hello();
    expect(ack.slow_path).toBeUndefined();
    await until(() => delivers(khanh).length === 4, 3000, 'three replayed delivers');
    await until(() => replayDones(khanh) === 2 && !khanh.inReplay, 3000, 'replay_done after the drain');
    expect(mode('B1')).toBe('live');
    expect(ids(khanh)).toEqual([primed, ...expected]);
    expect(delivers(khanh).slice(1).map((d) => d.stream_id)).toEqual(raw.slice(1).map(([id]) => id));
    expect(delivers(khanh).slice(1).every((d) => d.replay)).toBe(true);
    expect(khanh.duplicatesDropped).toBe(0);
    expect(rows('queue')).toContain(`XRANGE sq:B1 (${cursor} + → 3 entries, join bodies from the store`);
    expect(khanh.cursor).toBe(sidOf(khanh, expected[2]!));

    const live = await send(truc, 'c1', 'Live again');
    await until(() => delivers(khanh).length === 5, 3000, 'live deliver at Khanh');
    expect(rows('push')).toContain(`#${live} → Khanh·phone over the socket`);
    expect(khanh.cursor).toBe(sidOf(khanh, live));
    khanhCursor = khanh.cursor!;
    khanh.closeCleanly();
    await gone('B1');
  });

  test('live first: a message sent while Khanh is replaying is pushed at once and replayed again; stored once, its live stream id never applied before replay_done', async () => {
    const m1 = await send(truc, 'c1', 'Away 1');
    const m2 = await send(truc, 'c2', 'Away 2');
    const khanh = client(DEVICES.khanhPhone, { autoAck: false });
    khanh.cursor = khanhCursor;
    const hold = holdXrange('B1', 2);
    await khanh.connect();
    await khanh.hello();
    await hold.reached;
    await until(() => delivers(khanh).length === 2, 3000, 'first read at Khanh');
    expect(mode('B1')).toBe('replay');

    let pushedDuringReplay: DeviceId[] | undefined;
    const off = server.ctx.events.on('message_fanout', ({ pushed }) => { pushedDuringReplay = pushed; });
    const m3 = await send(truc, 'c1', 'Sent during the replay');
    await until(() => pushedDuringReplay !== undefined, 3000, 'fan-out of m3');
    off();
    expect(pushedDuringReplay).toEqual(['B1']);
    await until(() => khanh.store.has(m3), 3000, 'the live push at Khanh');
    expect(delivers(khanh).find((d) => d.message.message_id === m3)!.replay).toBe(false);
    expect(khanh.cursor).toBe(khanhCursor); // replay mode: not applied

    hold.release();
    await until(() => replayDones(khanh) === 1 && !khanh.inReplay, 3000, 'replay_done');
    expect(ids(khanh)).toEqual([m1, m2, m3]);
    expect(khanh.duplicatesDropped).toBe(1);
    expect(delivers(khanh).filter((d) => d.message.message_id === m3).map((d) => d.replay)).toEqual([false, true]);
    khanh.ack(sidOf(khanh, m3));
    khanhCursor = khanh.cursor!;
    khanh.closeCleanly();
    await gone('B1');
  });

  let appendedInTheWindow: MessageId;

  test('the B9 race, closed: a message appended after the last read and before replay_done is pushed live and stored once; nothing waits for a reconnect', async () => {
    const khanh = client(DEVICES.khanhPhone);
    khanh.cursor = khanhCursor;
    // The replay's empty read has run in Redis and its reply is in flight: the window B9 found.
    const hold = holdXrange('B1', 1, true);
    await khanh.connect();
    await khanh.hello();
    await hold.reached;
    expect(mode('B1')).toBe('replay');
    let pushed: DeviceId[] | undefined;
    const off = server.ctx.events.on('message_fanout', (e) => { pushed = e.pushed; });
    appendedInTheWindow = await send(truc, 'c1', 'Sent in the empty-XRANGE window');
    await until(() => pushed !== undefined, 3000, 'fan-out of the message');
    off();
    expect(pushed).toEqual(['B1']); // live first: the connection was subscribed before the replay started
    await until(() => khanh.store.has(appendedInTheWindow), 3000, 'stored at Khanh');
    expect(khanh.cursor).toBe(khanhCursor); // still in replay mode: the live stream id waits
    hold.release();
    await until(() => replayDones(khanh) === 1 && !khanh.inReplay, 3000, 'replay_done');
    expect(ids(khanh)).toEqual([appendedInTheWindow]);
    expect(khanh.duplicatesDropped).toBe(0);
    expect(khanh.reconnects).toBe(0);
    khanh.closeCleanly();
    await gone('B1');
  });

  test('late, not lost, as over-replay: the entry is in sq:B1 above the older cursor, a reconnect with that cursor delivers it again and the phone drops the copy', async () => {
    const stored = await ports.syncQueue.xrange('B1', khanhCursor, 100);
    expect(stored.map((e) => e.m)).toEqual([appendedInTheWindow]);
    const khanh = client(DEVICES.khanhPhone);
    khanh.cursor = khanhCursor;
    khanh.store.set(appendedInTheWindow, { ...(await server.ctx.ports.messages.get('c1', appendedInTheWindow))! });
    await khanh.connect();
    await khanh.hello();
    await until(() => replayDones(khanh) === 1 && !khanh.inReplay, 3000, 'replay_done');
    expect(delivers(khanh).map((d) => [d.message.message_id, d.replay])).toEqual([[appendedInTheWindow, true]]);
    expect(khanh.duplicatesDropped).toBe(1);
    expect(ids(khanh)).toEqual([appendedInTheWindow]);
    expect(khanh.cursor).toBe(stored[0]!.id);
    khanhCursor = khanh.cursor!;
  });

  test('presence over the Redis bus: a watcher sees offline after the debounce; lease and routes are Redis keys', async () => {
    const khanh = server.ctx.connections.byDevice('B1');
    expect(khanh).toBeDefined();
    const watcher = clients.at(-1)!;
    watcher.watch(['truc']);
    await until(() => presenceOf(watcher, 'truc').length === 1, 3000, 'current state replied');
    expect(presenceOf(watcher, 'truc')[0]).toMatchObject({ user_id: 'truc', state: 'online' });
    await bus.ready();
    expect(await bus.subscribedChannels()).toEqual([bus.channelOf('truc')]);
    expect(await ports.presence.get('truc')).toEqual({ state: 'online' });

    truc.closeCleanly();
    await gone('A1');
    expect(await ports.redis.smembers(ports.routes.devicesKey('truc'))).toEqual([]);
    await until(() => presenceOf(watcher, 'truc').length === 2, 3000, 'offline after the debounce');
    const offline = presenceOf(watcher, 'truc')[1]!;
    expect(offline.state).toBe('offline');
    expect(typeof offline.last_seen).toBe('number');
    expect(rows('presence').some((r) => r.startsWith('PUBLISH pres:truc offline'))).toBe(true);
    const lease = await ports.presence.get('truc');
    expect(lease).toEqual({ state: 'offline', last_seen: offline.last_seen });
    expect(await ports.redis.pttl(ports.presence.keyOf('truc'))).toBeGreaterThan(0);
  });
});
