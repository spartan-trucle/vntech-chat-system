/**
 * B9 · the per-device sync queue of design §4.2 on real Redis Streams, one stream per
 * device, the three commands verbatim:
 *
 *   XADD   sq:{device} MAXLEN ~ <maxLen> <snowflake>-0 m <message_id> c <conversation_id>
 *   XRANGE sq:{device} (<cursor> + COUNT <n>          ('-' when there is no cursor)
 *   XTRIM  sq:{device} MINID <id>                      (returns the dropped count)
 *
 * plus `first` = `XRANGE sq:{device} - + COUNT 1` for the trim-boundary check.
 *
 * Two facts the in-memory adapter hid (test/redis/syncQueue.test.ts):
 * - Redis refuses an XADD whose id is at or below the stream's top entry. A retry of an id
 *   that is already in the stream is the idempotent case of §4.2 and returns normally; any
 *   other out-of-order append is surfaced with the key in the error, never reordered.
 * - `MAXLEN ~` trims whole radix-tree nodes: the cap is a floor, not an exact length.
 */

import type { Redis } from 'ioredis';
import type { StreamEntry, SyncQueue } from '../ports/SyncQueue.js';
import type { DeviceId, StreamId } from '../protocol.js';
import { keyOf } from './client.js';

export interface RedisSyncQueueOptions {
  prefix?: string;
  /** `MAXLEN ~` cap per stream (design §4.5: 100 000). */
  maxLen?: number;
}

const TOP_ID_ERROR = 'equal or smaller than the target stream top item';

export class RedisSyncQueue implements SyncQueue {
  private readonly redis: Redis;
  private readonly prefix: string | undefined;
  private readonly maxLen: number;

  constructor(redis: Redis, opts: RedisSyncQueueOptions = {}) {
    this.redis = redis;
    this.prefix = opts.prefix;
    this.maxLen = opts.maxLen ?? 100_000;
  }

  /** `sq:{device}` under the prefix. */
  keyOf(device_id: DeviceId): string {
    return keyOf(this.prefix, `sq:${device_id}`);
  }

  async xadd(device_id: DeviceId, entry: StreamEntry): Promise<StreamId> {
    const key = this.keyOf(device_id);
    try {
      await this.redis.xadd(key, 'MAXLEN', '~', this.maxLen, entry.id, 'm', entry.m, 'c', entry.c);
      return entry.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes(TOP_ID_ERROR)) throw e;
      // At or below the top: an idempotent retry if the id is already there, otherwise a real
      // out-of-order append that the caller must know about (the stream would lie by omission).
      const present = await this.redis.xrange(key, entry.id, entry.id, 'COUNT', 1);
      if (present.length > 0) return entry.id;
      throw new Error(`XADD ${key} ${entry.id}: ${message}`, { cause: e });
    }
  }

  async xrange(device_id: DeviceId, after: StreamId | null, count: number): Promise<StreamEntry[]> {
    const start = after === null ? '-' : `(${after}`;
    const raw = await this.redis.xrange(this.keyOf(device_id), start, '+', 'COUNT', count);
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
