/**
 * Composition root of the prototype chat server (roadmap B0).
 *
 * The core owns what every module needs and nothing a module owns: the socket and HTTP
 * listeners, the connection table of design §1.5, the `hello` handshake, frame dispatch,
 * a typed event bus, the ports, and the hop trace. Each module registers in its slot at
 * the bottom of this file and touches only its own directory.
 *
 * Scope guard (runtime ADR): one process, in memory, no auth, no persistence, no
 * multi-server. `serverId` exists only so route rows look like the design's.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Snowflake } from './ids.js';
import { decodeFrame, encodeFrame, FrameError, type AppState, type ClientFrame, type ClientFrameType, type DeviceId, type HelloAckFrame, type HelloFrame, type MsgFrame, type ServerFrame, type UserId } from './protocol.js';
import {
  InMemoryConversations, InMemoryCursors, InMemoryDevices, InMemoryMessageStore, InMemoryPresenceStore,
  InMemoryRouteTable, InMemorySummaries, InMemorySyncQueue,
  type Conversations, type Cursors, type Devices, type MessageStore, type PresenceStore, type RouteTable, type Summaries, type SyncQueue,
} from './ports/index.js';
import { Trace, type TraceTag } from './trace.js';
import { deviceName, seedFixtures } from './fixtures.js';
import { registerConnection } from './connection/index.js';
import { registerMessaging } from './messaging/index.js';
import { registerHistory } from './history/index.js';
import { registerSync } from './sync/index.js';
import { registerReceipts } from './receipts/index.js';
import { registerPresence } from './presence/index.js';
import { registerMedia } from './media/index.js';

// ---- clock and timers (injectable so B1 / B6 can run on fake time) -------------------

export interface Clock {
  now(): number;
}

export type TimerHandle = unknown;

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as NodeJS.Timeout),
};

// ---- connection table (design §1.5) -------------------------------------------------

export type ConnectionPhase = 'handshake' | 'replay' | 'live';

/** `conn_id → { user_id, device_id, last_pong_at, app_state }`, in process memory only. */
export interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly opened_at: number;
  user_id?: UserId;
  device_id?: DeviceId;
  app_state: AppState;
  /** Updated by the connection module on every pong; never written to a store. */
  last_pong_at: number;
  /** `replay` while the sync module drains the queue; live pushes wait for `live`. */
  phase: ConnectionPhase;
  closed: boolean;
  /** Display name for the trace, `Truc·phone`. */
  readonly name: string;
}

export type DisconnectReason = 'closed' | 'dead' | 'replaced' | 'shutdown';

export class ConnectionRegistry {
  private readonly byId = new Map<string, Connection>();
  private readonly byDeviceId = new Map<DeviceId, Connection>();

  all(): Connection[] {
    return [...this.byId.values()];
  }
  get(id: string): Connection | undefined {
    return this.byId.get(id);
  }
  byDevice(device_id: DeviceId): Connection | undefined {
    return this.byDeviceId.get(device_id);
  }
  byUser(user_id: UserId): Connection[] {
    return this.all().filter((c) => c.user_id === user_id && c.device_id !== undefined);
  }
  /** @internal */
  _add(conn: Connection): void {
    this.byId.set(conn.id, conn);
  }
  /** @internal */
  _bind(conn: Connection): void {
    if (conn.device_id) this.byDeviceId.set(conn.device_id, conn);
  }
  /** @internal */
  _remove(conn: Connection): void {
    this.byId.delete(conn.id);
    if (conn.device_id && this.byDeviceId.get(conn.device_id) === conn) this.byDeviceId.delete(conn.device_id);
  }
}

// ---- events ---------------------------------------------------------------------------

/**
 * The hooks modules plug into. Listeners run in registration order and are awaited one
 * after another, so the write order of design §4.2 is a property of the slot order below.
 */
