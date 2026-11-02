/** Small helpers shared by the seven scenarios. */

import type { Socket } from 'node:net';
import type { MessageId } from '../../src/ids.js';
import type { ConversationId, DeliverFrame, DeviceId, MsgAckFrame, MsgFrame, PresenceFrame, StreamId, UserId } from '../../src/protocol.js';
import type { ScriptedClient } from '../harness/ScriptedClient.js';
import type { ScenarioEnv } from './scenario.js';

export const seconds = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);

export const delivers = (c: ScriptedClient): DeliverFrame[] => c.received.filter((f): f is DeliverFrame => f.t === 'deliver');

export const acksOf = (c: ScriptedClient, frame: MsgFrame): MsgAckFrame[] =>
  c.received.filter((f): f is MsgAckFrame => f.t === 'msg_ack' && f.client_msg_id === frame.client_msg_id);

export const presenceOf = (c: ScriptedClient, user_id: UserId): PresenceFrame[] =>
  c.received.filter((f): f is PresenceFrame => f.t === 'presence' && f.user_id === user_id);

export const replayDones = (c: ScriptedClient): number => c.received.filter((f) => f.t === 'replay_done').length;

/** The stream id a device saw on its first `deliver` of `message_id` (the entry id in its queue). */
export const sidOf = (c: ScriptedClient, message_id: MessageId): StreamId => {
  const frame = delivers(c).find((d) => d.message.message_id === message_id);
  if (!frame) throw new Error(`${c.device.name} never received #${message_id}`);
  return frame.stream_id;
};

/**
 * Holds the reply of the `n`-th XRANGE on `device` (1-based, counted from now) until released,
 * so a scenario can act "during the replay": the loop never waits for an ack (replay-mode ADR),
 * so without this it drains in one go.
 */
export function holdXrange(env: ScenarioEnv, device_id: DeviceId, n: number): { reached: Promise<void>; release: () => void } {
  const queue = env.server.ctx.ports.syncQueue;
  const xrange = queue.xrange.bind(queue);
  let release!: () => void;
  let reachedResolve!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { reachedResolve = r; });
  let calls = 0;
  queue.xrange = async (d, after, count) => {
    const out = await xrange(d, after, count);
    if (d === device_id && (calls += 1) === n) {
      queue.xrange = xrange;
      reachedResolve();
      await released;
    }
    return out;
  };
  return { reached, release };
}

/** Corks a device's server-side TCP socket: nothing written to it flushes until `uncork()`. */
export function corkSocket(env: ScenarioEnv, device_id: DeviceId): Socket {
  const socket = (env.server.ctx.connections.byDevice(device_id)!.socket as unknown as { _socket: Socket })._socket;
  socket.cork();
  return socket;
}

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
