import { compareIds, type MessageId } from '../ids.js';
import type { ConversationId, DeviceId, StreamId } from '../protocol.js';

/** What the appender writes: the message id and its conversation, nothing else (design §4.2). */
export interface StreamEntryBody {
  m: MessageId;
  c: ConversationId;
}

export interface StreamEntry extends StreamEntryBody {
  /** Store-assigned, Redis spelling `<ms>-<seq>`, increasing per stream (live-first ADR: `XADD … *`). */
  id: StreamId;
}

/** `xadd` did not answer within `xaddTimeoutMs`; the entry may or may not have landed. */
export class XaddTimeout extends Error {
  constructor(device_id: DeviceId, ms: number) {
    super(`XADD sq:${device_id}: no answer within ${ms} ms`);
    this.name = 'XaddTimeout';
  }
}

/**
 * The per-device sync queue of design §4.2 on Redis Streams, four operations plus the tail
 * read of the retry path (live-first ADR 2026-11-02):
 *
 *   XADD      sq:{device} MAXLEN ~ 100000 * m <message_id> c <conversation_id>
 *   XRANGE    sq:{device} (<cursor> + COUNT 100
 *   XTRIM     sq:{device} MINID <id 24 h ago>
 *   XRANGE    sq:{device} - + COUNT 1                       (`first`, the trim-boundary check)
 *   XREVRANGE sq:{device} + - COUNT 100                     (`xrevrange`, after an XADD timeout only)
 *
 * The store assigns the entry id, so appends to one stream need no ordering: a late append
 * lands behind the top entry and is replayed after the cursor. The store never dedups; the
 * appender's tail read on the retry path is best effort and the client's dedup by
 * `message_id` is the guarantee.
 */
export interface SyncQueue {
  /** Appends and returns the id the store assigned; rejects with `XaddTimeout` after `xaddTimeoutMs`. */
  xadd(device_id: DeviceId, entry: StreamEntryBody): Promise<StreamId>;
  /** Entries with id strictly greater than `after` (null = from the start), ascending, at most `count`. */
  xrange(device_id: DeviceId, after: StreamId | null, count: number): Promise<StreamEntry[]>;
  /** The newest `count` entries, newest first: the retry path's tail read. */
  xrevrange(device_id: DeviceId, count: number): Promise<StreamEntry[]>;
  /** Drops entries with id below `minId`; returns how many were dropped. */
  xtrim(device_id: DeviceId, minId: StreamId): Promise<number>;
  /** Oldest retained id, or null when the stream is empty. */
  first(device_id: DeviceId): Promise<StreamId | null>;
}

export function compareStreamIds(a: StreamId, b: StreamId): number {
  const [am, as = '0'] = a.split('-');
  const [bm, bs = '0'] = b.split('-');
  const c = compareIds(am ?? '0', bm ?? '0');
  return c !== 0 ? c : compareIds(as, bs);
}

const MAX_SEQ = 18446744073709551615n;

/**
 * The greatest id strictly below `id`: `XRANGE (<that>` reads from `id` inclusive, which is
 * where a backpressure re-replay starts (replay-mode ADR: inclusive of the dropped entry).
 */
export function streamIdJustBelow(id: StreamId): StreamId {
  const [ms = '0', seq = '0'] = id.split('-');
  if (seq !== '0') return `${ms}-${BigInt(seq) - 1n}`;
  const m = BigInt(ms);
  return m === 0n ? '0-0' : `${m - 1n}-${MAX_SEQ}`;
}