export interface ServerEvents {
  /** A socket opened; no identity yet. The connection module attaches its pong handler here. */
  connection_opened: { conn: Connection };
  /** `hello` parsed, identity bound, route written; `ack` may be amended (e.g. `slow_path`). */
  hello: { conn: Connection; frame: HelloFrame; ack: HelloAckFrame };
  /**
   * `hello_ack` sent; the connection is in the `replay` phase until every listener returns,
   * then `live`. Runs beside the connection's frame chain, not inside it: later frames
   * (acks, the outbox flush) are handled while the listeners run.
   */
  device_connected: { conn: Connection; frame: HelloFrame };
  /** Entry removed and route deleted; `last_device` is the `SCARD route:{user} → 0` check of §1.5. */
  device_disconnected: { conn: Connection; reason: DisconnectReason; last_device: boolean };
  /**
   * Messaging: a `msg` passed membership and is about to be stored. A listener that calls
   * `reject` stops it: the sender gets an `error{code, message}` and nothing is written.
   * The media module validates the §6.2 metadata here.
   */
  message_received: { conn: Connection; frame: MsgFrame; reject: (code: string, message: string) => void };
  /** Messaging: row written to the message store (first in the write order). */
  message_stored: { message: import('./protocol.js').Message; sender: Connection };
  /** Messaging: `msg_ack` sent to the sender (second); the sync module appends to queues here (third). */
  message_acked: { message: import('./protocol.js').Message; sender: Connection; recipient_devices: DeviceId[] };
  /** Messaging: direct pushes done; `pushed` got a `deliver` over a live socket, the rest did not. */
  message_fanout: { message: import('./protocol.js').Message; recipient_devices: DeviceId[]; pushed: DeviceId[] };
}

type Listener<K extends keyof ServerEvents> = (payload: ServerEvents[K]) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Map<keyof ServerEvents, Listener<keyof ServerEvents>[]>();

  on<K extends keyof ServerEvents>(name: K, listener: Listener<K>): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as Listener<keyof ServerEvents>);
    this.listeners.set(name, list);
    return () => {
      const i = list.indexOf(listener as Listener<keyof ServerEvents>);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async emit<K extends keyof ServerEvents>(name: K, payload: ServerEvents[K]): Promise<void> {
    for (const listener of [...(this.listeners.get(name) ?? [])]) await listener(payload);
  }
}

// ---- http router ----------------------------------------------------------------------

export interface HttpRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
}

export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

export class HttpRouter {
  private readonly routes: Array<{ method: string; keys: string[]; re: RegExp; handler: HttpHandler }> = [];

  route(method: string, pattern: string, handler: HttpHandler): void {
    const keys: string[] = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
        keys.push(key);
        return '/([^/]+)';
      }) + '/?$',
    );
    this.routes.push({ method: method.toUpperCase(), keys, re, handler });
  }

  match(method: string, path: string): { handler: HttpHandler; params: Record<string, string> } | undefined {
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      return { handler: r.handler, params };
    }
    return undefined;
  }
}

// ---- context ---------------------------------------------------------------------------

export interface Ports {
  messages: MessageStore;
  syncQueue: SyncQueue;
  routes: RouteTable;
  presence: PresenceStore;
  summaries: Summaries;
  conversations: Conversations;
  cursors: Cursors;
  devices: Devices;
}

export type FrameHandler<T extends ClientFrameType> = (conn: Connection, frame: Extract<ClientFrame, { t: T }>) => void | Promise<void>;

export interface ServerContext {
  readonly serverId: string;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly ids: Snowflake;
  readonly ports: Ports;
  readonly connections: ConnectionRegistry;
  readonly events: EventBus;
  readonly http: HttpRouter;
  readonly trace: Trace;
  /** Per-module options keyed by module name (`connection`, `messaging`, …); tests tune intervals here. */
  readonly moduleOptions: Readonly<Record<string, unknown>>;
  /** Register a handler for a client frame type; several may share a type and run in order. */
  onFrame<T extends ClientFrameType>(t: T, handler: FrameHandler<T>): void;
  /** Write one frame; false if the socket is gone (the message then belongs to the queue). */
  send(conn: Connection, frame: ServerFrame): boolean;
  /** Close a connection the server decided is dead (or being replaced) and run the §1.5 cleanup. */
  kill(conn: Connection, reason: DisconnectReason): Promise<void>;
}

export interface ChatServerOptions {
  port?: number;
  host?: string;
  serverId?: string;
  clock?: Clock;
  timers?: Timers;
  ports?: Partial<Ports>;
  /** Seed the three conversations and six devices of docs/prototype/index.html. */
  seed?: boolean;
  /** Snowflake worker id; one server, so 0 unless a test needs two generators. */
  worker?: number;
  /** Per-module options, e.g. `{ connection: { pingMs: 50 } }`; each module reads only its own key. */
  moduleOptions?: Record<string, unknown>;
}

