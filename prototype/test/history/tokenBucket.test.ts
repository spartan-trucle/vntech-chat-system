import { describe, expect, test } from 'vitest';
import { TokenBucket } from '../../src/history/tokenBucket.js';

describe('B4 slow-path token bucket (sync-queue ADR condition: the slow path is rate-limited)', () => {
  const clockAt = (start: number) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  };

  test('starts full and hands out one token per take until empty', () => {
    const clock = clockAt(1_000_000);
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: clock.now });
    expect(bucket.tokens).toBe(3);
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.tokens).toBe(0);
    expect(bucket.take()).toEqual({ ok: false, retry_after_ms: 1000 });
  });

  test('retry_after_ms is the time to the next whole token at the refill rate', () => {
    const clock = clockAt(0);
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 50, now: clock.now });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: false, retry_after_ms: 20 });
    clock.advance(5);
    // 0.25 token refilled; 0.75 to go at 50/s = 15 ms
    expect(bucket.take()).toEqual({ ok: false, retry_after_ms: 15 });
  });

  test('refills from elapsed time on the injected clock and never above capacity', () => {
    const clock = clockAt(0);
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now });
    bucket.take();
    bucket.take();
    clock.advance(999);
    expect(bucket.take()).toEqual({ ok: false, retry_after_ms: 1 });
    clock.advance(1);
    expect(bucket.take()).toEqual({ ok: true });
    clock.advance(60_000);
    expect(bucket.tokens).toBe(2);
    bucket.take();
    bucket.take();
    expect(bucket.take().ok).toBe(false);
  });

  test('rejects a capacity or rate that cannot limit anything', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1, now: () => 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0, now: () => 0 })).toThrow(RangeError);
  });
});
