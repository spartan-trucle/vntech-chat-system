/**
 * B3 · sync queue and replay (design §4.2, §4.4, §4.7; scenario S2).
 *
 * Third step of the write order: after B2 has stored the row and acked the sender, the
 * message id is appended to the stream of every recipient device (`XADD sq:{device}`).
 * On `hello` the device's cursor decides between replay and the slow path; the replay
 * drains the stream in batches of 100 before the connection goes live, each batch waited
 * on the device's `ack{up_to_stream_id}`. The ack is the only thing that moves the cursor,
 * the device keeps it, the server stores nothing (design §4.7).
 */

import { SNOWFLAKE_EPOCH_MS, type MessageId } from '../ids.js';
import type { ServerContext } from '../server.js';

export interface SyncOptions {
  /** `XRANGE … COUNT`: entries per replay batch, one ack per batch (design §4.2). */
  batchSize: number;
  /** How long a replay waits for the device's ack of a batch before giving up on it. */
  ackTimeoutMs: number;
  /** Sweeper period: `XTRIM MINID` on every stream (design §4.2, hourly). */
  sweepMs: number;
  /** Retention window the sweeper trims to (design §4.5, 24 h). */
  windowMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = { batchSize: 100, ackTimeoutMs: 5000, sweepMs: 3_600_000, windowMs: 86_400_000 };

/** `ctx.moduleOptions['sync']`, with defaults for whatever the caller left out. */
export function resolveSyncOptions(raw: unknown): SyncOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SyncOptions>;
  return { ...DEFAULT_SYNC_OPTIONS, ...given };
}

const TIMESTAMP_SHIFT = 22n; // 10 worker bits + 12 sequence bits (src/ids.ts)

/** The Snowflake id at `ms` (worker 0, sequence 0): every id minted at or after `ms` is ≥ it. */
export function idAt(ms: number): MessageId {
  const sinceEpoch = Math.max(0, Math.floor(ms) - SNOWFLAKE_EPOCH_MS);
  return (BigInt(sinceEpoch) << TIMESTAMP_SHIFT).toString(10);
}

export function registerSync(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Filled in step by step below.
}
