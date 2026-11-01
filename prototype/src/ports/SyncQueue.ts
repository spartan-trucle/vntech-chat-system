import { compareIds, type MessageId } from '../ids.js';
import type { ConversationId, DeviceId, StreamId } from '../protocol.js';

export interface StreamEntry {
  /** Client-chosen, Snowflake-derived, so retries of `xadd` are idempotent (design §4.2). */
  id: StreamId;
  m: MessageId;
  c: ConversationId;
}

/**
 * The per-device sync queue of design §4.2: exactly the three Redis Streams operations,
 * plus `first` (XINFO STREAM first-entry) to detect a cursor that has been trimmed past.
 *
 *   XADD   sq:{device} MAXLEN ~ 100000 <id> m <message_id> c <conversation_id>
 *   XRANGE sq:{device} (<cursor> + COUNT 100
 *   XTRIM  sq:{device} MINID <id 24 h ago>
 */
export interface SyncQueue {
  xadd(device_id: DeviceId, entry: StreamEntry): Promise<StreamId>;
  /** Entries with id strictly greater than `after` (null = from the start), ascending, at most `count`. */
  xrange(device_id: DeviceId, after: StreamId | null, count: number): Promise<StreamEntry[]>;
  /** Drops entries with id below `minId`; returns how many were dropped. */
  xtrim(device_id: DeviceId, minId: StreamId): Promise<number>;
  /** Oldest retained id, or null when the stream is empty. */
  first(device_id: DeviceId): Promise<StreamId | null>;
}

/** Stream id derived from the message id, in Redis `<ms>-<seq>` spelling. */
export function streamIdOf(message_id: MessageId): StreamId {
  return `${message_id}-0`;
}

export function messageIdOfStream(id: StreamId): MessageId {
  const dash = id.indexOf('-');
  return dash < 0 ? id : id.slice(0, dash);
}

export function compareStreamIds(a: StreamId, b: StreamId): number {
  const [am, as = '0'] = a.split('-');
  const [bm, bs = '0'] = b.split('-');
  const c = compareIds(am ?? '0', bm ?? '0');
  return c !== 0 ? c : compareIds(as, bs);
}
