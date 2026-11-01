import { describe, expect, test } from 'vitest';
import { createChatServer } from '../../src/server.js';
import { DEVICES } from '../../src/fixtures.js';
import type { PresenceFrame } from '../../src/protocol.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { until } from '../harness/FakeTime.js';

/**
 * Roadmap §5 risk: fake timers hide a real race. Once, on real timers scaled down
 * (ping 50 / dead 100 / sweep 10 ms, debounce 100 ms), the offline event must land on the
 * watcher inside a window: not before detection + debounce, not much after.
 */

describe('presence module: real timers, scaled down', () => {
  test('radio off on the watched device: the watcher sees offline within [150 ms, 1.5 s]', async () => {
    const server = await createChatServer({
      port: 0,
      moduleOptions: { connection: { pingMs: 50, deadAfterMs: 100, sweepMs: 10 }, presence: { debounceMs: 100 } },
    });
    const khanh = new ScriptedClient(DEVICES.khanhPhone, { url: server.url, mirrorRule: false, reconnect: false });
    const truc = new ScriptedClient(DEVICES.trucPhone, { url: server.url, mirrorRule: false, reconnect: false });
    const presence = (): PresenceFrame[] => khanh.received.filter((f): f is PresenceFrame => f.t === 'presence' && f.user_id === 'truc');
    try {
      await khanh.connect();
      await khanh.hello();
      khanh.watch(['truc']);
      khanh.flushWatches();
      await until(() => presence().length === 1, 1000, 'watch reply');
      await truc.connect();
      await truc.hello();
      await until(() => presence().length === 2, 1000, 'online');
      await new Promise((r) => setTimeout(r, 60)); // at least one pong has been answered
      truc.suppressPongs();
      truc.blackhole();
      const t0 = Date.now();
      await until(() => presence().length === 3, 3000, 'offline');
      const elapsed = Date.now() - t0;
      // The last pong may be up to one ping period (50 ms) before t0, so death is ≥ 50 ms after t0; plus the 100 ms debounce.
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1500);
      const offline = presence()[2]!;
      expect(offline).toMatchObject({ state: 'offline' });
      expect(offline.last_seen).toBeLessThanOrEqual(t0);
      expect(offline.last_seen).toBeGreaterThanOrEqual(t0 - 100);
      const rows = server.ctx.trace.rows().filter((r) => r.tag === 'presence').map((r) => r.text);
      expect(rows).toContain('truc: last device gone → pending-offline, 100 ms debounce');
    } finally {
      khanh.stop();
      truc.stop();
      await server.close();
    }
  });
});
