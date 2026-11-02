/**
 * B9 · the presence lease of design §1.5 / §5.3 on Redis: `presence:{user}` holds the
 * record as JSON and `SET … PX <ttlMs>` is the lease. Expiry is Redis's own clock, so
 * `get` after the TTL is a plain miss; nothing is computed on this side.
 */

import type { Redis } from 'ioredis';
import type { PresenceRecord, PresenceStore } from '../ports/PresenceStore.js';
import type { UserId } from '../protocol.js';
import { keyOf } from './client.js';

export interface RedisPresenceStoreOptions {
  prefix?: string;
}

export class RedisPresenceStore implements PresenceStore {
  private readonly redis: Redis;
  private readonly prefix: string | undefined;
  /** Instrumentation, as on the in-memory store: design §1.5 says the heartbeat path never writes here. */
  public writes = 0;

  constructor(redis: Redis, opts: RedisPresenceStoreOptions = {}) {
    this.redis = redis;
    this.prefix = opts.prefix;
  }

  keyOf(user_id: UserId): string {
    return keyOf(this.prefix, `presence:${user_id}`);
  }

  async set(user_id: UserId, record: PresenceRecord, ttlMs: number): Promise<void> {
    this.writes += 1;
    const value: PresenceRecord = record.last_seen === undefined ? { state: record.state } : { state: record.state, last_seen: record.last_seen };
    await this.redis.set(this.keyOf(user_id), JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlMs)));
  }

  async get(user_id: UserId): Promise<PresenceRecord | undefined> {
    const raw = await this.redis.get(this.keyOf(user_id));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as PresenceRecord;
    return parsed.last_seen === undefined ? { state: parsed.state } : { state: parsed.state, last_seen: parsed.last_seen };
  }
}
