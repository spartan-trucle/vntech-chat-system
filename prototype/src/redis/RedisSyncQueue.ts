/**
 * B9 · the per-device sync queue of design §4.2 on real Redis Streams, one stream per
 * device, the commands verbatim (B10: `XADD … *`, live-first ADR):
 *
 *   XADD      sq:{device} MAXLEN ~ <maxLen> * m <message_id> c <conversation_id>
 *   XRANGE    sq:{device} (<cursor> + COUNT <n>          ('-' when there is no cursor)
 *   XREVRANGE sq:{device} + - COUNT <n>                   (the retry path's tail read)
 *   XTRIM     sq:{device} MINID <id>                      (returns the dropped count)
 *
 * plus `first` = `XRANGE sq:{device} - + COUNT 1` for the trim-boundary check.
 *
 * Redis assigns the entry id, so two appends to one stream need no ordering: the B9 fact
 * "an XADD at or below the top id is refused" no longer applies to the fan-out. What is
 * still a fact (test/redis/syncQueue.test.ts): `MAXLEN ~` trims whole radix-tree nodes, so
 * the cap is a floor, not an exact length.
 */

import type { Redis } from 'ioredis';
import { XaddTimeout, type StreamEntry, type StreamEntryBody, type SyncQueue } from '../ports/SyncQueue.js';
import type { DeviceId, StreamId } from '../protocol.js';
import { keyOf } from './client.js';

export interface RedisSyncQueueOptions {
  prefix?: string;
  /** `MAXLEN ~` cap per stream (design §4.5: 100 000). */
  maxLen?: number;
  /** `xadd` rejects with `XaddTimeout` when Redis has not answered within this many ms (default 5 s). */
  xaddTimeoutMs?: number;
}

export class RedisSyncQueue implements SyncQueue {
  private readonly redis: Redis;
  private readonly prefix: string | undefined;
  private readonly maxLen: number;
  private readonly xaddTimeoutMs: number;

  constructor(redis: Redis, opts: RedisSyncQueueOptions = {}) {
    this.redis = redis;
    this.prefix = opts.prefix;
    this.maxLen = opts.maxLen ?? 100_000;
    this.xaddTimeoutMs = opts.xaddTimeoutMs ?? 5000;
  }

  /** `sq:{device}` under the prefix. */
  keyOf(device_id: DeviceId): string {
    return keyOf(this.prefix, `sq:${device_id}`);
  }

  async xadd(device_id: DeviceId, entry: StreamEntryBody): Promise<StreamId> {
    const key = this.keyOf(device_id);
    const command = this.redis.xadd(key, 'MAXLEN', '~', this.maxLen, '*', 'm', entry.m, 'c', entry.c);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new XaddTimeout(device_id, this.xaddTimeoutMs)), this.xaddTimeoutMs);
    });
    try {
      const id = await Promise.race([command, timeout]);
      if (id === null) throw new Error(`XADD ${key}: no id returned`);
      return id;
    } finally {
      clearTimeout(timer);
      // The command still settles on its own; a late rejection must not be unhandled.
      command.catch(() => undefined);
    }
  }

  async xrange(device_id: DeviceId, after: StreamId | null, count: number): Promise<StreamEntry[]> {
    const start = after === null ? '-' : `(${after}`;
    const raw = await this.redis.xrange(this.keyOf(device_id), start, '+', 'COUNT', count);
    return raw.map(([id, fields]) => entryOf(id, fields));
  }

  async xrevrange(device_id: DeviceId, count: number): Promise<StreamEntry[]> {
    const raw = await this.redis.xrevrange(this.keyOf(device_id), '+', '-', 'COUNT', count);
    return raw.map(([id, fields]) => entryOf(id, fields));
  }

  async xtrim(device_id: DeviceId, minId: StreamId): Promise<number> {
    return this.redis.xtrim(this.keyOf(device_id), 'MINID', minId);
  }

  async first(device_id: DeviceId): Promise<StreamId | null> {
    const raw = await this.redis.xrange(this.keyOf(device_id), '-', '+', 'COUNT', 1);
    return raw[0]?.[0] ?? null;
  }
}

function entryOf(id: string, fields: string[]): StreamEntry {
  let m = '';
  let c = '';
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'm') m = fields[i + 1]!;
    else if (fields[i] === 'c') c = fields[i + 1]!;
  }
  return { id, m, c };
}
