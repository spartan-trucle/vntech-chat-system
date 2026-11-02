/**
 * Scripted multi-device client (runtime ADR, roadmap B0 + B1). It can suppress pongs,
 * turn its radio off without telling anyone (half-open socket), tear the socket down
 * with no close frame, replay a script, and record a hop trace in the page's format.
 *
 * B1 (design §1.4): the mirror rule (no ping for 15 s → the socket is half-open, close
 * it and reconnect), reconnect with backoff 1 · 2 · 4 … 30 s and ±30 % jitter, an outbox
 * keyed by `client_msg_id` flushed in order after `hello_ack`, and `hello` carrying the
 * device cursor. The loop only engages for closes the client did not choose: a server
 * kill, the mirror rule, a dead network. `closeCleanly`, `destroyWithoutClose` and
 * `stop` are the app going away and never reconnect. Which server to reconnect to is
 * open (roadmap A3): always the same URL.
 *
 * B6 (presence ADR): `watch`/`unwatch` coalesce changes per `watchBatchMs` (500 ms) net
 * of cancellations, so a scrolled list is one frame per window and a watch undone inside
 * the window never leaves the device; `watching` is the client's net set, re-sent whole
 * after every `hello_ack` because the server keeps watch sets per connection.
 *
 * B10 (live-first and replay-mode ADRs): a local store keyed by `message_id` rendered in
 * id order, never in socket order; replay mode from `hello` (and from the first
 * `replay: true` frame after a `replay_done`) to `replay_done`; in replay mode the cursor
 * moves only by the client's own `ack{up_to_stream_id}` (every `ackEvery` replay frames or
 * `ackAfterMs`, and at `replay_done`); outside it each live frame's `stream_id` is applied
 * at once and acked on the same cadence.
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { FixtureDevice } from '../../src/fixtures.js';
import { decodeFrame, encodeFrame, type AppState, type ClientFrame, type DeliverFrame, type HelloAckFrame, type Message, type MsgFrame, type ServerFrame, type StreamId, type UserId } from '../../src/protocol.js';
import { compareIds, type MessageId } from '../../src/ids.js';
import { compareStreamIds } from '../../src/ports/index.js';
import type { TimerHandle, Timers } from '../../src/server.js';
import { Trace } from '../../src/trace.js';

export type FramePredicate = (frame: ServerFrame) => boolean;

export type ScriptStep =
  | { send: ClientFrame }
  | { wait: number }
  | { expect: ServerFrame['t'] | FramePredicate; timeout?: number }
  | { run: (client: ScriptedClient) => void | Promise<void> }
  | { note: string };

export interface MirrorRuleOptions {
  /** Design §1.2: no ping seen for this long means the socket is half-open. */
  noPingAfterMs?: number;
}

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Fraction of the step, both ways: 0.3 is ±30 %. */
  jitter?: number;
  /** Draw in [0, 1); injectable so a test can pin the schedule (0.5 is the step itself). */
  random?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = { baseMs: 1000, capMs: 30000, jitter: 0.3 };
export const DEFAULT_MIRROR_RULE: Required<MirrorRuleOptions> = { noPingAfterMs: 15000 };

/** Delay before retry number `attempt` (0-based): `min(base · 2^attempt, cap)`, jittered. */
export function backoffDelay(attempt: number, opts: Required<Omit<BackoffOptions, 'random'>>, random: () => number): number {
  const step = Math.min(opts.baseMs * 2 ** attempt, opts.capMs);
  return Math.round(step * (1 - opts.jitter + 2 * opts.jitter * random()));
}

