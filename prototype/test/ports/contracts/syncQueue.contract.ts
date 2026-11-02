import { beforeEach, describe, expect, test } from 'vitest';
import type { SyncQueue } from '../../../src/ports/SyncQueue.js';
import { compareStreamIds, XaddTimeout } from '../../../src/ports/SyncQueue.js';

export interface SyncQueueFactoryOptions {
  maxLen?: number;
  /** `XADD` must answer within this many ms or `xadd` rejects with `XaddTimeout`. */
  xaddTimeoutMs?: number;
  /** Fault: every `XADD` lands but its reply takes this long (a slow Redis, a lost ack). */
  xaddDelayMs?: number;
}

export interface SyncQueueContractOptions {
  /**
   * Case name → why it fails against this adapter. The case stays in the run as `test.fails`
   * with the reason in its name, so a divergence between adapters is visible, never silent
   * (B9: `MAXLEN ~` is approximate on Redis).
   */
  failing?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The per-device sync queue of design §4.2 after the live-first ADR (2026-11-02): the store
 * assigns stream ids (`XADD … *`), the message id lives in the entry body, appends need no
 * ordering, and a timed-out `XADD` is answered by a tail read on the retry path.
 */
export function describeSyncQueueContract(name: string, make: (opts?: SyncQueueFactoryOptions) => SyncQueue, opts: SyncQueueContractOptions = {}): void {
  describe(`${name} satisfies the SyncQueue contract`, () => {
    let q: SyncQueue;
    beforeEach(() => {
      q = make();
    });
    const it = (caseName: string, fn: () => void | Promise<void>): void => {
      const why = opts.failing?.[caseName];
      if (why === undefined) test(caseName, fn);
      else test.fails(`${caseName} [known to fail on ${name}: ${why}]`, fn);
    };

    const e = (m: string, c = 'c1') => ({ m, c });

    it('xadd returns a store-assigned id in Redis spelling <ms>-<seq>, increasing per stream whatever the message ids', async () => {
      const a = await q.xadd('A1', e('102'));
      const b = await q.xadd('A1', e('101', 'c2'));
      const c = await q.xadd('A1', e('9'));
      for (const id of [a, b, c]) expect(id).toMatch(/^\d+-\d+$/);
      expect(compareStreamIds(a, b)).toBeLessThan(0);
      expect(compareStreamIds(b, c)).toBeLessThan(0);
    });

    it('xrange from null returns everything in append order with the ids xadd returned; an unknown stream is empty', async () => {
      const a = await q.xadd('A1', e('102'));
      const b = await q.xadd('A1', e('101', 'c2'));
      expect(await q.xrange('A1', null, 100)).toEqual([{ id: a, m: '102', c: 'c1' }, { id: b, m: '101', c: 'c2' }]);
      expect(await q.xrange('B1', null, 100)).toEqual([]);
    });

    it('xrange after a cursor is exclusive and bounded by count', async () => {
      const ids: string[] = [];
      for (const m of ['101', '102', '103', '104']) ids.push(await q.xadd('A1', e(m)));
      expect((await q.xrange('A1', ids[1]!, 1)).map((x) => x.m)).toEqual(['103']);
      expect((await q.xrange('A1', ids[1]!, 10)).map((x) => x.m)).toEqual(['103', '104']);
    });

    it('xrange after an id below an entry\'s id (not an entry itself) starts at that entry: the re-replay start of the replay-mode ADR', async () => {
      const ids: string[] = [];
      for (const m of ['101', '102']) ids.push(await q.xadd('A1', e(m)));
      const [ms, seq] = ids[1]!.split('-') as [string, string];
      const justBelow = seq === '0' ? `${BigInt(ms) - 1n}-18446744073709551615` : `${ms}-${BigInt(seq) - 1n}`;
      expect((await q.xrange('A1', justBelow, 10)).map((x) => x.m)).toEqual(['102']);
    });

    it('the same message appended twice is two entries: the store does not dedup, the client does', async () => {
      await q.xadd('A1', e('101'));
      await q.xadd('A1', e('101'));
      expect((await q.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['101', '101']);
    });

    it('xrevrange reads the tail newest first, at most count entries', async () => {
      expect(await q.xrevrange('A1', 100)).toEqual([]);
      const ids: string[] = [];
      for (const m of ['101', '102', '103']) ids.push(await q.xadd('A1', e(m)));
      expect((await q.xrevrange('A1', 2))).toEqual([{ id: ids[2], m: '103', c: 'c1' }, { id: ids[1], m: '102', c: 'c1' }]);
      expect((await q.xrevrange('A1', 100)).map((x) => x.m)).toEqual(['103', '102', '101']);
    });

    it('an XADD that does not answer within xaddTimeoutMs rejects with XaddTimeout; the entry may still land, and the tail shows it', async () => {
      const slow = make({ xaddTimeoutMs: 20, xaddDelayMs: 80 });
      await expect(slow.xadd('A1', e('101'))).rejects.toBeInstanceOf(XaddTimeout);
      await sleep(100);
      expect((await slow.xrevrange('A1', 100)).map((x) => x.m)).toEqual(['101']);
    });

    it('xtrim drops entries below minId and reports how many', async () => {
      const ids: string[] = [];
      for (const m of ['101', '102', '103']) ids.push(await q.xadd('A1', e(m)));
      expect(await q.xtrim('A1', ids[2]!)).toBe(2);
      expect((await q.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['103']);
    });

    it('first reports the oldest retained id, so a cursor behind it means "trimmed past"', async () => {
      expect(await q.first('A1')).toBeNull();
      const ids: string[] = [];
      for (const m of ['101', '102']) ids.push(await q.xadd('A1', e(m)));
      await q.xtrim('A1', ids[1]!);
      expect(await q.first('A1')).toBe(ids[1]);
    });

    it('MAXLEN evicts the oldest entries', async () => {
      const capped = make({ maxLen: 2 });
      for (const m of ['101', '102', '103']) await capped.xadd('A1', e(m));
      expect((await capped.xrange('A1', null, 100)).map((x) => x.m)).toEqual(['102', '103']);
    });
  });
}
