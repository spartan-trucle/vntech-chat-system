import type { DeviceId, StreamId } from '../protocol.js';
import { compareStreamIds, type StreamEntry, type SyncQueue } from './SyncQueue.js';

export interface InMemorySyncQueueOptions {
  /** `MAXLEN ~` cap per stream (design §4.5). */
  maxLen?: number;
}

export class InMemorySyncQueue implements SyncQueue {
  private readonly streams = new Map<DeviceId, StreamEntry[]>();
  private readonly maxLen: number;

  constructor(opts: InMemorySyncQueueOptions = {}) {
    this.maxLen = opts.maxLen ?? 100_000;
  }

  async xadd(device_id: DeviceId, entry: StreamEntry): Promise<StreamId> {
    let s = this.streams.get(device_id);
    if (!s) {
      s = [];
      this.streams.set(device_id, s);
    }
    const copy = { id: entry.id, m: entry.m, c: entry.c };
    // Binary search for the insertion point; equal id → idempotent no-op.
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = compareStreamIds(s[mid]!.id, entry.id);
      if (c === 0) return entry.id;
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    s.splice(lo, 0, copy);
    if (s.length > this.maxLen) s.splice(0, s.length - this.maxLen);
    return entry.id;
  }

  async xrange(device_id: DeviceId, after: StreamId | null, count: number): Promise<StreamEntry[]> {
    const s = this.streams.get(device_id) ?? [];
    const out: StreamEntry[] = [];
    for (const e of s) {
      if (after !== null && compareStreamIds(e.id, after) <= 0) continue;
      out.push({ ...e });
      if (out.length >= count) break;
    }
    return out;
  }

  async xtrim(device_id: DeviceId, minId: StreamId): Promise<number> {
    const s = this.streams.get(device_id);
    if (!s) return 0;
    let n = 0;
    while (n < s.length && compareStreamIds(s[n]!.id, minId) < 0) n += 1;
    s.splice(0, n);
    return n;
  }

  async first(device_id: DeviceId): Promise<StreamId | null> {
    const s = this.streams.get(device_id);
    return s && s.length > 0 ? s[0]!.id : null;
  }
}
