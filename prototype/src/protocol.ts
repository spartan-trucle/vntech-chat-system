/**
 * Wire protocol between device and chat server (roadmap B0; design §1.2, §1.4, §3.4,
 * §4.2, §5.3). Every frame is one JSON text message with a discriminator `t`.
 *
 * IDs are decimal Snowflake strings (src/ids.ts). Stream ids are the sync-queue entry
 * ids the store assigned (`<ms>-<seq>`, see src/ports/SyncQueue.ts). Timestamps are epoch
 * milliseconds.
 *
 * Replay-mode boundary (ADR 2026-11-02): `deliver.replay` says whether the frame came from
 * the server's replay loop (`true`) or is a live push (`false`); `replay_done` closes a
 * replay. The client applies a live frame's `stream_id` to its cursor only outside replay
 * mode; inside it the cursor moves by `ack{up_to_stream_id}` alone.
 *
 * Delivered receipt (ADR 2026-11-02, design §3.4): `delivered{conversation_id,
 * up_to_message_id}` says the device stored every message of the conversation up to that
 * id, in replay mode and live mode alike. A different key and owner from the ack: the ack
 * is one stream id per device (the device's sync cursor), this is one message id per
 * conversation per device (the server's delivery cursor for F8).
 */

import type { MessageId } from './ids.js';

export type UserId = string;
export type DeviceId = string;
export type ConversationId = string;
export type StreamId = string;
export type AppState = 'foreground' | 'background';
export type PresenceState = 'online' | 'offline';

/** One row of the `messages` table in design §2.2. */
export interface Message {
  conversation_id: ConversationId;
  bucket: number;
  message_id: MessageId;
  sender_id: UserId;
  client_msg_id: string;
  body: string;
  /** Stored as an ID only; quoting is undecided (roadmap A3, reply quoting). */
  reply_to: MessageId | null;
  media_key: string | null;
  media_size: number | null;
  media_mime: string | null;
  /** Digest the client computed before upload; recipients verify the download (design §6.2). */
  sha256: string | null;
  created_at: number;
}

// ---- client → server ------------------------------------------------------------

export interface HelloFrame {
  t: 'hello';
  device_id: DeviceId;
  user_id: UserId;
  /** Sync-queue cursor: last acked stream id, or null for a new device (design §4.7). */
  last_synced_message_id: StreamId | null;
  /** Newest `last_at` the device has seen in its chat list, or null (design §4.3). */
  list_cursor: number | null;
  app_state: AppState;
}

export interface MsgFrame {
  t: 'msg';
  client_msg_id: string;
  conversation_id: ConversationId;
  body: string;
  reply_to?: MessageId;
  /** Set only after the upload completed (design §6.2); the three fields below travel with it. */
  media_key?: string;
  media_size?: number;
  media_mime?: string;
  sha256?: string;
}

export interface AckFrame {
  t: 'ack';
  up_to_stream_id: StreamId;
}

export interface ClientReceiptFrame {
  t: 'receipt';
  conversation_id: ConversationId;
  last_read_id: MessageId;
}

/** The device stored every message of the conversation up to this id (delivered-receipt ADR). */
export interface DeliveredFrame {
  t: 'delivered';
  conversation_id: ConversationId;
  up_to_message_id: MessageId;
}

export interface WatchFrame {
  t: 'watch';
  user_ids: UserId[];
}

export interface UnwatchFrame {
  t: 'unwatch';
  user_ids: UserId[];
}

export type ClientFrame = HelloFrame | MsgFrame | AckFrame | ClientReceiptFrame | DeliveredFrame | WatchFrame | UnwatchFrame;

// ---- server → client ------------------------------------------------------------

export interface HelloAckFrame {
  t: 'hello_ack';
  server_time: number;
  /** Set when the device's stream is trimmed past its cursor (design §4.2); B3. */
  slow_path?: boolean;
}

export interface MsgAckFrame {
  t: 'msg_ack';
  client_msg_id: string;
  message_id: MessageId;
}

export interface DeliverFrame {
  t: 'deliver';
  message: Message;
  /** The entry id in the device's sync queue; the cursor the device acks or applies. */
  stream_id: StreamId;
  /** `true` from the replay loop (`XRANGE`), `false` for a live push (replay-mode ADR). */
  replay: boolean;
}

/** End of a replay: the next live frame's `stream_id` may advance the cursor again. */
export interface ReplayDoneFrame {
  t: 'replay_done';
}

export interface ServerReceiptFrame {
  t: 'receipt';
  conversation_id: ConversationId;
  user_id: UserId;
  last_read_id: MessageId;
}

export interface PresenceFrame {
  t: 'presence';
  user_id: UserId;
  state: PresenceState;
  last_seen?: number;
}

export interface ErrorFrame {
  t: 'error';
  code: string;
  message: string;
}

export type ServerFrame = HelloAckFrame | MsgAckFrame | DeliverFrame | ReplayDoneFrame | ServerReceiptFrame | PresenceFrame | ErrorFrame;

