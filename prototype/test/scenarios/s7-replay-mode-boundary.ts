/**
 * S7 · Replay is a mode boundary (live-first ADR and replay-mode ADR, 2026-11-02; design
 * §4.4, §4.7; the backpressure rule of §5.8.3).
 *
 * Khanh's phone comes back 150 messages behind. The connection is live at once and the
 * replay runs beside live pushes: Truc's messages sent during the replay interleave on the
 * socket (out of message order) and the phone stores each once, rendering from its store in
 * message order. Then the phone stops reading and the push budget drops a live push: the
 * server stops pushing to it, lets the buffer drain, re-replays alone from the dropped entry,
 * sends replay_done, and only then pushes live again; an ack lands while the re-replay runs.
 * After every frame the phone receives, its cursor has never passed an entry it does not
 * hold (oracle: the stream read through the port) and its store holds every message once.
 *
 * B11 (delivered-receipt ADR, design §3.4): *delivered* is the phone's word. After every
 * frame, Khanh's delivery cursor on the server (`delivery_cursors[c1][B1]`) is never above
 * what the phone said in a `delivered` frame, and from the drop on it stays below the dropped
 * message until the re-replay has stored it on the phone and the phone's `delivered` has left
 * (coalesced: one per conversation per 2 s). Only then does the cursor pass the dropped id.
 */

import { DEVICES } from '../../src/fixtures.js';
import { compareIds, type MessageId } from '../../src/ids.js';
import { compareStreamIds, streamIdJustBelow } from '../../src/ports/index.js';
import type { ServerFrame } from '../../src/protocol.js';
import { Trace } from '../../src/trace.js';
import type { ScriptedClient } from '../harness/ScriptedClient.js';
import { defineScenario } from './scenario.js';
import { corkSocket, delivers, holdXrange, replayDones, seconds, send, sidOf } from './helpers.js';

const BEHIND = 150;
/** Live pushes one socket may have pending before the budget drops one (the runner's default is 1000). */
const MAX_PENDING = 8;

