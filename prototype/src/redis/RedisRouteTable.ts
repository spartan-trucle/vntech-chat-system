/**
 * B9 · the routing table of design §1.5 on Redis:
 *
 *   route:{user}:{device} → server_id        SET / GET / DEL
 *   routes:{user}         → {device, …}      SADD / SREM / SMEMBERS, the set behind `SCARD`
 *
 * `set` and `delete` touch both keys in one MULTI, so the set never names a device whose
 * route row is missing (or the reverse) between the two writes.
 */

import type { Redis } from 'ioredis';
import type { RouteTable } from '../ports/RouteTable.js';
import type { DeviceId, UserId } from '../protocol.js';
import { keyOf } from './client.js';

export interface RedisRouteTableOptions {
  prefix?: string;
}

export class RedisRouteTable implements RouteTable {
  private readonly redis: Redis;
  private readonly prefix: string | undefined;

  constructor(redis: Redis, opts: RedisRouteTableOptions = {}) {
    this.redis = redis;
    this.prefix = opts.prefix;
  }

  routeKey(user_id: UserId, device_id: DeviceId): string {
    return keyOf(this.prefix, `route:${user_id}:${device_id}`);
  }

  devicesKey(user_id: UserId): string {
    return keyOf(this.prefix, `routes:${user_id}`);
  }

  async set(user_id: UserId, device_id: DeviceId, server_id: string): Promise<void> {
    await this.redis.multi()
      .set(this.routeKey(user_id, device_id), server_id)
      .sadd(this.devicesKey(user_id), device_id)
      .exec();
  }

  async get(user_id: UserId, device_id: DeviceId): Promise<string | undefined> {
    return (await this.redis.get(this.routeKey(user_id, device_id))) ?? undefined;
  }

  async delete(user_id: UserId, device_id: DeviceId): Promise<boolean> {
    const replies = await this.redis.multi()
      .del(this.routeKey(user_id, device_id))
      .srem(this.devicesKey(user_id), device_id)
      .exec();
    const [, deleted] = replies?.[0] ?? [null, 0];
    return deleted === 1;
  }

  async devicesOf(user_id: UserId): Promise<DeviceId[]> {
    return this.redis.smembers(this.devicesKey(user_id));
  }
}
