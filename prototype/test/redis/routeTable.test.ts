/**
 * B9 · the B0 RouteTable contract against Redis: `route:{user}:{device}` strings and the
 * `routes:{user}` set behind `SCARD` of design §1.5. Skipped without REDIS_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisRouteTable } from '../../src/redis/RedisRouteTable.js';
import { describeRouteTableContract } from '../ports/contracts/routeTable.contract.js';
import { explainSkip, openRedis, redisAvailable, testPrefix, type RedisFixture } from './support.js';

explainSkip('test/redis/routeTable.test.ts');

describe.skipIf(!redisAvailable)('RedisRouteTable', () => {
  let f: RedisFixture;
  beforeAll(async () => {
    f = await openRedis();
  });
  afterAll(async () => {
    await f.close();
  });

  const make = (): RedisRouteTable => new RedisRouteTable(f.redis, { prefix: `${f.prefix}${testPrefix()}` });

  describeRouteTableContract('RedisRouteTable', make);

  describe('the keys are the design\'s', () => {
    test('set writes route:{user}:{device} → server_id and adds the device to routes:{user}; delete removes both', async () => {
      const r = make();
      await r.set('truc', 'A1', 'srv-1');
      await r.set('truc', 'A2', 'srv-2');
      expect(await f.redis.get(r.routeKey('truc', 'A1'))).toBe('srv-1');
      expect(await f.redis.scard(r.devicesKey('truc'))).toBe(2);
      await r.delete('truc', 'A1');
      expect(await f.redis.exists(r.routeKey('truc', 'A1'))).toBe(0);
      expect(await f.redis.smembers(r.devicesKey('truc'))).toEqual(['A2']);
      await r.delete('truc', 'A2');
      expect(await f.redis.exists(r.devicesKey('truc'))).toBe(0);
    });

    test('set on an existing route overwrites the server without duplicating the device in the set', async () => {
      const r = make();
      await r.set('truc', 'A1', 'srv-1');
      await r.set('truc', 'A1', 'srv-2');
      expect(await r.get('truc', 'A1')).toBe('srv-2');
      expect(await r.devicesOf('truc')).toEqual(['A1']);
    });
  });
});
