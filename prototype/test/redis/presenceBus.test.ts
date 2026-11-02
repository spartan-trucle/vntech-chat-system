/**
 * B9 · the B6 PresenceBus contract against Redis pub/sub: `PUBLISH pres:{user}` on the
 * shared client, `SUBSCRIBE`/`UNSUBSCRIBE` on a dedicated subscriber connection. Delivery
 * is asynchronous, so the contract's `settle` waits for every published event to come
 * back before asserting. Skipped without REDIS_URL.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { PresenceEvent } from '../../src/presence/PresenceBus.js';
import { RedisPresenceBus } from '../../src/redis/RedisPresenceBus.js';
import { describePresenceBusContract } from '../presence/contracts/presenceBus.contract.js';
import { explainSkip, openRedis, redisAvailable, sleep, testPrefix, type RedisFixture } from './support.js';

explainSkip('test/redis/presenceBus.test.ts');

describe.skipIf(!redisAvailable)('RedisPresenceBus', () => {
  let f: RedisFixture;
  const open: RedisPresenceBus[] = [];
  beforeAll(async () => {
    f = await openRedis();
  });
  afterEach(async () => {
    for (const bus of open.splice(0)) await bus.close();
  });
  afterAll(async () => {
    await f.close();
  });

  const make = (prefix = `${f.prefix}${testPrefix()}`): RedisPresenceBus => {
    const bus = new RedisPresenceBus(f.redis, { prefix });
    open.push(bus);
    return bus;
  };

  describePresenceBusContract('RedisPresenceBus', () => make(), { settle: (bus) => (bus as RedisPresenceBus).settled() });

  describe('what the in-memory bus could not show', () => {
    test('the channel is pres:{user}: a raw subscriber on another connection sees the event as JSON', async () => {
      const bus = make();
      const raw = f.redis.duplicate();
      const got: Array<[string, string]> = [];
      raw.on('message', (channel, message) => { got.push([channel, message]); });
      await raw.subscribe(bus.channelOf('truc'));
      await bus.publish('truc', { user_id: 'truc', state: 'offline', last_seen: 1234 });
      const deadline = Date.now() + 2000;
      while (got.length === 0 && Date.now() < deadline) await sleep(5);
      await raw.quit();
      expect(got).toHaveLength(1);
      expect(got[0]![0]).toBe(bus.channelOf('truc'));
      expect(JSON.parse(got[0]![1]).event).toEqual({ user_id: 'truc', state: 'offline', last_seen: 1234 });
    });

    test('two bus instances (two servers) on the same prefix both hear a publish from either', async () => {
      const prefix = `${f.prefix}${testPrefix()}`;
      const a = make(prefix);
      const b = make(prefix);
      const atA: PresenceEvent[] = [];
      const atB: PresenceEvent[] = [];
      a.subscribe('truc', (e) => { atA.push(e); });
      b.subscribe('truc', (e) => { atB.push(e); });
      await b.ready();
      await a.publish('truc', { user_id: 'truc', state: 'online' });
      const deadline = Date.now() + 2000;
      while ((atA.length === 0 || atB.length === 0) && Date.now() < deadline) await sleep(5);
      expect(atA).toEqual([{ user_id: 'truc', state: 'online' }]);
      expect(atB).toEqual([{ user_id: 'truc', state: 'online' }]);
    });

    test('the last off() of a user UNSUBSCRIBEs the channel; the first subscribe SUBSCRIBEs it', async () => {
      const bus = make();
      const off1 = bus.subscribe('truc', () => {});
      const off2 = bus.subscribe('truc', () => {});
      await bus.ready();
      expect(await bus.subscribedChannels()).toEqual([bus.channelOf('truc')]);
      off1();
      await bus.ready();
      expect(await bus.subscribedChannels()).toEqual([bus.channelOf('truc')]);
      off2();
      await bus.ready();
      expect(await bus.subscribedChannels()).toEqual([]);
    });

    test('a publish issued right after subscribe (no await between them) still reaches the handler', async () => {
      const bus = make();
      const got: PresenceEvent[] = [];
      bus.subscribe('truc', (e) => { got.push(e); });
      await bus.publish('truc', { user_id: 'truc', state: 'online' });
      await bus.settled();
      expect(got).toEqual([{ user_id: 'truc', state: 'online' }]);
    });
  });
});
