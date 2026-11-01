import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';
import { DEVICES } from '../../src/fixtures.js';
import { bucketOf } from '../../src/ids.js';
import { streamIdOf } from '../../src/ports/index.js';
import type { AckFrame, Message } from '../../src/protocol.js';

describe('ScriptedClient replay bookkeeping (B3): dedup by message id, auto-ack per batch (design §4.4, §4.7)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  const connect = async (opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(DEVICES.trucPhone, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const message = (message_id: string, body = `m${message_id}`): Message => ({
    conversation_id: 'c1', bucket: bucketOf(message_id), message_id, sender_id: 'khanh', client_msg_id: `cid-${message_id}`,
    body, reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 0,
  });
  /** Writes a `deliver` straight to the device's socket, as the replay would. */
  const deliver = (srv: ChatServer, message_id: string): void => {
    const conn = srv.ctx.connections.byDevice('A1')!;
    srv.ctx.send(conn, { t: 'deliver', message: message(message_id), stream_id: streamIdOf(message_id) });
  };
  const acksSent = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'ack' && r.text.startsWith('Truc·phone →')).map((r) => r.text);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  test('a deliver seen once is rendered; the same message id again is dropped and counted, the raw frame still received', async () => {
    const srv = await start();
    const c = await connect({ autoAck: false });
    deliver(srv, '101');
    deliver(srv, '102');
    deliver(srv, '101');
    await until(() => c.received.length === 4, 1000, 'four frames'); // hello_ack + 3 delivers
    expect(c.delivered.map((m) => m.message_id)).toEqual(['101', '102']);
    expect([...c.seen]).toEqual(['101', '102']);
    expect(c.duplicatesDropped).toBe(1);
    expect(c.received.filter((f) => f.t === 'deliver')).toHaveLength(3);
    const dedup = srv.ctx.trace.rows().filter((r) => r.tag === 'dedup').map((r) => r.text);
    expect(dedup).toEqual(['Truc·phone already has sid 101-0 (#101), dropped']);
  });

  test('auto-ack after the gap: one ack with the last stream id, the cursor advances only then', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, ackGapMs: 20 });
    const seen: AckFrame[] = [];
    srv.ctx.onFrame('ack', (_conn, frame) => { seen.push(frame); });
    deliver(srv, '101');
    deliver(srv, '102');
    await until(() => c.received.length === 3, 1000, 'two delivers');
    expect(c.cursor).toBeNull();
    expect(acksSent()).toEqual([]);
    await time.advance(19);
    expect(acksSent()).toEqual([]);
    await time.advance(1);
    await until(() => seen.length === 1, 1000, 'the ack on the server');
    expect(seen).toEqual([{ t: 'ack', up_to_stream_id: '102-0' }]);
    expect(c.cursor).toBe('102-0');
    expect(time.pending()).toBe(0);
  });

  test('auto-ack at the batch size: the ack goes out at once with the batch\'s last id; duplicates count towards the batch', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, ackBatchSize: 3 });
    deliver(srv, '101');
    deliver(srv, '102');
    deliver(srv, '102');
    deliver(srv, '103');
    await until(() => c.received.length === 5, 1000, 'four delivers');
    expect(acksSent()).toEqual(['Truc·phone → up_to=102-0']);
    expect(c.cursor).toBe('102-0');
    expect(c.delivered.map((m) => m.message_id)).toEqual(['101', '102', '103']);
    // The fourth frame opened a new batch; the gap timer will ack it.
    expect(time.pending()).toBe(1);
    await time.advance(20);
    expect(acksSent()).toEqual(['Truc·phone → up_to=102-0', 'Truc·phone → up_to=103-0']);
    expect(c.cursor).toBe('103-0');
  });

  test('autoAck: false sends nothing; ack() by hand still sets the cursor', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, autoAck: false });
    deliver(srv, '101');
    await until(() => c.received.length === 2, 1000, 'one deliver');
    await time.advance(100);
    expect(acksSent()).toEqual([]);
    expect(time.pending()).toBe(0);
    c.ack('101-0');
    expect(c.cursor).toBe('101-0');
    expect(acksSent()).toEqual(['Truc·phone → up_to=101-0']);
  });

  test('stop() clears a pending gap timer', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time });
    deliver(srv, '101');
    await until(() => c.received.length === 2, 1000, 'one deliver');
    expect(time.pending()).toBe(1);
    c.stop();
    expect(time.pending()).toBe(0);
  });
});
