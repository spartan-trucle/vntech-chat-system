/**
 * B9 · Redis behind the ports. Replaces exactly the three in-memory adapters the design
 * puts in Redis (sync queue §4.2, route table §1.5, presence lease §1.5/§5.3) and the
 * presence bus (§5.3). The message store, summaries, conversations, cursors and devices
 * stay in memory by decision (runtime ADR; no Cassandra in the prototype).
 *
 *   const redis = createRedisPorts({ url, prefix });
 *   createChatServer({ ports: redis, moduleOptions: { presence: { bus: new RedisPresenceBus(redis.redis, { prefix }) } } });
 */

import type { Redis } from 'ioredis';
import { createRedisClient, type RedisClientOptions } from './client.js';
import { RedisPresenceStore } from './RedisPresenceStore.js';
import { RedisRouteTable } from './RedisRouteTable.js';
import { RedisSyncQueue } from './RedisSyncQueue.js';

export { createRedisClient, DEFAULT_REDIS_URL, flushPrefix, keyOf, redisUrl } from './client.js';
export { RedisSyncQueue, type RedisSyncQueueOptions } from './RedisSyncQueue.js';
export { RedisRouteTable, type RedisRouteTableOptions } from './RedisRouteTable.js';
export { RedisPresenceStore, type RedisPresenceStoreOptions } from './RedisPresenceStore.js';
export { RedisPresenceBus, type RedisPresenceBusOptions } from './RedisPresenceBus.js';

export interface RedisPortsOptions extends RedisClientOptions {
  /** Key prefix for every adapter (tests isolate themselves with `test-<random>:`). */
  prefix?: string;
  /** `MAXLEN ~` cap per stream (design §4.5). */
  maxLen?: number;
  /** `xadd` timeout before the retry path (design §4.2). */
  xaddTimeoutMs?: number;
}

export interface RedisPorts {
  syncQueue: RedisSyncQueue;
  routes: RedisRouteTable;
  presence: RedisPresenceStore;
  /** The shared client; a `RedisPresenceBus` duplicates it for its subscriber connection. */
  redis: Redis;
  close(): Promise<void>;
}

export function createRedisPorts(opts: RedisPortsOptions = {}): RedisPorts {
  const redis = createRedisClient(opts.url === undefined ? {} : { url: opts.url });
  const prefixOpt = opts.prefix === undefined ? {} : { prefix: opts.prefix };
  return {
    syncQueue: new RedisSyncQueue(redis, {
      ...prefixOpt,
      ...(opts.maxLen === undefined ? {} : { maxLen: opts.maxLen }),
      ...(opts.xaddTimeoutMs === undefined ? {} : { xaddTimeoutMs: opts.xaddTimeoutMs }),
    }),
    routes: new RedisRouteTable(redis, prefixOpt),
    presence: new RedisPresenceStore(redis, prefixOpt),
    redis,
    async close() {
      await redis.quit();
    },
  };
}
