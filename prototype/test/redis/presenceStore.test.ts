/**
 * B9 · the B0 PresenceStore contract against Redis: `presence:{user}` with `SET … PX`.
 * The TTL runs on Redis's clock, so the fixture's `advance` really sleeps and the leases
 * are short (600 / 500 ms with 150 ms of slack); the assertions are the contract's.
 * Skipped without REDIS_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisPresenceStore } from '../../src/redis/RedisPresenceStore.js';
import { describePresenceStoreContract } from '../ports/contracts/presenceStore.contract.js';
import { explainSkip, openRedis, redisAvailable, sleep, testPrefix, type RedisFixture } from './support.js';

explainSkip('test/redis/presenceStore.test.ts');

describe.skipIf(!redisAvailable)('RedisPresenceStore', () => {
  let f: RedisFixture;
  beforeAll(async () => {
    f = await openRedis();
  });
  afterAll(async () => {
    await f.close();
  });

  const make = (): RedisPresenceStore => new RedisPresenceStore(f.redis, { prefix: `${f.prefix}${testPrefix()}` });

  describePresenceStoreContract('RedisPresenceStore', () => ({
    store: make(),
    advance: (ms) => sleep(ms),
    leases: { long: 600, short: 500, slack: 150 },
  }));

  describe('the key is the design\'s', () => {
    test('set writes presence:{user} as JSON with a PX TTL of the lease', async () => {
      const store = make();
      await store.set('truc', { state: 'offline', last_seen: 1234 }, 5 * 60_000);
      expect(JSON.parse((await f.redis.get(store.keyOf('truc')))!)).toEqual({ state: 'offline', last_seen: 1234 });
      const pttl = await f.redis.pttl(store.keyOf('truc'));
      expect(pttl).toBeGreaterThan(5 * 60_000 - 2000);
      expect(pttl).toBeLessThanOrEqual(5 * 60_000);
    });

    test('get returns undefined once Redis has expired the key on its own clock', async () => {
      const store = make();
      await store.set('truc', { state: 'online' }, 100);
      expect(await store.get('truc')).toEqual({ state: 'online' });
      await sleep(250);
      expect(await store.get('truc')).toBeUndefined();
      expect(await f.redis.exists(store.keyOf('truc'))).toBe(0);
    });
  });
});
