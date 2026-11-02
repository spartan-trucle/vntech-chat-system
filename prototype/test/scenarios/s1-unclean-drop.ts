/**
 * S1 · Unclean drop detected within 10 s (design §1.2, §1.5; reconnect §1.4).
 *
 * Khanh's phone loses its radio with no close frame. The server notices on its own after
 * two missed pings and deletes the route; independently the phone notices on its own after
 * 15 s without a ping, closes the half-open socket and reconnects with backoff, carrying
 * the cursor it owns and flushing what was typed while down with the same client_msg_id.
 */

import { DEVICES } from '../../src/fixtures.js';
import { defineScenario } from './scenario.js';
import { acksOf, alignToPingTick, delivers, seconds, send, sidOf } from './helpers.js';

export const s1 = defineScenario({
  id: 'S1',
  title: 'Unclean drop detected within 10 s',
  design: '§1.2, §1.5',
  realTimers: true,
  async run(env) {
    const n = env.numbers;
    const routes = env.server.ctx.ports.routes;

    env.step(`Truc's phone and Khanh's phone connect. Heartbeat: ping every ${seconds(n.pingMs)}, dead after ${seconds(n.deadAfterMs)}; a device with no ping for ${seconds(n.mirrorMs)} closes the socket itself.`);
    const truc = await env.connect(DEVICES.trucPhone);
    const khanh = await env.connect(DEVICES.khanhPhone);
    const first = await send(env, truc, 'c1', 'Hi Khanh');
    await env.until(() => delivers(khanh).length === 1, 'first deliver at Khanh');
    await env.settle();
    // Live mode (replay_done came with the hello): the frame's stream id is the cursor at once.
    env.assertEqual(khanh.cursor, sidOf(khanh, first), 'Khanh applied the live frame to its cursor');
    const cursor = khanh.cursor!;

    env.step(`Both phones stay healthy for ${seconds(30 * n.pingMs / 5)}: pongs refresh last_pong_at in memory, nothing else moves.`);
    await env.advance(6 * n.pingMs);
    env.assert(khanh.connected && truc.connected, 'both still connected after 30 s of pings');
    env.assertEqual(await routes.get('khanh', 'B1'), 'srv-1', 'route:khanh:B1 still set');
    env.assertEqual(env.rows('hb').filter((t) => /dead →/.test(t)), [], 'no death while healthy');

    await alignToPingTick(env);
    const t = env.now();
    if (!env.realTime) env.assertEqual(env.server.ctx.connections.byDevice('B1')!.last_pong_at, t, 'last pong at t');

    env.step("Khanh's network drops at t: no close frame, so the server still sees a route.");
    khanh.suppressPongs();
    khanh.blackhole();

    await env.advance(n.pingMs);
    env.step('Truc sends. Store, ack, queue; the push goes to a dead socket and only the sync queue has it.');
    const during = await send(env, truc, 'c1', 'Are you there?');
    if (!env.realTime) env.assert(env.rows('push').includes(`#${during} → Khanh·phone over the socket`), 'pushed to the dead socket');

    let deadAt: number | null = null;
    for (let i = 0; i < 60 && deadAt === null; i += 1) {
      await env.advance(n.sweepMs);
      if ((await routes.get('khanh', 'B1')) === undefined) deadAt = env.now();
    }
    if (deadAt === null) throw new Error('the server never detected the dead connection');
    if (env.realTime) env.assert(deadAt - t <= 10 * n.deadAfterMs, `dead within ${seconds(10 * n.deadAfterMs)} (real timers)`);
    else env.assert(deadAt - t >= n.deadAfterMs && deadAt - t <= n.deadAfterMs + n.sweepMs, `dead between t+${seconds(n.deadAfterMs)} and t+${seconds(n.deadAfterMs + n.sweepMs)}, got t+${seconds(deadAt - t)}`);
    env.assert(env.rows('hb').includes('Khanh·phone missed 2 pings, dead → DEL route:khanh:B1'), 'death row with the route deletion');
    env.assertEqual(env.phase('B1'), undefined, 'connection entry removed');
    env.assert(truc.connected && (await routes.get('truc', 'A1')) === 'srv-1', 'Truc unaffected');
    env.step(`After ${seconds(deadAt - t)} the route is gone. Khanh's phone has not noticed yet and types a message: it waits in the outbox.`);

    const typed = khanh.sendMessage({ conversation_id: 'c1', body: 'Typed while the radio was off' });
    env.assertEqual(khanh.outbox, [typed], 'one message in the outbox');

    await env.advance(Math.max(0, t + n.mirrorMs - env.now()));
    await env.until(() => !khanh.connected, 'the mirror rule closed the half-open socket');
    const mirrorRow = env.rows('hb').find((r) => /^Khanh·phone: no ping for .* → socket is half-open, close and reconnect in /.test(r));
    env.assert(mirrorRow !== undefined, 'the client detected the half-open socket on its own');
    if (!env.realTime) {
      env.assertEqual(mirrorRow, 'Khanh·phone: no ping for 15 s → socket is half-open, close and reconnect in 1 s', 'design numbers in the client row');
      env.assertEqual(env.now() - t, n.mirrorMs, 'the client noticed at t+15 s');
    }

    env.step("Khanh's network is back. The client reconnects with backoff and sends hello with its cursor; the outbox is flushed with the same client_msg_id and the server replays exactly what was queued.");
    khanh.restoreRadio();
    khanh.allowPongs();
    await env.advance(n.backoffBaseMs);
    await env.until(() => khanh.reconnects === 1 && khanh.outbox.length === 0, 'reconnect and outbox flush');
    if (!env.realTime) env.assertEqual(khanh.reconnectAttempts, [t + n.mirrorMs + n.backoffBaseMs], 'one attempt, 1 s after the mirror rule');
    env.assert(env.rows('hb').includes(`hello from Khanh·phone cursor=${cursor} → SET route:khanh:B1`), 'hello carried the last acked cursor');
    env.assert(env.rows('hb').includes('Khanh·phone: reconnected on attempt 1, flushing 1 from the outbox with the same client_msg_ids'), 'outbox flushed on reconnect');

    const typedAck = acksOf(khanh, typed);
    env.assertEqual(typedAck.length, 1, 'the typed message was acked once');
    env.assertEqual(await env.server.ctx.ports.messages.findByClientMsgId('khanh', typed.client_msg_id), typedAck[0]!.message_id, 'stored once under its client_msg_id');
    await env.until(() => delivers(truc).some((d) => d.message.client_msg_id === typed.client_msg_id), 'Truc received the typed message');

    await env.until(() => delivers(khanh).length === 2, 'the queued message replayed to Khanh');
    await env.settle();
    await env.until(() => !khanh.inReplay, 'replay_done at Khanh');
    env.assertEqual(khanh.rendered().map((m) => m.message_id), [first, during], 'exactly the one message sent during the outage, once');
    env.assertEqual(khanh.duplicatesDropped, 0, 'no duplicate');
    env.assertEqual(khanh.cursor, sidOf(khanh, during), 'the ack at replay_done moved the cursor to the replayed entry');
    env.assert(env.rows('queue').includes(`XRANGE sq:B1 (${cursor} + → 1 entries, join bodies from the store`), 'replay from the cursor');
    env.step("Khanh's phone is complete: no gap, no duplicate; the message typed while down was stored once.");
  },
});
