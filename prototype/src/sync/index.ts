/**
 * B3 · sync queue and replay (design §4.2, §4.4, §4.7; scenario S2), rewritten by B10 for
 * the live-first and replay-mode ADRs (2026-11-02; scenario S7).
 *
 * Third step of the write order: after B2 has stored the row and acked the sender, the
 * message is appended to the stream of every recipient device (`XADD sq:{device} … *`, the
 * store assigns the entry id). On `hello` the device's cursor decides between replay and the
 * slow path. The core subscribes the connection to live pushes first (it is `live` the moment
 * `hello_ack` is sent); then the loop below runs `XRANGE (cursor + COUNT 100` until an empty
 * batch, pushing each entry as `deliver{replay: true}`, and sends `replay_done`. It never
 * waits for an ack: the ack handler traces and persists nothing (the device keeps its cursor,
 * design §4.7); the bounded per-destination buffer is the only flow control.
 *
 * Backpressure (replay-mode ADR): when the budget drops a live push to a connection, live
 * pushes to it are suspended, the buffer drains, and the same loop runs alone from the
 * dropped entry (`XRANGE (<id just below it>`) until an empty read, then `replay_done`, then
 * live resumes. A further drop during that loop lowers its start; the loop ends only on an
 * empty read. The connection's `mode` is `replay` while a loop runs; it is this module's.
 *
 * Retry path (design §4.2): an `XADD` that times out is followed by a tail read
 * (`XREVRANGE … COUNT 100`); the append is skipped if the message id is there, retried
 * once otherwise. Best effort: the client's dedup by `message_id` is the guarantee.
 */

import { compareStreamIds, streamIdJustBelow, XaddTimeout, type StreamEntryBody } from '../ports/index.js';
import { encodeFrame, type DeviceId, type StreamId } from '../protocol.js';
import type { Connection, ServerContext } from '../server.js';

export interface SyncOptions {
  /** `XRANGE … COUNT`: entries per replay read (design §4.2). */
  batchSize: number;
  /** Sweeper period: `XTRIM MINID` on every stream (design §4.2, hourly). */
  sweepMs: number;
  /** Retention window the sweeper trims to (design §4.5, 24 h). */
  windowMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = { batchSize: 100, sweepMs: 3_600_000, windowMs: 86_400_000 };

/** `ctx.moduleOptions['sync']`, with defaults for whatever the caller left out. */
export function resolveSyncOptions(raw: unknown): SyncOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SyncOptions>;
  return { ...DEFAULT_SYNC_OPTIONS, ...given };
}

/** The retry path's tail read, `XREVRANGE … COUNT 100` (design §4.2). */
const TAIL_COUNT = 100;

/** The sweeper's `MINID` for a window ending at `ms`: every entry the store minted at or after `ms` is at or above `<ms>-0`. */
export function trimBoundaryAt(ms: number): StreamId {
  return `${Math.max(0, Math.floor(ms))}-0`;
}

/** One replay loop in flight for a connection. */
interface Loop {
  /** Lowered by a drop while the loop runs: the next read restarts from here (replay-mode ADR). */
  floor: StreamId | null;
  /** True once live pushes are suspended for this loop (a backpressure re-replay). */
  alone: boolean;
}

