/**
 * Bounded per-destination push buffer (the backpressure rule on the board, docs/index.html
 * "Fan-out"; replay-mode ADR 2026-11-02). One per connection, owned by the core
 * (`Connection.pushes`), and the only flow control for live and replay frames alike.
 *
 * A push is *pending* from `socket.send` until ws reports the bytes flushed (its send
 * callback). At most `maxPending` pushes may be pending per destination. The two operations:
 *
 * - `pushLive`: a live push into a full buffer is dropped at once (`'full'`); an accepted
 *   push that has not flushed within `pushTimeoutMs` is counted lost and its slot freed
 *   (`onLost('timeout')`, a later flush is ignored). The message stays in the device's sync
 *   queue either way; the caller reports the drop and the sync module re-replays.
 * - `pushReplay`: a replay push is never dropped and never times out; it waits for a free
 *   slot instead, in order, and resolves `false` only when the buffer is cleared (the
 *   connection is gone).
 *
 * `suspendLive` / `resumeLive` is the gate the sync module closes while it re-replays after
 * a drop: a suspended live push is not sent and not a drop (`'suspended'`), the entry waits
 * in the stream for the running loop.
 */

import type { Timers } from './server.js';

/** The slice of `ws.WebSocket` this needs: a send whose callback fires once flushed. */
export interface PushSocket {
  send(data: string, cb: (err?: Error) => void): void;
}

export type PushLostReason = 'timeout' | 'error';
export type LivePushResult = 'accepted' | 'full' | 'suspended';

export interface PushBufferOptions {
  maxPending: number;
  pushTimeoutMs: number;
  timers: Timers;
}

interface Slot {
  timer: unknown;
}

export class PushBuffer {
  private readonly socket: PushSocket;
  private readonly opts: PushBufferOptions;
  private readonly inFlight = new Set<Slot>();
  /** Replay pushes waiting for a slot, in order. */
  private readonly waiters: Array<{ data: string; resolve: (ok: boolean) => void }> = [];
  private readonly drainWaiters: Array<() => void> = [];
  private suspended = false;

  constructor(socket: PushSocket, opts: PushBufferOptions) {
    this.socket = socket;
    this.opts = opts;
  }

  /** How many pushes the destination has not taken yet. */
  get pending(): number {
    return this.inFlight.size;
  }

  /** Replay pushes waiting for room. */
  get waiting(): number {
    return this.waiters.length;
  }

  get liveSuspended(): boolean {
    return this.suspended;
  }

  /** Closes the live lane: `pushLive` answers `'suspended'` until `resumeLive`. */
  suspendLive(): void {
    this.suspended = true;
  }

  resumeLive(): void {
    this.suspended = false;
  }

  /**
   * Hands `data` to the socket if the live lane is open and there is room. `'full'` means the
   * push was dropped now, nothing sent. `onLost` is called at most once, later, if the push was
   * accepted but the destination never took it in time.
   */
  pushLive(data: string, onLost: (reason: PushLostReason) => void): LivePushResult {
    if (this.suspended) return 'suspended';
    // Replay pushes already waiting keep their place: a live push never overtakes them.
    if (this.waiters.length > 0 || this.inFlight.size >= this.opts.maxPending) return 'full';
    const slot: Slot = { timer: undefined };
    this.inFlight.add(slot);
    slot.timer = this.opts.timers.setTimeout(() => {
      if (this.settle(slot)) onLost('timeout');
    }, this.opts.pushTimeoutMs);
    this.socket.send(data, (err) => {
      if (this.settle(slot) && err) onLost('error');
    });
    return 'accepted';
  }

  /**
   * Hands `data` to the socket as soon as there is room; never dropped, never timed out.
   * Resolves `true` once handed over, `false` if the buffer was cleared first.
   */
  pushReplay(data: string): Promise<boolean> {
    if (this.waiters.length === 0 && this.inFlight.size < this.opts.maxPending) {
      this.sendReplay(data);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.waiters.push({ data, resolve });
    });
  }

  /** Resolves when nothing is pending (now, or once the last slot frees). */
  drained(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Forgets every pending push, cancels its timer, and releases every waiter with `false`. */
  clear(): void {
    for (const slot of this.inFlight) this.opts.timers.clearTimeout(slot.timer);
    this.inFlight.clear();
    for (const w of this.waiters.splice(0)) w.resolve(false);
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  private sendReplay(data: string): void {
    const slot: Slot = { timer: undefined };
    this.inFlight.add(slot);
    this.socket.send(data, () => {
      this.settle(slot);
    });
  }

  /** Frees a slot; false when it was already freed (a late flush after a timeout, or a clear). */
  private settle(slot: Slot): boolean {
    if (!this.inFlight.delete(slot)) return false;
    this.opts.timers.clearTimeout(slot.timer);
    // The freed slot goes to the next waiting replay push, then the drain waiters if nothing is left.
    const next = this.waiters.shift();
    if (next) {
      this.sendReplay(next.data);
      next.resolve(true);
    }
    if (this.inFlight.size === 0) for (const resolve of this.drainWaiters.splice(0)) resolve();
    return true;
  }
}
