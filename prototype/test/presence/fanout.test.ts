import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { decodeFrame, encodeFrame, type ClientFrame, type PresenceFrame, type ServerFrame } from '../../src/protocol.js';
import { DEVICES } from '../../src/fixtures.js';
import { InMemoryPresenceBus } from '../../src/presence/PresenceBus.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { FakeTime, until } from '../harness/FakeTime.js';

/**
 * Design §5.5: fan-out is bounded by watchers, not contacts. 200 watchers of one user get
 * one event each per transition, 20 connected non-watchers get nothing, and the channel
 * is joined once per server, not once per watcher.
 */

const T0 = 1_700_000_000_000;

/** A bare socket that hellos as a given user; cheap enough to open a few hundred. */
class Watcher {
  readonly frames: ServerFrame[] = [];
  readonly ws: WebSocket;
  constructor(url: string, readonly user_id: string, readonly device_id: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => { this.frames.push(decodeFrame(data.toString(), 'server')); });
    this.ws.on('error', () => { /* surfaced as close */ });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
  }
  send(frame: ClientFrame): void {
    this.ws.send(encodeFrame(frame));
  }
  presence(): PresenceFrame[] {
    return this.frames.filter((f): f is PresenceFrame => f.t === 'presence');
  }
  has(t: ServerFrame['t'], n: number): boolean {
    return this.frames.filter((f) => f.t === t).length >= n;
  }
}

describe('presence module: fan-out to watchers only', () => {
  let server: ChatServer;
  let time: FakeTime;
  let bus: InMemoryPresenceBus;
  const sockets: Watcher[] = [];
  const clients: ScriptedClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    for (const w of sockets.splice(0)) w.ws.terminate();
    await server.close();
  });

  test('200 watchers of truc get one event per transition, 20 non-watchers get nothing, one channel subscription', async () => {
    time = new FakeTime(T0);
    bus = new InMemoryPresenceBus();
    server = await createChatServer({ port: 0, clock: time, timers: time, seed: true, moduleOptions: { presence: { bus } } });

    const open = async (user_id: string, device_id: string): Promise<Watcher> => {
      const w = new Watcher(server.url, user_id, device_id);
      sockets.push(w);
      await w.open();
      w.send({ t: 'hello', device_id, user_id, last_synced_message_id: null, list_cursor: null, app_state: 'foreground' });
      return w;
    };
    const watchers = await Promise.all(Array.from({ length: 200 }, (_, i) => open(`w${i + 1}`, `W${i + 1}`)));
    const others = await Promise.all(Array.from({ length: 20 }, (_, i) => open(`n${i + 1}`, `N${i + 1}`)));
    await until(() => [...watchers, ...others].every((w) => w.has('hello_ack', 1)), 5000, '220 hello_acks');

    for (const w of watchers) w.send({ t: 'watch', user_ids: ['truc'] });
    await until(() => watchers.every((w) => w.has('presence', 1)), 5000, '200 watch replies');
    expect(bus.subscribers('truc')).toBe(1);

    const truc = new ScriptedClient(DEVICES.trucPhone, { url: server.url, now: () => time.now(), timers: time, mirrorRule: false, reconnect: false });
    clients.push(truc);
    await truc.connect();
    await truc.hello();
    await until(() => watchers.every((w) => w.has('presence', 2)), 5000, '200 online events');

    truc.closeCleanly();
    await until(() => server.ctx.connections.byDevice('A1') === undefined, 2000, 'truc gone');
    const droppedAt = time.now();
    await time.advance(5000);
    await until(() => watchers.every((w) => w.has('presence', 3)), 5000, '200 offline events');

    for (const w of watchers) {
      expect(w.presence()).toEqual([
        { t: 'presence', user_id: 'truc', state: 'offline' },
        { t: 'presence', user_id: 'truc', state: 'online' },
        { t: 'presence', user_id: 'truc', state: 'offline', last_seen: droppedAt },
      ]);
    }
    for (const n of others) expect(n.presence()).toEqual([]);
    const publishes = server.ctx.trace.rows().filter((r) => r.tag === 'presence' && /^PUBLISH pres:truc/.test(r.text));
    expect(publishes.map((r) => r.text.split(' → ')[0])).toEqual(['PUBLISH pres:truc online', `PUBLISH pres:truc offline last_seen=${new Date(droppedAt).toTimeString().slice(0, 8)}`]);
    expect(publishes[1]!.text.split(' → ')[1]!.split(', ')).toHaveLength(200);
  });
});
