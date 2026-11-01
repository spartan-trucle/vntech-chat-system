/**
 * S3 · Duplicate send deduplicated by client_msg_id (design §1.4, §2.2).
 *
 * Truc's phone sends, the ack is lost on the way back as far as the phone is concerned,
 * and it retries with the same client_msg_id. The server answers the retry with the same
 * message id: one store row, one queue entry, one deliver at Khanh.
 */

import { DEVICES } from '../../src/fixtures.js';
import { bucketOf } from '../../src/ids.js';
import { defineScenario } from './scenario.js';
import { acksOf, delivers } from './helpers.js';

export const s3 = defineScenario({
  id: 'S3',
  title: 'Duplicate send deduplicated by client_msg_id',
  design: '§1.4, §2.2',
  async run(env) {
    const { messages, syncQueue } = env.server.ctx.ports;

    env.step("Truc's phone and Khanh's phone connect. Truc sends; the server stores, acks, queues and pushes.");
    const truc = await env.connect(DEVICES.trucPhone);
    const khanh = await env.connect(DEVICES.khanhPhone);
    const frame = truc.sendMessage({ conversation_id: 'c1', body: 'Did you get this?' });
    await env.until(() => acksOf(truc, frame).length === 1, 'first ack');
    const id = acksOf(truc, frame)[0]!.message_id;
    await env.until(() => delivers(khanh).length === 1, 'deliver at Khanh');

    env.step(`Truc·phone retries unacked ${frame.client_msg_id.slice(0, 8)} with the same client_msg_id, as it would after a lost ack.`);
    truc.send(frame);
    await env.until(() => acksOf(truc, frame).length === 2, 'second ack for the same client_msg_id');
    await env.settle();

    env.assertEqual(acksOf(truc, frame).map((a) => a.message_id), [id, id], 'two acks, one message id');
    env.assert(env.rows('dedup').includes(`(truc, ${frame.client_msg_id}) already stored as #${id} → same ack, no second row`), 'the dedup row');
    env.assertEqual((await messages.readPartition('c1', bucketOf(id), { limit: 10 })).map((m) => m.message_id), [id], 'one row in the store');
    env.assertEqual(env.rows('store').filter((r) => r.startsWith('INSERT')).length, 1, 'one INSERT');
    env.assertEqual((await syncQueue.xrange('B1', null, 100)).map((e) => e.m), [id], 'one entry in sq:B1');
    env.assertEqual(env.rows('queue').filter((r) => r.startsWith('XADD')).length, 1, 'one XADD');
    env.assertEqual(delivers(khanh).map((d) => d.message.message_id), [id], 'Khanh got it once');
    env.assertEqual(truc.outbox, [], 'the outbox entry left on the first ack');
    env.step('Same ID, no second row, no second deliver: the retry was absorbed by the (sender_id, client_msg_id) index.');
  },
});