export interface ScriptedClientOptions {
  url: string;
  /** Shared trace, so several devices and the server can interleave in one log. */
  trace?: Trace;
  now?: () => number;
  /** Timers for the mirror deadline and the retry schedule; a test injects `FakeTime`. */
  timers?: Timers;
  /** Default on with 15 s; `false` for tests that drive the socket by hand. */
  mirrorRule?: boolean | MirrorRuleOptions;
  /** Default on with the §1.4 table; `false` to never reconnect. */
  reconnect?: boolean | BackoffOptions;
  /** Window over which `watch`/`unwatch` calls coalesce into one frame each (presence ADR: 500 ms). */
  watchBatchMs?: number;
  /** B10: ack on the client's own cadence (default on): every `ackEvery` frames (100) or `ackAfterMs` (500 ms) on the client's timers. */
  autoAck?: boolean;
  ackEvery?: number;
  ackAfterMs?: number;
  /** Runs after the client's own bookkeeping for every frame received; a test checks invariants here. */
  onFrame?: (frame: ServerFrame, client: ScriptedClient) => void;
}

/** The replay-mode ADR's cadence numbers (the author's, to confirm). */
export const DEFAULT_ACK_EVERY = 100;
export const DEFAULT_ACK_AFTER_MS = 500;

export const DEFAULT_WATCH_BATCH_MS = 500;

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as NodeJS.Timeout),
};

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

