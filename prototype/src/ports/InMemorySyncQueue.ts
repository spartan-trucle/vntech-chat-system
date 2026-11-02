import type { DeviceId, StreamId } from '../protocol.js';
import { compareStreamIds, XaddTimeout, type StreamEntry, type StreamEntryBody, type SyncQueue } from './SyncQueue.js';

export interface InMemorySyncQueueOptions {
  /** `MAXLEN ~` cap per stream (design §4.5). */
  maxLen?: number;
  /** `xadd` rejects with `XaddTimeout` when it has not answered within this many ms (default 5 s). */
  xaddTimeoutMs?: number;
  /** Clock the ids are minted from (`<ms>-<seq>`); the server passes its own so fake time works. */
  now?: () => number;
}

/** Fault hooks, so a test can force the retry path of design §4.2. */
export interface InMemorySyncQueueFaults {
  /** Every `xadd` lands at once but answers only after this many ms (0 = at once). */
  xaddDelayMs: number;
  /** The next `xadd` is lost: it answers with a timeout and nothing lands. */
  loseNextXadd: boolean;
}

export class InMemorySyncQueue implements SyncQueue {
  readonly faults: InMemorySyncQueueFaults = { xaddDelayMs: 0, loseNextXadd: false };
  private readonly streams = new Map<DeviceId, StreamEntry[]>();
  private readonly maxLen: number;
  private readonly xaddTimeoutMs: number;
  private readonly now: () => number;
  /** Last id minted per stream, so ids stay increasing when the clock does not move (or moves back). */
  private readonly lastId = new Map<DeviceId, { ms: number; seq: number }>();

  constructor(opts: InMemorySyncQueueOptions = {}) {
    this.maxLen = opts.maxLen ?? 100_000;
    this.xaddTimeoutMs = opts.xaddTimeoutMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  async xadd(device_id: DeviceId, entry: StreamEntryBody): Promise<StreamId> {
    if (this.faults.loseNextXadd) {
      this.faults.loseNextXadd = false;
      await sleep(this.xaddTimeoutMs);
      throw new XaddTimeout(device_id, this.xaddTimeoutMs);
    }
    const id = this.append(device_id, entry);
    if (this.faults.xaddDelayMs > 0) {
      if (this.faults.xaddDelayMs > this.xaddTimeoutMs) {
        await sleep(this.xaddTimeoutMs);
        throw new XaddTimeout(device_id, this.xaddTimeoutMs);
      }
      await sleep(this.faults.xaddDelayMs);
    }
    return id;
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

  async xrevrange(device_id: DeviceId, count: number): Promise<StreamEntry[]> {
    const s = this.streams.get(device_id) ?? [];
    const out: StreamEntry[] = [];
    for (let i = s.length - 1; i >= 0 && out.length < count; i -= 1) out.push({ ...s[i]! });
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

  /** `XADD … *`: an id from the clock, `<ms>-<seq>`, strictly greater than the stream's last. */
  private append(device_id: DeviceId, entry: StreamEntryBody): StreamId {
    let s = this.streams.get(device_id);
    if (!s) {
      s = [];
      this.streams.set(device_id, s);
    }
    const ms = Math.max(0, Math.floor(this.now()));
    const last = this.lastId.get(device_id);
    const next = last && ms <= last.ms ? { ms: last.ms, seq: last.seq + 1 } : { ms, seq: 0 };
    this.lastId.set(device_id, next);
    const id = `${next.ms}-${next.seq}`;
    s.push({ id, m: entry.m, c: entry.c });
    if (s.length > this.maxLen) s.splice(0, s.length - this.maxLen);
    return id;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
