/**
 * Scripted multi-device client (runtime ADR, roadmap B0). It can suppress pongs, turn
 * its radio off without telling anyone (half-open socket), tear the socket down with no
 * close frame, replay a script, and record a hop trace in the page's format.
 *
 * B1 extends it with the client mirror rule (no ping for 15 s → reconnect with backoff)
 * and the outbox; B0 leaves those hooks (`lastPingAt`, `cursor`) in place.
 */

import WebSocket from 'ws';
import type { Socket } from 'node:net';
import type { FixtureDevice } from '../../src/fixtures.js';
import { decodeFrame, encodeFrame, type AppState, type ClientFrame, type HelloAckFrame, type ServerFrame, type StreamId } from '../../src/protocol.js';
import { Trace } from '../../src/trace.js';

export type FramePredicate = (frame: ServerFrame) => boolean;

export type ScriptStep =
  | { send: ClientFrame }
  | { wait: number }
  | { expect: ServerFrame['t'] | FramePredicate; timeout?: number }
  | { run: (client: ScriptedClient) => void | Promise<void> }
  | { note: string };

export interface ScriptedClientOptions {
  url: string;
  /** Shared trace, so several devices and the server can interleave in one log. */
  trace?: Trace;
  now?: () => number;
}

function describeFrame(frame: ClientFrame | ServerFrame): string {
  switch (frame.t) {
    case 'hello': return `cursor=${frame.last_synced_message_id ?? 'none'} list_cursor=${frame.list_cursor ?? 'none'} ${frame.app_state}`;
    case 'msg': return `${frame.conversation_id} {cid:${frame.client_msg_id.slice(0, 8)}${frame.media_key ? `, media_key=${frame.media_key}` : ''}${frame.reply_to ? `, reply_to=#${frame.reply_to}` : ''}}`;
    case 'ack': return `up_to=${frame.up_to_stream_id}`;
    case 'receipt': return 'user_id' in frame ? `${frame.conversation_id} ${frame.user_id} read ≤ #${frame.last_read_id}` : `${frame.conversation_id} read ≤ #${frame.last_read_id}`;
    case 'watch': case 'unwatch': return frame.user_ids.join(', ');
    case 'hello_ack': return frame.slow_path ? 'slow_path' : 'ok';
    case 'msg_ack': return `{cid:${frame.client_msg_id.slice(0, 8)}, id:#${frame.message_id}}`;
    case 'deliver': return `#${frame.message.message_id} ${frame.message.conversation_id} from ${frame.message.sender_id} sid=${frame.stream_id}`;
    case 'presence': return `${frame.user_id} ${frame.state}${frame.last_seen ? ` last_seen=${frame.last_seen}` : ''}`;
    case 'error': return `${frame.code}: ${frame.message}`;
  }
}

export class ScriptedClient {
  readonly device: FixtureDevice;
  readonly trace: Trace;
  readonly received: ServerFrame[] = [];
  /** Sync cursor the device owns (design §4.7): last acked stream id, sent in every hello. */
  cursor: StreamId | null = null;
  listCursor: number | null = null;
  appState: AppState = 'foreground';
  /** Wall-clock of the last protocol ping seen; B1's mirror rule reads it. */
  lastPingAt: number | null = null;
  pongsSuppressed = false;
  radioOff = false;

  private readonly url: string;
  private readonly now: () => number;
  private ws: WebSocket | null = null;
  private waiters: Array<{ pred: FramePredicate; resolve: (f: ServerFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(device: FixtureDevice, opts: ScriptedClientOptions) {
    this.device = device;
    this.url = opts.url;
    this.now = opts.now ?? Date.now;
    this.trace = opts.trace ?? new Trace({ now: this.now });
  }

  get socket(): WebSocket | null {
    return this.ws;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private tcp(): Socket | undefined {
    return (this.ws as unknown as { _socket?: Socket } | null)?._socket;
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url, { autoPong: false });
    this.ws = ws;
    ws.on('ping', () => {
      this.lastPingAt = this.now();
      if (!this.pongsSuppressed && !this.radioOff) ws.pong();
    });
    ws.on('message', (data) => {
      if (this.radioOff) return;
      const frame = decodeFrame(data.toString(), 'server');
      this.received.push(frame);
      this.trace.add(frame.t, `← ${this.device.name}: ${describeFrame(frame)}`);
      const i = this.waiters.findIndex((w) => w.pred(frame));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w!.timer);
        w!.resolve(frame);
      }
    });
    ws.on('close', (code) => {
      this.trace.add('hb', `${this.device.name}: socket closed (${code})`);
    });
    ws.on('error', () => { /* surfaced as close */ });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    this.trace.add('hb', `${this.device.name}: WS connect`);
  }