export interface ChatServer {
  readonly ctx: ServerContext;
  /** `ws://host:port` */
  readonly url: string;
  /** `http://host:port` */
  readonly httpUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createChatServer(opts: ChatServerOptions = {}): Promise<ChatServer> {
  const clock: Clock = opts.clock ?? { now: () => Date.now() };
  const timers = opts.timers ?? realTimers;
  const serverId = opts.serverId ?? 'srv-1';
  const ports: Ports = {
    messages: opts.ports?.messages ?? new InMemoryMessageStore({ now: () => clock.now() }),
    syncQueue: opts.ports?.syncQueue ?? new InMemorySyncQueue(),
    routes: opts.ports?.routes ?? new InMemoryRouteTable(),
    presence: opts.ports?.presence ?? new InMemoryPresenceStore({ now: () => clock.now() }),
    summaries: opts.ports?.summaries ?? new InMemorySummaries(),
    conversations: opts.ports?.conversations ?? new InMemoryConversations(),
    cursors: opts.ports?.cursors ?? new InMemoryCursors(),
    devices: opts.ports?.devices ?? new InMemoryDevices(),
  };
  if (opts.seed) await seedFixtures(ports);

  const connections = new ConnectionRegistry();
  const events = new EventBus();
  const http = new HttpRouter();
  const trace = new Trace({ now: () => clock.now() });
  const frameHandlers = new Map<ClientFrameType, FrameHandler<ClientFrameType>[]>();

  const send = (conn: Connection, frame: ServerFrame): boolean => {
    if (conn.closed || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(encodeFrame(frame));
    return true;
  };

  const sendError = (conn: Connection, code: string, message: string): void => {
    send(conn, { t: 'error', code, message });
  };

  /** Steps 1 and 2 of design §1.5, then the last-device check for step 3 (presence, B6). */
  const cleanup = async (conn: Connection, reason: DisconnectReason): Promise<void> => {
    if (conn.closed) return;
    conn.closed = true;
    connections._remove(conn);
    if (!conn.user_id || !conn.device_id) return;
    let last_device = false;
    if (reason === 'replaced') {
      // The route now belongs to the new connection; nothing to delete and presence is unchanged.
    } else {
      await ports.routes.delete(conn.user_id, conn.device_id);
      last_device = (await ports.routes.devicesOf(conn.user_id)).length === 0;
      const why = reason === 'dead' ? 'missed 2 pings, dead' : reason === 'closed' ? 'clean close' : 'server shutdown';
      trace.add('hb', `${conn.name} ${why} → DEL route:${conn.user_id}:${conn.device_id}`);
    }
    await events.emit('device_disconnected', { conn, reason, last_device });
  };

  const kill = async (conn: Connection, reason: DisconnectReason): Promise<void> => {
    conn.socket.terminate();
    await cleanup(conn, reason);
  };

  const onHello = async (conn: Connection, frame: HelloFrame): Promise<void> => {
    if (conn.user_id) {
      sendError(conn, 'already_hello', 'hello was already sent on this connection');
      return;
    }
    const previous = connections.byDevice(frame.device_id);
    conn.user_id = frame.user_id;
    conn.device_id = frame.device_id;
    conn.app_state = frame.app_state;
    (conn as { name: string }).name = deviceName(frame.device_id, frame.user_id);
    connections._bind(conn);
    if (previous && previous !== conn) await kill(previous, 'replaced');
    await ports.devices.register({ user_id: frame.user_id, device_id: frame.device_id, kind: 'phone' });
    await ports.routes.set(frame.user_id, frame.device_id, serverId);
    trace.add('hb', `hello from ${conn.name} cursor=${frame.last_synced_message_id ?? 'none'} → SET route:${frame.user_id}:${frame.device_id}`);
    const ack: HelloAckFrame = { t: 'hello_ack', server_time: clock.now() };
    await events.emit('hello', { conn, frame, ack });
    if (conn.closed) return;
    send(conn, ack);
    conn.phase = 'replay';
    // Detached from this connection's frame chain on purpose: the sync module replays in
    // batches and waits for the device's `ack` of each (design §4.4), so frames sent after
    // `hello_ack` must keep flowing to their handlers while the listeners run. The flip to
    // `live` happens in the microtask that follows the last listener's return.
    void events.emit('device_connected', { conn, frame })
      .catch((e) => sendError(conn, 'internal', e instanceof Error ? e.message : String(e)))
      .finally(() => { if (!conn.closed) conn.phase = 'live'; });
  };

  const onFrameMessage = async (conn: Connection, raw: string): Promise<void> => {
    let frame: ClientFrame;
    try {
      frame = decodeFrame(raw, 'client');
    } catch (e) {
      sendError(conn, 'bad_frame', e instanceof FrameError ? e.message : String(e));
      return;
    }
    if (frame.t === 'hello') {
      await onHello(conn, frame);
      return;
    }
    if (!conn.user_id) {
      sendError(conn, 'not_hello', `first frame must be hello, got ${frame.t}`);
      return;
    }
    const handlers = frameHandlers.get(frame.t);
    if (!handlers || handlers.length === 0) {
      sendError(conn, 'unhandled', `no module handles ${frame.t}`);
      return;
    }
    for (const h of handlers) await h(conn, frame);
  };

  const httpServer: HttpServer = createHttpServer((req, res) => void handleHttp(req, res));
  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reply = (status: number, body: unknown): void => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        reply(200, { ok: true, server_id: serverId, connections: connections.all().length });
        return;
      }
      const hit = http.match(req.method ?? 'GET', url.pathname);
      if (!hit) {
        reply(404, { error: 'not_found' });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          reply(400, { error: 'bad_json' });
          return;
        }
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      const out = await hit.handler({ method: req.method ?? 'GET', path: url.pathname, params: hit.params, query, body });
      reply(out.status, out.body);
    } catch (e) {
      reply(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (socket) => {
    const now = clock.now();
    const conn: Connection = {
      id: randomUUID(),
      socket,
      opened_at: now,
      app_state: 'foreground',
      last_pong_at: now,
      phase: 'handshake',
      closed: false,
      name: 'unknown',
    };
    connections._add(conn);
    let chain: Promise<void> = Promise.resolve();
    socket.on('message', (data) => {
      // Frames of one connection are handled strictly in order.
      chain = chain.then(() => onFrameMessage(conn, data.toString())).catch((e) => {
        sendError(conn, 'internal', e instanceof Error ? e.message : String(e));
      });
    });
    socket.on('close', () => {
      chain = chain.then(() => cleanup(conn, 'closed'));
    });
    socket.on('error', () => { /* surfaced as close */ });
    void events.emit('connection_opened', { conn });
  });

  const ctx: ServerContext = {
    serverId,
    clock,
    timers,
    ids: new Snowflake({ worker: opts.worker ?? 0, now: () => clock.now() }),
    ports,
    connections,
    events,
    http,
    trace,
    moduleOptions: { ...(opts.moduleOptions ?? {}) },
    onFrame: (t, handler) => {
      const list = frameHandlers.get(t) ?? [];
      list.push(handler as unknown as FrameHandler<ClientFrameType>);
      frameHandlers.set(t, list);
    },
    send,
    kill,
  };

  // ---- module registration slots: one per module, in write-order (design §4.2) ----
  const unregister: Array<() => void | Promise<void>> = [];
  const register = (fn: (ctx: ServerContext) => void | (() => void | Promise<void>)): void => {
    const off = fn(ctx);
    if (typeof off === 'function') unregister.push(off);
  };
  register(registerConnection); // B1: heartbeat, sweeper, death
  register(registerMessaging);  // B2: store, dedup, ack, direct push
  register(registerSync);       // B3: queue append after ack, replay on hello
  register(registerHistory);    // B4: page API, summaries, slow path
  register(registerReceipts);   // B5: cursors, unread, push notifications
  register(registerPresence);   // B6: state machine, watch/unwatch, lease
  register(registerMedia);      // B7: media intent and signed-URL stub

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const host = opts.host ?? '127.0.0.1';

  return {
    ctx,
    port: address.port,
    url: `ws://${host}:${address.port}`,
    httpUrl: `http://${host}:${address.port}`,
    async close() {
      for (const off of unregister.reverse()) await off();
      for (const conn of connections.all()) await kill(conn, 'shutdown');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export { Trace, type TraceTag };
