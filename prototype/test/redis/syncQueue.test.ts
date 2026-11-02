/**
 * B9 · the B0 SyncQueue contract against Redis Streams, plus the Redis-only facts the
 * in-memory adapter could not show. Skipped without REDIS_URL (see support.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisSyncQueue } from '../../src/redis/RedisSyncQueue.js';
import { streamIdOf } from '../../src/ports/index.js';
import { describeSyncQueueContract } from '../ports/contracts/syncQueue.contract.js';
import { explainSkip, openRedis, redisAvailable, testPrefix, type RedisFixture } from './support.js';

explainSkip('test/redis/syncQueue.test.ts');

describe.skipIf(!redisAvailable)('RedisSyncQueue', () => {
  let f: RedisFixture;
  beforeAll(async () => {
    f = await openRedis();
  });
  afterAll(async () => {
    await f.close();
  });

  // Every contract case gets a fresh stream prefix, so the cases cannot see each other's keys.
  const make = (opts: { maxLen?: number } = {}): RedisSyncQueue =>
    new RedisSyncQueue(f.redis, { prefix: `${f.prefix}${testPrefix()}`, ...opts });

  describeSyncQueueContract('RedisSyncQueue', make, {
    failing: {
      'xadd orders by id even when appended out of order':
        'Redis refuses XADD with an id at or below the top entry (ERR The ID specified in XADD is equal or smaller than the target stream top item); the in-memory adapter sorts on insert',
      'MAXLEN evicts the oldest entries':
        'MAXLEN ~ (the design\'s spelling) trims whole radix-tree nodes only, so three entries under a cap of 2 are all kept; the in-memory adapter caps exactly',
    },
  });

  describe('facts only a real Redis shows', () => {
    const e = (m: string, c = 'c1') => ({ id: streamIdOf(m), m, c });

    test('the commands are the three of design §4.2: XADD lands as <snowflake>-0 with fields m and c', async () => {
      const q = make();
      await q.xadd('A1', { id: '123456789012345678-0', m: '123456789012345678', c: 'c2' });
      const raw = await f.redis.xrange(q.keyOf('A1'), '-', '+');
      expect(raw).toEqual([['123456789012345678-0', ['m', '123456789012345678', 'c', 'c2']]]);
    });

    test('an XADD below the top id surfaces the Redis error with the key, instead of silently reordering', async () => {
      const q = make();
      await q.xadd('A1', e('102'));
      await expect(q.xadd('A1', e('101'))).rejects.toThrow(/XADD .*sq:A1 101-0: ERR The ID specified in XADD is equal or smaller than the target stream top item/);
      expect((await q.xrange('A1', null, 10)).map((x) => x.m)).toEqual(['102']);
    });

    test('an XADD of an id that is already in the stream is the idempotent retry of design §4.2, not an error', async () => {
      const q = make();
      await q.xadd('A1', e('101'));
      await q.xadd('A1', e('102'));
      await expect(q.xadd('A1', e('101'))).resolves.toBe(streamIdOf('101'));
      expect((await q.xrange('A1', null, 10)).map((x) => x.m)).toEqual(['101', '102']);
    });

    test('MAXLEN ~ is a floor: nothing is evicted until a radix node fills, then at least maxLen entries stay', async () => {
      const q = make({ maxLen: 10 });
      for (let i = 1; i <= 250; i += 1) await q.xadd('A1', e(String(1000 + i)));
      const len = await f.redis.xlen(q.keyOf('A1'));
      expect(len).toBeGreaterThanOrEqual(10);
      expect(len).toBeLessThan(250);
      const first = await q.first('A1');
      expect(first).not.toBeNull();
      expect(BigInt(first!.split('-')[0]!)).toBeGreaterThan(1001n);
    });

    test('xtrim MINID returns the number of entries Redis dropped', async () => {
      const q = make();
      for (const m of ['101', '102', '103', '104']) await q.xadd('A1', e(m));
      expect(await q.xtrim('A1', streamIdOf('103'))).toBe(2);
      expect(await q.xtrim('A1', streamIdOf('103'))).toBe(0);
      expect(await q.first('A1')).toBe(streamIdOf('103'));
    });
  });
});
