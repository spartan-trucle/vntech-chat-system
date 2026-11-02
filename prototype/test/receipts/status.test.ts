import { afterEach, describe, expect, test } from 'vitest';
import { statusOf } from '../../src/receipts/status.js';
import type { DeviceRecord } from '../../src/ports/index.js';
import type { Message, MsgAckFrame } from '../../src/protocol.js';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';

const message = (over: Partial<Message> = {}): Message => ({
  conversation_id: 'c2', bucket: 202611, message_id: '100', sender_id: 'truc', client_msg_id: 'cid', body: 'x',
  reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 0, ...over,
});
const dev = (device_id: string, user_id: string): DeviceRecord => ({ device_id, user_id, kind: 'phone' });

describe('statusOf: read / delivered / sent derived from cursors, never stored (design §3.3)', () => {
  const members = ['truc', 'khanh', 'linh'];
  const devices = [dev('A1', 'truc'), dev('A2', 'truc'), dev('B1', 'khanh'), dev('B2', 'khanh'), dev('C1', 'linh')];

  test('sent: nobody else has it yet; the sender\'s own cursors do not count', () => {
    const out = statusOf(message(), new Map([['truc', '100']]), new Map([['A1', '100'], ['A2', '100']]), members, devices);
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: [] });
  });

  test('delivered: every device of every other member has a delivery cursor ≥ id', () => {
    const out = statusOf(
      message(),
      new Map(),
      new Map([['B1', '100'], ['B2', '150'], ['C1', '100']]),
      members, devices,
    );
    expect(out).toEqual({ status: 'delivered', read_by: [], delivered_to: ['B1', 'B2', 'C1'] });
  });

  test('one device of one member behind → still sent, the partial list says who has it', () => {
    const out = statusOf(message(), new Map(), new Map([['B1', '100'], ['B2', '99'], ['C1', '100']]), members, devices);
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: ['B1', 'C1'] });
  });

  test('read: every other member\'s read cursor ≥ id, regardless of delivery cursors', () => {
    const out = statusOf(message(), new Map([['khanh', '100'], ['linh', '200']]), new Map(), members, devices);
    expect(out).toEqual({ status: 'read', read_by: ['khanh', 'linh'], delivered_to: [] });
  });

  test('one member read, one only delivered → delivered, read_by names the reader', () => {
    const out = statusOf(message(), new Map([['khanh', '100']]), new Map([['B1', '100'], ['B2', '100'], ['C1', '100']]), members, devices);
    expect(out).toEqual({ status: 'delivered', read_by: ['khanh'], delivered_to: ['B1', 'B2', 'C1'] });
  });

  test('comparison is numeric, not lexicographic', () => {
    const out = statusOf(message({ message_id: '9' }), new Map([['khanh', '10'], ['linh', '10']]), new Map(), members, devices);
    expect(out.status).toBe('read');
  });

  test('a member with no device at all blocks delivered (it has not received the message anywhere)', () => {
    const out = statusOf(message(), new Map(), new Map([['B1', '100'], ['B2', '100']]), members, devices.filter((d) => d.user_id !== 'linh'));
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: ['B1', 'B2'] });
  });

  test('no other member → read (nothing outstanding)', () => {
    expect(statusOf(message(), new Map(), new Map(), ['truc'], devices).status).toBe('read');
  });
});

