/**
 * Shared by every test under test/redis: the skip rule and per-file key isolation.
 *
 * Without `REDIS_URL` the whole file is skipped (`describe.skipIf`), so `npm test` stays
 * green on a machine without Redis; `npm run redis:up && npm run test:redis` runs them.
 * Each file owns one random prefix and deletes only its own keys afterwards.
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createRedisClient, flushPrefix } from '../../src/redis/client.js';

export const REDIS_URL = process.env['REDIS_URL'];
export const redisAvailable = REDIS_URL !== undefined;

export function explainSkip(file: string): void {
  if (!redisAvailable) process.stderr.write(`${file}: skipped, REDIS_URL is not set (npm run redis:up && npm run test:redis)\n`);
}

/** `test-<8 hex>:` — unique per test file, so files run in parallel against one Redis. */
export function testPrefix(): string {
  return `test-${randomBytes(4).toString('hex')}:`;
}

export interface RedisFixture {
  redis: Redis;
  prefix: string;
  /** Deletes every key of this fixture's prefix and closes the client. */
  close(): Promise<void>;
}

export async function openRedis(): Promise<RedisFixture> {
  const redis = createRedisClient(REDIS_URL ? { url: REDIS_URL } : {});
  await redis.ping();
  const prefix = testPrefix();
  return {
    redis,
    prefix,
    async close() {
      await flushPrefix(redis, prefix);
      await redis.quit();
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
