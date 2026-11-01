/**
 * B6 · presence by subscription (design §5; scenario S5; presence ADR).
 *
 * Per user, in module memory, the state machine of §5.2:
 *
 *   offline ──connect (any device)──▶ online ──last device gone (§1.5)──▶ pending-offline
 *      ▲                                 ▲                                      │
 *      └──── debounce fires, last_seen ──┼──── a device connects inside it ─────┘
 *                                        └──── (nothing published)
 *
 * `online` is per user: one live device anywhere. Watchers are `watching[target] → set(conn)`
 * from `watch`/`unwatch` frames (§5.3); the server joins the `pres:{user}` channel of the
 * bus on its first watcher of a user and leaves on the last, so a transition is published
 * once and fanned out only to connections that asked. `watch` answers with the current
 * state at once, which is what lets the client's 500 ms batching and the 5 s debounce
 * compose: a watcher arriving during `pending-offline` is told `online` and is in the set
 * for the `offline` that may follow.
 *
 * The lease in the presence store (§1.5) is renewed every `leaseRenewMs` for every online
 * user in one batch with `leaseTtlMs`; the interval exists only while someone is online.
 * Nothing here runs on a pong: the only store writes are the two transitions and the batch.
 */

import type { PresenceFrame, UserId } from '../protocol.js';
import type { Connection, ServerContext, TimerHandle } from '../server.js';
import { formatClock } from '../trace.js';
import { InMemoryPresenceBus, type PresenceBus, type PresenceEvent } from './PresenceBus.js';

export interface PresenceOptions {
  /** `pending-offline` window; design §5.2 picks 5 s so a tunnel does not flap the dot. */
  debounceMs: number;
  /** Lease renewal period (design §1.5: 2 min). */
  leaseRenewMs: number;
  /** Lease TTL (design §1.5: 5 min). */
  leaseTtlMs: number;
  /** Cross-server fan-out channel; in-memory when absent (one server). */
  bus?: PresenceBus;
}

export const DEFAULT_PRESENCE_OPTIONS: Omit<PresenceOptions, 'bus'> = { debounceMs: 5000, leaseRenewMs: 120_000, leaseTtlMs: 300_000 };

/** `ctx.moduleOptions['presence']`, with defaults for whatever the caller left out. */
export function resolvePresenceOptions(raw: unknown): PresenceOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PresenceOptions>;
  const out: PresenceOptions = {
    debounceMs: given.debounceMs ?? DEFAULT_PRESENCE_OPTIONS.debounceMs,
    leaseRenewMs: given.leaseRenewMs ?? DEFAULT_PRESENCE_OPTIONS.leaseRenewMs,
    leaseTtlMs: given.leaseTtlMs ?? DEFAULT_PRESENCE_OPTIONS.leaseTtlMs,
  };
  if (given.bus) out.bus = given.bus;
  return out;
}

type UserState = 'offline' | 'online' | 'pending-offline';

interface UserPresence {
  state: UserState;
  /** Set on the transition to offline: the drop time (see `dropped_at`). */
  last_seen?: number;
  /** When the last device was last heard: `last_pong_at` for a dead socket, the close time otherwise. */
  dropped_at?: number;
  timer: TimerHandle | null;
}

const duration = (ms: number): string =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;

