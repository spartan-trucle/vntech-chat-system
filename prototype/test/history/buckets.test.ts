import { describe, expect, test } from 'vitest';
import { bucketOf, Snowflake, type MessageId } from '../../src/ids.js';
import { InMemoryMessageStore } from '../../src/ports/index.js';
import type { Message } from '../../src/protocol.js';
import { nextBucket, prevBucket, walkBack, walkForward } from '../../src/history/buckets.js';

/** Rows in the given UTC months, ids minted on a clock sitting in that month; returns ids oldest-first. */
async function seed(store: InMemoryMessageStore, months: Array<{ year: number; month: number; count: number }>): Promise<MessageId[]> {
  let t = 0;
  const ids = new Snowflake({ worker: 0, now: () => t });
  const out: MessageId[] = [];
  for (const m of months) {
    t = Date.UTC(m.year, m.month - 1, 10);
    for (let i = 0; i < m.count; i += 1) {
      t += 1000;
      const message_id = ids.next();
      const row: Message = {
        conversation_id: 'c1', bucket: bucketOf(message_id), message_id, sender_id: 'truc', client_msg_id: message_id,
        body: `m${out.length}`, reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: t,
      };
      await store.insert(row);
      out.push(message_id);
    }
  }
  return out;
}

describe('B4 month-bucket walk (design §2.3): one partition read per bucket visited', () => {
  test('prevBucket and nextBucket cross year boundaries', () => {
    expect(prevBucket(202601)).toBe(202512);
    expect(prevBucket(202607)).toBe(202606);
    expect(nextBucket(202612)).toBe(202701);
    expect(nextBucket(202603)).toBe(202604);
  });

  test('backward walk stops as soon as limit rows are in hand: one read for a busy month', async () => {
    const store = new InMemoryMessageStore();
    const ids = await seed(store, [{ year: 2026, month: 10, count: 5 }, { year: 2026, month: 11, count: 60 }]);
    const result = await walkBack(store, 'c1', { startBucket: 202611, floorBucket: 202601, limit: 50 });
    expect(result.messages).toHaveLength(50);
    expect(result.messages[0]!.message_id).toBe(ids[ids.length - 1]);
    expect(result.messages[49]!.message_id).toBe(ids[ids.length - 50]);
    expect(result.buckets).toEqual([202611]);
    expect(store.partitionReads).toBe(1);
  });

  test('backward walk descends month by month until limit rows or the floor bucket, never below it', async () => {
    const store = new InMemoryMessageStore();
    const ids = await seed(store, [{ year: 2026, month: 2, count: 3 }, { year: 2026, month: 9, count: 4 }]);
    const result = await walkBack(store, 'c1', { startBucket: 202611, floorBucket: 202601, limit: 50 });
    expect(result.messages.map((m) => m.message_id)).toEqual([...ids].reverse());
    // 202611 down to 202601 inclusive: 11 buckets, 11 reads, no read of 202512.
    expect(result.buckets).toEqual([202611, 202610, 202609, 202608, 202607, 202606, 202605, 202604, 202603, 202602, 202601]);
    expect(store.partitionReads).toBe(11);
  });

  test('backward walk with a before cursor starts in that id\'s bucket and returns rows strictly below it', async () => {
    const store = new InMemoryMessageStore();
    const ids = await seed(store, [{ year: 2026, month: 2, count: 3 }, { year: 2026, month: 9, count: 4 }]);
    const before = ids[4]!; // second row of September
    const result = await walkBack(store, 'c1', { startBucket: bucketOf(before), floorBucket: 202601, before, limit: 2 });
    expect(result.messages.map((m) => m.message_id)).toEqual([ids[3]!, ids[2]!]);
    expect(result.buckets).toEqual([202609, 202608, 202607, 202606, 202605, 202604, 202603, 202602]);
  });

  test('forward walk reads ascending from after, month by month up to the ceiling bucket', async () => {
    const store = new InMemoryMessageStore();
    const ids = await seed(store, [{ year: 2026, month: 2, count: 3 }, { year: 2026, month: 5, count: 4 }]);
    const after = ids[0]!;
    const result = await walkForward(store, 'c1', { startBucket: bucketOf(after), ceilBucket: 202606, after, limit: 50 });
    expect(result.messages.map((m) => m.message_id)).toEqual(ids.slice(1));
    expect(result.buckets).toEqual([202602, 202603, 202604, 202605, 202606]);
    expect(store.partitionReads).toBe(5);

    const capped = await walkForward(store, 'c1', { startBucket: bucketOf(after), ceilBucket: 202606, after, limit: 2 });
    expect(capped.messages.map((m) => m.message_id)).toEqual([ids[1]!, ids[2]!]);
    expect(capped.buckets).toEqual([202602]);
  });
});
