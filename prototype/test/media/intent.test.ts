import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';

/** 2026-11-01T10:00:00Z: the key's yyyy/mm come from the server clock, in UTC. */
const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);
const KEY_RE = /^([a-z0-9-]+)\/(\d{4})\/(\d{2})\/([0-9a-f-]{36})$/;

describe('B7 POST /media/intent (design §6.2): cap, pre-signed PUT stub, no bytes', () => {
  let server: ChatServer | undefined;

  const start = async (media: Record<string, unknown> = {}): Promise<ChatServer> => {
    server = await createChatServer({ port: 0, seed: true, clock: { now: () => NOW }, moduleOptions: { media } });
    return server;
  };
  const intent = (body: unknown, user_id = 'truc'): Promise<Response> =>
    fetch(`${server!.httpUrl}/media/intent?user_id=${user_id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test('over the 10 MB cap → 413, no key minted, trace says so', async () => {
    const srv = await start();
    const res = await intent({ size: 13_002_342, mime: 'video/mp4', sha256: 'a'.repeat(64) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', cap: 10 * 1024 * 1024 });
    const media = srv.ctx.trace.rows().filter((r) => r.tag === 'media').map((r) => r.text);
    expect(media).toEqual(['413: 12.4 MB > 10 MB cap; no upload link minted']);
  });

  test('exactly the cap is allowed', async () => {
    await start();
    const res = await intent({ size: 10 * 1024 * 1024, mime: 'video/mp4', sha256: 'b'.repeat(64) });
    expect(res.status).toBe(200);
  });

  test('bad input → 400: no user_id, size not a non-negative integer, mime/sha256 not strings, body not an object', async () => {
    await start();
    const cases: Array<[unknown, string]> = [
      [{ size: 1, mime: 'image/jpeg', sha256: 'x' }, ''],
      [{ size: -1, mime: 'image/jpeg', sha256: 'x' }, 'truc'],
      [{ size: 1.5, mime: 'image/jpeg', sha256: 'x' }, 'truc'],
      [{ size: '1', mime: 'image/jpeg', sha256: 'x' }, 'truc'],
      [{ size: 1, mime: 7, sha256: 'x' }, 'truc'],
      [{ size: 1, mime: 'image/jpeg' }, 'truc'],
      [[1, 2], 'truc'],
    ];
    for (const [body, user] of cases) {
      const res = await intent(body, user);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request', message: expect.any(String) });
    }
  });

  test('under the cap → 200 with region/yyyy/mm/uuid key, stub PUT URL with the content conditions, and trace rows', async () => {
    const srv = await start();
    const res = await intent({ size: 4_404_019, mime: 'image/jpeg', sha256: 'c'.repeat(64) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const m = KEY_RE.exec(body['media_key'] as string);
    expect(m, String(body['media_key'])).not.toBeNull();
    expect(m!.slice(1, 4)).toEqual(['ap-southeast-1', '2026', '11']);
    expect(body).toEqual({
      media_key: body['media_key'],
      put_url: `stub://bucket/${body['media_key']}`,
      expires_in_s: 600,
      content_length: 4_404_019,
      content_type: 'image/jpeg',
    });
    const rows = srv.ctx.trace.rows().filter((r) => r.tag === 'http' || r.tag === 'media').map((r) => `${r.tag} ${r.text}`);
    expect(rows).toEqual([
      'http POST /media/intent {size:4.2 MB, mime:image/jpeg} ← truc',
      `media pre-signed PUT, 10 min, content-length=4404019 → ${body['media_key']}`,
    ]);
  });

  test('the region comes from the module options', async () => {
    await start({ region: 'eu-west-1' });
    const res = await intent({ size: 10, mime: 'text/plain', sha256: 'd'.repeat(64) });
    expect(((await res.json()) as { media_key: string }).media_key.startsWith('eu-west-1/2026/11/')).toBe(true);
  });

  test('the same sha256 from the same uploader returns the same key (skip re-upload); another uploader gets its own', async () => {
    await start();
    const a = (await (await intent({ size: 10, mime: 'text/plain', sha256: 'e'.repeat(64) })).json()) as { media_key: string };
    const b = (await (await intent({ size: 10, mime: 'text/plain', sha256: 'e'.repeat(64) })).json()) as { media_key: string };
    const c = (await (await intent({ size: 10, mime: 'text/plain', sha256: 'e'.repeat(64) }, 'khanh')).json()) as { media_key: string };
    const d = (await (await intent({ size: 10, mime: 'text/plain', sha256: 'f'.repeat(64) })).json()) as { media_key: string };
    expect(b.media_key).toBe(a.media_key);
    expect(c.media_key).not.toBe(a.media_key);
    expect(d.media_key).not.toBe(a.media_key);
  });
});
