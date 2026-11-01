/** Small helpers shared by the six scenarios. */

import type { MessageId } from '../../src/ids.js';
import type { ConversationId, DeliverFrame, MsgAckFrame, MsgFrame, PresenceFrame, UserId } from '../../src/protocol.js';
import type { ScriptedClient } from '../harness/ScriptedClient.js';
import type { ScenarioEnv } from './scenario.js';

export const seconds = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);

export const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');

export const acksOf = (c: ScriptedClient, frame: MsgFrame): MsgAckFrame[] =>
  c.received.filter((f): f is MsgAckFrame => f.t === 'msg_ack' && f.client_msg_id === frame.client_msg_id);

export const presenceOf = (c: ScriptedClient, user_id: UserId): PresenceFrame[] =>
  c.received.filter((f): f is PresenceFrame => f.t === 'presence' && f.user_id === user_id);

/** Sends one `msg` through the outbox and the real send path; resolves with the message id once acked. */
export async function send(env: ScenarioEnv, from: ScriptedClient, conversation_id: ConversationId, body: string): Promise<MessageId> {
  const frame = from.sendMessage({ conversation_id, body });
  await env.until(() => acksOf(from, frame).length > 0, `msg_ack for ${from.device.name} {cid:${frame.client_msg_id.slice(0, 8)}}`);
  return acksOf(from, frame)[0]!.message_id;
}

/** Fake time: moves to the next ping tick, so `last_pong_at` of every healthy device equals the clock. */
export async function alignToPingTick(env: ScenarioEnv): Promise<void> {
  const into = (env.now() - env.t0) % env.numbers.pingMs;
  if (into !== 0) await env.advance(env.numbers.pingMs - into);
}
