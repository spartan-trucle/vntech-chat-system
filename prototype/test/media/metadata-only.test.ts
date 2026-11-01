import { afterEach, describe, expect, test } from 'vitest';
import { createChatServer, type ChatServer } from '../../src/server.js';
import { ScriptedClient } from '../harness/ScriptedClient.js';
import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { encodeFrame, type DeliverFrame, type MsgAckFrame } from '../../src/protocol.js';

/**
 * S6 (media ADR condition): a media message carries metadata only (`media_key`, size, mime,
 * sha256 as in design §6.2). Every frame that crosses either socket is a few hundred bytes;
 * no upload or download URL and no payload ever ride the real-time connection.
 */
const FRAME_CAP = 600;
const SHA = 'f00dfeed'.repeat(8);

describe('B7 / S6: a msg with media_key is stored and delivered as metadata only; no bytes on the socket', () => {
  let server: ChatServer | undefined;
  const clients: ScriptedClient[] = [];
  /** Every text that went over a client socket, both directions, by device name. */
  const wire: Array<{ who: string; dir: 'out' | 'in'; text: string }> = [];

  const connect = async (device: FixtureDevice): Promise<ScriptedClient> => {
    const c = new ScriptedClient(device, { url: server!.url, trace: server!.ctx.trace });
    clients.push(c);
    await c.connect();
    const ws = c.socket!;
    const send = ws.send.bind(ws);
    (ws as unknown as { send: (data: string) => void }).send = (data: string) => { wire.push({ who: device.name, dir: 'out', text: String(data) }); send(data); };
    ws.on('message', (data) => { wire.push({ who: device.name, dir: 'in', text: data.toString() }); });
    await c.hello();
    return c;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroyWithoutClose();
    await server?.close();
    server = undefined;
    wire.length = 0;
  });

  test('intent over HTTP, key over the socket, deliver carries the key and nothing of the upload', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const phone = await connect(DEVICES.trucPhone);
    const khanh = await connect(DEVICES.khanhPhone);

    // 1. The upload intent is HTTP, not a frame; the "upload" itself happens client ↔ storage and is not modelled.
    const res = await fetch(`${server.httpUrl}/media/intent?user_id=truc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 4_404_019, mime: 'image/jpeg', sha256: SHA }),
    });
    const { media_key, put_url } = (await res.json()) as { media_key: string; put_url: string };
    expect(put_url.startsWith('stub://')).toBe(true);

    // 2. The message references the key and carries the §6.2 metadata, nothing of the bytes.
    phone.send({ t: 'msg', client_msg_id: 'cid-s6', conversation_id: 'c1', body: 'look at this', media_key, media_size: 4_404_019, media_mime: 'image/jpeg', sha256: SHA });
    const ack = (await phone.expect('msg_ack')) as MsgAckFrame;
    const deliver = (await khanh.expect('deliver')) as DeliverFrame;
    expect(deliver.message).toMatchObject({ message_id: ack.message_id, body: 'look at this', media_key, media_size: 4_404_019, media_mime: 'image/jpeg', sha256: SHA });
    const row = await server.ctx.ports.messages.get('c1', ack.message_id);
    expect(row?.media_key).toBe(media_key);

    // 3. Khanh fetches a download URL over HTTP; it never appears on a socket either.
    const dl = await fetch(`${server.httpUrl}/media/${media_key}/url?user_id=khanh`);
    expect(dl.status).toBe(200);
    const { get_url } = (await dl.json()) as { get_url: string };

    // 4. Every frame on both sockets, both directions, is small metadata.
    expect(wire.length).toBeGreaterThanOrEqual(6); // 2 hello, 2 hello_ack, msg, msg_ack, deliver
    for (const f of wire) {
      expect(Buffer.byteLength(f.text), `${f.who} ${f.dir}: ${f.text}`).toBeLessThan(FRAME_CAP);
      expect(f.text).not.toContain('put_url');
      expect(f.text).not.toContain('get_url');
      expect(f.text).not.toContain('stub://');
      expect(f.text).not.toContain('bytes');
      expect(f.text).not.toContain(put_url);
      expect(f.text).not.toContain(get_url);
    }
    // The decoded frames measure the same: the harness saw nothing the wire did not.
    for (const c of [phone, khanh]) for (const f of c.received) expect(Buffer.byteLength(encodeFrame(f))).toBeLessThan(FRAME_CAP);
  });

  test('no HTTP route reads anything but the intent JSON: a PUT of bytes to the stub URL path is not a route of this server', async () => {
    server = await createChatServer({ port: 0, seed: true });
    const res = await fetch(`${server.httpUrl}/media/intent?user_id=truc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 10, mime: 'text/plain', sha256: SHA }),
    });
    const { media_key } = (await res.json()) as { media_key: string };
    const put = await fetch(`${server.httpUrl}/bucket/${media_key}`, { method: 'PUT', body: 'x'.repeat(10) });
    expect(put.status).toBe(404);
    const putOnKey = await fetch(`${server.httpUrl}/media/${media_key}`, { method: 'PUT', body: 'x'.repeat(10) });
    expect(putOnKey.status).toBe(404);
  });
});
