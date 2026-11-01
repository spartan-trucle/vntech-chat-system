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
import { streamIdOf } from '../ports/index.js';
import type { DeviceId, StreamId } from '../protocol.js';
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

export function registerSync(ctx: ServerContext): () => void {
  const queue = ctx.ports.syncQueue;

  /** Every device ever appended to: the port has no "list streams", the sweeper walks this. */
  const knownDevices = new Set<DeviceId>();
  /** `MINID` boundary of the last sweep that dropped entries from that device's stream. */
  const lastTrimmedId = new Map<DeviceId, StreamId>();

  // ---- append: third in the write order, after the sender's ack (design §4.2) ----
  const offAcked = ctx.events.on('message_acked', async ({ message, recipient_devices }) => {
    const id = streamIdOf(message.message_id);
    for (const device of recipient_devices) {
      await queue.xadd(device, { id, m: message.message_id, c: message.conversation_id });
      knownDevices.add(device);
    }
    ctx.trace.add('queue', `XADD sq:{device} #${message.message_id} × ${recipient_devices.length} devices`);
  });

  // ---- slow-path decision, before hello_ack (design §4.2, §4.7) ----
  const offHello = ctx.events.on('hello', ({ conn, frame, ack }) => {
    const device = conn.device_id as DeviceId;
    const cursor = frame.last_synced_message_id;
    if (cursor === null) {
      // New or wiped device: it has no cursor, so it is treated as new (design §4.7) and loads via B4.
      ack.slow_path = true;
      ctx.trace.add('queue', `sq:${device}: no cursor → slow path (new device)`);
      return;
    }
    void lastTrimmedId;
  });

  return () => {
    offAcked();
    offHello();
  };
}
