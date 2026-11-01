import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../src/server.js';
import { DEVICES, type FixtureDevice } from '../src/fixtures.js';
import { ScriptedClient } from './harness/ScriptedClient.js';

/** Waits for the server to see a pong (or not) after it pings a connection. */
function pongWithin(server: ChatServer, device_id: string, ms: number): Promise<boolean> {
  const conn = server.ctx.connections.byDevice(device_id)!;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    conn.socket.once('pong', () => { clearTimeout(timer); resolve(true); });
    conn.socket.ping();
  });
}

describe('ScriptedClient harness', () => {
  let server: ChatServer;
  const clients: ScriptedClient[] = [];
  const client = (dev: FixtureDevice = DEVICES.trucPhone): ScriptedClient => {
    const c = new ScriptedClient(dev, { url: server.url });
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    server = await createChatServer({ port: 0, serverId: 'srv-1', seed: true });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server.close();
  });

  test('connect + hello carries the fixture identity and the stored cursor', async () => {
    const c = client();
    c.cursor = '42-0';
    await c.connect();
    const ack = await c.hello();
    expect(ack.t).toBe('hello_ack');
    const conn = server.ctx.connections.byDevice('A1');
    expect(conn?.user_id).toBe('truc');
    expect(server.ctx.trace.rows().some((r) => r.text.includes('cursor=42-0'))).toBe(true);
  });

  test('pongs are answered by default and can be suppressed at runtime', async () => {
    const c = client();
    await c.connect();
    await c.hello();
    expect(await pongWithin(server, 'A1', 300)).toBe(true);
    c.suppressPongs();
    expect(await pongWithin(server, 'A1', 300)).toBe(false);
    c.allowPongs();
    expect(await pongWithin(server, 'A1', 300)).toBe(true);
  });

  test('destroyWithoutClose tears the socket down with no close frame: the server sees 1006', async () => {
    const codes: number[] = [];
    server.ctx.events.on('connection_opened', ({ conn }) => { conn.socket.on('close', (code) => codes.push(code)); });
    const c = client();
    await c.connect();
    await c.hello();
    c.destroyWithoutClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(codes).toEqual([1006]);
  });

  test('blackhole is a dead radio: the socket stays open for the server, nothing flows either way', async () => {
    const closes: number[] = [];
    server.ctx.events.on('connection_opened', ({ conn }) => { conn.socket.on('close', (code) => closes.push(code)); });
    const c = client();
    await c.connect();
    await c.hello();
    c.blackhole();
    expect(await pongWithin(server, 'A1', 300)).toBe(false);
    expect(closes).toEqual([]);
    expect(server.ctx.connections.byDevice('A1')).toBeDefined();
    c.send({ t: 'ack', up_to_stream_id: '1-0' });
    expect(c.trace.rows().at(-1)).toMatchObject({ tag: 'lost' });
    c.restoreRadio();
    expect(await pongWithin(server, 'A1', 300)).toBe(true);
  });

  test('replay runs a script in order and records a hop trace', async () => {
    const c = client(DEVICES.khanhPhone);
    const log: string[] = [];
    server.ctx.onFrame('watch', (conn, f) => {
      server.ctx.send(conn, { t: 'presence', user_id: f.user_ids[0]!, state: 'online' });
    });
    await c.replay([
      { run: async (self) => { await self.connect(); } },
      { run: async (self) => { await self.hello(); } },
      { note: 'watching truc' },
      { send: { t: 'watch', user_ids: ['truc'] } },
      { expect: 'presence' },
      { run: async () => { log.push('after presence'); } },
      { wait: 10 },
    ]);
    expect(log).toEqual(['after presence']);
    // B6 answers a watch with the current state before the stub above runs: hello_ack, then only presence frames.
    expect(c.received[0]?.t).toBe('hello_ack');
    expect(c.received.length).toBeGreaterThanOrEqual(2);
    expect(c.received.slice(1).every((f) => f.t === 'presence')).toBe(true);
    const tags = c.trace.rows().map((r) => r.tag);
    expect(tags).toContain('note');
    expect(tags).toContain('hello');
    expect(tags).toContain('presence');
    expect(c.trace.format().every((line) => /^\d\d:\d\d:\d\d {2}\w+ +.+$/.test(line))).toBe(true);
  });

  test('expect rejects when the frame never arrives', async () => {
    const c = client();
    await c.connect();
    await c.hello();
    await expect(c.expect('deliver', 50)).rejects.toThrow(/deliver/);
  });

  test('fixtures name the three devices like the clickable prototype', () => {
    expect(DEVICES.trucPhone).toMatchObject({ device_id: 'A1', user_id: 'truc', kind: 'phone', name: 'Truc·phone' });
    expect(DEVICES.trucLaptop).toMatchObject({ device_id: 'A2', user_id: 'truc', kind: 'laptop', name: 'Truc·laptop' });
    expect(DEVICES.khanhPhone).toMatchObject({ device_id: 'B1', user_id: 'khanh', kind: 'phone', name: 'Khanh·phone' });
  });
});
