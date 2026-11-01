import { beforeEach, describe, expect, test } from 'vitest';
import type { SyncQueue } from '../../../src/ports/SyncQueue.js';
import { streamIdOf } from '../../../src/ports/SyncQueue.js';

export function describeSyncQueueContract(name: string, make: (opts?: { maxLen?: number }) => SyncQueue): void {
  describe(`${name} satisfies the SyncQueue contract`, () => {
    let q: SyncQueue;
    beforeEach(() => {
      q = make();
    });

    const e = (m: string, c = 'c1') => ({ id: streamIdOf(m), m, c });

    test('streamIdOf derives a Redis-looking id from the message id', () => {
      expect(streamIdOf('123')).toBe('123-0');
    });

    test('xrange from null returns everything in id order', async () => {
      await q.xadd('A1', e('101'));
      await q.xadd('A1', e('102', 'c2'));
      expect(await q.xrange('A1', null, 100)).toEqual([e('101'), e('102', 'c2')]);
      expect(await q.xrange('B1', null, 100)).toEqual([]);
    });

    test('xrange after a cursor is exclusive and bounded by count', async () => {
      for (const m of ['101', '102', '103', '104']) await q.xadd('A1', e(m));
      expect((await q.xrange('A1', streamIdOf('102'), 1)).map((x) => x.m)).toEqual(['103']);
      expect((await q.xrange('A1', streamIdOf('102'), 10)).map((x) => x.m)).toEqual(['103', '104']);
    });

    test('xadd with the same id twice stores one entry (idempotent retries)', async () => {
      await q.xadd('A1', e('101'));
      await q.xadd('A1', e('101'));
      expect(await q.xrange('A1', null, 100)).toHaveLength(1);
    });

    test('xadd orders by id even when appended out of order', async () => {
      await q.xadd('A1', e('102'));
      await q.xadd('A1', e('101'));
      expect((await q.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['101', '102']);
    });

    test('ids compare numerically, not lexically', async () => {
      await q.xadd('A1', e('9'));
      await q.xadd('A1', e('10'));
      expect((await q.xrange('A1', streamIdOf('9'), 100)).map((x) => x.m)).toEqual(['10']);
    });

    test('xtrim drops entries below minId and reports how many', async () => {
      for (const m of ['101', '102', '103']) await q.xadd('A1', e(m));
      expect(await q.xtrim('A1', streamIdOf('103'))).toBe(2);
      expect((await q.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['103']);
    });

    test('first reports the oldest retained id, so a cursor behind it means "trimmed past"', async () => {
      expect(await q.first('A1')).toBeNull();
      for (const m of ['101', '102']) await q.xadd('A1', e(m));
      await q.xtrim('A1', streamIdOf('102'));
      expect(await q.first('A1')).toBe(streamIdOf('102'));
    });

    test('MAXLEN evicts the oldest entries', async () => {
      const capped = make({ maxLen: 2 });
      for (const m of ['101', '102', '103']) await capped.xadd('A1', e(m));
      expect((await capped.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['102', '103']);
    });
  });
}
