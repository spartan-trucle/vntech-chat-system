import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { InMemoryPresenceStore } from '../../src/ports/InMemoryPresenceStore.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { FakeTime, until, yieldToIo } from '../harness/FakeTime.js';

/**
 * Design §1.5 / §5.1: the presence lease in the store is renewed every 2 min with a 5 min
 * TTL, in one batch per server, and never on the pong path. `InMemoryPresenceStore.writes`
 * counts every `set`; a heartbeat-only run must not move it.
 */

const T0 = 1_700_000_000_000;
const PING = 5000;

describe('presence module: the lease is off the pong path', () => {
  let server: ChatServer;
  let time: FakeTime;
  let store: InMemoryPresenceStore;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<void> => {
    time = new FakeTime(T0);
    store = new InMemoryPresenceStore({ now: () => time.now() });
    server = await createChatServer({ port: 0, serverId: 'srv-1', clock: time, timers: time, ports: { presence: store } });
  };

  const client = async (dev: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(dev, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };

  const pongSeen = (device_id: string): Promise<void> =>
    new Promise((resolve) => server.ctx.connections.byDevice(device_id)!.socket.once('pong', () => resolve()));

  /** One ping period: the ping goes out, every device pongs, the sweeper runs five times. */
  const pingPeriod = async (devices: string[]): Promise<void> => {
    const pongs = devices.map(pongSeen);
    await time.advance(PING);
    await Promise.all(pongs);
  };

  const leaseRows = (): string[] => server.ctx.trace.rows().filter((r) => r.tag === 'presence' && /^lease renewed for/.test(r.text)).map((r) => r.text);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.close();
  });

  test('60 s of heartbeat on a connected device: one write at connect, none on any pong', async () => {
    await start();
    expect(store.writes).toBe(0);
    await client(DEVICES.trucPhone);
    expect(store.writes).toBe(1);
    for (let i = 0; i < 12; i++) {
      await pingPeriod(['A1']);
      expect(store.writes).toBe(1);
    }
    expect(time.now()).toBe(T0 + 60_000);
    expect(server.ctx.connections.byDevice('A1')).toBeDefined();
    expect(leaseRows()).toEqual([]);
  });

  test('at 2 min exactly one batch renews every online user with a 5 min TTL', async () => {
    await start();
    await client(DEVICES.trucPhone);
    await client(DEVICES.khanhPhone);
    expect(store.writes).toBe(2);
    for (let i = 0; i < 23; i++) await pingPeriod(['A1', 'B1']);
    await time.advance(4999);
    expect(time.now()).toBe(T0 + 119_999);
    expect(store.writes).toBe(2);
    const pongs = ['A1', 'B1'].map(pongSeen); // T0 + 120 s is also a ping tick
    await time.advance(1);
    await Promise.all(pongs);
    expect(store.writes).toBe(4);
    expect(leaseRows()).toEqual(['lease renewed for 2 users, 5 min TTL']);
    await time.advance(1000);
    await yieldToIo();
    expect(store.writes).toBe(4);
    expect(await store.get('truc')).toEqual({ state: 'online' });
    expect(await store.get('khanh')).toEqual({ state: 'online' });
  });

  test('the renewal interval exists only while someone is online', async () => {
    await start();
    expect(time.pending()).toBe(2); // B1: pinger and sweeper
    const truc = await client(DEVICES.trucPhone);
    expect(time.pending()).toBe(3);
    truc.closeCleanly();
    await until(() => server.ctx.connections.all().length === 0, 1000, 'gone');
    expect(time.pending()).toBe(4); // + the 5 s debounce
    await time.advance(5000);
    expect(time.pending()).toBe(2);
    expect(await store.get('truc')).toEqual({ state: 'offline', last_seen: T0 });
    await time.advance(120_000);
    expect(leaseRows()).toEqual([]);
  });
});
