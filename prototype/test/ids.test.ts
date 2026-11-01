import { describe, expect, test } from 'vitest';
import { Snowflake, SNOWFLAKE_EPOCH_MS, bucketOf, compareIds, timestampOf, workerOf, sequenceOf } from '../src/ids.js';

describe('Snowflake (41 bits ms since epoch / 10 bits worker / 12 bits sequence)', () => {
  test('ids are decimal strings that grow with time', () => {
    let now = SNOWFLAKE_EPOCH_MS + 1_000;
    const gen = new Snowflake({ worker: 1, now: () => now });
    const a = gen.next();
    now += 5;
    const b = gen.next();
    expect(a).toMatch(/^\d+$/);
    expect(compareIds(a, b)).toBeLessThan(0);
  });

  test('two ids in the same millisecond differ by the sequence only', () => {
    const now = SNOWFLAKE_EPOCH_MS + 42;
    const gen = new Snowflake({ worker: 3, now: () => now });
    const a = gen.next();
    const b = gen.next();
    expect(timestampOf(a)).toBe(now);
    expect(timestampOf(b)).toBe(now);
    expect(workerOf(a)).toBe(3);
    expect(sequenceOf(a)).toBe(0);
    expect(sequenceOf(b)).toBe(1);
    expect(compareIds(a, b)).toBeLessThan(0);
  });

  test('sequence overflow in one millisecond moves to the next millisecond', () => {
    const now = SNOWFLAKE_EPOCH_MS + 7;
    const gen = new Snowflake({ worker: 0, now: () => now });
    let last = gen.next();
    for (let i = 0; i < 4096; i++) {
      const id = gen.next();
      expect(compareIds(last, id)).toBeLessThan(0);
      last = id;
    }
    expect(timestampOf(last)).toBe(now + 1);
  });

  test('ids never go backwards when the clock does', () => {
    let now = SNOWFLAKE_EPOCH_MS + 100;
    const gen = new Snowflake({ worker: 0, now: () => now });
    const a = gen.next();
    now -= 50;
    const b = gen.next();
    expect(compareIds(a, b)).toBeLessThan(0);
  });

  test('worker id is bounded to 10 bits', () => {
    expect(() => new Snowflake({ worker: 1024, now: () => SNOWFLAKE_EPOCH_MS })).toThrow();
  });

  test('bucketOf is year*100+month of the id timestamp in UTC', () => {
    const at = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01
    const gen = new Snowflake({ worker: 0, now: () => at });
    expect(bucketOf(gen.next())).toBe(202611);
  });

  test('compareIds compares numerically, not lexically', () => {
    expect(compareIds('9', '10')).toBeLessThan(0);
    expect(compareIds('10', '9')).toBeGreaterThan(0);
    expect(compareIds('10', '10')).toBe(0);
  });
});