describe('GET /conversations/:id/messages/:message_id/status?user_id= (design §3.3: one partition read and a compare)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const status = async (conversation_id: string, message_id: string, user_id?: string): Promise<{ code: number; body: unknown }> => {
    const q = user_id === undefined ? '' : `?user_id=${user_id}`;
    const res = await fetch(`${server!.httpUrl}/conversations/${conversation_id}/messages/${message_id}/status${q}`);
    return { code: res.status, body: await res.json() };
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('user_id is required, the caller must be a member, the message must exist', async () => {
    await start();
    const phone = await connect(DEVICES.trucPhone);
    phone.send({ t: 'msg', client_msg_id: 's0', conversation_id: 'c1', body: 'x' });
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    expect(await status('c1', id)).toEqual({ code: 400, body: { error: 'user_id_required' } });
    expect(await status('c1', id, 'linh')).toEqual({ code: 403, body: { error: 'not_member' } });
    expect(await status('c1', '1', 'truc')).toEqual({ code: 404, body: { error: 'not_found' } });
  });

  test('status flips sent → delivered → read as the cursors move; nothing is stored per message', async () => {
    await start();
    const phone = await connect(DEVICES.trucPhone);
    // B11: *delivered* is the device's word, not the push. The automatic frame is off so the
    // reading between the push and the frame is visible; the frame then plays the device.
    const khanh = await connect(DEVICES.khanhPhone, { autoDelivered: false });

    phone.send({ t: 'msg', client_msg_id: 's1', conversation_id: 'c3', body: 'to linh, whose bot is offline' });
    const toLinh = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await settle();
    expect(await status('c3', toLinh, 'truc')).toEqual({ code: 200, body: { status: 'sent', read_by: [], delivered_to: [] } });

    phone.send({ t: 'msg', client_msg_id: 's2', conversation_id: 'c1', body: 'to khanh, live' });
    const toKhanh = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await khanh.expect('deliver');
    await settle();
    expect(await status('c1', toKhanh, 'truc')).toEqual({ code: 200, body: { status: 'sent', read_by: [], delivered_to: [] } }); // pushed, not yet stored by the device

    khanh.send({ t: 'delivered', conversation_id: 'c1', up_to_message_id: toKhanh });
    await settle();
    expect(await status('c1', toKhanh, 'truc')).toEqual({ code: 200, body: { status: 'delivered', read_by: [], delivered_to: ['B1'] } });

    khanh.send({ t: 'receipt', conversation_id: 'c1', last_read_id: toKhanh });
    await settle();
    expect(await status('c1', toKhanh, 'truc')).toEqual({ code: 200, body: { status: 'read', read_by: ['khanh'], delivered_to: ['B1'] } });
    // Status is the message's status for its sender (§3.3); `user_id` is the membership check only.
    expect(await status('c1', toKhanh, 'khanh')).toEqual({ code: 200, body: { status: 'read', read_by: ['khanh'], delivered_to: ['B1'] } });
  });

  test('a group of 100 members: "who has read N" is one readCursors partition read, never 100 row reads', async () => {
    const srv = await start();
    const others = Array.from({ length: 99 }, (_, i) => `m${i + 1}`);
    await srv.ctx.ports.conversations.create({ conversation_id: 'g100', type: 'group', name: 'hundred', members: ['truc', ...others], created_bucket: 202601 });
    const phone = await connect(DEVICES.trucPhone);
    phone.send({ t: 'msg', client_msg_id: 'g100-1', conversation_id: 'g100', body: 'hello all' });
    const id = ((await phone.expect('msg_ack')) as MsgAckFrame).message_id;
    await settle();
    for (const m of others.slice(0, 98)) await srv.ctx.ports.cursors.advanceRead('g100', m, id);

    const cursors = srv.ctx.ports.cursors;
    const calls = { readCursors: 0, readCursor: 0, deliveryCursors: 0 };
    const readCursors = cursors.readCursors.bind(cursors);
    const readCursor = cursors.readCursor.bind(cursors);
    const deliveryCursors = cursors.deliveryCursors.bind(cursors);
    cursors.readCursors = async (c) => { calls.readCursors += 1; return readCursors(c); };
    cursors.readCursor = async (c, u) => { calls.readCursor += 1; return readCursor(c, u); };
    cursors.deliveryCursors = async (c) => { calls.deliveryCursors += 1; return deliveryCursors(c); };

    const partial = await status('g100', id, 'truc');
    expect(partial.code).toBe(200);
    expect((partial.body as { status: string; read_by: string[] }).status).toBe('sent');
    expect((partial.body as { read_by: string[] }).read_by).toEqual(others.slice(0, 98));
    expect(calls).toEqual({ readCursors: 1, readCursor: 0, deliveryCursors: 1 });

    await srv.ctx.ports.cursors.advanceRead('g100', 'm99', id);
    const full = await status('g100', id, 'truc');
    expect((full.body as { status: string; read_by: string[] }).status).toBe('read');
    expect((full.body as { read_by: string[] }).read_by).toHaveLength(99);
    expect(calls).toEqual({ readCursors: 2, readCursor: 0, deliveryCursors: 2 });
  });
});