function describeFrame(frame: ClientFrame | ServerFrame): string {
  switch (frame.t) {
    case 'hello': return `cursor=${frame.last_synced_message_id ?? 'none'} list_cursor=${frame.list_cursor ?? 'none'} ${frame.app_state}`;
    case 'msg': return `${frame.conversation_id} {cid:${frame.client_msg_id.slice(0, 8)}${frame.media_key ? `, media_key=${frame.media_key}` : ''}${frame.reply_to ? `, reply_to=#${frame.reply_to}` : ''}}`;
    case 'ack': return `up_to=${frame.up_to_stream_id}`;
    case 'receipt': return 'user_id' in frame ? `${frame.conversation_id} ${frame.user_id} read ≤ #${frame.last_read_id}` : `${frame.conversation_id} read ≤ #${frame.last_read_id}`;
    case 'delivered': return `${frame.conversation_id} delivered ≤ #${frame.up_to_message_id}`;
    case 'watch': case 'unwatch': return frame.user_ids.join(', ');
    case 'hello_ack': return frame.slow_path ? 'slow_path' : 'ok';
    case 'msg_ack': return `{cid:${frame.client_msg_id.slice(0, 8)}, id:#${frame.message_id}}`;
    case 'deliver': return `#${frame.message.message_id} ${frame.message.conversation_id} from ${frame.message.sender_id} sid=${frame.stream_id}${frame.replay ? ' replay' : ''}`;
    case 'replay_done': return 'end of replay';
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
  /** Clock of the last protocol ping seen (connect counts as one); the mirror rule reads it. */
  lastPingAt: number | null = null;
  pongsSuppressed = false;
  radioOff = false;
  /** Messages not yet answered by `msg_ack`, in send order; flushed after every `hello_ack` (design §1.4). */
  readonly outbox: MsgFrame[] = [];
  /** Clock stamp of every automatic reconnect attempt, for schedule assertions. */
  readonly reconnectAttempts: number[] = [];
  /** Automatic reconnects that reached `hello_ack`. */
  reconnects = 0;
  /** Users this device watches, net of every `watch`/`unwatch` call, sent or still batched. */
  readonly watching = new Set<UserId>();

  private readonly url: string;
  private readonly watchBatchMs: number;
  private readonly pendingWatch = new Set<UserId>();
  private readonly pendingUnwatch = new Set<UserId>();
  private watchTimer: TimerHandle | null = null;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly mirror: Required<MirrorRuleOptions> | null;
  private readonly backoff: (Required<Omit<BackoffOptions, 'random'>> & { random: () => number }) | null;
  private ws: WebSocket | null = null;
  /** True between a successful `connect()` and a close the client chose. */
  private wanted = false;
  private attempt = 0;
  private deadline: TimerHandle | null = null;
  private retry: TimerHandle | null = null;
  private waiters: Array<{ pred: FramePredicate; resolve: (f: ServerFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  /** Index into `received` below which frames were already matched by `expect`. */
  private consumed = 0;

  constructor(device: FixtureDevice, opts: ScriptedClientOptions) {
    this.device = device;
    this.url = opts.url;
    this.watchBatchMs = opts.watchBatchMs ?? DEFAULT_WATCH_BATCH_MS;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.trace = opts.trace ?? new Trace({ now: this.now });
    const mirror = opts.mirrorRule ?? true;
    this.mirror = mirror === false ? null : { ...DEFAULT_MIRROR_RULE, ...(mirror === true ? {} : mirror) };
    const reconnect = opts.reconnect ?? true;
    this.backoff = reconnect === false
      ? null
      : { ...DEFAULT_BACKOFF, random: Math.random, ...(reconnect === true ? {} : reconnect) };
    this.initReplayBookkeeping(opts);
  }

  get socket(): WebSocket | null {
    return this.ws;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private get name(): string {
    return this.device.name;
  }

  private tcp(): Socket | undefined {
    return (this.ws as unknown as { _socket?: Socket } | null)?._socket;
  }

  /** Opens the socket; rejects with `no network` while the radio is off, like a real dead link. */
  async connect(): Promise<void> {
    if (this.radioOff) throw new Error(`${this.name}: no network`);
    const ws = new WebSocket(this.url, { autoPong: false });
    this.ws = ws;
    ws.on('ping', () => {
      if (this.radioOff) return;
      this.lastPingAt = this.now();
      this.armMirror();
      if (!this.pongsSuppressed) ws.pong();
    });
    ws.on('message', (data) => {
      if (this.radioOff) return;
      const frame = decodeFrame(data.toString(), 'server');
      this.received.push(frame);
      this.trace.add(frame.t, `← ${this.name}: ${describeFrame(frame)}`);
      if (frame.t === 'msg_ack') {
        const i = this.outbox.findIndex((m) => m.client_msg_id === frame.client_msg_id);
        if (i >= 0) this.outbox.splice(i, 1);
      }
      if (frame.t === 'deliver') this.onDeliver(frame);
      if (frame.t === 'replay_done') this.onReplayDone();
      this.onFrame?.(frame, this);
      const i = this.waiters.findIndex((w) => w.pred(frame));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w!.timer);
        w!.resolve(frame);
      }
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) {
        // Already replaced or torn down by the mirror rule; that path wrote its own row.
        return;
      }
      this.ws = null;
      this.disarmMirror();
      if (this.wanted && this.backoff && this.retry === null) {
        this.scheduleReconnect((delay) => `${this.name}: socket closed (${code}) → reconnect in ${seconds(delay)}`);
      } else {
        this.trace.add('hb', `${this.name}: socket closed (${code})`);
      }
    });
    ws.on('error', () => { /* surfaced as close */ });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
    } catch (e) {
      if (this.ws === ws) this.ws = null;
      throw e;
    }
    this.wanted = true;
    this.lastPingAt = this.now();
    this.armMirror();
    this.trace.add('hb', `${this.name}: WS connect`);
  }

  /** Sends hello with the device's cursors (replay mode begins here), waits for hello_ack, then flushes the outbox. */
  async hello(over: Partial<Pick<ClientFrame & { t: 'hello' }, 'app_state'>> = {}): Promise<HelloAckFrame> {
    this.enterReplay('hello');
    this.send({
      t: 'hello',
      device_id: this.device.device_id,
      user_id: this.device.user_id,
      last_synced_message_id: this.cursor,
      list_cursor: this.listCursor,
      app_state: over.app_state ?? this.appState,
    });
    const ack = (await this.expect('hello_ack')) as HelloAckFrame;
    this.flushOutbox();
    this.rewatch();
    return ack;
  }

  // ---- presence subscriptions (design §5.3, presence ADR) ----------------------------

  /** Starts watching users; coalesced with other changes of the window into one `watch` frame. */
  watch(user_ids: UserId[]): void {
    for (const u of user_ids) {
      if (this.pendingUnwatch.delete(u)) { /* undone before it left the device */ }
      else if (!this.watching.has(u)) this.pendingWatch.add(u);
      this.watching.add(u);
    }
    this.armWatchBatch();
  }

  /** Stops watching users; coalesced the same way into one `unwatch` frame. */
  unwatch(user_ids: UserId[]): void {
    for (const u of user_ids) {
      if (this.pendingWatch.delete(u)) { /* never left the device */ }
      else if (this.watching.has(u)) this.pendingUnwatch.add(u);
      this.watching.delete(u);
    }
    this.armWatchBatch();
  }

  /** Sends whatever the window holds now, one frame per direction, and disarms it. */
  flushWatches(): void {
    this.disarmWatchBatch();
    if (this.pendingWatch.size > 0) this.send({ t: 'watch', user_ids: [...this.pendingWatch] });
    if (this.pendingUnwatch.size > 0) this.send({ t: 'unwatch', user_ids: [...this.pendingUnwatch] });
    this.pendingWatch.clear();
    this.pendingUnwatch.clear();
  }

  private armWatchBatch(): void {
    const dirty = this.pendingWatch.size > 0 || this.pendingUnwatch.size > 0;
    if (!dirty) {
      this.disarmWatchBatch();
      return;
    }
    if (this.watchTimer !== null) return;
    this.watchTimer = this.timers.setTimeout(() => {
      this.watchTimer = null;
      this.flushWatches();
    }, this.watchBatchMs);
  }

  private disarmWatchBatch(): void {
    if (this.watchTimer === null) return;
    this.timers.clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  /** The server keeps watch sets per connection: a fresh connection re-sends the whole set at once. */
  private rewatch(): void {
    this.disarmWatchBatch();
    this.pendingWatch.clear();
    this.pendingUnwatch.clear();
    if (this.watching.size === 0) return;
    this.trace.add('note', `${this.name} re-watches ${this.watching.size} users after hello_ack`);
    this.send({ t: 'watch', user_ids: [...this.watching] });
  }

  send(frame: ClientFrame): void {
    if (this.radioOff || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.trace.add('lost', `${frame.t} from ${this.name}: radio off, frame never leaves the device`);
      return;
    }
    this.trace.add(frame.t, `${this.name} → ${describeFrame(frame)}`);
    this.ws.send(encodeFrame(frame));
  }

  /**
   * Writes a message to the outbox with a client-generated `client_msg_id` and sends it now
   * if the socket is live; otherwise it waits for the next `hello_ack` (design §1.4: the
   * client never waits for the heartbeat to send). The entry leaves on `msg_ack`.
   */
  sendMessage(msg: Omit<MsgFrame, 't' | 'client_msg_id'> & { client_msg_id?: string }): MsgFrame {
    const { client_msg_id, ...rest } = msg;
    const frame: MsgFrame = { t: 'msg', client_msg_id: client_msg_id ?? randomUUID(), ...rest };
    this.outbox.push(frame);
    if (this.connected && !this.radioOff) this.send(frame);
    else this.trace.add('note', `${this.name} queues {cid:${frame.client_msg_id.slice(0, 8)}} in the outbox (offline)`);
    return frame;
  }

  /** Resends every unacked message in order with its original `client_msg_id`; the server dedups (B2). */
  flushOutbox(): void {
    if (this.outbox.length === 0 || !this.connected) return;
    for (const frame of [...this.outbox]) this.send(frame);
  }

  /** Acks up to a stream id and sets the device-owned cursor there (design §4.7). */
  ack(up_to_stream_id: StreamId): void {
    this.cursor = up_to_stream_id;
    this.send({ t: 'ack', up_to_stream_id });
  }

  // ---- B10 replay bookkeeping (design §4.4, §4.7; live-first and replay-mode ADRs) ----

  /** The local store, keyed by `message_id`: a second `deliver` of a message is a no-op write. */
  readonly store = new Map<MessageId, Message>();
  /** Every message id this device has stored (the store's keys, kept as a set for the tests that copy it). */
  readonly seen = new Set<MessageId>();
  /** Unique messages in arrival order: the socket order, which is not the rendered order. */
  readonly delivered: Message[] = [];
  /** `deliver` frames dropped by the dedup (a live push also replayed, an over-replay, a cursor sent backwards). */
  duplicatesDropped = 0;
  /** Replay mode: from `hello` (or the first `replay: true` frame after a `replay_done`) to `replay_done`. */
  inReplay = false;
  private autoAck = true;
  private ackEvery = DEFAULT_ACK_EVERY;
  private ackAfterMs = DEFAULT_ACK_AFTER_MS;
  private onFrame: ScriptedClientOptions['onFrame'];
  /** Frames since the last ack (replay frames in replay mode, live frames outside it). */
  private unackedFrames = 0;
  /** The stream id the next ack will carry: the highest replay id stored (replay mode) or the cursor (live mode). */
  private ackTarget: StreamId | null = null;
  private ackTimer: TimerHandle | null = null;

  private initReplayBookkeeping(opts: ScriptedClientOptions): void {
    this.autoAck = opts.autoAck ?? true;
    this.ackEvery = opts.ackEvery ?? DEFAULT_ACK_EVERY;
    this.ackAfterMs = opts.ackAfterMs ?? DEFAULT_ACK_AFTER_MS;
    this.onFrame = opts.onFrame;
  }

  /** What the app shows: the store sorted by `message_id`, never socket arrival order (live-first ADR). */
  rendered(): Message[] {
    return [...this.store.values()].sort((a, b) => compareIds(a.message_id, b.message_id));
  }

  private enterReplay(why: 'hello' | 'frame'): void {
    this.inReplay = true;
    this.unackedFrames = 0;
    this.ackTarget = null;
    this.clearAckTimer();
    if (why === 'frame') this.trace.add('note', `${this.name}: replay mode again (a replay frame after replay_done: the server re-replays after a dropped push)`);
  }

  private onDeliver(frame: DeliverFrame): void {
    const { message, stream_id, replay } = frame;
    if (this.store.has(message.message_id)) {
      this.duplicatesDropped += 1;
      this.trace.add('dedup', `${this.name} already has #${message.message_id} (sid ${stream_id}${replay ? ' replay' : ''}), dropped`);
    } else {
      this.store.set(message.message_id, message);
      this.seen.add(message.message_id);
      this.delivered.push(message);
    }
    if (replay) {
      if (!this.inReplay) this.enterReplay('frame');
      if (this.ackTarget === null || compareStreamIds(stream_id, this.ackTarget) > 0) this.ackTarget = stream_id;
      this.countForAck();
      return;
    }
    // A live frame in replay mode is stored, but entries between the replay position and it are not
    // delivered yet: its stream id must not reach the cursor (cursor rule, live-first ADR).
    if (this.inReplay) return;
    if (this.cursor === null || compareStreamIds(stream_id, this.cursor) > 0) this.cursor = stream_id;
    this.ackTarget = this.cursor;
    this.countForAck();
  }

  private onReplayDone(): void {
    this.inReplay = false;
    if (this.autoAck) this.flushAck();
  }

  private countForAck(): void {
    if (!this.autoAck) return;
    this.unackedFrames += 1;
    if (this.unackedFrames >= this.ackEvery) {
      this.flushAck();
      return;
    }
    if (this.ackTimer !== null) return;
    this.ackTimer = this.timers.setTimeout(() => {
      this.ackTimer = null;
      this.flushAck();
    }, this.ackAfterMs);
  }

  private flushAck(): void {
    this.clearAckTimer();
    const target = this.ackTarget;
    this.unackedFrames = 0;
    this.ackTarget = null;
    if (target !== null && this.connected && !this.radioOff) this.ack(target);
  }

  private clearAckTimer(): void {
    if (this.ackTimer === null) return;
    this.timers.clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }
  // ---- end of the B10 block ----

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
        reject(new Error(`${this.name}: no ${label} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push({
        pred,
        timer,
        resolve: (f) => { this.consumed = this.received.length; resolve(f); },
        reject,
      });
    });
  }

  /** Simulates a client whose transport never answers pings (ADR risk: `ws` auto-pong). */
  suppressPongs(): void {
    this.pongsSuppressed = true;
    this.trace.add('note', `${this.name}: pongs suppressed`);
  }

  allowPongs(): void {
    this.pongsSuppressed = false;
  }

  /** Radio loss: the TCP socket stays open, nothing is read or written, nobody is told. */
  blackhole(): void {
    this.radioOff = true;
    this.tcp()?.pause();
    this.trace.add('note', `${this.name}: network dropped (unclean: no close frame, nobody is told)`);
  }

  /** Radio back. A pending retry fires on its schedule; the loop is not short-cut. */
  restoreRadio(): void {
    this.radioOff = false;
    this.tcp()?.resume();
    this.trace.add('note', `${this.name}: network restored`);
  }

  /** The app is gone: tears the TCP connection down with no close frame (the server sees 1006), no reconnect. */
  destroyWithoutClose(): void {
    this.giveUp();
    this.ws?.terminate();
  }

  /** The app closes on purpose: close frame 1000, no reconnect. */
  closeCleanly(): void {
    this.giveUp();
    this.ws?.close(1000);
  }

  /** Teardown for tests: stops every timer and drops the socket; never reconnects. */
  stop(): void {
    this.destroyWithoutClose();
    for (const w of this.waiters.splice(0)) clearTimeout(w.timer);
    this.clearAckTimer();
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

  // ---- mirror rule and reconnect (design §1.2, §1.4) ---------------------------------

  private giveUp(): void {
    this.wanted = false;
    this.disarmMirror();
    this.disarmWatchBatch();
    if (this.retry !== null) {
      this.timers.clearTimeout(this.retry);
      this.retry = null;
    }
  }

  private armMirror(): void {
    if (!this.mirror) return;
    this.disarmMirror();
    this.deadline = this.timers.setTimeout(() => this.onMirrorExpired(), this.mirror.noPingAfterMs);
  }

  private disarmMirror(): void {
    if (this.deadline === null) return;
    this.timers.clearTimeout(this.deadline);
    this.deadline = null;
  }

  private onMirrorExpired(): void {
    this.deadline = null;
    const ws = this.ws;
    if (!ws || !this.mirror) return;
    this.ws = null;
    ws.terminate();
    const silent = seconds(this.mirror.noPingAfterMs);
    if (this.wanted && this.backoff) {
      this.scheduleReconnect((delay) => `${this.name}: no ping for ${silent} → socket is half-open, close and reconnect in ${seconds(delay)}`);
    } else {
      this.trace.add('hb', `${this.name}: no ping for ${silent} → socket is half-open, closed`);
    }
  }

  private scheduleReconnect(describe: (delayMs: number) => string): void {
    if (!this.backoff || this.retry !== null) return;
    const delay = backoffDelay(this.attempt, this.backoff, this.backoff.random);
    this.trace.add('hb', describe(delay));
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      void this.tryReconnect();
    }, delay);
  }

  private async tryReconnect(): Promise<void> {
    if (!this.wanted) return;
    this.reconnectAttempts.push(this.now());
    this.attempt += 1;
    const attempt = this.attempt;
    try {
      await this.connect();
      const pending = this.outbox.length;
      this.trace.add('hb', `${this.name}: reconnected on attempt ${attempt}, ${pending === 0 ? 'outbox empty' : `flushing ${pending} from the outbox with the same client_msg_ids`}`);
      await this.hello();
    } catch (e) {
      const ws = this.ws;
      this.ws = null;
      ws?.terminate();
      const reason = this.radioOff ? 'no network' : e instanceof Error ? e.message : String(e);
      this.scheduleReconnect((delay) => `${this.name} reconnect failed (${reason}); next try in ${seconds(delay)}`);
      return;
    }
    this.attempt = 0;
    this.reconnects += 1;
  }
}
