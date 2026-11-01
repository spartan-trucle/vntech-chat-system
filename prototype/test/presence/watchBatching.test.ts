import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import type { ConnectionOptions } from '../../src/connection/index.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until, yieldToIo } from '../harness/FakeTime.js';

/**
 * ADR condition: the client batches watch/unwatch per 500 ms, so scrolling a long list
 * does not turn into a frame per row. Net of cancellations: a watch undone inside the
 * window never leaves the device.
 */

const T0 = 1_700_000_000_000;
type Seen = { t: 'watch' | 'unwatch'; from: string | undefined; user_ids: string[] };

describe('harness: watch/unwatch batching per 500 ms', () => {
  let server: ChatServer;
  let time: FakeTime;
  const seen: Seen[] = [];
  const clients: ScriptedClient[] = [];
  const QUIET: Partial<ConnectionOptions> = { pingMs: 1e9, deadAfterMs: 1e9, sweepMs: 1e9 };

  const start = async (): Promise<void> => {
    time = new FakeTime(T0);
    seen.length = 0;
    server = await createChatServer({ port: 0, clock: time, timers: time, moduleOptions: { connection: QUIET } });
    server.ctx.onFrame('watch', (conn, f) => { seen.push({ t: 'watch', from: conn.device_id, user_ids: f.user_ids }); });
    server.ctx.onFrame('unwatch', (conn, f) => { seen.push({ t: 'unwatch', from: conn.device_id, user_ids: f.user_ids }); });
  };

  const client = async (dev: FixtureDevice = DEVICES.khanhPhone, over: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(dev, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false, ...over });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.close();
  });

  test('several watch calls inside the window leave as one frame at 500 ms, deduplicated', async () => {
    await start();
    const c = await client();
    const before = time.pending();
    c.watch(['truc', 'linh']);
    c.watch(['truc']);
    c.watch(['minh']);
    expect(time.pending()).toBe(before + 1);
    await time.advance(499);
    await yieldToIo();
    expect(seen).toEqual([]);
    await time.advance(1);
    await until(() => seen.length === 1, 1000, 'batched watch frame');
    expect(seen).toEqual([{ t: 'watch', from: 'B1', user_ids: ['truc', 'linh', 'minh'] }]);
    expect([...c.watching]).toEqual(['truc', 'linh', 'minh']);
    expect(time.pending()).toBe(before);
  });

  test('a watch undone inside the window sends nothing at all', async () => {
    await start();
    const c = await client();
    const before = time.pending();
    c.watch(['truc']);
    c.unwatch(['truc']);
    expect(time.pending()).toBe(before);
    await time.advance(1000);
    await yieldToIo();
    expect(seen).toEqual([]);
    expect(c.watching.size).toBe(0);
  });

  test('unwatch batches the same way and leaves the net set', async () => {
    await start();
    const c = await client();
    c.watch(['truc', 'linh']);
    await time.advance(500);
    await until(() => seen.length === 1, 1000, 'watch frame');
    c.unwatch(['truc']);
    c.unwatch(['linh']);
    await time.advance(500);
    await until(() => seen.length === 2, 1000, 'unwatch frame');
    expect(seen[1]).toEqual({ t: 'unwatch', from: 'B1', user_ids: ['truc', 'linh'] });
    expect(c.watching.size).toBe(0);
  });

  test('an unwatch taken back inside the window is a no-op on the wire', async () => {
    await start();
    const c = await client();
    c.watch(['truc']);
    await time.advance(500);
    await until(() => seen.length === 1, 1000, 'watch frame');
    c.unwatch(['truc']);
    c.watch(['truc']);
    await time.advance(1000);
    await yieldToIo();
    expect(seen).toHaveLength(1);
    expect([...c.watching]).toEqual(['truc']);
  });

  test('watching a user already watched sends nothing', async () => {
    await start();
    const c = await client();
    c.watch(['truc']);
    await time.advance(500);
    await until(() => seen.length === 1, 1000, 'watch frame');
    c.watch(['truc']);
    await time.advance(1000);
    await yieldToIo();
    expect(seen).toHaveLength(1);
  });

  test('flushWatches() sends the pending batch now and disarms the window', async () => {
    await start();
    const c = await client();
    const before = time.pending();
    c.watch(['truc']);
    c.flushWatches();
    expect(time.pending()).toBe(before);
    await until(() => seen.length === 1, 1000, 'watch frame');
    await time.advance(1000);
    await yieldToIo();
    expect(seen).toHaveLength(1);
  });

  test('after a reconnect the client re-sends its whole watch set right after hello_ack', async () => {
    await start();
    const c = await client(DEVICES.khanhPhone, { reconnect: { random: () => 0.5 } });
    c.watch(['truc', 'linh']);
    await time.advance(500);
    await until(() => seen.length === 1, 1000, 'watch frame');
    await server.ctx.kill(server.ctx.connections.byDevice('B1')!, 'dead');
    await until(() => !c.connected, 1000, 'closed');
    await time.advance(1000);
    await until(() => c.reconnects === 1, 2000, 'reconnected');
    await until(() => seen.length === 2, 1000, 're-watch frame');
    expect(seen[1]).toEqual({ t: 'watch', from: 'B1', user_ids: ['truc', 'linh'] });
    expect(c.trace.rows().some((r) => r.tag === 'note' && /re-watches 2 users after hello_ack/.test(r.text))).toBe(true);
  });
});
