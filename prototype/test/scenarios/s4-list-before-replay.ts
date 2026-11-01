/**
 * S4 · Chat list renders from the summary before the replay finishes (design §4.3, §4.4).
 *
 * Truc's laptop is 250 messages behind. On waking it reads the chat list from the summary
 * rows over HTTP first (previews, unread dots) and only then connects the socket; the
 * replay drains in three batches of 100 acked by hand. Between two batches the laptop
 * opens the chat: a cold open from the store (the slow path, one token), not a wait for
 * the queue. The server trace keeps every row; the bulk is folded when printed.
 */

import { DEVICES } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { streamIdOf } from '../../src/ports/index.js';
import type { Message } from '../../src/protocol.js';
import { Trace } from '../../src/trace.js';
import { defineScenario } from './scenario.js';
import { delivers, send } from './helpers.js';

interface ListRow {
  conversation_id: string;
  last_message_id: MessageId;
  last_preview: string;
  last_sender: string;
  last_at: number;
  unread_count: number;
  unread_capped: boolean;
}
interface List {
  conversations: ListRow[];
  list_cursor: number;
}
interface Page {
  messages: Message[];
  next_before: MessageId | null;
}

const BULK = 250;

export const s4 = defineScenario({
  id: 'S4',
  title: 'Chat list renders from the summary before replay finishes',
  design: '§4.3, §4.4',
  async run(env) {
    env.step("Truc's laptop is live and up to date: it acked one message and loaded its chat list once (a full-list load is the slow path: one token).");
    const laptop = await env.connect(DEVICES.trucLaptop, { autoAck: false });
    // Khanh's own device rows stay out of this trace (a private one); the server rows it causes are folded below.
    const khanh = await env.connect(DEVICES.khanhPhone, { trace: new Trace({ now: env.now }) });
    const primed = await send(env, khanh, 'c1', 'Before the laptop sleeps');
    await env.until(() => delivers(laptop).length === 1, 'primed deliver at the laptop');
    laptop.ack(streamIdOf(primed));
    const full = await env.get<List>('/conversations?user_id=truc&device_id=A2');
    env.assertEqual(full.status, 200, 'full list');
    env.assertEqual(full.body.conversations.map((r) => r.conversation_id), ['c1'], 'one conversation has traffic');
    laptop.listCursor = full.body.list_cursor;

    env.step(`The laptop closes. Khanh sends ${BULK} messages in the dm while it is away.`);
    laptop.closeCleanly();
    await env.until(() => env.phase('A2') === undefined, 'laptop gone');
    await env.advance(1000);
    const ids: MessageId[] = [];
    await env.fold(`Khanh sends ${BULK} messages while the laptop is away`, async () => {
      for (let i = 1; i <= BULK; i += 1) {
        ids.push(await send(env, khanh, 'c1', `bulk ${i}`));
        if (i % 50 === 0) await env.advance(1000);
      }
    });
    env.assertEqual(ids.length, BULK, `${BULK} messages stored`);
    const last = ids[BULK - 1]!;

    env.step('The laptop wakes. First the chat list from the summary rows, incremental since its list cursor (not the slow path); only then the socket.');
    const list: { status: number; body: List } | undefined = await env.get<List>(`/conversations?user_id=truc&device_id=A2&since=${laptop.listCursor}`);
    const listedAt = env.traceRows().length;
    env.assert(list !== undefined && list.status === 200, 'the list answered');
    const row = list!.body.conversations.find((r) => r.conversation_id === 'c1');
    env.assert(row !== undefined, 'c1 in the list');
    env.assertEqual(row!.last_message_id, last, 'the list row points at the newest message');
    env.assertEqual(row!.last_preview, `bulk ${BULK}`, 'preview of the newest message');
    env.assertEqual(row!.last_sender, 'khanh', 'sender of the newest message');
    env.assertEqual([row!.unread_count, row!.unread_capped], [99, true], 'unread dot shows 99+');
    env.assert(list!.body.list_cursor > laptop.listCursor!, 'list cursor moved forward');
    env.assertEqual(delivers(laptop).length, 1, 'no replayed deliver yet when the list was read');
    env.assert(env.rows('http').includes(`GET /conversations?since=${laptop.listCursor} ← Truc·laptop`), 'the list request row');
    laptop.listCursor = list!.body.list_cursor;

    env.step(`Now the socket: hello with the cursor; the server replays ${BULK} entries in batches of ${env.numbers.batchSize}, each waited on the laptop's ack.`);
    await env.fold('the replay drains in three acked batches of 100, 100 and 50', async () => {
      await laptop.connect();
      const ack = await laptop.hello();
      env.assertEqual(ack.slow_path, undefined, 'a cursor replays; no slow path');
      await env.until(() => delivers(laptop).length === 101, 'first batch of 100', 5000);
      env.assertEqual(env.phase('A2'), 'replay', 'still replaying');

      env.step('Before the replay is done the laptop opens the chat: a cold open from the store (the slow path, one more token), not a wait for the queue (§4.4).');
      const page = await env.get<Page>('/conversations/c1/messages?user_id=truc&device_id=A2&limit=50');
      env.assertEqual(page.status, 200, 'page answered during the replay');
      env.assertEqual(page.body.messages.map((m) => m.message_id), ids.slice(BULK - 50).reverse(), 'newest 50 from the store, newest first');
      env.assertEqual(env.phase('A2'), 'replay', 'the page did not wait for the queue');

      laptop.ack(delivers(laptop)[100]!.stream_id);
      await env.until(() => delivers(laptop).length === 201, 'second batch of 100', 5000);
      laptop.ack(delivers(laptop)[200]!.stream_id);
      await env.until(() => delivers(laptop).length === 251, 'last batch of 50', 5000);
      laptop.ack(delivers(laptop)[250]!.stream_id);
      await env.until(() => env.phase('A2') === 'live', 'laptop live after the drain');
    });
    env.assertEqual(laptop.delivered.map((m) => m.message_id), [primed, ...ids], `exactly the ${BULK} missed messages, in order, once`);
    env.assertEqual(laptop.duplicatesDropped, 0, 'nothing duplicated');
    env.assertEqual(laptop.cursor, streamIdOf(last), 'cursor at the last replayed id');
    env.assertEqual(row!.last_message_id, laptop.delivered[laptop.delivered.length - 1]!.message_id, "the list's last_message_id is the last replayed id");
    const xranges = env.rows('queue').filter((r) => r.startsWith('XRANGE sq:A2'));
    env.assertEqual(xranges, [
      `XRANGE sq:A2 (${streamIdOf(primed)} + → 100 entries, join bodies from the store`,
      `XRANGE sq:A2 (${streamIdOf(ids[99]!)} + → 100 entries, join bodies from the store`,
      `XRANGE sq:A2 (${streamIdOf(ids[199]!)} + → 50 entries, join bodies from the store`,
    ], 'three batches');

    // Order in the shared trace: the list request precedes every deliver row of the laptop.
    const rows = env.traceRows();
    const listAt = rows.findIndex((r) => r.tag === 'http' && r.text.startsWith('GET /conversations?since=') && r.text.endsWith('← Truc·laptop') && !r.text.includes('since=0'));
    const firstDeliver = rows.findIndex((r) => r.tag === 'deliver' && r.text.includes('Truc·laptop') && r.text.includes(`#${ids[0]}`));
    env.assert(listAt >= 0 && firstDeliver > listAt && firstDeliver >= listedAt, 'the http row precedes every replayed deliver of the laptop');
    env.assert(rows.length < 2000, 'trace under the 2000-row cap, so its head is intact');
    env.step(`Two slow-path tokens spent in all (the first full list, the cold open during the replay); the incremental list was free. The laptop replayed ${BULK} messages, no gap, no duplicates; live traffic now.`);
  },
});
