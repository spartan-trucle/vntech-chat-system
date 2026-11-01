/**
 * Snowflake IDs (design §2.2): time-ordered 63-bit integers, carried on the wire as
 * decimal strings because JSON cannot hold a 64-bit integer.
 *
 * Layout, high to low: 41 bits milliseconds since SNOWFLAKE_EPOCH_MS, 10 bits worker,
 * 12 bits per-millisecond sequence.
 */

export type MessageId = string;

/** 2026-01-01T00:00:00Z. 41 bits of milliseconds last ~69 years from here. */
export const SNOWFLAKE_EPOCH_MS = Date.UTC(2026, 0, 1);

const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER = (1n << WORKER_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export interface SnowflakeOptions {
  worker: number;
  now?: () => number;
}

export class Snowflake {
  private readonly worker: bigint;
  private readonly now: () => number;
  private lastMs = -1n;
  private sequence = 0n;

  constructor(opts: SnowflakeOptions) {
    if (!Number.isInteger(opts.worker) || opts.worker < 0 || BigInt(opts.worker) > MAX_WORKER) {
      throw new RangeError(`worker must be an integer in [0, ${MAX_WORKER}]`);
    }
    this.worker = BigInt(opts.worker);
    this.now = opts.now ?? Date.now;
  }

  next(): MessageId {
    let ms = BigInt(this.now()) - BigInt(SNOWFLAKE_EPOCH_MS);
    // Never go backwards: a clock step back must not reorder ids.
    if (ms < this.lastMs) ms = this.lastMs;
    if (ms === this.lastMs) {
      this.sequence += 1n;
      if (this.sequence > MAX_SEQUENCE) {
        // 4096 ids in one ms; borrow the next millisecond rather than block.
        ms = this.lastMs + 1n;
        this.sequence = 0n;
      }
    } else {
      this.sequence = 0n;
    }
    this.lastMs = ms;
    const id = (ms << (WORKER_BITS + SEQUENCE_BITS)) | (this.worker << SEQUENCE_BITS) | this.sequence;
    return id.toString(10);
  }
}

export function timestampOf(id: MessageId): number {
  return Number(BigInt(id) >> (WORKER_BITS + SEQUENCE_BITS)) + SNOWFLAKE_EPOCH_MS;
}

export function workerOf(id: MessageId): number {
  return Number((BigInt(id) >> SEQUENCE_BITS) & MAX_WORKER);
}

export function sequenceOf(id: MessageId): number {
  return Number(BigInt(id) & MAX_SEQUENCE);
}

/** Month bucket of the id's timestamp, `year*100+month` in UTC (design §2.2). */
export function bucketOf(id: MessageId): number {
  return bucketOfTime(timestampOf(id));
}

export function bucketOfTime(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

/** Numeric comparison of two decimal id strings; usable as an Array sort comparator. */
export function compareIds(a: MessageId, b: MessageId): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
