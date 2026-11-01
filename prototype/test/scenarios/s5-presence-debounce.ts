/**
 * S5 · Presence watch/unwatch and the 5 s debounce (design §5.2–§5.4; presence ADR).
 *
 * Khanh's phone watches Truc (one batched `watch` frame, answered with the current state).
 * Truc's phone drops at t: the server detects the death at t+10..11 s, waits the 5 s
 * debounce and publishes offline with last_seen=t, which Khanh sees at ≈ t+15..16 s. A
 * second drop with a reconnect inside the debounce publishes nothing. After unwatch a
 * later transition reaches no one. Sixty seconds of pongs never write the presence lease.
 */

import { DEVICES } from '../../src/fixtures.js';
import type { InMemoryPresenceStore } from '../../src/ports/index.js';
import { defineScenario } from './scenario.js';
import { alignToPingTick, presenceOf, seconds } from './helpers.js';

const duration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);

export const s5 = defineScenario({
  id: 'S5',
  title: 'Presence watch/unwatch and the 5 s debounce',
  design: '§5.2–§5.4',
  realTimers: true,
  async run(env) {
    const n = env.numbers;
    const store = env.server.ctx.ports.presence as InMemoryPresenceStore;
    const quiet = { mirrorRule: false as const, reconnect: false as const };

    env.step(`Khanh's phone connects and watches Truc. The device batches watch changes for ${duration(n.watchBatchMs)} and sends one frame; the server answers with the current state at once.`);
    const khanh = await env.connect(DEVICES.khanhPhone);
    khanh.watch(['truc']);
    await env.advance(n.watchBatchMs);
    await env.until(() => presenceOf(khanh, 'truc').length === 1, 'watch reply');
    env.assertEqual(presenceOf(khanh, 'truc')[0], { t: 'presence', user_id: 'truc', state: 'offline' }, 'a user never seen is offline, no last_seen');
    env.assertEqual(env.rows('watch'), ['Khanh·phone → truc'], 'exactly one watch frame left the device');
    env.assert(env.rows('presence').includes('SUBSCRIBE pres:truc (first watcher on this server)'), 'channel joined on the first watcher');

    env.step("Truc's phone connects: online is published at once, to the watcher only, and the lease is written once.");
    const truc = await env.connect(DEVICES.trucPhone, quiet);
    await env.until(() => presenceOf(khanh, 'truc').length === 2, 'online at Khanh');
    env.assertEqual(presenceOf(khanh, 'truc')[1], { t: 'presence', user_id: 'truc', state: 'online' }, 'online frame');
    env.assert(env.rows('presence').includes('PUBLISH pres:truc online → Khanh·phone'), 'published to the watcher');

    env.step(`${seconds(12 * n.pingMs)} of heartbeats: pongs refresh last_pong_at in memory; the presence lease in the store is not written on the pong path.`);
    const writes = store.writes;
    await env.advance(12 * n.pingMs);
    env.assertEqual(store.writes, writes, `no presence write across ${seconds(12 * n.pingMs)} of pongs`);
    env.assert(truc.connected && khanh.connected, 'both healthy');

    await alignToPingTick(env);
    const t = env.now();
    env.step(`Truc's phone loses the radio at t: no close frame. Two missed pings → dead at t+${seconds(n.deadAfterMs)}..${seconds(n.deadAfterMs + n.sweepMs)}, then the ${duration(n.debounceMs)} debounce, then offline with last_seen=t.`);
    truc.suppressPongs();
    truc.blackhole();
    let offlineAt: number | null = null;
    for (let i = 0; i < 60 && offlineAt === null; i += 1) {
      await env.advance(n.sweepMs);
      if (presenceOf(khanh, 'truc').some((f) => f.state === 'offline' && f.last_seen !== undefined)) offlineAt = env.now();
    }
    if (offlineAt === null) throw new Error('Khanh never saw Truc go offline');
    const offline = presenceOf(khanh, 'truc')[2]!;
    if (env.realTime) {
      // The last pong may be up to one ping period before t, so death is ≥ dead − ping after t; plus the debounce.
      const low = n.deadAfterMs - n.pingMs + n.debounceMs;
      env.assert(offlineAt - t >= low && offlineAt - t <= 1500, `offline within [${low} ms, 1.5 s] of the drop, got ${offlineAt - t} ms`);
      env.assert(offline.last_seen! <= t && offline.last_seen! >= t - 2 * n.pingMs, 'last_seen is the last pong before the drop');
    } else {
      env.assert(offlineAt - t >= 15_000 && offlineAt - t <= 17_000, `offline between t+15 s and t+17 s, got t+${seconds(offlineAt - t)}`);
      env.assertEqual(offline, { t: 'presence', user_id: 'truc', state: 'offline', last_seen: t }, 'offline with last_seen=t');
    }
    env.assert(env.rows('presence').includes(`truc: last device gone → pending-offline, ${duration(n.debounceMs)} debounce`), 'the debounce row');
    env.assert(env.rows('presence').some((r) => /^PUBLISH pres:truc offline last_seen=\d\d:\d\d:\d\d → Khanh·phone$/.test(r)), 'published to the watcher');
    env.assertEqual(await store.get('truc'), { state: 'offline', last_seen: offline.last_seen! }, 'store row');

    env.step("Variant: Truc's laptop connects (online again) and drops at t2; the phone comes back inside the debounce → nothing is published, Khanh never sees a flap.");
    const laptop = await env.connect(DEVICES.trucLaptop, quiet);
    await env.until(() => presenceOf(khanh, 'truc').length === 4, 'online again at Khanh');
    await alignToPingTick(env);
    const t2 = env.now();
    laptop.suppressPongs();
    laptop.blackhole();
    if (env.realTime) {
      await env.until(() => env.rows('presence').filter((r) => r.includes('pending-offline')).length === 2, 'laptop dead, pending-offline');
    } else {
      await env.advance(n.deadAfterMs + 2 * n.sweepMs);
      env.assertEqual(env.phase('A2'), undefined, 'laptop dead at t2+11 s');
    }
    const phone2 = await env.connect(DEVICES.trucPhone, quiet);
    env.assert(env.rows('presence').includes(`truc: reconnected inside the ${duration(n.debounceMs)} debounce, nothing published`), 'reconnect inside the debounce');
    await env.advance(n.debounceMs + 8 * n.sweepMs);
    env.assertEqual(presenceOf(khanh, 'truc').length, 4, 'no frame at Khanh: the state never left online');
    env.assertEqual(await store.get('truc'), { state: 'online' }, 'store still online');
    if (!env.realTime) env.assert(env.now() - t2 >= 24_000, 'well past where the offline would have fired');

    env.step("Khanh stops watching (one batched unwatch frame). Truc's phone closes cleanly: the offline after the debounce is published to no one.");
    khanh.unwatch(['truc']);
    await env.advance(n.watchBatchMs);
    await env.until(() => env.rows('presence').includes('Khanh·phone unwatches truc'), 'unwatch handled');
    env.assertEqual(env.rows('unwatch'), ['Khanh·phone → truc'], 'exactly one unwatch frame');
    env.assert(env.rows('presence').includes('UNSUBSCRIBE pres:truc (last watcher gone)'), 'channel left');
    phone2.closeCleanly();
    await env.until(() => env.phase('A1') === undefined, 'phone gone');
    await env.advance(n.debounceMs + 2 * n.sweepMs);
    await env.until(() => env.rows('presence').filter((r) => /^PUBLISH pres:truc offline/.test(r)).length === 2, 'second offline published');
    env.assert(env.rows('presence').some((r) => /^PUBLISH pres:truc offline last_seen=\d\d:\d\d:\d\d → no watchers$/.test(r)), 'published to no watchers');
    env.assertEqual(presenceOf(khanh, 'truc').length, 4, 'nothing reached Khanh after unwatch');
  },
});
