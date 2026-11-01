import { describe, expect, test } from 'vitest';
import { PushBuffer, type PushSocket } from '../../src/messaging/pushBuffer.js';
import type { Timers } from '../../src/server.js';

/** A socket whose flush callbacks the test fires by hand. */
class FakeSocket implements PushSocket {
  readonly sent: string[] = [];
  readonly callbacks: Array<(err?: Error) => void> = [];
  send(data: string, cb: (err?: Error) => void): void {
    this.sent.push(data);
    this.callbacks.push(cb);
  }
  flush(i: number, err?: Error): void {
    this.callbacks[i]!(err);
  }
}

/** Manual timers: nothing fires until the test says so. */
class FakeTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  setInterval(): unknown { throw new Error('not used'); }
  clearInterval(): void { throw new Error('not used'); }
  fireAll(): void {
    for (const [id, t] of [...this.pending]) {
      this.pending.delete(id);
      t.fn();
    }
  }
}

const setup = (maxPending: number, pushTimeoutMs = 100) => {
  const socket = new FakeSocket();
  const timers = new FakeTimers();
  const lost: string[] = [];
  const buffer = new PushBuffer(socket, { maxPending, pushTimeoutMs, timers });
  const push = (label: string) => buffer.push(label, (reason) => lost.push(`${label}:${reason}`));
  return { socket, timers, lost, buffer, push };
};

describe('PushBuffer: bounded per-destination buffer with a timeout (board backpressure rule)', () => {
  test('accepts pushes while below maxPending and hands them to the socket', () => {
    const { socket, buffer, push } = setup(2);
    expect(push('m1')).toBe(true);
    expect(push('m2')).toBe(true);
    expect(socket.sent).toEqual(['m1', 'm2']);
    expect(buffer.pending).toBe(2);
  });

  test('a push into a full buffer is dropped now: not sent, not counted, caller told', () => {
    const { socket, buffer, push, lost } = setup(1);
    expect(push('m1')).toBe(true);
    expect(push('m2')).toBe(false);
    expect(socket.sent).toEqual(['m1']);
    expect(buffer.pending).toBe(1);
    expect(lost).toEqual([]);
  });

  test('a flushed push frees its slot and cancels its timer', () => {
    const { socket, timers, buffer, push, lost } = setup(1);
    push('m1');
    socket.flush(0);
    expect(buffer.pending).toBe(0);
    expect(timers.pending.size).toBe(0);
    expect(push('m2')).toBe(true);
    expect(lost).toEqual([]);
  });

  test('a push not flushed within pushTimeoutMs is lost, its slot freed, and a late flush is ignored', () => {
    const { socket, timers, buffer, push, lost } = setup(1, 50);
    push('m1');
    expect([...timers.pending.values()][0]?.ms).toBe(50);
    timers.fireAll();
    expect(lost).toEqual(['m1:timeout']);
    expect(buffer.pending).toBe(0);
    socket.flush(0);
    expect(lost).toEqual(['m1:timeout']);
    expect(buffer.pending).toBe(0);
  });

  test('a socket error on the push counts as lost', () => {
    const { socket, buffer, push, lost } = setup(1);
    push('m1');
    socket.flush(0, new Error('EPIPE'));
    expect(lost).toEqual(['m1:error']);
    expect(buffer.pending).toBe(0);
  });

  test('clear cancels every timer and forgets the pending pushes without reporting them', () => {
    const { timers, buffer, push, lost } = setup(3);
    push('m1');
    push('m2');
    buffer.clear();
    expect(timers.pending.size).toBe(0);
    expect(buffer.pending).toBe(0);
    expect(lost).toEqual([]);
  });
});
