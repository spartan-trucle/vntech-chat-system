import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import type { ConnectionOptions } from '../../src/connection/index.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { backoffDelay, DEFAULT_BACKOFF, ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';

const T0 = 1_700_000_000_000;
const hbRows = (c: ScriptedClient): string[] => c.trace.rows().filter((r) => r.tag === 'hb').map((r) => r.text);

describe('client backoff table (design §1.4)', () => {
  test('1 · 2 · 4 · 8 · 16 s, then capped at 30 s, when the jitter draw is the midpoint', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, DEFAULT_BACKOFF, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test('jitter stays inside ±30 % of the step, including at the cap', () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(700);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999999)).toBe(1300);
    expect(backoffDelay(9, DEFAULT_BACKOFF, () => 0)).toBe(21000);
    expect(backoffDelay(9, DEFAULT_BACKOFF, () => 0.999999)).toBe(39000);
    for (let i = 0; i < 1000; i++) {
      const d = backoffDelay(2, DEFAULT_BACKOFF, Math.random);
      expect(d).toBeGreaterThanOrEqual(2800);
      expect(d).toBeLessThanOrEqual(5200);
    }
  });
});

describe('client mirror rule, reconnect loop and outbox on fake time', () => {
  let server: ChatServer;
  let time: FakeTime;
  const clients: ScriptedClient[] = [];

  /** `QUIET` turns the server's own heartbeat off, so only the client's rule is under test. */
  const QUIET: Partial<ConnectionOptions> = { pingMs: 1e9, deadAfterMs: 1e9, sweepMs: 1e9 };
  const NO_SWEEP: Partial<ConnectionOptions> = { deadAfterMs: 1e9, sweepMs: 1e9 };
  const start = async (connection: Partial<ConnectionOptions> = {}): Promise<void> => {
    time = new FakeTime(T0);
    server = await createChatServer({ port: 0, serverId: 'srv-1', clock: time, timers: time, moduleOptions: { connection } });
  };

  const client = (dev: FixtureDevice = DEVICES.khanhPhone, over: Partial<ScriptedClientOptions> = {}): ScriptedClient => {
    const c = new ScriptedClient(dev, { url: server.url, now: () => time.now(), timers: time, reconnect: { random: () => 0.5 }, ...over });
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.close();
  });

  test('no ping for 15 s: the client closes the half-open socket itself and reconnects after 1 s', async () => {
    await start(QUIET);
    const c = client();
    await c.connect();
    await c.hello();
    expect(time.pending()).toBe(3); // server pinger + sweeper, client deadline
    await time.advance(14_999);
    expect(c.connected).toBe(true);
    await time.advance(1);
    expect(c.connected).toBe(false);
    expect(hbRows(c)).toContain('Khanh·phone: no ping for 15 s → socket is half-open, close and reconnect in 1 s');
    await time.advance(1000);
    await until(() => c.reconnects === 1, 2000, 'reconnect');
    expect(c.reconnectAttempts).toEqual([T0 + 16_000]);
    expect(c.connected).toBe(true);
    expect(hbRows(c)).toContain('Khanh·phone: reconnected on attempt 1, outbox empty');
  });

  test('every ping re-arms the deadline: it fires 15 s after the last ping, not after connect', async () => {
    await start(NO_SWEEP);
    const c = client();
    await c.connect();
    await c.hello();
    for (let i = 1; i <= 4; i++) {
      await time.advance(5000);
      await until(() => c.lastPingAt === T0 + i * 5000, 1000, `ping ${i}`);
    }
    c.blackhole();
    await time.advance(14_000);
    expect(c.connected).toBe(true);
    expect(time.now()).toBe(T0 + 34_000);
    await time.advance(1000);
    expect(c.connected).toBe(false);
    expect(hbRows(c).some((t) => t.startsWith('Khanh·phone: no ping for 15 s'))).toBe(true);
  });

  test('while the radio is off the retry schedule is 1 · 2 · 4 · 8 · 16 · 30 · 30 s; the first try after the radio is back succeeds', async () => {
    await start(QUIET);
    const c = client();
    await c.connect();
    await c.hello();
    c.blackhole();
    await time.advance(15_000);
    expect(c.connected).toBe(false);
    for (const step of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) await time.advance(step);
    const base = T0 + 15_000;
    expect(c.reconnectAttempts).toEqual([1000, 3000, 7000, 15000, 31000, 61000, 91000].map((d) => base + d));
    expect(hbRows(c)).toContain('Khanh·phone reconnect failed (no network); next try in 2 s');
    expect(hbRows(c)).toContain('Khanh·phone reconnect failed (no network); next try in 30 s');
    c.restoreRadio();
    await time.advance(30_000);
    await until(() => c.reconnects === 1, 2000, 'reconnect');
    expect(c.reconnectAttempts).toHaveLength(8);
    expect(await server.ctx.ports.routes.get('khanh', 'B1')).toBe('srv-1');
  });

  test('S1 round trip: pongs suppressed → server kills at 11 s → client reconnects at 12 s with its cursor and flushes the outbox in order', async () => {
    await start();
    const seen: string[] = [];
    let n = 0;
    server.ctx.onFrame('msg', (conn, f) => {
      seen.push(`${conn.device_id}:${f.client_msg_id}`);
      server.ctx.send(conn, { t: 'msg_ack', client_msg_id: f.client_msg_id, message_id: String(++n) });
    });
    const c = client();
    await c.connect();
    await c.hello();
    c.ack('7-0');
    const live = c.sendMessage({ conversation_id: 'c1', body: 'while online' });
    await until(() => c.outbox.length === 0, 1000, 'live ack');
    c.suppressPongs();
    await time.advance(11_000);
    await until(() => !c.connected, 1000, 'server kill seen');
    expect(server.ctx.connections.byDevice('B1')).toBeUndefined();
    expect(hbRows(c)).toContain('Khanh·phone: socket closed (1006) → reconnect in 1 s');
    const queued = ['one', 'two', 'three'].map((body) => c.sendMessage({ conversation_id: 'c1', body }));
    expect(c.outbox).toEqual(queued);
    expect(c.trace.rows().filter((r) => r.tag === 'lost')).toEqual([]);
    await time.advance(1000);
    await until(() => c.reconnects === 1 && c.outbox.length === 0, 2000, 'reconnect + flush');
    expect(c.reconnectAttempts).toEqual([T0 + 12_000]);
    expect(seen).toEqual([live, ...queued].map((f) => `B1:${f.client_msg_id}`));
    expect(server.ctx.trace.rows().some((r) => r.text === 'hello from Khanh·phone cursor=7-0 → SET route:khanh:B1')).toBe(true);
    expect(hbRows(c)).toContain('Khanh·phone: reconnected on attempt 1, flushing 3 from the outbox with the same client_msg_ids');
    expect(server.ctx.connections.byDevice('B1')).toBeDefined();
  });

  test('a close the client chose does not reconnect: closeCleanly, destroyWithoutClose, stop', async () => {
    await start(QUIET);
    const a = client(DEVICES.trucPhone);
    const b = client(DEVICES.trucLaptop);
    const k = client(DEVICES.khanhPhone);
    for (const c of [a, b, k]) { await c.connect(); await c.hello(); }
    expect(time.pending()).toBe(5);
    a.closeCleanly();
    b.destroyWithoutClose();
    k.stop();
    await until(() => server.ctx.connections.all().length === 0, 1000, 'all gone');
    await time.advance(60_000);
    expect(time.pending()).toBe(2);
    for (const c of [a, b, k]) {
      expect(c.reconnectAttempts).toEqual([]);
      expect(c.connected).toBe(false);
    }
  });

  test('mirror rule and reconnect can be switched off for tests that drive the socket by hand', async () => {
    await start(QUIET);
    const c = client(DEVICES.khanhPhone, { mirrorRule: false, reconnect: false });
    await c.connect();
    await c.hello();
    expect(time.pending()).toBe(2);
    await server.ctx.kill(server.ctx.connections.byDevice('B1')!, 'dead');
    await until(() => !c.connected, 1000, 'closed');
    await time.advance(60_000);
    expect(c.reconnectAttempts).toEqual([]);
    expect(time.pending()).toBe(2);
  });

  test('connect() while the radio is off fails like a dead network, and a manual hello flushes the outbox too', async () => {
    await start(QUIET);
    const c = client(DEVICES.khanhPhone, { reconnect: false });
    const seen: string[] = [];
    server.ctx.onFrame('msg', (conn, f) => {
      seen.push(f.client_msg_id);
      server.ctx.send(conn, { t: 'msg_ack', client_msg_id: f.client_msg_id, message_id: '1' });
    });
    const queued = c.sendMessage({ conversation_id: 'c1', body: 'before any connect' });
    c.radioOff = true;
    await expect(c.connect()).rejects.toThrow(/no network/);
    c.radioOff = false;
    await c.connect();
    await c.hello();
    await until(() => c.outbox.length === 0, 1000, 'ack');
    expect(seen).toEqual([queued.client_msg_id]);
  });
});
