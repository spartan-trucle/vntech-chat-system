import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';
import { DEVICES } from '../../src/fixtures.js';
import { bucketOf } from '../../src/ids.js';
import type { AckFrame, Message, StreamId } from '../../src/protocol.js';

/**
 * ScriptedClient replay bookkeeping after the replay-mode ADR (2026-11-02): a local store
 * keyed by `message_id` rendered in id order; replay mode from `hello` (and from the first
 * `replay: true` frame after a `replay_done`) to `replay_done`; in replay mode the cursor
 * moves only by the client's own acks (every `ackEvery` replay frames or `ackAfterMs`, and at
 * `replay_done`); outside it each live frame's `stream_id` is applied at once.
 */
describe('ScriptedClient replay bookkeeping (B10): store by message id, replay mode, ack cadence', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true });
    return server;
  };
  /** Connects and says hello with a cursor, so the server replays (an empty stream: replay_done at once). */
  const connect = async (opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(DEVICES.trucPhone, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    c.cursor = '0-0';
    await c.connect();
    await c.hello();
    await until(() => !c.inReplay, 1000, 'replay_done after hello');
    return c;
  };
  const message = (message_id: string, body = `m${message_id}`): Message => ({
    conversation_id: 'c1', bucket: bucketOf(message_id), message_id, sender_id: 'khanh', client_msg_id: `cid-${message_id}`,
    body, reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 0,
  });
  /** Writes a `deliver` straight to the device's socket, as the replay loop or a live push would. */
  const deliver = (srv: ChatServer, message_id: string, stream_id: StreamId, replay: boolean): void => {
    const conn = srv.ctx.connections.byDevice('A1')!;
    srv.ctx.send(conn, { t: 'deliver', message: message(message_id), stream_id, replay });
  };
  const replayDone = (srv: ChatServer): void => {
    srv.ctx.send(srv.ctx.connections.byDevice('A1')!, { t: 'replay_done' });
  };
  const acksSent = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'ack' && r.text.startsWith('Truc·phone →')).map((r) => r.text);
  const delivers = (c: ScriptedClient): number => c.received.filter((f) => f.t === 'deliver').length;
  const dones = (c: ScriptedClient): number => c.received.filter((f) => f.t === 'replay_done').length;

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  test('the store is keyed by message id: a second deliver of the same message is a no-op write, counted, the raw frame still received; rendered() sorts by message id', async () => {
    const srv = await start();
    const c = await connect({ autoAck: false });
    deliver(srv, '102', '10-0', true);
    deliver(srv, '101', '10-1', true);
    deliver(srv, '102', '10-2', false);
    deliver(srv, '9', '10-3', true);
    await until(() => delivers(c) === 4, 1000, 'four delivers');
    expect(c.delivered.map((m) => m.message_id)).toEqual(['102', '101', '9']);
    expect(c.rendered().map((m) => m.message_id)).toEqual(['9', '101', '102']);
    expect([...c.store.keys()].sort()).toEqual(['101', '102', '9']);
    expect(c.duplicatesDropped).toBe(1);
    expect(c.received.filter((f) => f.t === 'deliver')).toHaveLength(4);
    const dedup = srv.ctx.trace.rows().filter((r) => r.tag === 'dedup').map((r) => r.text);
    expect(dedup).toEqual(['Truc·phone already has #102 (sid 10-2), dropped']);
  });

  test('replay mode begins at hello and ends at replay_done; a live frame in replay mode is stored but its stream id is not applied to the cursor', async () => {
    const srv = await start();
    const c = await connect({ autoAck: false });
    expect(c.inReplay).toBe(false);
    c.cursor = '5-0';
    // A second hello on the same connection is refused by the server, so model the boundary with a replay frame.
    deliver(srv, '101', '6-0', true);
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    expect(c.inReplay).toBe(true);
    deliver(srv, '102', '7-0', false);
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(c.cursor).toBe('5-0');
    expect(c.rendered().map((m) => m.message_id)).toEqual(['101', '102']);
    replayDone(srv);
    await until(() => dones(c) === 2, 1000, 'replay_done');
    expect(c.inReplay).toBe(false);
    // Live mode: applied at once, no ack needed for the cursor to move.
    deliver(srv, '103', '8-0', false);
    await until(() => delivers(c) === 3, 1000, 'three delivers');
    expect(c.cursor).toBe('8-0');
  });

  test('in replay mode the client acks every ackEvery replay frames with the highest replay stream id stored; duplicates count, live frames do not', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, ackEvery: 3 });
    const seen: AckFrame[] = [];
    srv.ctx.onFrame('ack', (_conn, frame) => { seen.push(frame); });
    deliver(srv, '101', '1-0', true);
    deliver(srv, '102', '1-1', true);
    deliver(srv, '200', '1-9', false); // live during replay: stored, not counted, not applied
    deliver(srv, '102', '1-2', true);
    await until(() => delivers(c) === 4, 1000, 'four delivers');
    await until(() => seen.length === 1, 1000, 'the ack on the server');
    expect(seen).toEqual([{ t: 'ack', up_to_stream_id: '1-2' }]);
    expect(c.cursor).toBe('1-2');
    expect(c.rendered().map((m) => m.message_id)).toEqual(['101', '102', '200']);
    expect(time.pending()).toBe(0);
  });

  test('or after ackAfterMs of the first unacked replay frame, whichever first; the timer is cleared by the ack', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, ackAfterMs: 500 });
    deliver(srv, '101', '1-0', true);
    deliver(srv, '102', '1-1', true);
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(c.cursor).toBe('0-0');
    expect(acksSent()).toEqual([]);
    await time.advance(499);
    expect(acksSent()).toEqual([]);
    await time.advance(1);
    expect(acksSent()).toEqual(['Truc·phone → up_to=1-1']);
    expect(c.cursor).toBe('1-1');
    expect(time.pending()).toBe(0);
  });

  test('replay_done flushes the pending ack at once, so the cursor is at the last replayed id when replay mode ends', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time });
    deliver(srv, '101', '1-0', true);
    deliver(srv, '102', '1-1', true);
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(time.pending()).toBe(1);
    replayDone(srv);
    await until(() => dones(c) === 2, 1000, 'replay_done');
    expect(acksSent()).toEqual(['Truc·phone → up_to=1-1']);
    expect(c.cursor).toBe('1-1');
    expect(time.pending()).toBe(0);
  });

  test('outside replay mode live frames are acked on the same cadence, with the cursor already applied', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, ackAfterMs: 500 });
    deliver(srv, '101', '2-0', false);
    deliver(srv, '102', '2-1', false);
    await until(() => delivers(c) === 2, 1000, 'two delivers');
    expect(c.cursor).toBe('2-1');
    expect(acksSent()).toEqual([]);
    await time.advance(500);
    expect(acksSent()).toEqual(['Truc·phone → up_to=2-1']);
    expect(time.pending()).toBe(0);
  });

  test('autoAck: false sends nothing; ack() by hand still sets the cursor', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time, autoAck: false });
    deliver(srv, '101', '1-0', true);
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    await time.advance(1000);
    expect(acksSent()).toEqual([]);
    expect(time.pending()).toBe(0);
    c.ack('1-0');
    expect(c.cursor).toBe('1-0');
    expect(acksSent()).toEqual(['Truc·phone → up_to=1-0']);
  });

  test('stop() clears a pending ack timer', async () => {
    const srv = await start();
    const time = new FakeTime();
    const c = await connect({ timers: time });
    deliver(srv, '101', '1-0', true);
    await until(() => delivers(c) === 1, 1000, 'one deliver');
    expect(time.pending()).toBe(1);
    c.stop();
    expect(time.pending()).toBe(0);
  });

  test('onFrame runs after the client\'s own bookkeeping for every frame, so a test can check invariants frame by frame', async () => {
    const srv = await start();
    const log: string[] = [];
    const c = await connect({ autoAck: false, onFrame: (frame, client) => { log.push(`${frame.t}:${client.rendered().length}:${client.inReplay}`); } });
    deliver(srv, '101', '1-0', true);
    replayDone(srv);
    await until(() => dones(c) === 2, 1000, 'replay_done');
    expect(log).toEqual(['hello_ack:0:true', 'replay_done:0:false', 'deliver:1:true', 'replay_done:1:false']);
  });
});
