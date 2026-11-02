/**
 * B9 · the real server over real Redis: `createChatServer({ports: createRedisPorts(…)})`
 * with the presence bus on Redis pub/sub, driven by the B1 ScriptedClient on real timers.
 *
 *   1. S2's core: Khanh offline, Truc sends three across c1/c2, Khanh reconnects with its
 *      cursor and gets exactly those three, in order, once; the trace shows `XRANGE sq:B1`
 *      and the stream in Redis holds the ids.
 *   2. The B3 report's race, first form: a message sent while Khanh is in `replay`
 *      waiting on an ack is delivered exactly once (by the replay, not the push).
 *   3. The B3 report's race, second form: a message whose XADD lands after the replay's
 *      last, empty XRANGE and whose fan-out runs before the flip to `live` is neither
 *      replayed nor pushed. Real with I/O: the empty-XRANGE reply is held to model its
 *      latency. Kept as `test.fails` (C2 finding; src/sync and src/messaging untouched).
 *   4. Presence over the Redis bus: a watcher sees offline after the debounce, the lease
 *      and the route keys are Redis keys.
 *
 * Skipped without REDIS_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEVICES } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { streamIdOf, type SyncQueue } from '../../src/ports/index.js';
import type { ConversationId, DeviceId } from '../../src/protocol.js';
import { createRedisPorts, RedisPresenceBus, type RedisPorts } from '../../src/redis/index.js';
import { flushPrefix } from '../../src/redis/client.js';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { until } from '../harness/FakeTime.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { acksOf, delivers, presenceOf } from '../scenarios/helpers.js';
import { explainSkip, REDIS_URL, redisAvailable, sleep, testPrefix } from './support.js';

explainSkip('test/redis/e2e.test.ts');

describe.skipIf(!redisAvailable)('the chat server over real Redis (B9)', () => {
  const prefix = testPrefix();
  let ports: RedisPorts;
  let bus: RedisPresenceBus;
  let server: ChatServer;
  const clients: ScriptedClient[] = [];
  /** Test 3 holds the reply of an empty XRANGE here, modelling its latency. */
  let holdEmptyXrange: Promise<void> | null = null;

  beforeAll(async () => {
    ports = createRedisPorts({ url: REDIS_URL!, prefix });
    bus = new RedisPresenceBus(ports.redis, { prefix });
    const gated: SyncQueue = {
      xadd: (device, entry) => ports.syncQueue.xadd(device, entry),
      xtrim: (device, minId) => ports.syncQueue.xtrim(device, minId),
      first: (device) => ports.syncQueue.first(device),
      async xrange(device, after, count) {
        const out = await ports.syncQueue.xrange(device, after, count);
        if (out.length === 0 && holdEmptyXrange) await holdEmptyXrange;
        return out;
      },
    };
    server = await createChatServer({
      port: 0,
      serverId: 'srv-1',
      seed: true,
      ports: { syncQueue: gated, routes: ports.routes, presence: ports.presence },
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
    return c;
  };
  const send = async (from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> => {
    const frame = from.sendMessage({ conversation_id, body });
    await until(() => acksOf(from, frame).length > 0, 3000, `msg_ack for ${from.device.name}`);
    return acksOf(from, frame)[0]!.message_id;
  };
  const gone = (device_id: DeviceId): Promise<void> => until(() => server.ctx.connections.byDevice(device_id) === undefined, 3000, `${device_id} gone`);
  const phase = (device_id: DeviceId) => server.ctx.connections.byDevice(device_id)?.phase;
  const rows = (tag: string): string[] => server.ctx.trace.rows().filter((r) => r.tag === tag).map((r) => r.text);
  const ids = (c: ScriptedClient): MessageId[] => c.delivered.map((m) => m.message_id);

  let truc: ScriptedClient;
  /** Khanh's cursor after test 1, the starting point of the later tests. */
  let khanhCursor: string;

  test('S2 core: Khanh reconnects with its cursor and replays exactly the three it missed, from sq:B1 in Redis', async () => {
    truc = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    expect(await ports.routes.get('khanh', 'B1')).toBe('srv-1');
    expect(await ports.redis.smembers(ports.routes.devicesKey('khanh'))).toEqual(['B1']);

    const primed = await send(truc, 'c1', 'Before you go');
    await until(() => delivers(khanh).length === 1, 3000, 'primed deliver at Khanh');
    await until(() => khanh.cursor === streamIdOf(primed), 3000, 'Khanh acked');
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
    // The stream is a real Redis key with the design's entries.
    const raw = await ports.redis.xrange(ports.syncQueue.keyOf('B1'), '-', '+');
    expect(raw.map(([id]) => id)).toEqual([primed, ...expected].map(streamIdOf));
    expect(raw.map(([, fields]) => fields)).toEqual([
      ['m', primed, 'c', 'c1'], ['m', expected[0]!, 'c', 'c1'], ['m', expected[1]!, 'c', 'c2'], ['m', expected[2]!, 'c', 'c1'],
    ]);

    await khanh.connect();
    const ack = await khanh.hello();
    expect(ack.slow_path).toBeUndefined();
    await until(() => delivers(khanh).length === 4, 3000, 'three replayed delivers');
    await until(() => phase('B1') === 'live', 3000, 'Khanh live after the drain');
    expect(ids(khanh)).toEqual([primed, ...expected]);
    expect(khanh.duplicatesDropped).toBe(0);
    expect(rows('queue')).toContain(`XRANGE sq:B1 (${cursor} + → 3 entries, join bodies from the store`);
    await until(() => khanh.cursor === streamIdOf(expected[2]!), 3000, 'cursor at the last replayed id');

    const live = await send(truc, 'c1', 'Live again');
    await until(() => delivers(khanh).length === 5, 3000, 'live deliver at Khanh');
    expect(rows('push')).toContain(`#${live} → Khanh·phone over the socket`);
    await until(() => khanh.cursor === streamIdOf(live), 3000, 'cursor at the live id');
    khanhCursor = khanh.cursor!;
    khanh.closeCleanly();
    await gone('B1');
  });

  test('race, first form: a message sent while Khanh is in replay waiting on an ack arrives exactly once, by the replay', async () => {
    const m1 = await send(truc, 'c1', 'Away 1');
    const m2 = await send(truc, 'c2', 'Away 2');
    // Acks by hand: the replay delivers [m1, m2] and waits for the ack of m2.
    const khanh = client(DEVICES.khanhPhone, { autoAck: false });
    khanh.cursor = khanhCursor;
    await khanh.connect();
    await khanh.hello();
    await until(() => delivers(khanh).length === 2, 3000, 'first batch at Khanh');
    expect(phase('B1')).toBe('replay');

    // `msg_ack` precedes the queue append and the push (write order), so wait for the fan-out itself.
    let pushedDuringReplay: DeviceId[] | undefined;
    const off = server.ctx.events.on('message_fanout', ({ pushed }) => { pushedDuringReplay = pushed; });
    const m3 = await send(truc, 'c1', 'Sent during the replay');
    await until(() => pushedDuringReplay !== undefined, 3000, 'fan-out of m3');
    off();
    expect(pushedDuringReplay).toEqual([]);
    expect(rows('push')).not.toContain(`#${m3} → Khanh·phone over the socket`);
    expect(ids(khanh)).toEqual([m1, m2]);

    khanh.ack(streamIdOf(m2));
    await until(() => delivers(khanh).length === 3, 3000, 'm3 replayed in the next batch');
    expect(phase('B1')).toBe('replay');
    expect(rows('queue')).toContain(`XRANGE sq:B1 (${streamIdOf(m2)} + → 1 entries, join bodies from the store`);
    khanh.ack(streamIdOf(m3));
    await until(() => phase('B1') === 'live', 3000, 'Khanh live');
    expect(ids(khanh)).toEqual([m1, m2, m3]);
    expect(khanh.duplicatesDropped).toBe(0);
    expect(rows('push')).not.toContain(`#${m3} → Khanh·phone over the socket`);
    khanhCursor = streamIdOf(m3);
    khanh.closeCleanly();
    await gone('B1');
  });

  let skipped: MessageId;

  test.fails('race, second form: a message whose XADD lands after the replay\'s last empty XRANGE and whose fan-out runs before the flip to live is neither replayed nor pushed (empty-XRANGE reply held to model its latency)', async () => {
    let release!: () => void;
    holdEmptyXrange = new Promise<void>((resolve) => { release = resolve; });
    try {
      const khanh = client(DEVICES.khanhPhone);
      khanh.cursor = khanhCursor;
      await khanh.connect();
      await khanh.hello();
      expect(phase('B1')).toBe('replay');
      // The replay's XRANGE has run in Redis (empty) and its reply is in flight. Now a message.
      await sleep(50);
      let pushed: DeviceId[] | undefined;
      const off = server.ctx.events.on('message_fanout', (e) => { pushed = e.pushed; });
      skipped = await send(truc, 'c1', 'Sent in the empty-XRANGE window');
      await until(() => pushed !== undefined, 3000, 'fan-out of the message');
      off();
      expect(pushed).toEqual([]); // phase is still `replay`, so the push path left it to the queue
      release();
      holdEmptyXrange = null;
      await until(() => phase('B1') === 'live', 3000, 'Khanh live');
      await sleep(300);
      expect(ids(khanh)).toContain(skipped); // fails: the replay returned empty and the push skipped it
    } finally {
      release();
      holdEmptyXrange = null;
    }
  });

  test('the message skipped in that window is still in sq:B1 and arrives on the next reconnect: late, not lost', async () => {
    const stored = await ports.syncQueue.xrange('B1', khanhCursor, 100);
    expect(stored.map((e) => e.m)).toEqual([skipped]);
    const khanh = client(DEVICES.khanhPhone);
    khanh.cursor = khanhCursor;
    await khanh.connect();
    await khanh.hello();
    await until(() => delivers(khanh).length === 1, 3000, 'the skipped message replayed');
    expect(ids(khanh)).toEqual([skipped]);
    await until(() => phase('B1') === 'live', 3000, 'Khanh live');
    await until(() => khanh.cursor === streamIdOf(skipped), 3000, 'cursor at the skipped id');
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
