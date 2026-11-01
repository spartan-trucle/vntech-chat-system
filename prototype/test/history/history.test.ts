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
});
