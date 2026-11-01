/**
 * Token bucket for the slow path (design §4.5 last bullet; sync-queue ADR condition).
 *
 * One per server: a cold open and a full-list load each take a token; an empty bucket
 * answers 429 with the time to the next whole token. Time comes from the injected clock,
 * so a test can run it on fake time. Fractional tokens accrue continuously, so the refill
 * rate is exact and not quantised to a timer tick.
 */

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now: () => number;
}

export type TakeResult = { ok: true } | { ok: false; retry_after_ms: number };

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private level: number;
  private lastAt: number;

  constructor(opts: TokenBucketOptions) {
    if (!(opts.capacity >= 1)) throw new RangeError('capacity must be at least 1');
    if (!(opts.refillPerSecond > 0)) throw new RangeError('refillPerSecond must be positive');
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSecond / 1000;
    this.now = opts.now;
    this.level = opts.capacity;
    this.lastAt = opts.now();
  }

  /** Whole tokens available right now. */
  get tokens(): number {
    this.refill();
    return Math.floor(this.level);
  }

  take(): TakeResult {
    this.refill();
    if (this.level >= 1) {
      this.level -= 1;
      return { ok: true };
    }
    const missing = 1 - this.level;
    // Binary fractions make 0.999 + 0.001 land a hair above 1; a microsecond of slack keeps ceil honest.
    return { ok: false, retry_after_ms: Math.max(1, Math.ceil(missing / this.refillPerMs - 1e-6)) };
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastAt;
    if (elapsed > 0) this.level = Math.min(this.capacity, this.level + elapsed * this.refillPerMs);
    // A clock that stepped back refills nothing and is not allowed to drain the bucket either.
    this.lastAt = t;
  }
}
