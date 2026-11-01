/**
 * Client-side receipt coalescing (design §3.4): a device sends at most one read receipt
 * per conversation per window (2 s), carrying the newest id it has on screen.
 *
 * Pure helper on injectable timers. The harness (`test/harness/ScriptedClient.ts`) is
 * B1's to edit; B8 or a later harness change wires this in. Reading is monotonic, so an
 * id not above the last one sent is dropped rather than sent out of order.
 */

import { compareIds, type MessageId } from '../ids.js';
import type { ConversationId } from '../protocol.js';
import type { TimerHandle, Timers } from '../server.js';

export type ReceiptSender = (conversation_id: ConversationId, last_read_id: MessageId) => void;

interface Window {
  timer: TimerHandle;
  /** Newest id offered inside the window, or null if nothing arrived since the last send. */
  pending: MessageId | null;
  send: ReceiptSender;
}

export class ReceiptCoalescer {
  private readonly windows = new Map<ConversationId, Window>();
  private readonly lastSent = new Map<ConversationId, MessageId>();

  constructor(private readonly timers: Timers, private readonly windowMs = 2000) {}

  offer(conversation_id: ConversationId, last_read_id: MessageId, send: ReceiptSender): void {
    const sent = this.lastSent.get(conversation_id);
    if (sent !== undefined && compareIds(last_read_id, sent) <= 0) return;
    const open = this.windows.get(conversation_id);
    if (open) {
      if (open.pending === null || compareIds(last_read_id, open.pending) > 0) open.pending = last_read_id;
      open.send = send;
      return;
    }
    this.emit(conversation_id, last_read_id, send);
  }

  /** Sends now and opens a window; when it ends, a pending id goes out and opens the next one. */
  private emit(conversation_id: ConversationId, last_read_id: MessageId, send: ReceiptSender): void {
    this.lastSent.set(conversation_id, last_read_id);
    send(conversation_id, last_read_id);
    const window: Window = { timer: undefined, pending: null, send };
    window.timer = this.timers.setTimeout(() => {
      this.windows.delete(conversation_id);
      if (window.pending !== null) this.emit(conversation_id, window.pending, window.send);
    }, this.windowMs);
    this.windows.set(conversation_id, window);
  }

  dispose(): void {
    for (const w of this.windows.values()) this.timers.clearTimeout(w.timer);
    this.windows.clear();
  }
}
