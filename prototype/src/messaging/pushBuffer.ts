/**
 * Bounded per-destination push buffer (the backpressure rule on the board, docs/index.html
 * "Fan-out"): if a destination does not take a push within budget, the push is dropped and
 * the message stays in that device's sync queue; the device catches up on its own. A slow
 * recipient is a delay for one recipient, never a stall for the sender.
 *
 * A push is *pending* from `socket.send` until ws reports the bytes flushed (its send
 * callback). At most `maxPending` pushes may be pending per destination; a push into a
 * full buffer is dropped at once, a pending push that has not flushed within
 * `pushTimeoutMs` is counted lost and its slot freed (a later flush is ignored).
 */

import type { Timers } from '../server.js';

/** The slice of `ws.WebSocket` this needs: a send whose callback fires once flushed. */
export interface PushSocket {
  send(data: string, cb: (err?: Error) => void): void;
}

export type PushLostReason = 'timeout' | 'error';

export interface PushBufferOptions {
  maxPending: number;
  pushTimeoutMs: number;
  timers: Timers;
}

export class PushBuffer {
  private readonly socket: PushSocket;
  private readonly opts: PushBufferOptions;
  private readonly inFlight = new Set<{ timer: unknown }>();

  constructor(socket: PushSocket, opts: PushBufferOptions) {
    this.socket = socket;
    this.opts = opts;
  }

  /** How many pushes the destination has not taken yet. */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Hands `data` to the socket if there is room. Returns false when the buffer is full (the
   * push was dropped, nothing sent). `onLost` is called at most once, later, if the push was
   * accepted but the destination never took it in time.
   */
  push(data: string, onLost: (reason: PushLostReason) => void): boolean {
    if (this.inFlight.size >= this.opts.maxPending) return false;
    const slot: { timer: unknown } = { timer: undefined };
    this.inFlight.add(slot);
    const settle = (): boolean => {
      if (!this.inFlight.delete(slot)) return false;
      this.opts.timers.clearTimeout(slot.timer);
      return true;
    };
    slot.timer = this.opts.timers.setTimeout(() => {
      if (settle()) onLost('timeout');
    }, this.opts.pushTimeoutMs);
    this.socket.send(data, (err) => {
      if (settle() && err) onLost('error');
    });
    return true;
  }

  /** Forgets every pending push and cancels its timer; nothing is reported. */
  clear(): void {
    for (const slot of this.inFlight) this.opts.timers.clearTimeout(slot.timer);
    this.inFlight.clear();
  }
}
