import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';

const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);
const HOUR = 3_600_000;

describe('B7 GET /media/{key}/url (design §6.3, §6.4): membership at minting time, 1 h bearer URL, host by conversation type', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];

  const start = async (): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, clock: { now: () => NOW } });
    return server;
  };
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const mint = async (user_id = 'truc', sha256 = 'a'.repeat(64)): Promise<string> => {
    const res = await fetch(`${server!.httpUrl}/media/intent?user_id=${user_id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 500_000, mime: 'image/jpeg', sha256 }),
    });
    return ((await res.json()) as { media_key: string }).media_key;
  };
  const url = (media_key: string, user_id: string): Promise<Response> =>
    fetch(`${server!.httpUrl}/media/${media_key}/url?user_id=${user_id}`);
  /** Sends a msg carrying the key and waits for the ack, so `message_stored` has run. */
  const sendWith = async (c: ScriptedClient, conversation_id: string, media_key: string): Promise<void> => {
    c.send({ t: 'msg', client_msg_id: `cid-${media_key.slice(-8)}-${conversation_id}`, conversation_id, body: 'photo', media_key });
    await c.expect('msg_ack');
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('an unknown key → 404; a missing user_id → 400', async () => {
    await start();
    const res = await url('ap-southeast-1/2026/11/00000000-0000-0000-0000-000000000000', 'truc');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    const key = await mint();
    expect((await fetch(`${server!.httpUrl}/media/${key}/url`)).status).toBe(400);
  });

  test('before any message carries the key only the uploader may fetch it, from the bucket', async () => {
    await start();
    const key = await mint('truc');
    const other = await url(key, 'khanh');
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'forbidden' });
    const own = await url(key, 'truc');
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ host: 'bucket', expires_at: NOW + HOUR });
  });

  test('sent in the dm c1: the other member gets a 1 h URL from the bucket; a non-member gets 403', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const key = await mint('truc');
    await sendWith(phone, 'c1', key);

    const khanh = await url(key, 'khanh');
    expect(khanh.status).toBe(200);
    const body = (await khanh.json()) as { get_url: string; expires_at: number; host: string };
    expect(body.host).toBe('bucket');
    expect(body.expires_at).toBe(NOW + HOUR);
    expect(body.get_url).toMatch(new RegExp(`^stub://bucket/${key}\\?sig=[0-9a-f]{32}&exp=${NOW + HOUR}$`));

    const linh = await url(key, 'linh');
    expect(linh.status).toBe(403);
    expect(await linh.json()).toEqual({ error: 'forbidden' });
    const uuid = key.split('/')[3];
    const rows = srv.ctx.trace.rows().filter((r) => r.tag === 'http' && r.text.startsWith('GET')).map((r) => r.text);
    expect(rows).toEqual([
      `GET /media/${uuid}/url ← khanh → member of c1, signed 1 h, host=bucket (dm: straight from the bucket)`,
      `GET /media/${uuid}/url ← linh → 403, not a member of c1`,
    ]);
  });

  test('sent in the group c2: members get the CDN host (design §6.4), with the trace row of the page', async () => {
    const srv = await start();
    const phone = await connect(DEVICES.trucPhone);
    const key = await mint('truc');
    await sendWith(phone, 'c2', key);

    const khanh = await url(key, 'khanh');
    expect(khanh.status).toBe(200);
    const body = (await khanh.json()) as { get_url: string; host: string };
    expect(body.host).toBe('cdn');
    expect(body.get_url.startsWith(`stub://cdn/${key}?sig=`)).toBe(true);
    const uuid = key.split('/')[3];
    const rows = srv.ctx.trace.rows().filter((r) => r.tag === 'http' && r.text.startsWith('GET')).map((r) => r.text);
    expect(rows).toEqual([`GET /media/${uuid}/url ← khanh → member of c2, signed 1 h, host=cdn (group: CDN in front)`]);
  });

  test('two mints of the URL sign independently; neither response carries bytes, a put_url, or the sha256', async () => {
    await start();
    const phone = await connect(DEVICES.trucPhone);
    const key = await mint('truc', 'deadbeef'.repeat(8));
    await sendWith(phone, 'c1', key);
    const a = await (await url(key, 'khanh')).text();
    const b = await (await url(key, 'khanh')).text();
    expect(a).not.toBe(b);
    for (const text of [a, b]) {
      expect(text).not.toContain('put_url');
      expect(text).not.toContain('deadbeef');
      expect(text.length).toBeLessThan(300);
    }
  });
});
