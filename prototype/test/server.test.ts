import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createChatServer, type ChatServer } from '../src/server.js';
import { decodeFrame, encodeFrame, type ClientFrame, type ServerFrame } from '../src/protocol.js';
import { DEVICES } from '../src/fixtures.js';

/** Bare socket helper: no harness, so the core is tested on its own. */
class RawClient {
  readonly frames: ServerFrame[] = [];
  readonly ws: WebSocket;
  readonly closed: Promise<number>;
  private waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const f = decodeFrame(data.toString(), 'server');
      this.frames.push(f);
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(f);
    });
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(frame: ClientFrame | string): void {
    this.ws.send(typeof frame === 'string' ? frame : encodeFrame(frame));
  }
  next(t: ServerFrame['t'], timeoutMs = 1000): Promise<ServerFrame> {
    const hit = this.frames.find((f) => f.t === t);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${t} frame within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({ pred: (f) => f.t === t, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  }
}

const hello = (dev: { device_id: string; user_id: string }, cursor: string | null = null): ClientFrame => ({
  t: 'hello', device_id: dev.device_id, user_id: dev.user_id, last_synced_message_id: cursor, list_cursor: null, app_state: 'foreground',
});

describe('chat server core (composition root)', () => {
  let server: ChatServer;
  const clients: RawClient[] = [];
  const connect = async (): Promise<RawClient> => {
    const c = new RawClient(server.url);
    clients.push(c);
    await c.open();
    return c;
  };

  beforeEach(async () => {
    server = await createChatServer({ port: 0, serverId: 'srv-1' });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await server.close();
  });

  test('hello binds the connection, registers the route and device, answers hello_ack', async () => {
    const c = await connect();
    c.send(hello(DEVICES.trucPhone));
    const ack = await c.next('hello_ack');
    expect(ack).toMatchObject({ t: 'hello_ack' });
    expect(await server.ctx.ports.routes.get('truc', 'A1')).toBe('srv-1');
    expect((await server.ctx.ports.devices.devicesOf('truc')).map((d) => d.device_id)).toEqual(['A1']);
    const conn = server.ctx.connections.byDevice('A1');
    expect(conn?.user_id).toBe('truc');
    expect(conn?.phase).toBe('live');
    // No replay phase (live-first ADR): the connection is live at once; `mode` is the sync module's.
    expect(conn?.mode).toBe('live');
    expect(server.ctx.connections.byUser('truc').map((x) => x.device_id)).toEqual(['A1']);
  });

  test('any frame before hello is refused', async () => {
    const c = await connect();
    c.send({ t: 'ack', up_to_stream_id: '1-0' });
    expect(await c.next('error')).toMatchObject({ t: 'error', code: 'not_hello' });
  });

  test('a malformed frame is answered with an error, not a crash', async () => {
    const c = await connect();
    c.send('{"t":"msg"}');
    expect(await c.next('error')).toMatchObject({ t: 'error', code: 'bad_frame' });
    c.send('garbage');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.filter((f) => f.t === 'error')).toHaveLength(2);
  });

  test('frames after hello go to the handler registered for their type, in order', async () => {
    const seen: string[] = [];
    server.ctx.onFrame('ack', (conn, f) => { seen.push(`a:${conn.device_id}:${f.up_to_stream_id}`); });
    server.ctx.onFrame('ack', (_conn, f) => { seen.push(`b:${f.up_to_stream_id}`); });
    const c = await connect();
    c.send(hello(DEVICES.trucPhone));
    await c.next('hello_ack');
    c.send({ t: 'ack', up_to_stream_id: '7-0' });
    // The watch reply (B6) is the barrier: frames of one connection run in order, so the ack handlers ran first.
    c.send({ t: 'watch', user_ids: ['khanh'] });
    expect(await c.next('presence')).toMatchObject({ user_id: 'khanh' });
    expect(seen).toEqual(['a:A1:7-0', 'b:7-0']);
  });

  test('the hello event runs before hello_ack and may mark the slow path; device_connected runs on a live connection', async () => {
    const phases: string[] = [];
    server.ctx.events.on('hello', ({ conn, ack }) => {
      phases.push(`hello:${conn.phase}`);
      ack.slow_path = true;
    });
    server.ctx.events.on('device_connected', async ({ conn }) => {
      phases.push(`connected:${conn.phase}`);
      await new Promise((r) => setTimeout(r, 10));
    });
    const c = await connect();
    c.send(hello(DEVICES.trucPhone, '5-0'));
    const ack = await c.next('hello_ack');
    expect(ack).toMatchObject({ slow_path: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(phases).toEqual(['hello:handshake', 'connected:live']);
    expect(server.ctx.connections.byDevice('A1')?.phase).toBe('live');
  });

  test('frames sent after hello_ack reach their handlers while device_connected listeners are still running', async () => {
    // The replay runs beside the connection's frame chain (design §7.2, the B3 fix): an ack sent
    // during it must not sit behind the hello, whatever a listener is waiting on.
    let settle: (() => void) | undefined;
    const acked = new Promise<void>((resolve) => { settle = resolve; });
    const order: string[] = [];
    server.ctx.onFrame('ack', (_conn, f) => { order.push(`ack:${f.up_to_stream_id}`); settle?.(); });
    server.ctx.events.on('device_connected', async ({ conn }) => {
      order.push(`replay:${conn.phase}`);
      await Promise.race([acked, new Promise<void>((r) => setTimeout(r, 500))]);
      order.push(`drained:${conn.phase}`);
    });
    const c = await connect();
    c.send(hello(DEVICES.trucPhone, '1-0'));
    await c.next('hello_ack');
    c.send({ t: 'ack', up_to_stream_id: '9-0' });
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(['replay:live', 'ack:9-0', 'drained:live']);
    expect(server.ctx.connections.byDevice('A1')?.phase).toBe('live');
  });

  test('every connection owns a bounded push buffer sized by the push option; kill clears it and releases a waiting replay push', async () => {
    const tuned = await createChatServer({ port: 0, push: { maxPending: 1, pushTimeoutMs: 200 } });
    const c = new RawClient(tuned.url);
    clients.push(c);
    try {
      await c.open();
      c.send(hello(DEVICES.trucPhone));
      await c.next('hello_ack');
      const conn = tuned.ctx.connections.byDevice('A1')!;
      expect(conn.pushes.pending).toBe(0);
      expect(conn.pushes.pushLive('{"t":"presence","user_id":"khanh","state":"online"}', () => {})).toBe('accepted');
      expect(conn.pushes.pushLive('{"t":"presence","user_id":"khanh","state":"online"}', () => {})).toBe('full');
      const waiting = conn.pushes.pushReplay('{"t":"presence","user_id":"khanh","state":"offline"}');
      expect(conn.pushes.waiting).toBe(1);
      await tuned.ctx.kill(conn, 'dead');
      expect(await waiting).toBe(false);
      expect(conn.pushes.pending).toBe(0);
      expect(server.ctx.connections.all().every((x) => x.pushes !== undefined)).toBe(true);
    } finally {
      await tuned.close();
    }
  });

  test('a clean close removes the entry and the route and says whether it was the last device', async () => {
    const gone: Array<{ device_id: string | undefined; last_device: boolean; reason: string }> = [];
    server.ctx.events.on('device_disconnected', ({ conn, last_device, reason }) => {
      gone.push({ device_id: conn.device_id, last_device, reason });
    });
    const phone = await connect();
    const laptop = await connect();
    phone.send(hello(DEVICES.trucPhone));
    laptop.send(hello(DEVICES.trucLaptop));
    await phone.next('hello_ack');
    await laptop.next('hello_ack');
    phone.ws.close(1000);
    await phone.closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(await server.ctx.ports.routes.devicesOf('truc')).toEqual(['A2']);
    expect(server.ctx.connections.byDevice('A1')).toBeUndefined();
    laptop.ws.close(1000);
    await laptop.closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(gone).toEqual([
      { device_id: 'A1', last_device: false, reason: 'closed' },
      { device_id: 'A2', last_device: true, reason: 'closed' },
    ]);
  });

  test('kill terminates a connection the sweeper found dead and runs the same cleanup', async () => {
    const gone: string[] = [];
    server.ctx.events.on('device_disconnected', ({ conn, reason }) => { gone.push(`${conn.device_id}:${reason}`); });
    const c = await connect();
    c.send(hello(DEVICES.khanhPhone));
    await c.next('hello_ack');
    const conn = server.ctx.connections.byDevice('B1')!;
    await server.ctx.kill(conn, 'dead');
    expect(await c.closed).toBe(1006);
    expect(await server.ctx.ports.routes.get('khanh', 'B1')).toBeUndefined();
    expect(gone).toEqual(['B1:dead']);
  });

  test('a second hello for the same device supersedes the first connection without a presence event', async () => {
    const gone: string[] = [];
    server.ctx.events.on('device_disconnected', ({ conn, reason, last_device }) => { gone.push(`${conn.device_id}:${reason}:${last_device}`); });
    const first = await connect();
    first.send(hello(DEVICES.trucPhone));
    await first.next('hello_ack');
    const second = await connect();
    second.send(hello(DEVICES.trucPhone));
    await second.next('hello_ack');
    expect(await first.closed).toBe(1006);
    expect(server.ctx.connections.byDevice('A1')?.id).not.toBe(undefined);
    expect(server.ctx.connections.byUser('truc')).toHaveLength(1);
    expect(gone).toEqual(['A1:replaced:false']);
    expect(await server.ctx.ports.routes.get('truc', 'A1')).toBe('srv-1');
  });

  test('send writes a frame to one connection and reports false once it is gone', async () => {
    const c = await connect();
    c.send(hello(DEVICES.trucPhone));
    await c.next('hello_ack');
    const conn = server.ctx.connections.byDevice('A1')!;
    expect(server.ctx.send(conn, { t: 'presence', user_id: 'khanh', state: 'online' })).toBe(true);
    expect(await c.next('presence')).toMatchObject({ user_id: 'khanh' });
    await server.ctx.kill(conn, 'dead');
    expect(server.ctx.send(conn, { t: 'presence', user_id: 'khanh', state: 'online' })).toBe(false);
  });

  test('http beside the socket: /health from the core, registered routes with params and query, 404 otherwise', async () => {
    server.ctx.http.route('GET', '/probe/:id/things', async (req) => ({
      status: 200,
      body: { id: req.params['id'], limit: req.query['limit'] ?? null },
    }));
    server.ctx.http.route('POST', '/echo', async (req) => ({ status: 201, body: req.body }));
    const health = await fetch(`${server.httpUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, server_id: 'srv-1' });
    const page = await fetch(`${server.httpUrl}/probe/c1/things?limit=50`);
    expect(await page.json()).toEqual({ id: 'c1', limit: '50' });
    const echo = await fetch(`${server.httpUrl}/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
    expect(echo.status).toBe(201);
    expect(await echo.json()).toEqual({ a: 1 });
    expect((await fetch(`${server.httpUrl}/nope`)).status).toBe(404);
  });

  test('the server records a hop trace in the format of docs/prototype/index.html', async () => {
    const c = await connect();
    c.send(hello(DEVICES.trucPhone, '9-0'));
    await c.next('hello_ack');
    const rows = server.ctx.trace.rows();
    expect(rows.some((r) => r.tag === 'hb' && r.text === 'hello from Truc·phone cursor=9-0 → SET route:truc:A1')).toBe(true);
    expect(server.ctx.trace.format()[0]).toMatch(/^\d\d:\d\d:\d\d {2}\w+ +.+$/);
  });

  test('module options reach the context so a module can read its intervals without touching server.ts', async () => {
    const tuned = await createChatServer({ port: 0, moduleOptions: { connection: { pingMs: 50 } } });
    try {
      expect(tuned.ctx.moduleOptions['connection']).toEqual({ pingMs: 50 });
      expect(server.ctx.moduleOptions).toEqual({});
    } finally {
      await tuned.close();
    }
  });

  test('seeded fixtures: the three conversations of the clickable prototype exist', async () => {
    const seeded = await createChatServer({ port: 0, serverId: 'srv-2', seed: true });
    try {
      expect(await seeded.ctx.ports.conversations.membersOf('c2')).toEqual(['truc', 'khanh', 'linh', 'minh', 'an']);
      expect(await seeded.ctx.ports.conversations.membersOf('c1')).toEqual(['truc', 'khanh']);
      expect(await seeded.ctx.ports.conversations.membersOf('c3')).toEqual(['truc', 'linh']);
    } finally {
      await seeded.close();
    }
  });
});
