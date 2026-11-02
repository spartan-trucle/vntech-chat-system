/**
 * S2 · Reconnect with cursor replays exactly the missed messages (design §4.2, §4.4, §4.7).
 *
 * Khanh's phone owns a cursor, goes away, misses seven messages across two conversations
 * (and none of a third it is not in), comes back with the cursor and gets exactly the seven
 * in stream order, once, each marked `replay: true`, then `replay_done`; the device acks on
 * its own cadence and the server only traces it. Then the device lies backwards: the server
 * replays more, never less, and the device drops the duplicates by message id.
 */

import { DEVICES } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { defineScenario } from './scenario.js';
import { delivers, send, sidOf } from './helpers.js';

export const s2 = defineScenario({
  id: 'S2',
  title: 'Reconnect with cursor replays exactly the missed messages',
  design: '§4.2, §4.4, §4.7',
  async run(env) {
    const store = env.server.ctx.ports.messages;

    env.step("Truc's phone, Khanh's phone and Linh's bot connect. Khanh acks one live message: the phone now owns a cursor.");
    const truc = await env.connect(DEVICES.trucPhone);
    const khanh = await env.connect(DEVICES.khanhPhone);
    const linh = await env.connect(DEVICES.linhBot);
    const primed = await send(env, truc, 'c1', 'Before you go');
    await env.until(() => delivers(khanh).length === 1, 'primed deliver at Khanh');
    await env.settle();
    env.assertEqual(khanh.cursor, sidOf(khanh, primed), 'Khanh applied the live frame to its cursor');
    const cursor = khanh.cursor!;

    env.step("Khanh's phone closes. Truc sends seven across the dm and the group; Linh sends one in a chat Khanh is not in. Each is stored, acked, appended to sq:B1 as an id; Khanh has no route, so a push hint goes out, never the body.");
    khanh.closeCleanly();
    await env.until(() => env.phase('B1') === undefined, 'Khanh gone');
    const expected: MessageId[] = [];
    for (let i = 1; i <= 7; i += 1) expected.push(await send(env, truc, i % 2 === 1 ? 'c1' : 'c2', `While you were away ${i}`));
    const notForKhanh = await send(env, linh, 'c3', 'Linh to Truc only');

    env.step("Khanh's phone is back and sends hello with its cursor: the connection is live at once and the server replays exactly the seven, in stream order, in one read of 100, then replay_done.");
    await khanh.connect();
    const ack = await khanh.hello();
    env.assertEqual(ack.slow_path, undefined, 'a cursor replays; no slow path');
    await env.until(() => delivers(khanh).length === 8, 'seven replayed delivers');
    await env.settle();
    await env.until(() => !khanh.inReplay, 'replay_done at Khanh');
    env.assertEqual(env.mode('B1'), 'live', 'the server left replay mode too');
    env.assertEqual(expected.length, 7, 'seven messages were sent while Khanh was away');
    env.assertEqual(khanh.rendered().map((m) => m.message_id), [primed, ...expected], 'exactly the missed messages, in id order, once');
    env.assert(delivers(khanh).slice(1).every((d) => d.replay), 'every replayed frame says replay: true');
    env.assertEqual(khanh.duplicatesDropped, 0, 'nothing duplicated on the wire');
    env.assert(!khanh.rendered().some((m) => m.message_id === notForKhanh), 'nothing from a conversation Khanh is not in');
    const refs = khanh.rendered().slice(1).map((m) => ({ conversation_id: m.conversation_id, message_id: m.message_id }));
    env.assertEqual(khanh.rendered().slice(1), await store.getMany(refs), 'bodies are the store rows');
    const lastSid = sidOf(khanh, expected[6]!);
    env.assertEqual(khanh.cursor, lastSid, 'the ack at replay_done moved the device cursor to the last replayed id');
    env.assert(env.rows('queue').includes(`XRANGE sq:B1 (${cursor} + → 7 entries, join bodies from the store`), 'one XRANGE from the cursor');
    await env.until(() => env.rows('queue').includes(`Khanh·phone ack sid=${lastSid} (device-owned cursor; server stores nothing)`), 'the ack traced, nothing stored');
    env.step("Khanh's phone replayed 7 missed messages, no gap, no duplicates; live traffic now, each frame applied to the cursor at once.");
    const live = await send(env, truc, 'c1', 'Live again');
    await env.until(() => delivers(khanh).length === 9, 'live deliver at Khanh');
    env.assert(env.rows('push').includes(`#${live} → Khanh·phone over the socket`), 'a live message is a direct push, not a replay');
    env.assertEqual(khanh.cursor, sidOf(khanh, live), 'outside replay mode the live stream id is the cursor');

    env.step('The device lies backwards (§4.7): cursor moved back to the primed message. The server replays more, never less; the device drops the duplicates by message id.');
    khanh.closeCleanly();
    await env.until(() => env.phase('B1') === undefined, 'Khanh gone again');
    khanh.cursor = cursor;
    await khanh.connect();
    await khanh.hello();
    await env.until(() => delivers(khanh).length === 17, 'eight re-delivered on the wire');
    await env.settle();
    await env.until(() => !khanh.inReplay, 'replay_done after the second drain');
    env.assertEqual(khanh.rendered().map((m) => m.message_id), [primed, ...expected, live], 'what the app shows is unchanged');
    env.assertEqual(khanh.duplicatesDropped, 8, 'eight duplicates dropped on the device');
    env.assertEqual(env.rows('dedup').filter((r) => r.startsWith('Khanh·phone already has #')).length, 8, 'one dedup row per duplicate');
    env.assertEqual(khanh.cursor, sidOf(khanh, live), 'cursor back at the newest id');
  },
});
