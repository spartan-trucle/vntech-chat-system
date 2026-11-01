import { describe, expect, test } from 'vitest';
import { DEFAULT_SYNC_OPTIONS, idAt, resolveSyncOptions } from '../../src/sync/index.js';
import { SNOWFLAKE_EPOCH_MS, sequenceOf, timestampOf, workerOf } from '../../src/ids.js';

describe('B3 sync options and the trim boundary id', () => {
  test('defaults: batches of 100, 5 s ack timeout, hourly sweep, 24 h window (design §4.2, §4.5)', () => {
    expect(DEFAULT_SYNC_OPTIONS).toEqual({ batchSize: 100, ackTimeoutMs: 5000, sweepMs: 3_600_000, windowMs: 86_400_000 });
    expect(resolveSyncOptions(undefined)).toEqual(DEFAULT_SYNC_OPTIONS);
  });

  test('a partial override from moduleOptions keeps the other defaults', () => {
    expect(resolveSyncOptions({ batchSize: 3 })).toEqual({ ...DEFAULT_SYNC_OPTIONS, batchSize: 3 });
    expect(resolveSyncOptions('garbage')).toEqual(DEFAULT_SYNC_OPTIONS);
  });

  test('idAt(ms) is the Snowflake at that millisecond with worker 0 and sequence 0', () => {
    const at = Date.UTC(2026, 10, 1, 12, 30, 0, 123);
    const id = idAt(at);
    expect(timestampOf(id)).toBe(at);
    expect(workerOf(id)).toBe(0);
    expect(sequenceOf(id)).toBe(0);
  });

  test('idAt clamps at the epoch so a window reaching before 2026 trims nothing', () => {
    expect(idAt(SNOWFLAKE_EPOCH_MS - 1)).toBe('0');
    expect(idAt(SNOWFLAKE_EPOCH_MS)).toBe('0');
  });
});
