/**
 * B1 · heartbeat, detection, death (design §1.2, §1.5).
 *
 * Server-initiated protocol pings every `pingMs` per connection; a pong only writes
 * `conn.last_pong_at` in memory from the server clock, never a port (design §1.5:
 * heartbeat traffic never touches Redis). A sweeper every `sweepMs` kills any connection
 * silent for more than `deadAfterMs`; `ctx.kill` does steps 1–2 of §1.5 and emits
 * `device_disconnected{last_device}` for presence (B6). Intervals come from
 * `moduleOptions.connection` so a test can scale them down or run on fake timers.
 */

import type { Connection, ServerContext } from '../server.js';

export interface ConnectionOptions {
  /** Ping interval per connection; design §1.3 picks 5 s for the 10 s F7 target. */
  pingMs: number;
  /** `now − last_pong_at` past which the sweeper kills the connection (two missed pongs). */
  deadAfterMs: number;
  /** Sweeper period over the local connection table. */
  sweepMs: number;
}

export const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = { pingMs: 5000, deadAfterMs: 10000, sweepMs: 1000 };

export function resolveConnectionOptions(raw: unknown): ConnectionOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ConnectionOptions>;
  return { ...DEFAULT_CONNECTION_OPTIONS, ...given };
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

export function registerConnection(ctx: ServerContext): () => void {
  const opts = resolveConnectionOptions(ctx.moduleOptions['connection']);
  ctx.trace.add('hb', `heartbeat: ping every ${seconds(opts.pingMs)}, dead after ${seconds(opts.deadAfterMs)}, sweep every ${seconds(opts.sweepMs)}`);

  ctx.events.on('connection_opened', ({ conn }) => {
    conn.socket.on('pong', () => {
      // Memory only. Nothing here may reach a port.
      conn.last_pong_at = ctx.clock.now();
    });
  });

  const ping = (conn: Connection, now: number): void => {
    if (conn.closed || conn.socket.readyState !== conn.socket.OPEN) return;
    const silent = now - conn.last_pong_at;
    const missed = Math.floor(silent / opts.pingMs) - 1;
    if (missed >= 1) ctx.trace.add('hb', `${conn.name}: no pong for ${seconds(silent)}, ${missed} missed`);
    conn.socket.ping();
  };

  const sweep = (conn: Connection, now: number): void => {
    if (conn.closed) return;
    const silent = now - conn.last_pong_at;
    if (silent <= opts.deadAfterMs) return;
    if (!conn.device_id) ctx.trace.add('hb', `unidentified socket silent for ${seconds(silent)} → swept`);
    void ctx.kill(conn, 'dead');
  };

  const pinger = ctx.timers.setInterval(() => {
    const now = ctx.clock.now();
    for (const conn of ctx.connections.all()) ping(conn, now);
  }, opts.pingMs);

  const sweeper = ctx.timers.setInterval(() => {
    const now = ctx.clock.now();
    for (const conn of ctx.connections.all()) sweep(conn, now);
  }, opts.sweepMs);

  return () => {
    ctx.timers.clearInterval(pinger);
    ctx.timers.clearInterval(sweeper);
  };
}
