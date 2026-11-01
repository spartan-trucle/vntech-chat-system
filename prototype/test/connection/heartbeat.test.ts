import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer, type DisconnectReason, type Ports } from '../../src/server.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { resolveConnectionOptions } from '../../src/connection/index.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';

type Gone = { device_id: string | undefined; reason: DisconnectReason; last_device: boolean };

/** Wraps every port in a call counter, so a test can prove the heartbeat path never reaches one. */
function countingPorts(): { calls: string[]; wrap: (ports: Ports) => Ports } {
  const calls: string[] = [];
  const wrap = (ports: Ports): Ports => {
    const out = {} as Record<string, unknown>;
    for (const [name, port] of Object.entries(ports)) {
      out[name] = new Proxy(port as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push(`${name}.${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }
    return out as unknown as Ports;
  };
  return { calls, wrap };
}

describe('connection module: options', () => {
  test('defaults follow design §1.2 and §1.5: ping 5 s, dead after 10 s, sweep 1 s', () => {
    expect(resolveConnectionOptions(undefined)).toEqual({ pingMs: 5000, deadAfterMs: 10000, sweepMs: 1000 });
  });

  test('a partial override from moduleOptions keeps the other defaults', () => {
    expect(resolveConnectionOptions({ pingMs: 50 })).toEqual({ pingMs: 50, deadAfterMs: 10000, sweepMs: 1000 });
  });
});

describe('connection module: heartbeat, sweeper and death on fake time', () => {
  let server: ChatServer;
  let time: FakeTime;
  const gone: Gone[] = [];
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<void> => {
    time = new FakeTime(1_700_000_000_000);
    server = await createChatServer({ port: 0, serverId: 'srv-1', clock: time, timers: time });
    gone.length = 0;
    server.ctx.events.on('device_disconnected', ({ conn, reason, last_device }) => {
      gone.push({ device_id: conn.device_id, reason, last_device });
    });
  };

  const client = async (dev: FixtureDevice = DEVICES.trucPhone): Promise<ScriptedClient> => {
    const c = new ScriptedClient(dev, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };

  const pongSeen = (device_id: string): Promise<void> => {
    const conn = server.ctx.connections.byDevice(device_id)!;
    return new Promise((resolve) => conn.socket.once('pong', () => resolve()));
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.close();
  });

  test('a pong refreshes last_pong_at from the server clock and touches no port', async () => {
    const counting = countingPorts();
    await start();
    const c = await client();
    const conn = server.ctx.connections.byDevice('A1')!;
    const t0 = conn.last_pong_at;
    // Install the counter after hello, so only heartbeat traffic is measured.
    Object.assign(server.ctx.ports, counting.wrap(server.ctx.ports));
    const pong = pongSeen('A1');
    await time.advance(5000);
    await pong;
    expect(conn.last_pong_at).toBe(t0 + 5000);
    expect(c.lastPingAt).toBe(t0 + 5000);
    expect(counting.calls).toEqual([]);
  });

  test('pongs suppressed: still alive at 10 s, dead at the first sweep past 10 s (S1)', async () => {
    await start();
    const c = await client(DEVICES.khanhPhone);
    c.suppressPongs();
    await time.advance(10_000);
    expect(server.ctx.connections.byDevice('B1')).toBeDefined();
    expect(gone).toEqual([]);
    await time.advance(1000);
    await until(() => gone.length === 1, 1000, 'device_disconnected');
    expect(gone).toEqual([{ device_id: 'B1', reason: 'dead', last_device: true }]);
    expect(server.ctx.connections.byDevice('B1')).toBeUndefined();
    expect(await server.ctx.ports.routes.get('khanh', 'B1')).toBeUndefined();
    const hb = server.ctx.trace.rows().filter((r) => r.tag === 'hb').map((r) => r.text);
    expect(hb).toContain('Khanh·phone missed 2 pings, dead → DEL route:khanh:B1');
    expect(hb).toContain('Khanh·phone: no pong for 10 s, 1 missed');
    await until(() => !c.connected, 1000, 'client socket closed');
  });

  test('a healthy connection answers every ping and survives the sweeper for 30 s', async () => {
    await start();
    await client();
    const conn = server.ctx.connections.byDevice('A1')!;
    for (let i = 0; i < 6; i++) {
      const pong = pongSeen('A1');
      await time.advance(5000);
      await pong;
    }
    await time.advance(1000);
    expect(gone).toEqual([]);
    expect(server.ctx.connections.byDevice('A1')).toBe(conn);
    expect(conn.last_pong_at).toBe(time.now() - 1000);
    expect(server.ctx.trace.rows().filter((r) => r.tag === 'hb' && /no pong/.test(r.text))).toEqual([]);
  });

  test('a clean close is detected at once, with no time passing', async () => {
    await start();
    const c = await client();
    c.closeCleanly();
    await until(() => gone.length === 1, 1000, 'device_disconnected');
    expect(gone).toEqual([{ device_id: 'A1', reason: 'closed', last_device: true }]);
    expect(time.now()).toBe(1_700_000_000_000);
  });

  test('a socket that never sent hello is swept too', async () => {
    await start();
    const c = new ScriptedClient(DEVICES.trucLaptop, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false });
    clients.push(c);
    await c.connect();
    c.suppressPongs();
    expect(server.ctx.connections.all()).toHaveLength(1);
    await time.advance(11_000);
    await until(() => server.ctx.connections.all().length === 0, 1000, 'sweep');
    expect(gone).toEqual([]);
    await until(() => !c.connected, 1000, 'client socket closed');
    expect(server.ctx.trace.rows().some((r) => r.tag === 'hb' && /unidentified .* swept/.test(r.text))).toBe(true);
  });

  test('registration logs the intervals once and close() clears every timer', async () => {
    await start();
    const first = server.ctx.trace.rows()[0];
    expect(first).toMatchObject({ tag: 'hb', text: 'heartbeat: ping every 5 s, dead after 10 s, sweep every 1 s' });
    expect(time.pending()).toBe(2);
    await server.close();
    expect(time.pending()).toBe(0);
    server = await createChatServer({ port: 0, clock: time, timers: time }); // so afterEach has something to close
  });
});

describe('connection module: real timers, scaled down', () => {
  test('pongs suppressed and radio off: dead after ~100 ms with ping 50 / dead 100 / sweep 10', async () => {
    const server = await createChatServer({ port: 0, moduleOptions: { connection: { pingMs: 50, deadAfterMs: 100, sweepMs: 10 } } });
    const gone: Gone[] = [];
    server.ctx.events.on('device_disconnected', ({ conn, reason, last_device }) => { gone.push({ device_id: conn.device_id, reason, last_device }); });
    const c = new ScriptedClient(DEVICES.khanhPhone, { url: server.url, mirrorRule: false, reconnect: false });
    try {
      await c.connect();
      await c.hello();
      c.suppressPongs();
      c.blackhole();
      const t0 = Date.now();
      await until(() => gone.length === 1, 2000, 'death');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(600);
      expect(gone).toEqual([{ device_id: 'B1', reason: 'dead', last_device: true }]);
      expect(server.ctx.trace.rows().some((r) => r.text === 'Khanh·phone missed 2 pings, dead → DEL route:khanh:B1')).toBe(true);
    } finally {
      c.stop();
      await server.close();
    }
  });
});