export const s7 = defineScenario({
  id: 'S7',
  title: 'Replay is a mode boundary: live first, replay_done, re-replay after a dropped push',
  design: '§4.4, §4.7, §5.8.3',
  realTimers: true,
  server: {
    push: { maxPending: MAX_PENDING, pushTimeoutMs: 60_000 },
    // The heartbeat is not under test; a corked socket must not be declared dead meanwhile.
    moduleOptions: { connection: { pingMs: 1e9, deadAfterMs: 1e9, sweepMs: 1e9 } },
  },
  async run(env) {
    const queue = env.server.ctx.ports.syncQueue;
    const cursors = env.server.ctx.ports.cursors;
    const deliveryCursor = async (): Promise<MessageId | undefined> => (await cursors.deliveryCursors('c1')).get('B1');
    /** The message the budget drops, once the scenario gets there; the delivery-cursor oracle watches it from then on. */
    let droppedId: MessageId | null = null;

    // ---- the oracle, run after every frame the phone receives ----
    const violations: string[] = [];
    const checks: Promise<void>[] = [];
    let frames = 0;
    const onFrame = (frame: ServerFrame, c: ScriptedClient): void => {
      if (frame.t !== 'deliver' && frame.t !== 'replay_done') return;
      const n = (frames += 1);
      const cursor = c.cursor;
      const stored = new Set(c.store.keys());
      const rendered = c.rendered();
      for (let i = 1; i < rendered.length; i += 1) {
        if (compareIds(rendered[i - 1]!.message_id, rendered[i]!.message_id) >= 0) violations.push(`frame ${n}: rendered() not strictly in message order`);
      }
      if (c.delivered.length !== stored.size) violations.push(`frame ${n}: ${c.delivered.length} delivered but ${stored.size} stored`);
      // B11: the server's delivery cursor is the phone's word and never more (the cursors port is in
      // memory in every form of this scenario, so the read lands before any later frame or receipt).
      const said = c.deliveredUpTo.get('c1');
      const dropped = droppedId;
      checks.push((async () => {
        const server = await deliveryCursor();
        if (server === undefined) return;
        if (said === undefined || compareIds(server, said) > 0) violations.push(`frame ${n} (${frame.t}): delivery cursor #${server} above what the phone said delivered (${said === undefined ? 'nothing' : `#${said}`})`);
        if (dropped === null) return;
        const phoneSaidSo = stored.has(dropped) && said !== undefined && compareIds(said, dropped) >= 0;
        if (!phoneSaidSo && compareIds(server, dropped) >= 0) violations.push(`frame ${n} (${frame.t}): delivery cursor #${server} reached the dropped #${dropped} before the phone stored it and said delivered`);
      })());
      if (cursor === null) return;
      // Every entry at or below the cursor must already be in the store (the stream only grows above it).
      checks.push((async () => {
        for (const e of await queue.xrange('B1', null, 100_000)) {
          if (compareStreamIds(e.id, cursor) <= 0 && !stored.has(e.m)) violations.push(`frame ${n} (${frame.t}): cursor ${cursor} passed entry ${e.id} #${e.m} that the phone does not hold`);
        }
      })());
    };

    env.step("Truc's phone and Khanh's phone connect (no heartbeat in this scenario). Truc sends one message; Khanh's phone is live, so the frame's stream id is its cursor at once.");
    const quiet = { mirrorRule: false as const, reconnect: false as const };
    // Truc's own device rows stay out of this trace (a private one); Khanh's are the point.
    const truc = await env.connect(DEVICES.trucPhone, { ...quiet, trace: new Trace({ now: env.now }) });
    const khanh = await env.connect(DEVICES.khanhPhone, { ...quiet, onFrame });
    await env.until(() => !khanh.inReplay, 'replay_done with the hello (nothing to replay)');
    const primed = await send(env, truc, 'c1', 'Before you go');
    await env.until(() => delivers(khanh).length === 1, 'first deliver at Khanh');
    env.assertEqual(khanh.cursor, sidOf(khanh, primed), 'live mode: the stream id is the cursor');
    const all: MessageId[] = [primed];

    env.step(`Khanh's phone closes. Truc sends ${BEHIND} messages while it is away: each stored, acked, appended to sq:B1 with a store-assigned id.`);
    khanh.closeCleanly();
    await env.until(() => env.phase('B1') === undefined, 'Khanh gone');
    const behind: MessageId[] = [];
    await env.fold(`Truc sends ${BEHIND} messages while Khanh is away`, async () => {
      for (let i = 1; i <= BEHIND; i += 1) behind.push(await send(env, truc, 'c1', `while away ${i}`));
    });
    all.push(...behind);

    env.step(`Khanh's phone is back: hello with its cursor. The connection is live at once; the replay reads ${env.numbers.batchSize} at a time beside live pushes and never waits for an ack. The second read is held so Truc can send during the replay.`);
    const hold = holdXrange(env, 'B1', 2);
    await khanh.connect();
    const ack = await khanh.hello();
    env.assertEqual(ack.slow_path, undefined, 'a cursor replays; no slow path');
    await hold.reached;
    await env.fold('the first read of 100 lands on the phone', async () => {
      await env.until(() => delivers(khanh).length === 101, 'first 100 replay frames', 5000);
    });
    env.assertEqual(env.mode('B1'), 'replay', 'the server is replaying');
    env.assert(khanh.inReplay, 'the phone is in replay mode');
    env.assert(delivers(khanh).slice(1).every((d) => d.replay), 'every replayed frame says replay: true');
    const sid100 = sidOf(khanh, behind[99]!);
    await env.until(() => env.rows('queue').includes(`Khanh·phone ack sid=${sid100} (device-owned cursor; server stores nothing)`), 'the phone acked after 100 replay frames; the server traced it');
    env.assertEqual(khanh.cursor, sid100, 'the ack moved the cursor to the 100th replayed entry');

    env.step('Truc sends three live messages during the replay: pushed at once (live first) and queued; the phone stores them but does not apply their stream ids to its cursor (replay mode).');
    const during: MessageId[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const id = await send(env, truc, 'c1', `during the replay ${i}`);
      during.push(id);
      await env.until(() => delivers(khanh).some((d) => d.message.message_id === id), `live deliver ${i} at Khanh`);
      const frame = delivers(khanh).find((d) => d.message.message_id === id)!;
      env.assertEqual(frame.replay, false, 'a live push during the replay says replay: false');
      env.assertEqual(khanh.cursor, sid100, 'the live stream id is not applied to the cursor in replay mode');
    }
    all.push(...during);
    env.assert(env.rows('push').some((r) => r === `#${during[0]} → Khanh·phone over the socket`), 'pushed live to the replaying connection');

    env.step('The held read is released: the rest of the backlog, then the three live ones again (duplicates the phone drops), then replay_done. The phone acks at replay_done.');
    hold.release();
    await env.fold('the replay drains and ends', async () => {
      await env.until(() => replayDones(khanh) === 2 && !khanh.inReplay, 'replay_done after the drain', 5000);
      for (const c of checks) await c;
    });
    env.assertEqual(env.mode('B1'), 'live', 'the server left replay mode');
    env.assertEqual(khanh.duplicatesDropped, 3, 'the three live ones came again by the replay and were dropped');
    env.assertEqual(khanh.rendered().map((m) => m.message_id), all, 'the store holds every message once, in message order');
    const socketOrder = delivers(khanh).map((d) => d.message.message_id);
    env.assert(socketOrder.some((id, i) => i > 0 && compareIds(socketOrder[i - 1]!, id) > 0), 'frames on the socket were out of message order during the replay');
    env.assertEqual(khanh.cursor, sidOf(khanh, during[2]!), 'the ack at replay_done moved the cursor to the last replayed entry');
    env.assertEqual(khanh.reconnects, 0, 'no reconnect so far');

    env.step(`Khanh's phone stops reading (its socket is corked server-side). Truc sends ${MAX_PENDING + 1}: ${MAX_PENDING} pushes sit in the budget, the next is dropped. The server stops pushing to the phone and waits for the buffer to drain.`);
    const tcp = corkSocket(env, 'B1');
    const burst: MessageId[] = [];
    for (let i = 1; i <= MAX_PENDING + 1; i += 1) burst.push(await send(env, truc, 'c1', `burst ${i}`));
    all.push(...burst);
    const dropped = burst[MAX_PENDING]!;
    droppedId = dropped;
    await env.until(() => env.rows('lost').some((r) => r.startsWith(`#${dropped} → Khanh·phone: buffer full`)), 'the drop traced');
    env.assertEqual(env.mode('B1'), 'replay', 'the server re-entered replay mode for the phone');
    env.assert(env.server.ctx.connections.byDevice('B1')!.pushes.liveSuspended, 'live pushes to the phone are suspended');
    const afterDrop = await send(env, truc, 'c1', 'after the drop');
    all.push(afterDrop);
    await env.until(() => env.rows('queue').includes(`#${afterDrop} → Khanh·phone: live pushes suspended during a re-replay, left to the stream`), 'a message after the drop is neither pushed nor dropped');

    env.step('The phone reads again: the eight pending pushes land (live mode, applied to the cursor), the buffer drains, the re-replay starts from the dropped entry; its first read is held so an ack can arrive while it runs.');
    const holdAgain = holdXrange(env, 'B1', 1);
    tcp.uncork();
    await holdAgain.reached;
    await env.until(() => burst.slice(0, MAX_PENDING).every((id) => khanh.store.has(id)), 'the eight pending pushes landed');
    env.assert(!khanh.inReplay, 'the phone is still in live mode: no replay frame has arrived yet');
    const sidLastLive = sidOf(khanh, burst[MAX_PENDING - 1]!);
    env.assertEqual(khanh.cursor, sidLastLive, 'live mode: the cursor is at the last live frame, below the dropped entry');
    env.assert(!khanh.store.has(dropped), 'the dropped message has not arrived');
    await env.advance(500);
    await env.until(() => env.rows('queue').includes(`Khanh·phone ack sid=${sidLastLive} (device-owned cursor; server stores nothing)`), 'the ack arrived while the re-replay was running');
    holdAgain.release();
    await env.until(() => replayDones(khanh) === 3 && !khanh.inReplay, 'replay_done after the re-replay', 5000);
    for (const c of checks) await c;
    const sidDropped = sidOf(khanh, dropped);
    env.assert(khanh.store.has(dropped) && khanh.store.has(afterDrop), 'the dropped message and the one after it arrived by the re-replay, without a reconnect');
    env.assertEqual(delivers(khanh).find((d) => d.message.message_id === dropped)!.replay, true, 'the dropped message came as a replay frame');
    env.assert(env.rows('queue').includes(`XRANGE sq:B1 (${streamIdJustBelow(sidDropped)} + → 2 entries, join bodies from the store`), 're-replayed from the dropped entry, inclusive');
    env.assert(env.rows('queue').includes('sq:B1: re-replay done → live pushes to Khanh·phone resumed'), 'live resumed after replay_done');
    env.assertEqual(env.mode('B1'), 'live', 'the server left replay mode again');
    env.assert(!env.server.ctx.connections.byDevice('B1')!.pushes.liveSuspended, 'the live lane is open again');
    env.assertEqual(khanh.cursor, sidOf(khanh, afterDrop), 'the ack at replay_done moved the cursor past the re-replayed entries');
    env.assertEqual(khanh.reconnects, 0, 'the dropped push was redelivered without a reconnect');

    const window = env.numbers.deliveredWindowMs;
    env.step(`Delivered is the phone's word (B11): the dropped push never moved Khanh's delivery cursor. The re-replay stored the message on the phone; its delivered{c1, ≤ #} is coalesced into the phone's ${seconds(window)} window, and the server's cursor passes the dropped entry only when that frame arrives.`);
    env.assert(khanh.store.has(dropped), 'the phone holds the dropped message');
    if (!env.realTime) {
      // Fake time: the window cannot have ended yet, so the cursor is still below the dropped entry.
      const before = await deliveryCursor();
      env.assert(before === undefined || compareIds(before, dropped) < 0, `before the receipt: the delivery cursor (${before === undefined ? 'none' : `#${before}`}) is below the dropped #${dropped}`);
      env.assert(compareIds(khanh.deliveredUpTo.get('c1')!, dropped) < 0, 'the phone has not said delivered for the dropped message yet (inside the window)');
    }
    await env.advance(window);
    await env.until(() => env.rows('receipt').includes(`delivered c1 ≤ #${afterDrop} by Khanh·phone`), 'the delivered frame for the re-replayed messages arrived at the server');
    env.assertEqual(khanh.deliveredUpTo.get('c1'), afterDrop, 'the phone said delivered up to the highest id it stored');
    const afterReceipt = await deliveryCursor();
    env.assert(afterReceipt !== undefined && compareIds(afterReceipt, dropped) >= 0, `after the receipt: the delivery cursor (#${afterReceipt}) is at or above the dropped #${dropped}`);

    env.step('Live again: the next message is a direct push and its stream id is the cursor at once; the delivered for it goes out with the next window.');
    const after = await send(env, truc, 'c1', 'Live again');
    all.push(after);
    await env.until(() => khanh.store.has(after), 'live deliver at Khanh');
    env.assertEqual(delivers(khanh).find((d) => d.message.message_id === after)!.replay, false, 'a live push again');
    env.assertEqual(khanh.cursor, sidOf(khanh, after), 'applied to the cursor at once');
    await env.advance(window);
    await env.until(() => env.rows('receipt').includes(`delivered c1 ≤ #${after} by Khanh·phone`), 'the delivered for the live message arrived');
    env.assertEqual(await deliveryCursor(), after, "Khanh's delivery cursor is at the last message: delivered means stored, in live mode as in replay mode");

    for (const c of checks) await c;
    env.assertEqual(violations, [], 'after every frame: the cursor never passed an undelivered entry, the store held each message once, and the delivery cursor never ran ahead of the phone');
    env.assertEqual(khanh.rendered().map((m) => m.message_id), all, `every one of the ${all.length} messages stored exactly once, in message order`);
    env.assertEqual(khanh.delivered.length, all.length, 'no message rendered twice');
    env.assert(env.traceRows().length < 2000, 'trace under the 2000-row cap, so its head is intact');
    env.step(`Checked after each of the ${frames} frames: cursor never past an undelivered entry, store exact, delivery cursor never above what the phone said. ${all.length} messages, ${khanh.duplicatesDropped} duplicate frames dropped, one dropped push redelivered and then reported delivered by the phone, no reconnect.`);
  },
});
