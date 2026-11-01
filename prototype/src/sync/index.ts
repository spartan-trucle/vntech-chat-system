/**
 * B3 · sync queue and replay (design §4.2, §4.4, §4.7; scenario S2).
 *
 * Third step of the write order: after B2 has stored the row and acked the sender, the
 * message id is appended to the stream of every recipient device (`XADD sq:{device}`).
 * On `hello` the device's cursor decides between replay and the slow path; the replay
 * drains the stream in batches of 100 before the connection goes live, each batch waited
 * on the device's `ack{up_to_stream_id}`. The ack is the only thing that moves the cursor,
 * the device keeps it, the server stores nothing (design §4.7).
 *
 * Waiting for the ack: the core runs `device_connected` beside the connection's frame
 * chain, not inside it, so acks sent during the replay reach `ctx.onFrame('ack')` while the
 * drain is waiting; the handler settles the per-connection waiter below.
 */

import { SNOWFLAKE_EPOCH_MS, type MessageId } from '../ids.js';
import { compareStreamIds, streamIdOf } from '../ports/index.js';
import type { DeviceId, StreamId } from '../protocol.js';
import type { Connection, ServerContext } from '../server.js';

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

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

type AckWait = 'acked' | 'timeout' | 'closed';

export function registerSync(ctx: ServerContext): () => void {
  const opts = resolveSyncOptions(ctx.moduleOptions['sync']);
  const queue = ctx.ports.syncQueue;

  /** Every device ever appended to: the port has no "list streams", the sweeper walks this. */
  const knownDevices = new Set<DeviceId>();
  /** `MINID` boundary of the last sweep that dropped entries from that device's stream. */
  const lastTrimmedId = new Map<DeviceId, StreamId>();
  /** Cursor to replay from, decided on `hello`, consumed on `device_connected`. */
  const replayFrom = new Map<string, StreamId>();
  /** Replays in flight, by connection: the ack handler feeds them, a disconnect aborts them. */
  const inFlight = new Map<string, { onAck: (sid: StreamId) => void; abort: () => void }>();

  const traceAck = (conn: Connection, sid: StreamId): void => {
    ctx.trace.add('queue', `${conn.name} ack sid=${sid} (device-owned cursor; server stores nothing)`);
  };

  // ---- append: third in the write order, after the sender's ack (design §4.2) ----
  const offAcked = ctx.events.on('message_acked', async ({ message, recipient_devices }) => {
    const id = streamIdOf(message.message_id);
    for (const device of recipient_devices) {
      await queue.xadd(device, { id, m: message.message_id, c: message.conversation_id });
      knownDevices.add(device);
    }
    if (recipient_devices.length > 0) armSweeper();
    ctx.trace.add('queue', `XADD sq:{device} #${message.message_id} × ${recipient_devices.length} devices`);
  });

  // ---- slow-path decision, before hello_ack (design §4.2, §4.7) ----
  const offHello = ctx.events.on('hello', async ({ conn, frame, ack }) => {
    const device = conn.device_id as DeviceId;
    const cursor = frame.last_synced_message_id;
    if (cursor === null) {
      // New or wiped device: it has no cursor, so it is treated as new (design §4.7) and loads via B4.
      ack.slow_path = true;
      ctx.trace.add('queue', `sq:${device}: no cursor → slow path (new device)`);
      return;
    }
    // Trimmed past the cursor: a sweep dropped entries from this stream and the cursor is below that
    // boundary, so entries in (cursor, boundary) may have existed. §4.7: when in doubt, replay more,
    // never less; the honest answer here is the slow path. A cursor at or above the boundary, or any
    // cursor on a stream that was never trimmed, replays: nothing above it can have been dropped.
    const trimmed = lastTrimmedId.get(device);
    if (trimmed !== undefined && compareStreamIds(cursor, trimmed) < 0) {
      ack.slow_path = true;
      const first = await queue.first(device);
      ctx.trace.add('queue', `sq:${device}: cursor ${cursor} behind the trim boundary ${trimmed} (oldest retained ${first ?? 'none'}) → slow path`);
      return;
    }
    replayFrom.set(conn.id, cursor);
  });

  // ---- replay: drain the stream in batches before live traffic (design §4.4) ----
  const replay = async (conn: Connection, cursor: StreamId): Promise<void> => {
    const device = conn.device_id as DeviceId;
    const acked: { last: StreamId | null } = { last: null };
    let waiter: { need: StreamId; settle: (how: AckWait) => void } | null = null;
    let closed = false;

    const onAck = (sid: StreamId): void => {
      if (acked.last === null || compareStreamIds(sid, acked.last) > 0) acked.last = sid;
      if (waiter && compareStreamIds(acked.last, waiter.need) >= 0) {
        const w = waiter;
        waiter = null;
        w.settle('acked');
      }
    };
    const abort = (): void => {
      closed = true;
      const w = waiter;
      waiter = null;
      w?.settle('closed');
    };
    const waitForAck = (need: StreamId): Promise<AckWait> => {
      if (closed) return Promise.resolve('closed');
      if (acked.last !== null && compareStreamIds(acked.last, need) >= 0) return Promise.resolve('acked');
      return new Promise<AckWait>((resolve) => {
        const pending = { need, settle: (how: AckWait): void => { ctx.timers.clearTimeout(timer); resolve(how); } };
        const timer = ctx.timers.setTimeout(() => {
          if (waiter !== pending) return; // already settled by an ack or a close
          waiter = null;
          resolve('timeout');
        }, opts.ackTimeoutMs);
        waiter = pending;
      });
    };

    inFlight.set(conn.id, { onAck, abort });
    try {
      let after = cursor;
      for (let batchNo = 0; ; batchNo += 1) {
        const batch = await queue.xrange(device, after, opts.batchSize);
        if (batch.length === 0) {
          // Return at once: the core flips the connection to `live` in this same microtask drain,
          // so nothing can be appended in between without being pushed live.
          if (batchNo === 0) ctx.trace.add('queue', `sq:${device} nothing past cursor ${after}; live traffic starts`);
          return;
        }
        ctx.trace.add('queue', `XRANGE sq:${device} (${after} + → ${batch.length} entries, join bodies from the store`);
        const rows = await ctx.ports.messages.getMany(batch.map((e) => ({ conversation_id: e.c, message_id: e.m })));
        const byId = new Map(rows.map((m) => [m.message_id, m]));
        for (const entry of batch) {
          const message = byId.get(entry.m);
          if (!message) continue; // the port skips missing rows; an id without a row is nothing to deliver
          if (!ctx.send(conn, { t: 'deliver', message, stream_id: entry.id })) return;
        }
        const last = batch[batch.length - 1]!.id;
        const how = await waitForAck(last);
        if (how === 'closed') return;
        if (how === 'timeout') {
          ctx.trace.add('lost', `replay sq:${device} → ${conn.name}: no ack for the batch up to ${last} within ${seconds(opts.ackTimeoutMs)}, stopped; the device keeps its cursor`);
          return;
        }
        after = acked.last ?? last;
      }
    } finally {
      if (inFlight.get(conn.id)?.abort === abort) inFlight.delete(conn.id);
    }
  };

  const offConnected = ctx.events.on('device_connected', async ({ conn }) => {
    const cursor = replayFrom.get(conn.id);
    replayFrom.delete(conn.id);
    if (cursor === undefined) return;
    await replay(conn, cursor);
  });

  const offDisconnected = ctx.events.on('device_disconnected', ({ conn }) => {
    replayFrom.delete(conn.id);
    inFlight.get(conn.id)?.abort();
    inFlight.delete(conn.id);
  });

  // ---- acks: the device advanced its cursor; the server keeps nothing (design §4.7) ----
  ctx.onFrame('ack', (conn, frame) => {
    traceAck(conn, frame.up_to_stream_id);
    inFlight.get(conn.id)?.onAck(frame.up_to_stream_id);
  });

  // ---- sweeper: XTRIM MINID <id windowMs ago> on every stream, every sweepMs (design §4.2, §4.5) ----
  // Armed by the first append: with no stream there is nothing to trim, and a server that has
  // never queued anything holds no timer of this module.
  let sweeper: unknown = null;
  const armSweeper = (): void => {
    if (sweeper !== null) return;
    sweeper = ctx.timers.setInterval(() => { void sweep(); }, opts.sweepMs);
  };
  const sweep = async (): Promise<void> => {
    const minId = streamIdOf(idAt(ctx.clock.now() - opts.windowMs));
    let dropped = 0;
    let streams = 0;
    for (const device of knownDevices) {
      const n = await queue.xtrim(device, minId);
      if (n === 0) continue;
      dropped += n;
      streams += 1;
      lastTrimmedId.set(device, minId);
    }
    if (dropped > 0) ctx.trace.add('queue', `XTRIM MINID ${minId} : ${dropped} entries across ${streams} streams`);
  };

  return () => {
    if (sweeper !== null) ctx.timers.clearInterval(sweeper);
    sweeper = null;
    for (const { abort } of [...inFlight.values()]) abort();
    inFlight.clear();
    offAcked();
    offHello();
    offConnected();
    offDisconnected();
  };
}