export function registerSync(ctx: ServerContext): () => void {
  const opts = resolveSyncOptions(ctx.moduleOptions['sync']);
  const queue = ctx.ports.syncQueue;

  /** Every device ever appended to: the port has no "list streams", the sweeper walks this. */
  const knownDevices = new Set<DeviceId>();
  /** `MINID` boundary of the last sweep that dropped entries from that device's stream. */
  const lastTrimmedId = new Map<DeviceId, StreamId>();
  /** Cursor to replay from, decided on `hello`, consumed on `device_connected`. */
  const replayFrom = new Map<string, StreamId>();
  /** Replay loops in flight, by connection. */
  const loops = new Map<string, Loop>();

  // ---- append: third in the write order, after the sender's ack (design §4.2) ----
  const append = async (device: DeviceId, body: StreamEntryBody): Promise<StreamId> => {
    try {
      return await queue.xadd(device, body);
    } catch (e) {
      if (!(e instanceof XaddTimeout)) throw e;
      const tail = await queue.xrevrange(device, TAIL_COUNT);
      const present = tail.find((entry) => entry.m === body.m);
      if (present) {
        ctx.trace.add('queue', `XADD sq:${device} #${body.m} timed out → XREVRANGE tail: present as ${present.id}, append skipped`);
        return present.id;
      }
      ctx.trace.add('queue', `XADD sq:${device} #${body.m} timed out → XREVRANGE tail: absent, retried`);
      return queue.xadd(device, body);
    }
  };

  const offAcked = ctx.events.on('message_acked', async ({ message, recipient_devices, queued }) => {
    const body: StreamEntryBody = { m: message.message_id, c: message.conversation_id };
    for (const device of recipient_devices) {
      queued.set(device, await append(device, body));
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

  // ---- the replay loop (design §4.4; replay-mode ADR) ----
  /**
   * `XRANGE (after + COUNT n` until an empty read, each entry pushed as `deliver{replay: true}`
   * through the bounded buffer (waiting for room, never dropping), then `replay_done`. `alone`
   * is a backpressure re-replay: live pushes are already suspended and the buffer is let to
   * drain first; they resume after `replay_done` is on the wire.
   */
  const replay = async (conn: Connection, from: StreamId, alone: boolean): Promise<void> => {
    const device = conn.device_id as DeviceId;
    const loop: Loop = { floor: null, alone };
    loops.set(conn.id, loop);
    conn.mode = 'replay';
    let after = from;
    let total = 0;
    try {
      if (alone) await conn.pushes.drained();
      for (;;) {
        if (conn.closed) return;
        if (loop.floor !== null) {
          if (compareStreamIds(loop.floor, after) < 0) after = loop.floor;
          loop.floor = null;
        }
        const batch = await queue.xrange(device, after, opts.batchSize);
        if (batch.length === 0) {
          if (loop.floor !== null) continue; // a drop landed during the read: start again from its floor
          break;
        }
        ctx.trace.add('queue', `XRANGE sq:${device} (${after} + → ${batch.length} entries, join bodies from the store`);
        const rows = await ctx.ports.messages.getMany(batch.map((e) => ({ conversation_id: e.c, message_id: e.m })));
        const byId = new Map(rows.map((m) => [m.message_id, m]));
        for (const entry of batch) {
          const message = byId.get(entry.m);
          if (!message) continue; // the port skips missing rows; an id without a row is nothing to deliver
          const frame = encodeFrame({ t: 'deliver', message, stream_id: entry.id, replay: true });
          if (!(await conn.pushes.pushReplay(frame))) return; // cleared: the connection is gone
        }
        total += batch.length;
        after = batch[batch.length - 1]!.id;
      }
      if (conn.closed) return;
      // The single writer on the socket: replay_done is on the wire before live pushes resume.
      ctx.send(conn, { t: 'replay_done' });
      if (loop.alone) ctx.trace.add('queue', `sq:${device}: re-replay done → live pushes to ${conn.name} resumed`);
      else if (total === 0) ctx.trace.add('queue', `sq:${device} nothing past cursor ${from} → replay_done to ${conn.name}`);
      else ctx.trace.add('queue', `replay_done → ${conn.name} after ${total} entries; live frames may advance the cursor again`);
    } finally {
      if (loops.get(conn.id) === loop) loops.delete(conn.id);
      if (!conn.closed) conn.mode = 'live';
      if (loop.alone) conn.pushes.resumeLive();
    }
  };

  const offConnected = ctx.events.on('device_connected', ({ conn }) => {
    const cursor = replayFrom.get(conn.id);
    replayFrom.delete(conn.id);
    if (cursor === undefined) {
      // Slow path: nothing to replay, but the client entered replay mode at hello and must leave it.
      ctx.send(conn, { t: 'replay_done' });
      ctx.trace.add('queue', `sq:${conn.device_id}: nothing to replay → replay_done to ${conn.name}`);
      return;
    }
    // Detached: the loop runs beside the frame chain and beside the other listeners.
    void replay(conn, cursor, false).catch((e) => {
      ctx.trace.add('lost', `replay sq:${conn.device_id} → ${conn.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  // ---- a dropped live push: re-replay alone from the dropped entry (replay-mode ADR) ----
  const offDropped = ctx.events.on('push_dropped', ({ conn, stream_id }) => {
    if (conn.closed) return;
    const device = conn.device_id as DeviceId;
    const floor = streamIdJustBelow(stream_id);
    const running = loops.get(conn.id);
    if (running) {
      if (running.floor === null || compareStreamIds(floor, running.floor) < 0) running.floor = floor;
      if (!running.alone) {
        running.alone = true;
        conn.pushes.suspendLive();
        ctx.trace.add('queue', `sq:${device}: live push dropped at ${stream_id} during the replay → live frames to ${conn.name} suspended, loop extended`);
      } else {
        ctx.trace.add('queue', `sq:${device}: another live push dropped at ${stream_id} during the re-replay → loop extended`);
      }
      return;
    }
    conn.pushes.suspendLive();
    ctx.trace.add('queue', `sq:${device}: live push dropped at ${stream_id} → live frames to ${conn.name} suspended, re-replay from ${stream_id} once the buffer drains`);
    void replay(conn, floor, true).catch((e) => {
      ctx.trace.add('lost', `re-replay sq:${device} → ${conn.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  const offDisconnected = ctx.events.on('device_disconnected', ({ conn }) => {
    replayFrom.delete(conn.id);
    loops.delete(conn.id);
  });

  // ---- acks: the device advanced its cursor; the server keeps nothing (design §4.7) ----
  ctx.onFrame('ack', (conn, frame) => {
    ctx.trace.add('queue', `${conn.name} ack sid=${frame.up_to_stream_id} (device-owned cursor; server stores nothing)`);
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
    const minId = trimBoundaryAt(ctx.clock.now() - opts.windowMs);
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
    loops.clear();
    offAcked();
    offHello();
    offConnected();
    offDropped();
    offDisconnected();
  };
}
