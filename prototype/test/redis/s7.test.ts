/**
 * B10 · scenario S7 over real Redis: the sync queue, route table and presence store are the
 * Redis adapters, the server and the clients run on real timers (the scaled numbers), and
 * the stream ids are Redis-assigned (`XADD … *`), so the append order and the entry ids the
 * frames carry are Redis's. Skipped without REDIS_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRedisPorts, type RedisPorts } from '../../src/redis/index.js';
import { flushPrefix } from '../../src/redis/client.js';
import { runScenario } from '../scenarios/scenario.js';
import { s7 } from '../scenarios/s7-replay-mode-boundary.js';
import { explainSkip, REDIS_URL, redisAvailable, testPrefix } from './support.js';

explainSkip('test/redis/s7.test.ts');

describe.skipIf(!redisAvailable)('S7 over real Redis (replay-mode boundary with Redis-assigned stream ids)', () => {
  const prefix = testPrefix();
  let ports: RedisPorts;

  beforeAll(() => {
    ports = createRedisPorts({ url: REDIS_URL!, prefix });
  });
  afterAll(async () => {
    await flushPrefix(ports.redis, prefix);
    await ports.close();
  });

  test('S7 passes on real timers with the Redis ports; the stream ids on the wire are Redis-assigned', { timeout: 60_000 }, async () => {
    const r = await runScenario(s7, {
      realTime: true,
      server: { ports: { syncQueue: ports.syncQueue, routes: ports.routes, presence: ports.presence } },
    });
    if (!r.ok) {
      console.log(`\n${r.id} · ${r.title} (real timers, Redis) FAILED: ${r.error}`);
      for (const line of r.trace) console.log(`${r.id}  ${line}`);
    }
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.realTime).toBe(true);
    // Redis minted the ids the frames carried: `<unix ms>-<seq>` with a 13-digit millisecond part.
    const sids = r.trace.filter((l) => / deliver +← Khanh·phone: /.test(l)).map((l) => /sid=(\d+-\d+)/.exec(l)?.[1]).filter((s): s is string => s !== undefined);
    expect(sids.length).toBeGreaterThan(0);
    expect(sids.every((s) => /^\d{13}-\d+$/.test(s))).toBe(true);
    const raw = await ports.redis.xrange(ports.syncQueue.keyOf('B1'), '-', '+');
    expect(raw.length).toBeGreaterThanOrEqual(150);
  });
});
