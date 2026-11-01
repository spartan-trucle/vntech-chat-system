import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import type { ErrorFrame, MsgAckFrame, MsgFrame } from '../../src/protocol.js';

/**
 * Design §6.2: the message sent after the upload carries `{body, media_key, size, mime,
 * sha256}`. The server validates the claimed size against the intent it minted for that
 * key (the only thing it knows about the object) and the 10 MB cap; nothing else about
 * the bytes is ever seen here.
 */
const SHA = 'c0ffee00'.repeat(8);

describe('B7: media metadata on a msg is validated against the upload intent', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url });
    clients.push(c);
    await c.connect();
    await c.hello();
    return c;
  };
  const intent = async (size: number, mime = 'image/jpeg', sha256 = SHA): Promise<string> => {
    const res = await fetch(`${server!.httpUrl}/media/intent?user_id=truc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size, mime, sha256 }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { media_key: string }).media_key;
  };
  const media = (media_key: string, over: Partial<MsgFrame> = {}): MsgFrame => ({
    t: 'msg', client_msg_id: `cid-${Math.random()}`, conversation_id: 'c1', body: 'pic', media_key,
    media_size: 4_404_019, media_mime: 'image/jpeg', sha256: SHA, ...over,
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
  });

  test('size, mime and sha256 that match the intent are stored on the row', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    const key = await intent(4_404_019);
    phone.send(media(key));
    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    const row = await server.ctx.ports.messages.get('c1', ack.message_id);
    expect(row).toMatchObject({ media_key: key, media_size: 4_404_019, media_mime: 'image/jpeg', sha256: SHA });
  });

  test('a size that does not match the intent is refused and nothing is stored', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    const key = await intent(4_404_019);
    phone.send(media(key, { client_msg_id: 'cid-bad-size', media_size: 9_999_999 }));
    const err = (await phone.expect('error')) as ErrorFrame;
    expect(err.code).toBe('media_size_mismatch');
    expect(await server.ctx.ports.messages.findByClientMsgId('truc', 'cid-bad-size')).toBeUndefined();
    expect(server.ctx.trace.rows().some((r) => r.tag === 'media' && /size mismatch/.test(r.text))).toBe(true);
  });

  test('an intent without a size claim, or a size claim without an intent, is refused', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    const key = await intent(100);
    phone.send({ t: 'msg', client_msg_id: 'cid-no-size', conversation_id: 'c1', body: 'pic', media_key: key });
    expect(((await phone.expect('error')) as ErrorFrame).code).toBe('media_size_missing');
    phone.send(media('vn/2026/11/never-minted', { client_msg_id: 'cid-no-intent', media_size: 100 }));
    expect(((await phone.expect('error')) as ErrorFrame).code).toBe('unknown_media_key');
  });

  test('mime or sha256 that contradict the intent are refused', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    const key = await intent(4_404_019);
    phone.send(media(key, { client_msg_id: 'cid-mime', media_mime: 'video/mp4' }));
    expect(((await phone.expect('error')) as ErrorFrame).code).toBe('media_mime_mismatch');
    phone.send(media(key, { client_msg_id: 'cid-sha', sha256: 'ff'.repeat(32) }));
    expect(((await phone.expect('error')) as ErrorFrame).code).toBe('media_sha256_mismatch');
  });

  test('a key that was never minted here but carries no size claim still passes (B2 tests, foreign uploads)', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    phone.send({ t: 'msg', client_msg_id: 'cid-foreign', conversation_id: 'c1', body: 'pic', media_key: 'vn/2026/11/foreign' });
    await phone.expect('msg_ack');
  });
});
