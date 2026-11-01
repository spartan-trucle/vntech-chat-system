/**
 * Fake clock and timers in one object (roadmap B1): the server takes it as
 * `createChatServer({ clock, timers })`, the harness client as `{ now, timers }`, so one
 * `advance()` moves both sides of the heartbeat together and a schedule can be asserted
 * exactly. Sockets stay real; `advance()` yields to I/O after every fired timer, but a
 * test that depends on a network event (a pong, a close) still awaits that event itself.
 */

import type { Clock, TimerHandle, Timers } from '../../src/server.js';

interface FakeTimer {
  id: number;
  due: number;
  every: number | null;
  fn: () => void;
}

export class FakeTime implements Clock, Timers {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, null);
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Timers still armed; zero after a clean shutdown. */
  pending(): number {
    return this.timers.size;
  }

  /** Moves the clock forward, firing every due timer in due order, yielding to I/O after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const next = this.earliestDue(target);
      if (!next) break;
      this.t = Math.max(this.t, next.due);
      if (next.every === null) this.timers.delete(next.id);
      else next.due += next.every;
      next.fn();
      await yieldToIo();
    }
    this.t = target;
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.timers.set(id, { id, due: this.t + Math.max(0, ms), every, fn });
    return id;
  }

  private earliestDue(limit: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.due > limit) continue;
      if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) best = timer;
    }
    return best;
  }
}

/** One macrotask turn plus a few immediates, enough for a localhost frame to land. */
export async function yieldToIo(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls a condition in real time; for events that cross the socket after a fake-timer fire. */
export async function until(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await yieldToIo();
  }
}
