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

import { USERS, deviceName } from '../fixtures.js';
import type { Connection, ServerContext } from '../server.js';
import type { ConversationId, UserId } from '../protocol.js';
import { InMemoryPushGateway, type PushGateway } from './PushGateway.js';
import { statusOf } from './status.js';

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

  // ---- after the direct pushes (design §3.3 delivery cursors, §3.6 notifications) ----------
  const offFanout = ctx.events.on('message_fanout', async ({ message, recipient_devices, pushed }) => {
    const { conversation_id, message_id, sender_id } = message;
    // `recipient_devices` is every member device minus the sending one, so the sending device
    // is the sender's one registered device that is not listed.
    const sender_device = (await ctx.ports.devices.devicesOf(sender_id)).map((d) => d.device_id).find((d) => !recipient_devices.includes(d));

    // The sender has read and received their own message (the page does the same on store).
    // No frame for this: the sender's other devices get the `deliver` itself.
    await ctx.ports.cursors.advanceRead(conversation_id, sender_id, message_id);
    const advanced: string[] = [];
    if (sender_device) {
      await ctx.ports.cursors.advanceDelivery(conversation_id, sender_device, message_id);
      advanced.push(`${deviceName(sender_device, sender_id)} (sender)`);
    }
    // A device in `pushed` got the `deliver` over a live socket. Acks of a replay batch are B3's.
    for (const device_id of pushed) {
      await ctx.ports.cursors.advanceDelivery(conversation_id, device_id, message_id);
      advanced.push(`${ctx.connections.byDevice(device_id)?.name ?? deviceName(device_id)} (over the socket)`);
    }
    if (advanced.length > 0) ctx.trace.add('receipt', `delivery_cursors[${conversation_id}] ← #${message_id} for ${advanced.join(', ')}`);

    // Push hints for the rest. A device that still has a route (replaying, or back-pressured)
    // is live: the queue carries the message, APNs does not (§3.6 step 1).
    const sender_display_name = USERS[sender_id]?.name ?? sender_id;
    for (const device_id of recipient_devices) {
      if (pushed.includes(device_id)) continue;
      const device = await ctx.ports.devices.get(device_id);
      if (!device) continue;
      if ((await ctx.ports.routes.get(device.user_id, device_id)) !== undefined) continue;
      const name = deviceName(device_id, device.user_id, device.kind);
      if (await opts.isMuted(conversation_id, device.user_id)) {
        ctx.trace.add('apns', `#${message_id} → ${name}: muted, no push`);
        continue;
      }
      // Never the body: it would leave our boundary and go stale on delete (§3.6 step 2).
      await opts.pushGateway.push(device_id, { conversation_id, message_id, sender_display_name });
      ctx.trace.add('apns', `#${message_id} → ${name}: no route → push hint {conv, id, from}, no body`);
    }
  });

  // ---- status for the sender (design §3.3): derived, never stored ------------------------
  // One `readCursors` partition read and one `deliveryCursors` read, whatever the group size;
  // the member list and the device directory are not the cursor partitions.
  ctx.http.route('GET', '/conversations/:id/messages/:message_id/status', async (req) => {
    const user_id = req.query['user_id'];
    if (!user_id) return { status: 400, body: { error: 'user_id_required' } };
    const conversation_id = req.params['id'] as ConversationId;
    const conversation = await ctx.ports.conversations.get(conversation_id);
    if (!conversation || !conversation.members.includes(user_id)) return { status: 403, body: { error: 'not_member' } };
    const message = await ctx.ports.messages.get(conversation_id, req.params['message_id'] as string);
    if (!message) return { status: 404, body: { error: 'not_found' } };
    const [read, delivery] = await Promise.all([ctx.ports.cursors.readCursors(conversation_id), ctx.ports.cursors.deliveryCursors(conversation_id)]);
    const devices = (await Promise.all(conversation.members.map((m) => ctx.ports.devices.devicesOf(m)))).flat();
    const report = statusOf(message, read, delivery, conversation.members, devices);
    ctx.trace.add('http', `GET status ${conversation_id}/#${message.message_id} for ${user_id} → ${report.status} (1 partition read, ${read.size} cursors)`);
    return { status: 200, body: report };
  });

  return () => {
    offDisconnected();
    offFanout();
    openSet.clear();
  };
}
