import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { bucketOf } from '../../src/ids.js';
import { streamIdOf } from '../../src/ports/index.js';
import type { DeliverFrame, ErrorFrame, MsgAckFrame, MsgFrame } from '../../src/protocol.js';
import type { MessagingOptions } from '../../src/messaging/index.js';

const msg = (over: Partial<MsgFrame> & Pick<MsgFrame, 'client_msg_id'>): MsgFrame => ({
  t: 'msg', conversation_id: 'c1', body: 'hi', ...over,
});

describe('B2 send path: store, ids, dedup, write order, fan-out (design §2.2, §1.4, §4.2)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (messaging: Partial<MessagingOptions> = {}): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, moduleOptions: { messaging } });
    return server;
  };
  /** Connects and says hello; the client shares the server's trace so the log interleaves like the page. */
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('a msg from a member is stored as one row, acked to the sender, delivered to the other member with a stream id', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);
    const before = srv.ctx.clock.now();

    phone.send(msg({ client_msg_id: 'cid-1', body: 'hello khanh', reply_to: '42', media_key: 'vn/2026/11/k1' }));

    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    expect(ack.client_msg_id).toBe('cid-1');
    const id = ack.message_id;
    const rows = await srv.ctx.ports.messages.readPartition('c1', bucketOf(id), { limit: 10 });
    expect(rows).toEqual([{
      conversation_id: 'c1',
      bucket: bucketOf(id),
      message_id: id,
      sender_id: 'truc',
      client_msg_id: 'cid-1',
      body: 'hello khanh',
      reply_to: '42',
      media_key: 'vn/2026/11/k1',
      media_size: null,
      media_mime: null,
      created_at: expect.any(Number),
    }]);
    expect(rows[0]!.created_at).toBeGreaterThanOrEqual(before);

    const deliver = (await khanh.expect('deliver')) as DeliverFrame;
    expect(deliver.message).toEqual(rows[0]);
    expect(deliver.stream_id).toBe(streamIdOf(id));
    expect(delivers(phone)).toHaveLength(0);
  });

  test('reply_to and media_key are null when the frame carries none', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    phone.send(msg({ client_msg_id: 'cid-2' }));
    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    const row = await srv.ctx.ports.messages.get('c1', ack.message_id);
    expect(row).toMatchObject({ reply_to: null, media_key: null, media_size: null, media_mime: null });
  });

  test('a msg to a conversation the sender is not a member of is refused and nothing is stored', async () => {
    const srv = await start();
    const linh = await connect(DEVICES.linhBot);
    const khanh = await connect(DEVICES.khanhPhone);
    linh.send(msg({ client_msg_id: 'cid-3', conversation_id: 'c1' }));
    const err = (await linh.expect('error')) as ErrorFrame;
    expect(err.code).toBe('not_member');
    expect(await srv.ctx.ports.messages.findByClientMsgId('linh', 'cid-3')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(delivers(khanh)).toHaveLength(0);
  });
});
