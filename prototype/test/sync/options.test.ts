import { describe, expect, test } from 'vitest';
import { DEFAULT_SYNC_OPTIONS, resolveSyncOptions, trimBoundaryAt } from '../../src/sync/index.js';
import { compareStreamIds } from '../../src/ports/index.js';

describe('B3 sync options and the trim boundary id', () => {
  test('defaults: batches of 100, hourly sweep, 24 h window; no ack timeout since the replay never waits for an ack (replay-mode ADR)', () => {
    expect(DEFAULT_SYNC_OPTIONS).toEqual({ batchSize: 100, sweepMs: 3_600_000, windowMs: 86_400_000 });
    expect('ackTimeoutMs' in DEFAULT_SYNC_OPTIONS).toBe(false);
    expect(resolveSyncOptions(undefined)).toEqual(DEFAULT_SYNC_OPTIONS);
  });

  test('a partial override from moduleOptions keeps the other defaults', () => {
    expect(resolveSyncOptions({ batchSize: 3 })).toEqual({ ...DEFAULT_SYNC_OPTIONS, batchSize: 3 });
    expect(resolveSyncOptions('garbage')).toEqual(DEFAULT_SYNC_OPTIONS);
  });

  test('trimBoundaryAt(ms) is the stream id <ms>-0: every entry the store minted at or after ms is at or above it (XADD … *, live-first ADR)', () => {
    const at = Date.UTC(2026, 10, 1, 12, 30, 0, 123);
    expect(trimBoundaryAt(at)).toBe(`${at}-0`);
    expect(compareStreamIds(`${at}-0`, trimBoundaryAt(at))).toBe(0);
    expect(compareStreamIds(`${at}-7`, trimBoundaryAt(at))).toBeGreaterThan(0);
    expect(compareStreamIds(`${at - 1}-99`, trimBoundaryAt(at))).toBeLessThan(0);
  });

  test('trimBoundaryAt clamps at zero so a window reaching before the epoch trims nothing', () => {
    expect(trimBoundaryAt(-1)).toBe('0-0');
    expect(trimBoundaryAt(0)).toBe('0-0');
  });
});
