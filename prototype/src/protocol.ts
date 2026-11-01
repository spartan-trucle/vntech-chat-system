/**
 * Wire protocol between device and chat server (roadmap B0; design §1.2, §1.4, §3.4,
 * §4.2, §5.3). Every frame is one JSON text message with a discriminator `t`.
 *
 * IDs are decimal Snowflake strings (src/ids.ts). Stream ids are the sync-queue entry
 * ids (`<message_id>-0`, see src/ports/SyncQueue.ts). Timestamps are epoch milliseconds.
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
  media_key?: string;
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

export interface WatchFrame {
  t: 'watch';
  user_ids: UserId[];
}

export interface UnwatchFrame {
  t: 'unwatch';
  user_ids: UserId[];
}

export type ClientFrame = HelloFrame | MsgFrame | AckFrame | ClientReceiptFrame | WatchFrame | UnwatchFrame;

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
  stream_id: StreamId;
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

export type ServerFrame = HelloAckFrame | MsgAckFrame | DeliverFrame | ServerReceiptFrame | PresenceFrame | ErrorFrame;

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
  },
  ack: { up_to_stream_id: { type: 'string' } },
  receipt: { conversation_id: { type: 'string' }, last_read_id: { type: 'string' } },
  watch: { user_ids: { type: 'string[]' } },
  unwatch: { user_ids: { type: 'string[]' } },
};

const serverShapes: Record<ServerFrameType, Shape> = {
  hello_ack: { server_time: { type: 'number' }, slow_path: { type: 'boolean', optional: true } },
  msg_ack: { client_msg_id: { type: 'string' }, message_id: { type: 'string' } },
  deliver: { message: { type: 'object' }, stream_id: { type: 'string' } },
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
  return obj as unknown as Frame;
}

export function isClientFrameType(t: string): t is ClientFrameType {
  return t in clientShapes;
}