export type Frame = ClientFrame | ServerFrame;
export type ClientFrameType = ClientFrame['t'];
export type ServerFrameType = ServerFrame['t'];

// ---- encode / decode ------------------------------------------------------------

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

type Field = 'string' | 'number' | 'boolean' | 'string[]' | 'string|null' | 'number|null' | 'object';
type Shape = Record<string, { type: Field; optional?: boolean; enum?: readonly string[] }>;

const messageShape: Shape = {
  conversation_id: { type: 'string' },
  bucket: { type: 'number' },
  message_id: { type: 'string' },
  sender_id: { type: 'string' },
  client_msg_id: { type: 'string' },
  body: { type: 'string' },
  reply_to: { type: 'string|null' },
  media_key: { type: 'string|null' },
  media_size: { type: 'number|null' },
  media_mime: { type: 'string|null' },
  sha256: { type: 'string|null' },
  created_at: { type: 'number' },
};

const clientShapes: Record<ClientFrameType, Shape> = {
  hello: {
    device_id: { type: 'string' },
    user_id: { type: 'string' },
    last_synced_message_id: { type: 'string|null' },
    list_cursor: { type: 'number|null' },
    app_state: { type: 'string', enum: ['foreground', 'background'] },
  },
  msg: {
    client_msg_id: { type: 'string' },
    conversation_id: { type: 'string' },
    body: { type: 'string' },
    reply_to: { type: 'string', optional: true },
    media_key: { type: 'string', optional: true },
    media_size: { type: 'number', optional: true },
    media_mime: { type: 'string', optional: true },
    sha256: { type: 'string', optional: true },
  },
  ack: { up_to_stream_id: { type: 'string' } },
  receipt: { conversation_id: { type: 'string' }, last_read_id: { type: 'string' } },
  delivered: { conversation_id: { type: 'string' }, up_to_message_id: { type: 'string' } },
  watch: { user_ids: { type: 'string[]' } },
  unwatch: { user_ids: { type: 'string[]' } },
};

const serverShapes: Record<ServerFrameType, Shape> = {
  hello_ack: { server_time: { type: 'number' }, slow_path: { type: 'boolean', optional: true } },
  msg_ack: { client_msg_id: { type: 'string' }, message_id: { type: 'string' } },
  deliver: { message: { type: 'object' }, stream_id: { type: 'string' }, replay: { type: 'boolean' } },
  replay_done: {},
  receipt: { conversation_id: { type: 'string' }, user_id: { type: 'string' }, last_read_id: { type: 'string' } },
  presence: {
    user_id: { type: 'string' },
    state: { type: 'string', enum: ['online', 'offline'] },
    last_seen: { type: 'number', optional: true },
  },
  error: { code: { type: 'string' }, message: { type: 'string' } },
};

function checkField(frameType: string, name: string, value: unknown, spec: Shape[string]): void {
  if (value === undefined) {
    if (spec.optional) return;
    throw new FrameError(`${frameType}: missing field ${name}`);
  }
  const ok = (() => {
    switch (spec.type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
      case 'string|null': return value === null || typeof value === 'string';
      case 'number|null': return value === null || (typeof value === 'number' && Number.isFinite(value));
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
  })();
  if (!ok) throw new FrameError(`${frameType}: field ${name} has the wrong type`);
  if (spec.enum && !spec.enum.includes(value as string)) {
    throw new FrameError(`${frameType}: field ${name} must be one of ${spec.enum.join(', ')}`);
  }
}

function checkShape(frameType: string, obj: Record<string, unknown>, shape: Shape): void {
  for (const [name, spec] of Object.entries(shape)) checkField(frameType, name, obj[name], spec);
}

export function decodeFrame(raw: string | Buffer, from: 'client'): ClientFrame;
export function decodeFrame(raw: string | Buffer, from: 'server'): ServerFrame;
export function decodeFrame(raw: string | Buffer, from: 'client' | 'server'): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new FrameError('frame is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new FrameError('frame is not an object');
  const obj = parsed as Record<string, unknown>;
  const t = obj['t'];
  if (typeof t !== 'string') throw new FrameError('frame has no type');
  const shapes: Record<string, Shape> = from === 'client' ? clientShapes : serverShapes;
  const shape = shapes[t];
  if (!shape) throw new FrameError(`unknown ${from} frame type ${t}`);
  checkShape(t, obj, shape);
  if (t === 'deliver') checkShape('deliver.message', obj['message'] as Record<string, unknown>, messageShape);
  if (t === 'msg' && obj['media_key'] === undefined) {
    for (const name of ['media_size', 'media_mime', 'sha256']) {
      if (obj[name] !== undefined) throw new FrameError(`msg: field ${name} is only valid together with media_key`);
    }
  }
  return obj as unknown as Frame;
}

export function isClientFrameType(t: string): t is ClientFrameType {
  return t in clientShapes;
}
