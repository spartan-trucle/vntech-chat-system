import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer, type ChatServerOptions } from '../../src/server.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { MessageId } from '../../src/ids.js';
import { streamIdOf } from '../../src/ports/index.js';
import type { ConversationId, DeliverFrame, MsgAckFrame } from '../../src/protocol.js';
import type { SyncOptions } from '../../src/sync/index.js';

describe('B3 sync queue and replay (design §4.2, §4.4, §4.7; scenario S2)', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  let seq = 0;

  const start = async (sync: Partial<SyncOptions> = {}, over: Partial<ChatServerOptions> = {}): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, ...over, moduleOptions: { sync, ...(over.moduleOptions ?? {}) } });
    return server;
  };
  /** Connects and says hello; the client shares the server's trace so the log interleaves like the page. */
  const connect = async (device: FixtureDevice, opts: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace, mirrorRule: false, reconnect: false, ...opts });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');
  /** Sends one `msg` through the real send path and returns its message id. */
  const sendMsg = async (from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> => {
    const client_msg_id = `cid-${(seq += 1)}`;
    from.send({ t: 'msg', conversation_id, client_msg_id, body });
    const ack = (await from.expect((f) => f.t === 'msg_ack' && f.client_msg_id === client_msg_id)) as MsgAckFrame;
    return ack.message_id;
  };
  const queueRows = (): string[] => server!.ctx.trace.rows().filter((r) => r.tag === 'queue').map((r) => r.text);
  const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server?.close();
    server = undefined;
  });

  describe('append, third in the write order (design §4.2)', () => {
    test('a stored and acked message lands in the stream of every recipient device, never the sender\'s', async () => {
      const srv = await start();
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(phone, 'c2', 'to the group');
      await khanh.expect('deliver');

      const entry = { id: streamIdOf(id), m: id, c: 'c2' };
      for (const device of ['A2', 'B1', 'C1', 'D1', 'E1']) {
        expect(await srv.ctx.ports.syncQueue.xrange(device, null, 100), device).toEqual([entry]);
      }
      expect(await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).toEqual([]);
      expect(queueRows()).toContain(`XADD sq:{device} #${id} × 5 devices`);
    });

    test('the append runs after the sender\'s ack and before the push (write order asserted, not assumed)', async () => {
      const srv = await start();
      const phone = await connect(DEVICES.trucPhone);
      const khanh = await connect(DEVICES.khanhPhone);
      const seqLog: string[] = [];
      const queue = srv.ctx.ports.syncQueue;
      const xadd = queue.xadd.bind(queue);
      queue.xadd = async (d, e) => { seqLog.push(`xadd:${d}`); return xadd(d, e); };
      const tap = (device_id: string, label: string): void => {
        const socket = srv.ctx.connections.byDevice(device_id)!.socket as unknown as { send: (...args: unknown[]) => void };
        const send = socket.send.bind(socket);
        socket.send = (...args: unknown[]) => { seqLog.push(label); send(...args); };
      };
      tap('A1', 'ack');
      tap('B1', 'push');

      await sendMsg(phone, 'c1', 'order');
      await khanh.expect('deliver');
      expect(seqLog).toEqual(['ack', 'xadd:A2', 'xadd:B1', 'push']);
    });
  });

  describe('hello without a cursor (design §4.7: new or wiped device)', () => {
    test('a null cursor takes the slow path: hello_ack{slow_path}, nothing replayed even if the stream has entries', async () => {
      const srv = await start();
      const khanh = await connect(DEVICES.khanhPhone);
      const id = await sendMsg(khanh, 'c1', 'while the phone was away');
      expect(await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).toHaveLength(1);

      const phone = new ScriptedClient(DEVICES.trucPhone, { url: srv.url, trace: srv.ctx.trace, mirrorRule: false, reconnect: false });
      clients.push(phone);
      await phone.connect();
      const ack = await phone.hello();
      expect(ack.slow_path).toBe(true);
      await settle();
      expect(delivers(phone)).toHaveLength(0);
      expect(srv.ctx.connections.byDevice('A1')?.phase).toBe('live');
      expect(queueRows()).toContain('sq:A1: no cursor → slow path (new device)');
      // The entry is still there for a later hello that does carry a cursor.
      expect((await srv.ctx.ports.syncQueue.xrange('A1', null, 100)).map((e) => e.m)).toEqual([id]);
    });
  });
});
