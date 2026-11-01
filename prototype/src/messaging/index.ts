/**
 * B2 · send path: store, IDs, dedup, write order (design §2.2, §1.4, §4.2; scenario S3).
 *
 * One `msg` frame runs, each step awaited before the next:
 *
 *   0. membership check                         → `error{not_member}` and nothing else
 *   1. dedup on `(sender_id, client_msg_id)`    → the original `msg_ack`, no second row
 *   2. INSERT into the message store            → `message_stored`
 *   3. `msg_ack` to the sender                  → `message_acked`   (B3 appends to the sync queues here)
 *   4. direct push to every live recipient socket → `message_fanout`
 *
 * Store first, ack second, queue third, push last is the invariant of design §4.2: nothing
 * is ever acked that is not stored, and nothing is in a queue that is not acked. The order
 * is asserted by test/messaging/send.test.ts, not by convention.
 *
 * Pushes go through a bounded per-destination buffer (pushBuffer.ts); a push the
 * destination does not take within budget is dropped and the message stays in that
 * device's queue. The handler never waits for a socket to drain, so a slow recipient is a
 * delay for that recipient and not a stall for the sender.
 */

import { bucketOf } from '../ids.js';
import { encodeFrame, type DeviceId, type Message, type UserId } from '../protocol.js';
import { streamIdOf } from '../ports/index.js';
import type { Connection, ServerContext } from '../server.js';
import { PushBuffer } from './pushBuffer.js';

export interface MessagingOptions {
  /**
   * Pushes one destination socket may have pending (handed to ws, not yet flushed) before
   * further pushes are dropped. ws reports a flush on the next tick, so every push issued
   * within one tick counts as pending even on a healthy socket: the bound must leave room
   * for one tick's worth of fan-out, which is why the default is in the hundreds.
   */
  maxPending: number;
  /** A pending push not flushed within this many ms is counted lost; the sync queue carries the message. */
  pushTimeoutMs: number;
}

export const DEFAULT_MESSAGING_OPTIONS: MessagingOptions = { maxPending: 1000, pushTimeoutMs: 5000 };

/** `ctx.moduleOptions['messaging']`, with defaults for whatever the caller left out. */
export function resolveMessagingOptions(raw: unknown): MessagingOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MessagingOptions>;
  return {
    maxPending: given.maxPending ?? DEFAULT_MESSAGING_OPTIONS.maxPending,
    pushTimeoutMs: given.pushTimeoutMs ?? DEFAULT_MESSAGING_OPTIONS.pushTimeoutMs,
  };
}

