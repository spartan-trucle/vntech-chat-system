/**
 * B9 · one ioredis client for the Redis adapters.
 *
 * Keys are prefixed by the adapters themselves (`keyOf(prefix, 'sq:B1')`), not by
 * ioredis's `keyPrefix`: the pub/sub channel names and the SCAN-based cleanup below
 * need the same prefix, and one explicit helper is easier to read than a driver option
 * that applies to some arguments and not others.
 */

import { Redis } from 'ioredis';

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6399';

export interface RedisClientOptions {
  /** `redis://host:port`; falls back to `REDIS_URL`, then the compose port 6399. */
  url?: string;
}

export function redisUrl(opts: RedisClientOptions = {}): string {
  return opts.url ?? process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL;
}

export function createRedisClient(opts: RedisClientOptions = {}): Redis {
  return new Redis(redisUrl(opts), { maxRetriesPerRequest: 3, lazyConnect: false });
}

/** `prefix + name`; an empty or missing prefix is the plain design key. */
export function keyOf(prefix: string | undefined, name: string): string {
  return `${prefix ?? ''}${name}`;
}

/**
 * Deletes every key under `prefix` (SCAN MATCH + UNLINK). A test owns one random prefix
 * and calls this in `afterAll`; nothing outside the prefix is touched, and a prefix that
 * is empty is refused so a mistake never flushes the whole database.
 */
export async function flushPrefix(redis: Redis, prefix: string): Promise<number> {
  if (prefix.length === 0) throw new Error('flushPrefix: refusing to delete every key (empty prefix)');
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}
