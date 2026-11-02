/**
 * B9 · the B0 SyncQueue contract against Redis Streams, plus the Redis-only facts the
 * in-memory adapter could not show. Skipped without REDIS_URL (see support.ts).
 *
 * B10 (live-first ADR): stream ids are Redis-assigned (`XADD … *`) and the message id lives
 * in the entry body, so the B9 "append below the top id" failure no longer exists: appends
 * to one stream need no ordering. `MAXLEN ~` being a floor is still a fact and still named.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisSyncQueue } from '../../src/redis/RedisSyncQueue.js';
import { XaddTimeout } from '../../src/ports/index.js';
import { describeSyncQueueContract, type SyncQueueFactoryOptions } from '../ports/contracts/syncQueue.contract.js';
import { explainSkip, openRedis, redisAvailable, sleep, testPrefix, type RedisFixture } from './support.js';

explainSkip('test/redis/syncQueue.test.ts');

describe.skipIf(!redisAvailable)('RedisSyncQueue', () => {
  let f: RedisFixture;
  beforeAll(async () => {
    f = await openRedis();
  });
  afterAll(async () => {
    await f.close();
  });

  /** A client whose XADD lands at once but answers late: a slow Redis or a lost reply, as the appender sees it. */
  const slowXadd = (redis: Redis, delayMs: number): Redis =>
    new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop !== 'xadd') return Reflect.get(target, prop, receiver) as unknown;
        return async (...args: unknown[]) => {
          const out = await (target.xadd as unknown as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          await sleep(delayMs);
          return out;
        };
      },
    });

  // Every contract case gets a fresh stream prefix, so the cases cannot see each other's keys.
  const make = (opts: SyncQueueFactoryOptions = {}): RedisSyncQueue => {
    const client = opts.xaddDelayMs === undefined ? f.redis : slowXadd(f.redis, opts.xaddDelayMs);
    return new RedisSyncQueue(client, {
      prefix: `${f.prefix}${testPrefix()}`,
      ...(opts.maxLen === undefined ? {} : { maxLen: opts.maxLen }),
      ...(opts.xaddTimeoutMs === undefined ? {} : { xaddTimeoutMs: opts.xaddTimeoutMs }),
    });
  };

  describeSyncQueueContract('RedisSyncQueue', make, {
    failing: {
      'MAXLEN evicts the oldest entries':
        'MAXLEN ~ (the design\'s spelling) trims whole radix-tree nodes only, so three entries under a cap of 2 are all kept; the in-memory adapter caps exactly',
    },
  });

  describe('facts only a real Redis shows', () => {
    const e = (m: string, c = 'c1') => ({ m, c });

    test('the commands are those of design §4.2: XADD * lands with a Redis-assigned <ms>-<seq> id and the fields m and c', async () => {
      const q = make();
      const id = await q.xadd('A1', { m: '123456789012345678', c: 'c2' });
      expect(id).toMatch(/^\d{13}-\d+$/);
      const raw = await f.redis.xrange(q.keyOf('A1'), '-', '+');
      expect(raw).toEqual([[id, ['m', '123456789012345678', 'c', 'c2']]]);
    });

    test('two appends whose message ids are out of order both land, in append order: no ordering invariant on the fan-out (B9 row 16 closed)', async () => {
      const q = make();
      const a = await q.xadd('A1', e('102'));
      const b = await q.xadd('A1', e('101'));
      expect(BigInt(a.replace('-', '')) < BigInt(b.replace('-', ''))).toBe(true);
      expect((await q.xrange('A1', null, 10)).map((x) => x.m)).toEqual(['102', '101']);
    });

    test('a timed-out XADD has landed: XREVRANGE shows the message id, so the appender skips the retry (design §4.2 retry path)', async () => {
      const q = make({ xaddTimeoutMs: 20, xaddDelayMs: 80 });
      await expect(q.xadd('A1', e('101'))).rejects.toBeInstanceOf(XaddTimeout);
      const tail = await q.xrevrange('A1', 100);
      expect(tail.map((x) => x.m)).toEqual(['101']);
      expect(await f.redis.xlen(q.keyOf('A1'))).toBe(1);
    });

    test('MAXLEN ~ is a floor: nothing is evicted until a radix node fills, then at least maxLen entries stay', async () => {
      const q = make({ maxLen: 10 });
      for (let i = 1; i <= 250; i += 1) await q.xadd('A1', e(String(1000 + i)));
      const len = await f.redis.xlen(q.keyOf('A1'));
      expect(len).toBeGreaterThanOrEqual(10);
      expect(len).toBeLessThan(250);
      expect(await q.first('A1')).not.toBeNull();
    });

    test('xtrim MINID returns the number of entries Redis dropped', async () => {
      const q = make();
      const ids: string[] = [];
      for (const m of ['101', '102', '103', '104']) ids.push(await q.xadd('A1', e(m)));
      expect(await q.xtrim('A1', ids[2]!)).toBe(2);
      expect(await q.xtrim('A1', ids[2]!)).toBe(0);
      expect(await q.first('A1')).toBe(ids[2]);
    });
  });
});