export function registerMessaging(ctx: ServerContext): () => void {
  const opts = resolveMessagingOptions(ctx.moduleOptions['messaging']);

  // One bounded buffer per destination connection, dropped with the connection.
  const buffers = new Map<string, PushBuffer>();
  const bufferOf = (dest: Connection): PushBuffer => {
    let buffer = buffers.get(dest.id);
    if (!buffer) {
      buffer = new PushBuffer(dest.socket, { maxPending: opts.maxPending, pushTimeoutMs: opts.pushTimeoutMs, timers: ctx.timers });
      buffers.set(dest.id, buffer);
    }
    return buffer;
  };
  const offDisconnected = ctx.events.on('device_disconnected', ({ conn }) => {
    buffers.get(conn.id)?.clear();
    buffers.delete(conn.id);
  });

  /** Every registered device of every member, in member then registration order, minus the sending device. */
  const recipientDevicesOf = async (members: UserId[], sending_device: DeviceId): Promise<DeviceId[]> => {
    const out: DeviceId[] = [];
    for (const member of members) {
      for (const device of await ctx.ports.devices.devicesOf(member)) {
        if (device.device_id !== sending_device && !out.includes(device.device_id)) out.push(device.device_id);
      }
    }
    return out;
  };

  ctx.onFrame('msg', async (conn, frame) => {
    // The core refuses every frame before hello, so identity is bound here.
    const user_id = conn.user_id as UserId;
    const device_id = conn.device_id as DeviceId;
    const { conversation_id, client_msg_id } = frame;

    if (!(await ctx.ports.conversations.isMember(conversation_id, user_id))) {
      ctx.send(conn, { t: 'error', code: 'not_member', message: `${user_id} is not a member of ${conversation_id}` });
      return;
    }

    // Anyone may veto before the write (the media module checks §6.2 metadata against the intent).
    let veto: { code: string; message: string } | undefined;
    await ctx.events.emit('message_received', {
      conn, frame, reject: (code, message) => { veto ??= { code, message }; },
    });
    if (veto) {
      ctx.send(conn, { t: 'error', code: veto.code, message: veto.message });
      return;
    }

    // Dedup (design §1.4): a retry whose ack was lost gets the same ack and no second row.
    const already = await ctx.ports.messages.findByClientMsgId(user_id, client_msg_id);
    if (already !== undefined) {
      ctx.trace.add('dedup', `(${user_id}, ${client_msg_id}) already stored as #${already} → same ack, no second row`);
      ctx.send(conn, { t: 'msg_ack', client_msg_id, message_id: already });
      return;
    }

    // 1. Store. The row is the `messages` table of design §2.2, partitioned by (conversation, month).
    const message_id = ctx.ids.next();
    const message: Message = {
      conversation_id,
      bucket: bucketOf(message_id),
      message_id,
      sender_id: user_id,
      client_msg_id,
      body: frame.body,
      // An id only, never resolved or quoted here: whether the server quotes the replied-to
      // message, or the client does, is undecided (roadmap A3, reply quoting).
      reply_to: frame.reply_to ?? null,
      // Metadata only, as the client sent it after the upload (design §6.2); validated above by the media module.
      media_key: frame.media_key ?? null,
      media_size: frame.media_size ?? null,
      media_mime: frame.media_mime ?? null,
      sha256: frame.sha256 ?? null,
      created_at: ctx.clock.now(),
    };
    await ctx.ports.messages.insert(message);
    const conversation = await ctx.ports.conversations.get(conversation_id);
    ctx.trace.add('store', `INSERT messages(${conversation_id}, ${conversation?.type ?? 'dm'}) #${message_id} from ${user_id}`
      + (message.reply_to ? ` reply_to=#${message.reply_to}` : '')
      + (message.media_key ? ` media_key=${message.media_key}` : ''));
    await ctx.events.emit('message_stored', { message, sender: conn });

    // 2. Ack the sender. From here on the message exists for the sender; the queue append (B3) listens next.
    ctx.send(conn, { t: 'msg_ack', client_msg_id, message_id });
    ctx.trace.add('ack', `→ ${conn.name} {cid:${client_msg_id.slice(0, 8)}, id:#${message_id}}`);
    const members = conversation?.members ?? (await ctx.ports.conversations.membersOf(conversation_id));
    const recipient_devices = await recipientDevicesOf(members, device_id);
    await ctx.events.emit('message_acked', { message, sender: conn, recipient_devices });

    // 3. Direct push to every recipient device with a live socket; the rest is the queue's.
    const deliver = encodeFrame({ t: 'deliver', message, stream_id: streamIdOf(message_id) });
    const pushed: DeviceId[] = [];
    const pushedNames: string[] = [];
    for (const recipient of recipient_devices) {
      const dest = ctx.connections.byDevice(recipient);
      // `replay`: the sync module is draining the queue into this socket and the queue carries this message too.
      if (!dest || dest.phase !== 'live' || dest.closed || dest.socket.readyState !== dest.socket.OPEN) continue;
      const buffer = bufferOf(dest);
      const accepted = buffer.push(deliver, (reason) => {
        const why = reason === 'timeout' ? `not taken within ${opts.pushTimeoutMs} ms` : 'socket error';
        ctx.trace.add('lost', `#${message_id} → ${dest.name}: ${why}, left to the queue`);
      });
      if (accepted) {
        pushed.push(recipient);
        pushedNames.push(dest.name);
      } else {
        ctx.trace.add('lost', `#${message_id} → ${dest.name}: buffer full (${buffer.pending} pending), left to the queue`);
      }
    }
    if (pushed.length > 0) ctx.trace.add('push', `#${message_id} → ${pushedNames.join(', ')} over the socket`);
    await ctx.events.emit('message_fanout', { message, recipient_devices, pushed });
  });

  return () => {
    offDisconnected();
    for (const buffer of buffers.values()) buffer.clear();
    buffers.clear();
  };
}
