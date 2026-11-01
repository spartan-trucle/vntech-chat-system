import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer, type Clock } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { bucketOf, type MessageId } from '../../src/ids.js';
import { InMemoryMessageStore } from '../../src/ports/index.js';
import type { ConversationId, Message, MsgAckFrame, MsgFrame } from '../../src/protocol.js';
import type { HistoryOptions } from '../../src/history/index.js';

interface Reply<T = unknown> {
  status: number;
  body: T;
}

interface Page {
  messages: Message[];
  next_before: MessageId | null;
  next_after: MessageId | null;
}

describe('B4 history page API, summary row and slow path (design §2.3, §4.3, §4.5)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let seq = 0;

  const start = async (opts: { history?: Partial<HistoryOptions>; clock?: Clock } = {}): Promise<ChatServer> => {
    const options: Parameters<typeof createChatServer>[0] = { port: 0, seed: true, moduleOptions: { history: opts.history ?? {} } };
    if (opts.clock) options.clock = opts.clock;
    server = await createChatServer(options);
    return server;
  };
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const get = async <T = unknown>(path: string): Promise<Reply<T>> => {
    const res = await fetch(`${server!.httpUrl}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  /** Sends one `msg` through the real send path and returns its message id. */
  const sendMsg = async (from: ScriptedClient, conversation_id: ConversationId, body: string, extra: Partial<MsgFrame> = {}): Promise<MessageId> => {
    const client_msg_id = `cid-${(seq += 1)}`;
    from.send({ t: 'msg', conversation_id, client_msg_id, body, ...extra });
    const ack = (await from.expect((f) => f.t === 'msg_ack' && f.client_msg_id === client_msg_id)) as MsgAckFrame;
    return ack.message_id;
  };
  const idsOf = (page: Page): MessageId[] => page.messages.map((m) => m.message_id);
  const store = (): InMemoryMessageStore => server!.ctx.ports.messages as InMemoryMessageStore;

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  describe('GET /conversations/:id/messages (design §2.3: open, scroll up, page down)', () => {
    test('cold open returns the newest rows first with next_before; scrolling up with before returns the rest, no overlap', async () => {
      await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const ids: MessageId[] = [];
      for (let i = 1; i <= 5; i += 1) ids.push(await sendMsg(khanh, 'c1', `m${i}`));

      const first = await get<Page>('/conversations/c1/messages?user_id=truc&device_id=A1&limit=3');
      expect(first.status).toBe(200);
      expect(idsOf(first.body)).toEqual([ids[4], ids[3], ids[2]]);
      expect(first.body.messages[0]).toMatchObject({ conversation_id: 'c1', sender_id: 'khanh', body: 'm5', bucket: bucketOf(ids[4]!) });
      expect(first.body.next_before).toBe(ids[2]);
      expect(first.body.next_after).toBeNull();

      const second = await get<Page>(`/conversations/c1/messages?user_id=truc&limit=3&before=${first.body.next_before}`);
      expect(idsOf(second.body)).toEqual([ids[1], ids[0]]);
      expect(second.body.next_before).toBe(ids[0]);

      const third = await get<Page>(`/conversations/c1/messages?user_id=truc&limit=3&before=${second.body.next_before}`);
      expect(third.body).toEqual({ messages: [], next_before: null, next_after: null });
    });

    test('after pages down, oldest first, with next_after', async () => {
      await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const ids: MessageId[] = [];
      for (let i = 1; i <= 5; i += 1) ids.push(await sendMsg(khanh, 'c1', `m${i}`));

      const page = await get<Page>(`/conversations/c1/messages?user_id=truc&limit=2&after=${ids[1]}`);
      expect(page.status).toBe(200);
      expect(idsOf(page.body)).toEqual([ids[2], ids[3]]);
      expect(page.body.next_after).toBe(ids[3]);
      expect(page.body.next_before).toBeNull();
      const rest = await get<Page>(`/conversations/c1/messages?user_id=truc&limit=2&after=${page.body.next_after}`);
      expect(idsOf(rest.body)).toEqual([ids[4]]);
    });

    test('limit defaults to 50 and an empty conversation answers an empty page', async () => {
      await start();
      const page = await get<Page>('/conversations/c1/messages?user_id=truc');
      expect(page.status).toBe(200);
      expect(page.body).toEqual({ messages: [], next_before: null, next_after: null });
    });

    test('identity is the user_id query parameter: 400 without it, 403 for a non-member, 404 for an unknown conversation', async () => {
      await start();
      expect(await get('/conversations/c1/messages')).toEqual({ status: 400, body: { error: 'missing_user_id' } });
      expect(await get('/conversations/c1/messages?user_id=linh')).toEqual({ status: 403, body: { error: 'not_member' } });
      expect(await get('/conversations/c9/messages?user_id=truc')).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    test('malformed paging is 400: limit out of range, cursors that are not ids, before and after together', async () => {
      await start();
      expect((await get('/conversations/c1/messages?user_id=truc&limit=0')).body).toEqual({ error: 'bad_limit' });
      expect((await get('/conversations/c1/messages?user_id=truc&limit=201')).body).toEqual({ error: 'bad_limit' });
      expect((await get('/conversations/c1/messages?user_id=truc&limit=abc')).body).toEqual({ error: 'bad_limit' });
      expect((await get('/conversations/c1/messages?user_id=truc&before=9-0')).body).toEqual({ error: 'bad_cursor' });
      expect((await get('/conversations/c1/messages?user_id=truc&before=1&after=2')).body).toEqual({ error: 'bad_cursor' });
      expect((await get('/conversations/c1/messages?user_id=truc&before=1&after=2')).status).toBe(400);
    });

    test('a conversation idle for 14 months costs 14 partition reads once and still returns the right 50', async () => {
      // The Snowflake epoch is 2026-01-01, so the idle stretch lives in 2026–2027.
      let now = Date.UTC(2026, 1, 10, 12);
      const srv = await start({ clock: { now: () => now } });
      const ids: MessageId[] = [];
      for (let i = 0; i < 60; i += 1) {
        now += 1000;
        const message_id = srv.ctx.ids.next();
        ids.push(message_id);
        await srv.ctx.ports.messages.insert({
          conversation_id: 'c1', bucket: bucketOf(message_id), message_id, sender_id: 'khanh', client_msg_id: `old-${i}`,
          body: `old ${i}`, reply_to: null, media_key: null, media_size: null, media_mime: null, created_at: now,
        });
      }
      expect(bucketOf(ids[0]!)).toBe(202602);
      now = Date.UTC(2027, 2, 15, 9); // March 2027: 202703 … 202602 is 14 buckets

      const before = store().partitionReads;
      const page = await get<Page>('/conversations/c1/messages?user_id=truc&device_id=A1&limit=50');
      expect(page.status).toBe(200);
      expect(store().partitionReads - before).toBeLessThanOrEqual(14);
      expect(store().partitionReads - before).toBe(14);
      expect(idsOf(page.body)).toEqual(ids.slice(10).reverse());
      expect(page.body.next_before).toBe(ids[10]);

      const mark = store().partitionReads;
      const older = await get<Page>(`/conversations/c1/messages?user_id=truc&limit=50&before=${page.body.next_before}`);
      expect(idsOf(older.body)).toEqual(ids.slice(0, 10).reverse());
      // 202602 holds the rest; 202601 is the created bucket and is read once more, nothing older.
      expect(store().partitionReads - mark).toBe(2);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === 'GET /conversations/c1/messages?limit=50 ← Truc·phone (buckets 202703→202602, 14 reads)')).toBe(true);
    });
  });

  describe('GET /conversations/:id/messages/:message_id (design §2.3: jump to a quoted parent, F10)', () => {
    interface Jump { message: Message; before: Message[]; after: Message[] }

    test('returns the row by key with a window around it: before newest-first, after oldest-first', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const ids: MessageId[] = [];
      for (let i = 1; i <= 7; i += 1) ids.push(await sendMsg(khanh, 'c1', `m${i}`));
      const anchor = ids[3]!;

      const bare = await get<Jump>(`/conversations/c1/messages/${anchor}?user_id=truc&device_id=A2`);
      expect(bare.status).toBe(200);
      expect(bare.body.message).toMatchObject({ message_id: anchor, body: 'm4' });
      expect(bare.body.before).toEqual([]);
      expect(bare.body.after).toEqual([]);

      const window = await get<Jump>(`/conversations/c1/messages/${anchor}?user_id=truc&before=2&after=2`);
      expect(window.body.before.map((m) => m.message_id)).toEqual([ids[2], ids[1]]);
      expect(window.body.after.map((m) => m.message_id)).toEqual([ids[4], ids[5]]);

      const both = await get<Jump>(`/conversations/c1/messages/${anchor}?user_id=truc&limit=10`);
      expect(both.body.before.map((m) => m.message_id)).toEqual([ids[2], ids[1], ids[0]]);
      expect(both.body.after.map((m) => m.message_id)).toEqual([ids[4], ids[5], ids[6]]);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === `GET /conversations/c1/messages/${anchor} ← Truc·laptop`)).toBe(true);
    });

    test('404 for an id that is not in the conversation, 403 for a non-member, 400 for a malformed id or window', async () => {
      await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'only');
      expect(await get(`/conversations/c1/messages/${BigInt(id) + 1n}?user_id=truc`)).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await get(`/conversations/c3/messages/${id}?user_id=truc`)).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await get(`/conversations/c1/messages/${id}?user_id=linh`)).toEqual({ status: 403, body: { error: 'not_member' } });
      expect(await get(`/conversations/c1/messages/abc?user_id=truc`)).toEqual({ status: 400, body: { error: 'bad_cursor' } });
      expect(await get(`/conversations/c1/messages/${id}?user_id=truc&before=201`)).toEqual({ status: 400, body: { error: 'bad_limit' } });
    });
  });

  describe('conv:{id}:summary (design §4.3): updated on every store write', () => {
    test('a stored msg writes the summary row: last id, preview, sender, created_at; the next one replaces it', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      expect(await srv.ctx.ports.summaries.get('c1')).toBeUndefined();

      const first = await sendMsg(khanh, 'c1', 'first one');
      const row = await srv.ctx.ports.messages.get('c1', first);
      expect(await srv.ctx.ports.summaries.get('c1')).toEqual({
        conversation_id: 'c1', last_message_id: first, last_preview: 'first one', last_sender: 'khanh', last_at: row!.created_at,
      });

      const second = await sendMsg(khanh, 'c1', 'second one');
      expect(await srv.ctx.ports.summaries.get('c1')).toMatchObject({ last_message_id: second, last_preview: 'second one' });
      expect(await srv.ctx.ports.summaries.get('c2')).toBeUndefined();
    });

    test('the preview is the body cut to 80 characters, or [media] for a media-only message', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const long = 'x'.repeat(79) + 'yz' + ' tail';
      await sendMsg(khanh, 'c1', long);
      expect((await srv.ctx.ports.summaries.get('c1'))!.last_preview).toBe('x'.repeat(79) + 'y…');
      await sendMsg(khanh, 'c1', '', { media_key: 'ap-southeast-1/2026/11/abc' });
      expect((await srv.ctx.ports.summaries.get('c1'))!.last_preview).toBe('[media]');
    });

    test('the summary is written before the ack, so a client that gets msg_ack can already see the row in the list', async () => {
      const srv = await start();
      const order: string[] = [];
      const upsert = srv.ctx.ports.summaries.upsert.bind(srv.ctx.ports.summaries);
      srv.ctx.ports.summaries.upsert = async (s) => { order.push('summary'); await upsert(s); };
      srv.ctx.events.on('message_acked', () => { order.push('ack'); });
      const khanh = await connect(DEVICES.khanhPhone);
      await sendMsg(khanh, 'c1', 'ordered');
      expect(order).toEqual(['summary', 'ack']);
    });
  });

  describe('GET /conversations?since&limit (design §4.3: the chat list from the summary rows)', () => {
    interface ListRow {
      conversation_id: string; last_message_id: MessageId; last_preview: string; last_sender: string; last_at: number;
      my_read_cursor: MessageId | null; unread_count: number; unread_capped: boolean;
    }
    interface List { conversations: ListRow[]; list_cursor: number }

    test('rows come from the summaries ordered by last activity; conversations never written to are omitted; since returns only changed rows', async () => {
      let now = Date.UTC(2026, 10, 1, 8);
      const srv = await start({ clock: { now: () => now } });
      const khanh = await connect(DEVICES.khanhPhone);
      const linh = await connect(DEVICES.linhBot);
      const inC1 = await sendMsg(khanh, 'c1', 'dm from khanh');
      now += 1000;
      const inC3 = await sendMsg(linh, 'c3', 'dm from linh');
      now += 1000;
      const inC2 = await sendMsg(khanh, 'c2', 'group chatter');
      // c2 and c3 are newer than c1; nobody wrote to any other conversation.

      const full = await get<List>('/conversations?user_id=truc&device_id=A2');
      expect(full.status).toBe(200);
      expect(full.body.conversations.map((r) => r.conversation_id)).toEqual(['c2', 'c3', 'c1']);
      expect(full.body.conversations[2]).toEqual({
        conversation_id: 'c1', last_message_id: inC1, last_preview: 'dm from khanh', last_sender: 'khanh', last_at: Date.UTC(2026, 10, 1, 8),
        my_read_cursor: null, unread_count: 1, unread_capped: false,
      });
      expect(full.body.conversations[0]).toMatchObject({ conversation_id: 'c2', last_message_id: inC2 });
      expect(full.body.list_cursor).toBe(Date.UTC(2026, 10, 1, 8) + 2000);

      // Khanh is not in c3: two rows, and neither is c3.
      const khanhList = await get<List>('/conversations?user_id=khanh');
      expect(khanhList.body.conversations.map((r) => r.conversation_id)).toEqual(['c2', 'c1']);

      // Incremental: only rows that changed after the device's list cursor.
      const since = await get<List>(`/conversations?user_id=truc&since=${Date.UTC(2026, 10, 1, 8)}`);
      expect(since.body.conversations.map((r) => r.conversation_id)).toEqual(['c2', 'c3']);
      expect(since.body.conversations[1]).toMatchObject({ last_message_id: inC3 });
      const nothing = await get<List>(`/conversations?user_id=truc&since=${full.body.list_cursor}`);
      expect(nothing.body).toEqual({ conversations: [], list_cursor: full.body.list_cursor });

      const limited = await get<List>('/conversations?user_id=truc&limit=1');
      expect(limited.body.conversations.map((r) => r.conversation_id)).toEqual(['c2']);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === 'GET /conversations?since=0 ← Truc·laptop')).toBe(true);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === `GET /conversations?since=${Date.UTC(2026, 10, 1, 8)} ← Truc`)).toBe(true);
    });

    test('unread_count is the bounded count above the read cursor, capped at 99 with unread_capped', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const ids: MessageId[] = [];
      for (let i = 1; i <= 3; i += 1) ids.push(await sendMsg(khanh, 'c1', `m${i}`));

      const unread = (await get<List>('/conversations?user_id=truc')).body.conversations[0]!;
      expect(unread).toMatchObject({ conversation_id: 'c1', my_read_cursor: null, unread_count: 3, unread_capped: false });

      await srv.ctx.ports.cursors.advanceRead('c1', 'truc', ids[1]!);
      const partly = (await get<List>('/conversations?user_id=truc')).body.conversations[0]!;
      expect(partly).toMatchObject({ my_read_cursor: ids[1], unread_count: 1, unread_capped: false });

      await srv.ctx.ports.cursors.advanceRead('c1', 'truc', ids[2]!);
      const read = (await get<List>('/conversations?user_id=truc')).body.conversations[0]!;
      expect(read).toMatchObject({ my_read_cursor: ids[2], unread_count: 0, unread_capped: false });

      for (let i = 0; i < 120; i += 1) {
        const message_id = srv.ctx.ids.next();
        await srv.ctx.ports.messages.insert({
          conversation_id: 'c1', bucket: bucketOf(message_id), message_id, sender_id: 'khanh', client_msg_id: `bulk-${i}`,
          body: `bulk ${i}`, reply_to: null, media_key: null, media_size: null, media_mime: null, created_at: srv.ctx.clock.now(),
        });
        await srv.ctx.events.emit('message_stored', { message: (await srv.ctx.ports.messages.get('c1', message_id))!, sender: srv.ctx.connections.byDevice('B1')! });
      }
      const capped = (await get<List>('/conversations?user_id=truc')).body.conversations[0]!;
      expect(capped).toMatchObject({ unread_count: 99, unread_capped: true });
    });

    test('400 without user_id or with a malformed since or limit', async () => {
      await start();
      expect(await get('/conversations')).toEqual({ status: 400, body: { error: 'missing_user_id' } });
      expect(await get('/conversations?user_id=truc&since=yesterday')).toEqual({ status: 400, body: { error: 'bad_since' } });
      expect(await get('/conversations?user_id=truc&limit=0')).toEqual({ status: 400, body: { error: 'bad_limit' } });
      expect(await get('/conversations?user_id=truc&limit=201')).toEqual({ status: 400, body: { error: 'bad_limit' } });
    });
  });

  describe('slow-path rate limit (design §4.5; sync-queue ADR condition): one token bucket per server', () => {
    test('cold opens and full-list loads share the bucket and get 429 with retry_after_ms when it is empty; refill follows the clock', async () => {
      let now = Date.UTC(2026, 10, 1, 8);
      const srv = await start({ clock: { now: () => now }, history: { slowPathCapacity: 2, slowPathRefillPerSecond: 1 } });
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'hi');

      expect((await get('/conversations/c1/messages?user_id=truc&device_id=A1')).status).toBe(200);
      expect((await get('/conversations?user_id=truc')).status).toBe(200);
      const limited = await get('/conversations/c1/messages?user_id=truc&device_id=A1');
      expect(limited).toEqual({ status: 429, body: { error: 'slow_path_rate_limited', retry_after_ms: 1000 } });
      expect((await get('/conversations?user_id=truc&device_id=A2')).status).toBe(429);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === '429 slow path: GET /conversations/c1/messages ← Truc·phone, retry in 1000 ms')).toBe(true);
      expect(srv.ctx.trace.rows().some((r) => r.tag === 'http' && r.text === '429 slow path: GET /conversations?since=0 ← Truc·laptop, retry in 1000 ms')).toBe(true);

      // Not the slow path: scroll up, page down, jump, incremental list. All still answered while the bucket is empty.
      expect((await get(`/conversations/c1/messages?user_id=truc&before=${id}`)).status).toBe(200);
      expect((await get(`/conversations/c1/messages?user_id=truc&after=${id}`)).status).toBe(200);
      expect((await get(`/conversations/c1/messages/${id}?user_id=truc&limit=5`)).status).toBe(200);
      expect((await get(`/conversations?user_id=truc&since=${now - 60_000}`)).status).toBe(200);

      now += 500;
      expect((await get<{ retry_after_ms: number }>('/conversations/c1/messages?user_id=truc')).body.retry_after_ms).toBe(500);
      now += 500;
      expect((await get('/conversations/c1/messages?user_id=truc')).status).toBe(200);
      expect((await get('/conversations/c1/messages?user_id=truc')).status).toBe(429);
    });

    test('the defaults are 100 tokens refilled at 50 per second, read from moduleOptions.history', async () => {
      const { DEFAULT_HISTORY_OPTIONS, resolveHistoryOptions } = await import('../../src/history/index.js');
      expect(DEFAULT_HISTORY_OPTIONS).toEqual({ slowPathCapacity: 100, slowPathRefillPerSecond: 50 });
      expect(resolveHistoryOptions({ slowPathCapacity: 7 })).toEqual({ slowPathCapacity: 7, slowPathRefillPerSecond: 50 });
      expect(resolveHistoryOptions(undefined)).toEqual(DEFAULT_HISTORY_OPTIONS);
    });
  });

  describe('S4, the part that exists before B3: the list is usable while the socket is still replaying', () => {
    test('a device fetches the list over HTTP while its connection sits in replay; rows are usable and no deliver has arrived', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'sent while the laptop was away');

      // Hold the laptop in the replay phase, as a long queue drain would (B3).
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      srv.ctx.events.on('device_connected', async ({ conn }) => { if (conn.device_id === 'A2') await held; });
      const laptop = new ScriptedClient(DEVICES.trucLaptop, { url: srv.url, trace: srv.ctx.trace });
      clients.push(laptop);
      await laptop.connect();
      await laptop.hello();
      expect(srv.ctx.connections.byDevice('A2')?.phase).toBe('replay');

      const list = await get<{ conversations: Array<{ conversation_id: string; last_message_id: MessageId; last_preview: string; unread_count: number }> }>('/conversations?user_id=truc&device_id=A2');
      expect(list.status).toBe(200);
      expect(list.body.conversations).toEqual([expect.objectContaining({ conversation_id: 'c1', last_message_id: id, last_preview: 'sent while the laptop was away', unread_count: 1 })]);
      expect(srv.ctx.connections.byDevice('A2')?.phase).toBe('replay');
      expect(laptop.received.filter((f) => f.t === 'deliver')).toHaveLength(0);

      // In the shared trace the list request precedes any deliver row to the laptop.
      const rows = srv.ctx.trace.rows();
      const listAt = rows.findIndex((r) => r.tag === 'http' && r.text === 'GET /conversations?since=0 ← Truc·laptop');
      const deliverAt = rows.findIndex((r) => r.tag === 'deliver' && r.text.includes('Truc·laptop'));
      expect(listAt).toBeGreaterThanOrEqual(0);
      expect(deliverAt === -1 || deliverAt > listAt).toBe(true);
      release();
    });
  });
});