export function registerPresence(ctx: ServerContext): () => void {
  const opts = resolvePresenceOptions(ctx.moduleOptions['presence']);
  const bus: PresenceBus = opts.bus ?? new InMemoryPresenceBus();
  ctx.trace.add('presence', `presence: ${duration(opts.debounceMs)} debounce, lease renewed every ${duration(opts.leaseRenewMs)} with ${duration(opts.leaseTtlMs)} TTL`);

  const users = new Map<UserId, UserPresence>();
  const watching = new Map<UserId, Set<Connection>>();
  const subscriptions = new Map<UserId, () => void>();
  let lease: TimerHandle | null = null;

  // ---- frames -------------------------------------------------------------------------

  const frameOf = (event: PresenceEvent): PresenceFrame => {
    const frame: PresenceFrame = { t: 'presence', user_id: event.user_id, state: event.state };
    if (event.last_seen !== undefined) frame.last_seen = event.last_seen;
    return frame;
  };

  /** What a new watcher is told: `pending-offline` is still `online` to the outside (§5.2). */
  const currentState = (user_id: UserId): PresenceEvent => {
    const p = users.get(user_id);
    if (!p || p.state === 'offline') {
      const event: PresenceEvent = { user_id, state: 'offline' };
      if (p?.last_seen !== undefined) event.last_seen = p.last_seen;
      return event;
    }
    return { user_id, state: 'online' };
  };

  // ---- channel per watched user (§5.3) ----------------------------------------------------

  const deliver = (event: PresenceEvent): void => {
    const frame = frameOf(event);
    for (const conn of watching.get(event.user_id) ?? []) ctx.send(conn, frame);
  };

  const subscribeIfFirst = (user_id: UserId): void => {
    if (subscriptions.has(user_id)) return;
    subscriptions.set(user_id, bus.subscribe(user_id, deliver));
    ctx.trace.add('presence', `SUBSCRIBE pres:${user_id} (first watcher on this server)`);
  };

  const unsubscribeIfEmpty = (user_id: UserId): void => {
    const set = watching.get(user_id);
    if (set && set.size > 0) return;
    watching.delete(user_id);
    const off = subscriptions.get(user_id);
    if (!off) return;
    off();
    subscriptions.delete(user_id);
    ctx.trace.add('presence', `UNSUBSCRIBE pres:${user_id} (last watcher gone)`);
  };

  const publish = async (event: PresenceEvent): Promise<void> => {
    const names = [...(watching.get(event.user_id) ?? [])].map((c) => c.name).join(', ') || 'no watchers';
    const seen = event.last_seen !== undefined ? ` last_seen=${formatClock(event.last_seen)}` : '';
    ctx.trace.add('presence', `PUBLISH pres:${event.user_id} ${event.state}${seen} → ${names}`);
    await bus.publish(event.user_id, event);
  };

  ctx.onFrame('watch', (conn, frame) => {
    if (frame.user_ids.length === 0) return;
    for (const target of frame.user_ids) {
      let set = watching.get(target);
      if (!set) {
        set = new Set();
        watching.set(target, set);
      }
      set.add(conn);
      subscribeIfFirst(target);
      ctx.send(conn, frameOf(currentState(target)));
    }
    ctx.trace.add('presence', `${conn.name} watches ${frame.user_ids.join(', ')} → current state replied`);
  });

  ctx.onFrame('unwatch', (conn, frame) => {
    if (frame.user_ids.length === 0) return;
    for (const target of frame.user_ids) {
      watching.get(target)?.delete(conn);
      unsubscribeIfEmpty(target);
    }
    ctx.trace.add('presence', `${conn.name} unwatches ${frame.user_ids.join(', ')}`);
  });

  // ---- lease (§1.5): one batch per period, only while someone is online ------------------

  const onlineUsers = (): UserId[] => [...users].filter(([, p]) => p.state === 'online').map(([u]) => u);

  const disarmLeaseIfIdle = (): void => {
    if (lease === null || onlineUsers().length > 0) return;
    ctx.timers.clearInterval(lease);
    lease = null;
  };

  const renewLeases = async (): Promise<void> => {
    const online = onlineUsers();
    if (online.length === 0) {
      disarmLeaseIfIdle();
      return;
    }
    for (const user_id of online) await ctx.ports.presence.set(user_id, { state: 'online' }, opts.leaseTtlMs);
    ctx.trace.add('presence', `lease renewed for ${online.length} users, ${duration(opts.leaseTtlMs)} TTL`);
  };

  const armLease = (): void => {
    if (lease !== null) return;
    lease = ctx.timers.setInterval(() => void renewLeases(), opts.leaseRenewMs);
  };

  // ---- transitions (§5.2, §5.4) ------------------------------------------------------------

  const setOnline = async (conn: Connection): Promise<void> => {
    const user_id = conn.user_id!;
    const p = users.get(user_id);
    if (p?.state === 'pending-offline') {
      if (p.timer !== null) ctx.timers.clearTimeout(p.timer);
      p.timer = null;
      p.state = 'online';
      delete p.last_seen;
      delete p.dropped_at;
      ctx.trace.add('presence', `${user_id}: reconnected inside the ${duration(opts.debounceMs)} debounce, nothing published`);
      return;
    }
    if (p?.state === 'online') {
      ctx.trace.add('presence', `${user_id} already online; ${conn.name} is another device`);
      return;
    }
    users.set(user_id, { state: 'online', timer: null });
    armLease();
    await ctx.ports.presence.set(user_id, { state: 'online' }, opts.leaseTtlMs);
    await publish({ user_id, state: 'online' });
  };

  const goOffline = async (user_id: UserId): Promise<void> => {
    const p = users.get(user_id);
    if (!p || p.state !== 'pending-offline') return;
    p.timer = null;
    p.state = 'offline';
    p.last_seen = p.dropped_at ?? ctx.clock.now();
    delete p.dropped_at;
    await ctx.ports.presence.set(user_id, { state: 'offline', last_seen: p.last_seen }, opts.leaseTtlMs);
    await publish({ user_id, state: 'offline', last_seen: p.last_seen });
    disarmLeaseIfIdle();
  };

  const onDisconnected = (conn: Connection, reason: string, last_device: boolean): void => {
    // A watcher that is gone leaves every set it was in, whatever the reason.
    for (const [target, set] of [...watching]) {
      if (set.delete(conn)) unsubscribeIfEmpty(target);
    }
    if (!conn.user_id || reason === 'replaced') return; // the route belongs to the new connection
    const user_id = conn.user_id;
    if (!last_device) {
      ctx.trace.add('presence', `${user_id} still has another device connected; presence unchanged`);
      return;
    }
    const p = users.get(user_id);
    if (!p || p.state !== 'online') return; // never reached device_connected, or already pending
    p.state = 'pending-offline';
    p.dropped_at = reason === 'dead' ? conn.last_pong_at : ctx.clock.now();
    ctx.trace.add('presence', `${user_id}: last device gone → pending-offline, ${duration(opts.debounceMs)} debounce`);
    p.timer = ctx.timers.setTimeout(() => void goOffline(user_id), opts.debounceMs);
  };

  const offs = [
    ctx.events.on('device_connected', ({ conn }) => setOnline(conn)),
    ctx.events.on('device_disconnected', ({ conn, reason, last_device }) => onDisconnected(conn, reason, last_device)),
  ];

  return () => {
    for (const off of offs) off();
    if (lease !== null) ctx.timers.clearInterval(lease);
    lease = null;
    for (const p of users.values()) {
      if (p.timer !== null) ctx.timers.clearTimeout(p.timer);
      p.timer = null;
    }
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
    watching.clear();
  };
}
