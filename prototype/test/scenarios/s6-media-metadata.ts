/**
 * S6 · Media message carries a media_key only, no bytes (design §6.2; media ADR condition).
 *
 * The upload intent is HTTP; the bytes go client ↔ storage (not modelled); the message
 * over the socket carries {media_key, size, mime, sha256} and nothing else; the recipient
 * fetches a signed URL over HTTP. Every frame on both sockets is a few hundred bytes with
 * no URL in it. An intent over the cap is refused before any byte moves.
 */

import { DEVICES, type FixtureDevice } from '../../src/fixtures.js';
import { encodeFrame, type DeliverFrame } from '../../src/protocol.js';
import type { ScriptedClient } from '../harness/ScriptedClient.js';
import { defineScenario } from './scenario.js';
import { acksOf, delivers } from './helpers.js';

const FRAME_CAP = 600;
const SHA = 'f00dfeed'.repeat(8);
const PHOTO = 4_404_019; // 4.2 MB jpeg
const VIDEO = 13_002_342; // 12.4 MB, over the 10 MB cap

interface Intent {
  media_key: string;
  put_url: string;
  content_length: number;
  content_type: string;
}

export const s6 = defineScenario({
  id: 'S6',
  title: 'Media message carries a media_key only, no bytes',
  design: '§6.2',
  async run(env) {
    /** Every text that crossed a client socket, both directions. */
    const wire: Array<{ who: string; dir: 'out' | 'in'; text: string }> = [];
    const tap = (c: ScriptedClient): void => {
      const ws = c.socket!;
      const send = ws.send.bind(ws);
      (ws as unknown as { send: (data: string) => void }).send = (data: string) => { wire.push({ who: c.device.name, dir: 'out', text: String(data) }); send(data); };
      ws.on('message', (data) => { wire.push({ who: c.device.name, dir: 'in', text: data.toString() }); });
    };
    const connectTapped = async (device: FixtureDevice): Promise<ScriptedClient> => {
      const c = env.client(device);
      await c.connect();
      tap(c);
      await c.hello();
      return c;
    };

    env.step("Truc's phone and Khanh's phone connect; every byte on both sockets is recorded.");
    const truc = await connectTapped(DEVICES.trucPhone);
    const khanh = await connectTapped(DEVICES.khanhPhone);

    env.step('Truc attaches a 4.2 MB photo: the upload intent is HTTP, the pre-signed PUT goes straight to the bucket (not modelled here); only then is the message sent.');
    const intent: { status: number; body: Intent } | undefined = await env.post<Intent>('/media/intent?user_id=truc', { size: PHOTO, mime: 'image/jpeg', sha256: SHA });
    env.assert(intent !== undefined && intent.status === 200, 'intent minted');
    const { media_key, put_url } = intent!.body;
    env.assert(put_url.startsWith('stub://bucket/'), 'PUT URL on the bucket');
    env.assertEqual([intent!.body.content_length, intent!.body.content_type], [PHOTO, 'image/jpeg'], 'the PUT is conditioned on length and type');
    env.assert(/^[a-z0-9-]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/.test(media_key), 'media_key is {region}/{yyyy}/{mm}/{uuid}');

    const frame = truc.sendMessage({ conversation_id: 'c1', body: 'look at this', media_key, media_size: PHOTO, media_mime: 'image/jpeg', sha256: SHA });
    await env.until(() => acksOf(truc, frame).length === 1, 'msg_ack');
    const id = acksOf(truc, frame)[0]!.message_id;
    await env.until(() => delivers(khanh).length === 1, 'deliver at Khanh');
    const deliver: DeliverFrame = delivers(khanh)[0]!;
    env.assertEqual(
      [deliver.message.message_id, deliver.message.media_key, deliver.message.media_size, deliver.message.media_mime, deliver.message.sha256],
      [id, media_key, PHOTO, 'image/jpeg', SHA],
      'the deliver carries the key and the §6.2 metadata',
    );
    env.assertEqual((await env.server.ctx.ports.messages.get('c1', id))?.media_key, media_key, 'the store row carries the key');
    env.assert(env.rows('store').some((r) => r.endsWith(`media_key=${media_key}`)), 'INSERT row names the key');

    env.step('Khanh fetches a download URL over HTTP: 1 h bearer URL, straight from the bucket for a 1:1 chat; it never appears on a socket.');
    const dl = await env.get<{ get_url: string; host: string }>(`/media/${media_key}/url?user_id=khanh`);
    env.assertEqual(dl.status, 200, 'download URL minted');
    env.assertEqual(dl.body.host, 'bucket', 'dm: straight from the bucket');
    env.assert(dl.body.get_url.startsWith(`stub://bucket/${media_key}?sig=`), 'signed bucket URL');

    env.assert(wire.length >= 7, 'hello ×2, hello_ack ×2, msg, msg_ack, deliver crossed the sockets');
    for (const f of wire) {
      env.assert(Buffer.byteLength(f.text) < FRAME_CAP, `${f.who} ${f.dir} frame under ${FRAME_CAP} bytes: ${f.text.slice(0, 80)}`);
      for (const forbidden of ['put_url', 'get_url', 'stub://', put_url, dl.body.get_url]) {
        env.assert(!f.text.includes(forbidden), `${f.who} ${f.dir} frame carries no ${forbidden.slice(0, 12)}`);
      }
    }
    for (const c of [truc, khanh]) for (const f of c.received) env.assert(Buffer.byteLength(encodeFrame(f)) < FRAME_CAP, 'decoded frames measure the same');
    env.step(`${wire.length} frames crossed the two sockets, the largest ${Math.max(...wire.map((f) => Buffer.byteLength(f.text)))} bytes; none carried a URL or a byte of the photo.`);

    env.step('Truc attaches a 12.4 MB video: refused at the upload-link step, before any byte moves.');
    const big = await env.post<{ error: string; cap: number }>('/media/intent?user_id=truc', { size: VIDEO, mime: 'video/mp4', sha256: 'c0ffee'.repeat(10) });
    env.assertEqual(big.status, 413, '413 over the cap');
    env.assertEqual(big.body, { error: 'too_large', cap: 10 * 1024 * 1024 }, 'the cap in the body');
    env.assert(env.rows('media').includes('413: 12.4 MB > 10 MB cap; no upload link minted'), 'the refusal row');
  },
});
