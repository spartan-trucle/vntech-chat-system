import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer, type DisconnectReason } from '../../src/server.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { InMemoryPresenceStore } from '../../src/ports/InMemoryPresenceStore.js';
import { InMemoryPresenceBus } from '../../src/presence/PresenceBus.js';
import { DEFAULT_PRESENCE_OPTIONS, resolvePresenceOptions } from '../../src/presence/index.js';
import type { PresenceFrame } from '../../src/protocol.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { FakeTime, until, yieldToIo } from '../harness/FakeTime.js';

/**
 * Design §5.2–§5.4 on fake time shared by server and clients (scenario S5). Pings fire at
 * T0 + k·5 s (the pinger is armed when the server is created at T0), so a healthy client
 * is kept healthy by awaiting its pong across every ping tick, as B1's tests do.
 */

const T0 = 1_700_000_000_000;
const PING = 5000;
type Gone = { device_id: string | undefined; reason: DisconnectReason; last_device: boolean; at: number };

describe('presence module: options', () => {
  test('defaults follow design §5: 5 s debounce, lease renewed every 2 min with a 5 min TTL', () => {
    expect(DEFAULT_PRESENCE_OPTIONS).toEqual({ debounceMs: 5000, leaseRenewMs: 120_000, leaseTtlMs: 300_000 });
    expect(resolvePresenceOptions(undefined)).toMatchObject({ debounceMs: 5000, leaseRenewMs: 120_000, leaseTtlMs: 300_000 });
  });

  test('a partial override from moduleOptions keeps the other defaults and carries the bus', () => {
    const bus = new InMemoryPresenceBus();
    expect(resolvePresenceOptions({ debounceMs: 100, bus })).toMatchObject({ debounceMs: 100, leaseRenewMs: 120_000, leaseTtlMs: 300_000, bus });
  });
});

