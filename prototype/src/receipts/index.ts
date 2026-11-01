/**
 * B5 · receipts, unread, multi-device read state (design §3).
 *
 * State is two cursor partitions (`read_cursors(conversation, user)`,
 * `delivery_cursors(conversation, device)`, both `max()` writes, design §3.3); status and
 * unread are derived from them and never stored. One `receipt` frame runs:
 *
 *   0. membership check                      → `error{not_member}` and nothing else
 *   1. open set: this connection has the conversation open (rule below)
 *   2. `advanceRead` → cursor did not move    → trace "no-op", stop (late or duplicate, §3.3)
 *   3. server `receipt{conversation, user, last_read_id}` to the reader's other devices
 *      (clears their badge, §3.5) and to members with the chat open (§3.4); one frame per
 *      connection, nothing to anybody else.
 *
 * Open set (stand-in for B6's watch set, which may replace it: see `openSet` below): a
 * device has a conversation open from the moment it sends a `receipt` for it until it
 * sends a `receipt` for another conversation or its connection ends. The protocol has no
 * `open` frame, so the receipt itself is the signal that a chat is on screen.
 *
 * On `message_fanout` (§3.3, §3.6): delivery cursors advance for every device that got
 * the `deliver` over a live socket (and the sender's own cursors, as the page does on
 * store); every other recipient device without a route gets a push hint through the
 * `PushGateway`, after the mute hook, and never the body.
 */

import type { Connection, ServerContext } from '../server.js';
import type { ConversationId, UserId } from '../protocol.js';
import { InMemoryPushGateway, type PushGateway } from './PushGateway.js';

export { InMemoryPushGateway, type PushGateway, type PushHint, type RecordedPush } from './PushGateway.js';
export { statusOf, type MessageStatus, type StatusReport } from './status.js';
export { ReceiptCoalescer, type ReceiptSender } from './coalesce.js';

export interface ReceiptsOptions {
  /** Where push hints go for devices without a socket; tests pass an `InMemoryPushGateway` and read it back. */
  pushGateway: PushGateway;
  /** Mute / do-not-disturb check of design §3.6 step 4, per conversation per user; default: nothing is muted. */
  isMuted(conversation_id: ConversationId, user_id: UserId): boolean | Promise<boolean>;
}

/** `ctx.moduleOptions['receipts']`, with defaults for whatever the caller left out. */
export function resolveReceiptsOptions(raw: unknown): ReceiptsOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ReceiptsOptions>;
  return {
    pushGateway: given.pushGateway ?? new InMemoryPushGateway(),
    isMuted: given.isMuted ?? (() => false),
  };
}

export function registerReceipts(ctx: ServerContext): () => void {
  const opts = resolveReceiptsOptions(ctx.moduleOptions['receipts']);

  // ---- open set ------------------------------------------------------------------------
  // `conn.id → conversation_id`: the one conversation a connection has on screen. B6's
  // watch set (`watching[target] → set(conn)`) may replace this with a per-conversation
  // set once it exists; `markOpen` and `connectionsWithOpen` are the only two touch points.
  const openSet = new Map<string, ConversationId>();
  const markOpen = (conn: Connection, conversation_id: ConversationId): void => {
    openSet.set(conn.id, conversation_id);
  };
  const connectionsWithOpen = (conversation_id: ConversationId): Connection[] => {
    const out: Connection[] = [];
    for (const [id, open] of openSet) {
      if (open !== conversation_id) continue;
      const conn = ctx.connections.get(id);
      if (conn && !conn.closed) out.push(conn);
    }
    return out;
  };
  const offDisconnected = ctx.events.on('device_disconnected', ({ conn }) => {
    openSet.delete(conn.id);
  });

  // ---- receipt frame (design §3.4, §3.5) -----------------------------------------------
  ctx.onFrame('receipt', async (conn, frame) => {
    const user_id = conn.user_id as UserId;
    const { conversation_id, last_read_id } = frame;

    if (!(await ctx.ports.conversations.isMember(conversation_id, user_id))) {
      ctx.send(conn, { t: 'error', code: 'not_member', message: `${user_id} is not a member of ${conversation_id}` });
      return;
    }

    markOpen(conn, conversation_id);

    const prev = await ctx.ports.cursors.readCursor(conversation_id, user_id);
    const after = await ctx.ports.cursors.advanceRead(conversation_id, user_id, last_read_id);
    if (after === prev) {
      ctx.trace.add('receipt', `read_cursors[${conversation_id}][${user_id}] no-op: #${last_read_id} ≤ #${prev} (late or duplicate)`);
      return;
    }
    ctx.trace.add('receipt', `read_cursors[${conversation_id}][${user_id}] = max(prev,#${last_read_id})`);

    const cursor = { t: 'receipt' as const, conversation_id, user_id, last_read_id };
    const told = new Set<string>([conn.id]);

    // (a) The reader's other devices: one cursor per user, not per device, is what makes
    //     multi-device read state consistent; this is what clears the laptop's badge.
    const others = ctx.connections.byUser(user_id).filter((c) => c !== conn && !c.closed);
    if (others.length > 0) {
      ctx.trace.add('push', `read_cursor → ${others.map((c) => c.name).join(', ')} (clears their badge)`);
      for (const c of others) {
        told.add(c.id);
        ctx.send(c, cursor);
      }
    }

    // (b) Members looking at the conversation right now; nobody is pushed receipts for a chat
    //     they are not watching (§3.4), they read the partition when they open it.
    const watching = connectionsWithOpen(conversation_id).filter((c) => !told.has(c.id));
    if (watching.length > 0) {
      ctx.trace.add('receipt', `cursors ${conversation_id} → ${watching.map((c) => c.name).join(', ')} (devices with the chat open)`);
      for (const c of watching) {
        told.add(c.id);
        ctx.send(c, cursor);
      }
    }
  });

  return () => {
    offDisconnected();
    openSet.clear();
  };
}
