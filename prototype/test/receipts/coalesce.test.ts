import { describe, expect, test } from 'vitest';
import { ReceiptCoalescer } from '../../src/receipts/coalesce.js';
import type { Timers } from '../../src/server.js';

/** Hand-driven timers: `advance(ms)` fires what is due, in order. */
function manualTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timeouts.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timeouts.delete(handle as number);
    },
    setInterval() {
      throw new Error('not used');
    },
    clearInterval() {
      throw new Error('not used');
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timeouts.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timeouts.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => timeouts.size,
  };
}

describe('ReceiptCoalescer: at most one receipt per conversation per window, carrying the newest id (design §3.4)', () => {
  const setup = (windowMs = 2000) => {
    const timers = manualTimers();
    const sent: Array<[string, string]> = [];
    const send = (conversation_id: string, last_read_id: string): void => { sent.push([conversation_id, last_read_id]); };
    const c = new ReceiptCoalescer(timers, windowMs);
    return { timers, sent, send, c };
  };

  test('the first offer for a conversation goes out at once', () => {
    const { sent, send, c } = setup();
    c.offer('c1', '100', send);
    expect(sent).toEqual([['c1', '100']]);
  });

  test('offers inside the window are held; the newest id goes out when the window ends', () => {
    const { timers, sent, send, c } = setup();
    c.offer('c1', '100', send);
    c.offer('c1', '101', send);
    c.offer('c1', '103', send);
    c.offer('c1', '102', send);
    expect(sent).toEqual([['c1', '100']]);
    timers.advance(1999);
    expect(sent).toEqual([['c1', '100']]);
    timers.advance(1);
    expect(sent).toEqual([['c1', '100'], ['c1', '103']]);
  });

  test('sustained reading yields one receipt per window, each with the newest id', () => {
    const { timers, sent, send, c } = setup();
    c.offer('c1', '1', send);
    timers.advance(500);
    c.offer('c1', '2', send);
    timers.advance(1500); // window 1 ends → #2
    c.offer('c1', '3', send); // inside window 2
    timers.advance(2000); // window 2 ends → #3
    timers.advance(2000); // window 3 ends with nothing pending: closes quietly
    c.offer('c1', '4', send); // no window open → at once
    expect(sent).toEqual([['c1', '1'], ['c1', '2'], ['c1', '3'], ['c1', '4']]);
  });

  test('conversations are coalesced independently', () => {
    const { timers, sent, send, c } = setup();
    c.offer('c1', '10', send);
    c.offer('c2', '20', send);
    c.offer('c1', '11', send);
    c.offer('c2', '21', send);
    expect(sent).toEqual([['c1', '10'], ['c2', '20']]);
    timers.advance(2000);
    expect(sent).toEqual([['c1', '10'], ['c2', '20'], ['c1', '11'], ['c2', '21']]);
  });

  test('an id not above the last one sent is dropped (reading is monotonic)', () => {
    const { timers, sent, send, c } = setup();
    c.offer('c1', '100', send);
    c.offer('c1', '90', send);
    c.offer('c1', '100', send);
    timers.advance(2000);
    expect(sent).toEqual([['c1', '100']]);
    c.offer('c1', '99', send);
    expect(sent).toEqual([['c1', '100']]);
  });

  test('the window length is configurable and dispose() drops pending work and timers', () => {
    const { timers, sent, send, c } = setup(500);
    c.offer('c1', '1', send);
    c.offer('c1', '2', send);
    timers.advance(499);
    expect(sent).toEqual([['c1', '1']]);
    c.dispose();
    timers.advance(1);
    expect(sent).toEqual([['c1', '1']]);
    expect(timers.pending()).toBe(0);
  });
});