describe('presence module: state machine, watch/unwatch and fan-out on fake time', () => {
  let server: ChatServer;
  let time: FakeTime;
  let store: InMemoryPresenceStore;
  let bus: InMemoryPresenceBus;
  const gone: Gone[] = [];
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<void> => {
    time = new FakeTime(T0);
    store = new InMemoryPresenceStore({ now: () => time.now() });
    bus = new InMemoryPresenceBus();
    gone.length = 0;
    server = await createChatServer({
      port: 0, serverId: 'srv-1', seed: true, clock: time, timers: time,
      ports: { presence: store }, moduleOptions: { presence: { bus } },
    });
    server.ctx.events.on('device_disconnected', ({ conn, reason, last_device }) => {
      gone.push({ device_id: conn.device_id, reason, last_device, at: time.now() });
    });
  };

  const client = async (dev: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(dev, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };

  /** Watches now (the 500 ms batch is B6's client side; flushed here so the server side is under test). */
  const watchNow = async (c: ScriptedClient, user: string): Promise<PresenceFrame> => {
    const before = presenceOf(c, user).length;
    c.watch([user]);
    c.flushWatches();
    await until(() => presenceOf(c, user).length > before, 1000, `presence reply for ${user}`);
    return presenceOf(c, user)[before]!;
  };

  const presenceOf = (c: ScriptedClient, user: string): PresenceFrame[] =>
    c.received.filter((f): f is PresenceFrame => f.t === 'presence' && f.user_id === user);

  const rows = (): string[] => server.ctx.trace.rows().filter((r) => r.tag === 'presence').map((r) => r.text);

  const pongSeen = (device_id: string): Promise<void> => {
    const conn = server.ctx.connections.byDevice(device_id);
    if (!conn) return Promise.resolve();
    return new Promise((resolve) => conn.socket.once('pong', () => resolve()));
  };

  /** Advances `ms` in 1 s steps; across a ping tick, waits for the pong of every device in `pongers`. */
  const advance = async (ms: number, pongers: string[] = []): Promise<void> => {
    for (let left = ms; left > 0; left -= 1000) {
      const step = Math.min(1000, left);
      const crossesPing = Math.floor((time.now() + step - T0) / PING) > Math.floor((time.now() - T0) / PING);
      const pongs = crossesPing ? pongers.map(pongSeen) : [];
      await time.advance(step);
      await Promise.all(pongs);
      await yieldToIo();
    }
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.close();
  });

  test('watch replies with the current state; a user never seen is offline without last_seen; the channel is joined on the first watcher', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    expect(bus.subscribers('truc')).toBe(0);
    const reply = await watchNow(khanh, 'truc');
    expect(reply).toEqual({ t: 'presence', user_id: 'truc', state: 'offline' });
    expect(bus.subscribers('truc')).toBe(1);
    expect(rows()).toContain('SUBSCRIBE pres:truc (first watcher on this server)');
    expect(rows()).toContain('Khanh·phone watches truc → current state replied');
  });

  test('connect publishes online to watchers only and writes one lease', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    const linh = await client(DEVICES.linhBot);
    await watchNow(khanh, 'truc');
    const writes = store.writes;
    await client(DEVICES.trucPhone);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'online for Khanh');
    expect(presenceOf(khanh, 'truc')[1]).toEqual({ t: 'presence', user_id: 'truc', state: 'online' });
    expect(store.writes).toBe(writes + 1);
    expect(await store.get('truc')).toEqual({ state: 'online' });
    expect(rows()).toContain('PUBLISH pres:truc online → Khanh·phone');
    await advance(2000, ['A1', 'B1', 'C1']);
    expect(linh.received.filter((f) => f.t === 'presence')).toEqual([]);
  });

  test('S5: a drop at t is seen by the watcher as offline with last_seen=t at t+16 s (dead at t+11, 5 s debounce)', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    await watchNow(khanh, 'truc');
    const truc = await client(DEVICES.trucPhone);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'online for Khanh');
    await advance(PING, ['A1', 'B1']);
    const t = time.now();
    expect(server.ctx.connections.byDevice('A1')!.last_pong_at).toBe(t);
    truc.suppressPongs();
    truc.blackhole();

    let offlineAt: number | null = null;
    while (time.now() < t + 20_000) {
      await advance(1000, ['B1']);
      if (offlineAt === null && presenceOf(khanh, 'truc').some((f) => f.state === 'offline' && f.last_seen !== undefined)) offlineAt = time.now();
    }
    expect(gone).toEqual([{ device_id: 'A1', reason: 'dead', last_device: true, at: t + 11_000 }]);
    expect(offlineAt).not.toBeNull();
    expect(offlineAt! - t).toBeGreaterThanOrEqual(15_000);
    expect(offlineAt! - t).toBeLessThanOrEqual(17_000);
    expect(presenceOf(khanh, 'truc')).toEqual([
      { t: 'presence', user_id: 'truc', state: 'offline' },
      { t: 'presence', user_id: 'truc', state: 'online' },
      { t: 'presence', user_id: 'truc', state: 'offline', last_seen: t },
    ]);
    expect(await store.get('truc')).toEqual({ state: 'offline', last_seen: t });
    expect(rows()).toContain('truc: last device gone → pending-offline, 5 s debounce');
    expect(rows().some((r) => /^PUBLISH pres:truc offline last_seen=\d\d:\d\d:\d\d → Khanh·phone$/.test(r))).toBe(true);
  });

  test('S5 variant: another device of the user connects at t+12 s, inside the debounce → nothing emitted, state online', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    await watchNow(khanh, 'truc');
    const truc = await client(DEVICES.trucPhone);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'online for Khanh');
    await advance(PING, ['A1', 'B1']);
    const t = time.now();
    truc.suppressPongs();
    truc.blackhole();
    await advance(12_000, ['B1']);
    expect(gone.map((g) => g.at)).toEqual([t + 11_000]);
    const laptop = await client(DEVICES.trucLaptop);
    expect(rows()).toContain('truc: reconnected inside the 5 s debounce, nothing published');
    await advance(13_000, ['A2', 'B1']);
    expect(presenceOf(khanh, 'truc').map((f) => f.state)).toEqual(['offline', 'online']);
    expect(await store.get('truc')).toEqual({ state: 'online' });

    // The state was online: a clean close of the laptop starts a fresh debounce from the close time.
    laptop.closeCleanly();
    await until(() => gone.length === 2, 1000, 'laptop gone');
    const closedAt = time.now();
    expect(gone[1]).toMatchObject({ device_id: 'A2', reason: 'closed', last_device: true });
    await advance(4000, ['B1']);
    expect(presenceOf(khanh, 'truc')).toHaveLength(2);
    await advance(1000, ['B1']);
    await until(() => presenceOf(khanh, 'truc').length === 3, 1000, 'offline after the laptop');
    expect(presenceOf(khanh, 'truc')[2]).toEqual({ t: 'presence', user_id: 'truc', state: 'offline', last_seen: closedAt });
  });

  test('a watcher who subscribes during pending-offline is told online and then gets the offline event', async () => {
    await start();
    const truc = await client(DEVICES.trucPhone);
    truc.closeCleanly();
    await until(() => gone.length === 1, 1000, 'truc gone');
    const khanh = await client(DEVICES.khanhPhone);
    const reply = await watchNow(khanh, 'truc');
    expect(reply).toEqual({ t: 'presence', user_id: 'truc', state: 'online' });
    await advance(5000, ['B1']);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'offline');
    expect(presenceOf(khanh, 'truc')[1]).toMatchObject({ state: 'offline', last_seen: T0 });
  });

  test('unwatch stops events; the channel is left when the last watcher goes', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    const linh = await client(DEVICES.linhBot);
    await watchNow(khanh, 'truc');
    await watchNow(linh, 'truc');
    expect(bus.subscribers('truc')).toBe(1);
    khanh.unwatch(['truc']);
    khanh.flushWatches();
    await until(() => rows().includes('Khanh·phone unwatches truc'), 1000, 'unwatch row');
    expect(bus.subscribers('truc')).toBe(1);
    await client(DEVICES.trucPhone);
    await until(() => presenceOf(linh, 'truc').length === 2, 1000, 'online for Linh');
    expect(presenceOf(khanh, 'truc')).toHaveLength(1);
    expect(rows()).toContain('PUBLISH pres:truc online → Linh·bot');
    linh.closeCleanly();
    await until(() => bus.subscribers('truc') === 0, 1000, 'channel left');
    expect(rows()).toContain('UNSUBSCRIBE pres:truc (last watcher gone)');
  });

  test('a second device of an online user changes nothing, and losing one of two devices changes nothing', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    await watchNow(khanh, 'truc');
    const phone = await client(DEVICES.trucPhone);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'online');
    await client(DEVICES.trucLaptop);
    expect(rows()).toContain('truc already online; Truc·laptop is another device');
    phone.closeCleanly();
    await until(() => gone.length === 1, 1000, 'phone gone');
    expect(gone[0]).toMatchObject({ device_id: 'A1', last_device: false });
    expect(rows()).toContain('truc still has another device connected; presence unchanged');
    await advance(10_000, ['A2', 'B1']);
    expect(presenceOf(khanh, 'truc').map((f) => f.state)).toEqual(['offline', 'online']);
    expect(await store.get('truc')).toEqual({ state: 'online' });
  });

  test('a replaced connection (second hello for the same device) is not a presence transition', async () => {
    await start();
    const khanh = await client(DEVICES.khanhPhone);
    await watchNow(khanh, 'truc');
    await client(DEVICES.trucPhone);
    await until(() => presenceOf(khanh, 'truc').length === 2, 1000, 'online');
    await client(DEVICES.trucPhone);
    await until(() => gone.length === 1, 1000, 'first connection replaced');
    expect(gone[0]).toMatchObject({ device_id: 'A1', reason: 'replaced', last_device: false });
    await advance(10_000, ['A1', 'B1']);
    expect(presenceOf(khanh, 'truc').map((f) => f.state)).toEqual(['offline', 'online']);
    expect(rows().filter((r) => /pending-offline/.test(r))).toEqual([]);
  });

  test('close() leaves no timer: debounce timers and the lease interval are cleared, shutdown kills emit nothing', async () => {
    await start();
    const truc = await client(DEVICES.trucPhone);
    await client(DEVICES.khanhPhone);
    truc.closeCleanly();
    await until(() => gone.length === 1, 1000, 'truc gone');
    expect(time.pending()).toBeGreaterThan(2);
    await server.close();
    expect(time.pending()).toBe(0);
    server = await createChatServer({ port: 0, clock: time, timers: time }); // so afterEach has something to close
  });
});