  /** Sends hello with the device's cursors and waits for hello_ack. */
  async hello(over: Partial<Pick<ClientFrame & { t: 'hello' }, 'app_state'>> = {}): Promise<HelloAckFrame> {
    this.send({
      t: 'hello',
      device_id: this.device.device_id,
      user_id: this.device.user_id,
      last_synced_message_id: this.cursor,
      list_cursor: this.listCursor,
      app_state: over.app_state ?? this.appState,
    });
    return (await this.expect('hello_ack')) as HelloAckFrame;
  }

  send(frame: ClientFrame): void {
    if (this.radioOff || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.trace.add('lost', `${frame.t} from ${this.device.name}: radio off, frame never leaves the device`);
      return;
    }
    this.trace.add(frame.t, `${this.device.name} → ${describeFrame(frame)}`);
    this.ws.send(encodeFrame(frame));
  }

  /** Acks a replay batch and advances the device-owned cursor (design §4.7). */
  ack(up_to_stream_id: StreamId): void {
    this.cursor = up_to_stream_id;
    this.send({ t: 'ack', up_to_stream_id });
  }

  /** Resolves with the first frame that matches (already received frames count), or rejects after `timeoutMs`. */
  expect(what: ServerFrame['t'] | FramePredicate, timeoutMs = 2000): Promise<ServerFrame> {
    const pred: FramePredicate = typeof what === 'string' ? (f) => f.t === what : what;
    const label = typeof what === 'string' ? what : 'matching frame';
    const consumedUpTo = this.consumed;
    const hitIndex = this.received.findIndex((f, i) => i >= consumedUpTo && pred(f));
    if (hitIndex >= 0) {
      this.consumed = hitIndex + 1;
      return Promise.resolve(this.received[hitIndex]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.device.name}: no ${label} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push({
        pred,
        timer,
        resolve: (f) => { this.consumed = this.received.length; resolve(f); },
        reject,
      });
    });
  }
  /** Index into `received` below which frames were already matched by `expect`. */
  private consumed = 0;

  /** Simulates a client whose transport never answers pings (ADR risk: `ws` auto-pong). */
  suppressPongs(): void {
    this.pongsSuppressed = true;
    this.trace.add('note', `${this.device.name}: pongs suppressed`);
  }

  allowPongs(): void {
    this.pongsSuppressed = false;
  }

  /** Radio loss: the TCP socket stays open, nothing is read or written, nobody is told. */
  blackhole(): void {
    this.radioOff = true;
    this.tcp()?.pause();
    this.trace.add('note', `${this.device.name}: network dropped (unclean: no close frame, nobody is told)`);
  }

  restoreRadio(): void {
    this.radioOff = false;
    this.tcp()?.resume();
    this.trace.add('note', `${this.device.name}: network restored`);
  }

  /** Tears the TCP connection down with no WebSocket close frame (the server sees 1006). */
  destroyWithoutClose(): void {
    this.ws?.terminate();
  }

  closeCleanly(): void {
    this.ws?.close(1000);
  }

  async replay(script: ScriptStep[]): Promise<void> {
    for (const step of script) {
      if ('send' in step) this.send(step.send);
      else if ('wait' in step) await new Promise((r) => setTimeout(r, step.wait));
      else if ('expect' in step) await this.expect(step.expect, step.timeout);
      else if ('run' in step) await step.run(this);
      else if ('note' in step) this.trace.add('note', step.note);
    }
  }
}
