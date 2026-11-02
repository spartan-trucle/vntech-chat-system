/**
 * B8 · scenario framework (runtime ADR: definition of done).
 *
 * A scenario is a scripted run over the real server with the fixture devices. The runner
 * owns the server, the clock and every client; the scenario narrates with `step()` and
 * proves with `assert()`. Its result is a row of the table plus the hop trace in the
 * format of docs/prototype/index.html (`HH:MM:SS  tag  text`), server and devices
 * interleaved, so the two can be compared by eye.
 *
 * Two clocks: by default a `FakeTime` shared by server and clients with the design's
 * numbers (ping 5 s, dead 10 s, mirror 15 s, debounce 5 s), so the printed timestamps read
 * like the page (t, t+10 s, t+15 s). A scenario that declares `realTimers` can also run
 * on real timers with the intervals scaled down a hundredfold (roadmap §5 risk: fake
 * timers hide a real race).
 */

import { isDeepStrictEqual } from 'node:util';
import { createChatServer, type ChatServer, type ChatServerOptions, type ConnectionMode, type ConnectionPhase } from '../../src/server.js';
import type { FixtureDevice } from '../../src/fixtures.js';
import type { DeviceId } from '../../src/protocol.js';
import { formatTraceRow, type TraceRow, type TraceTag } from '../../src/trace.js';
import { ScriptedClient, type ScriptedClientOptions } from '../harness/ScriptedClient.js';
import { FakeTime, until as pollUntil, yieldToIo } from '../harness/FakeTime.js';

export interface ScenarioNumbers {
  pingMs: number;
  deadAfterMs: number;
  sweepMs: number;
  debounceMs: number;
  /** Client mirror rule (design §1.2): no ping for this long means the socket is half-open. */
  mirrorMs: number;
  /** First retry of the reconnect loop (design §1.4). */
  backoffBaseMs: number;
  batchSize: number;
  /** Client-side `watch`/`unwatch` batching window (presence ADR: 500 ms). */
  watchBatchMs: number;
}

/** The design's numbers, printed in the trace as-is. */
export const DESIGN_NUMBERS: ScenarioNumbers = { pingMs: 5000, deadAfterMs: 10_000, sweepMs: 1000, debounceMs: 5000, mirrorMs: 15_000, backoffBaseMs: 1000, batchSize: 100, watchBatchMs: 500 };
/** The same proportions a hundred times faster, for a real-timer run that still ends in seconds. */
export const SCALED_NUMBERS: ScenarioNumbers = { pingMs: 50, deadAfterMs: 100, sweepMs: 10, debounceMs: 100, mirrorMs: 150, backoffBaseMs: 100, batchSize: 100, watchBatchMs: 5 };

/** Fake runs start at local midnight so the trace reads `00:00:00`, `00:00:10`, `00:00:15` like the page's clock. */
export const T0 = new Date(2026, 10, 1, 0, 0, 0).getTime();

export class ScenarioAssertion extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioAssertion';
  }
}

export interface ScenarioEnv {
  readonly server: ChatServer;
  /** The shared fake clock, or null on real timers. */
  readonly time: FakeTime | null;
  readonly realTime: boolean;
  readonly numbers: ScenarioNumbers;
  /** Clock at the start of the run. */
  readonly t0: number;
  /** Clock now, whichever clock is in use. */
  now(): number;
  /** A client sharing the server's trace, clock and timers; stopped by the runner. */
  client(device: FixtureDevice, opts?: Partial<ScriptedClientOptions>): ScriptedClient;
  /** `client()` + `connect()` + `hello()`. */
  connect(device: FixtureDevice, opts?: Partial<ScriptedClientOptions>): Promise<ScriptedClient>;
  /**
   * Moves time forward by `ms` in the active number system (`numbers`). Fake: 1 s steps,
   * awaiting the pong of every healthy connected device across each ping tick, so healthy
   * sockets stay healthy. Real: sleeps `ms`.
   */
  advance(ms: number): Promise<void>;
  /** Lets frames in flight land on both sides: 50 ms of the active clock. */
  settle(): Promise<void>;
  /** Polls in real time; the budget is never below 2 s (load on the test machine). */
  until(cond: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** A `note` row: the narration of the page's scenario bullets. */
  step(note: string): void;
  assert(cond: unknown, message: string): void;
  assertEqual<T>(actual: T, expected: T, message: string): void;
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  /** Server trace texts, optionally one tag. */
  rows(tag?: TraceTag): string[];
  /** Full trace rows, for ordering assertions. */
  traceRows(): readonly TraceRow[];
  phase(device_id: DeviceId): ConnectionPhase | undefined;
  /** The sync module's replay mode of a connection (replay-mode ADR), or undefined when there is none. */
  mode(device_id: DeviceId): ConnectionMode | undefined;
  /** Marks the rows added by `fn` as bulk: printed folded, kept whole in the server trace. */
  fold<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  /** Design sections the scenario proves, as printed in the table. */
  design: string;
  /** True when the scenario can also run on real timers with the scaled numbers (S1, S5, S7). */
  realTimers?: boolean;
  /** Server options the scenario needs on top of the runner's (S7 shrinks the push budget and quiets the heartbeat). */
  server?: Partial<ChatServerOptions>;
  run(env: ScenarioEnv): Promise<void>;
}

export interface Scenario extends ScenarioDefinition {
  realTimers: boolean;
}

export interface ScenarioResult {
  id: string;
  title: string;
  design: string;
  realTime: boolean;
  ok: boolean;
  error?: string;
  /** The hop trace, one line per row, in the page's format (bulk ranges folded). */
  trace: string[];
  durationMs: number;
}

export function defineScenario(def: ScenarioDefinition): Scenario {
  return { ...def, realTimers: def.realTimers ?? false };
}

interface Fold {
  from: number;
  to: number;
  label: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Renders the trace with every fold collapsed to its first row per tag and one summary line. */
export function renderTrace(rows: readonly TraceRow[], folds: Fold[]): string[] {
  const out: string[] = [];
  let i = 0;
  const sorted = [...folds].sort((a, b) => a.from - b.from);
  for (const fold of sorted) {
    for (; i < fold.from && i < rows.length; i += 1) out.push(formatTraceRow(rows[i]!));
    const seen = new Set<string>();
    const folded = new Map<string, number>();
    let hidden = 0;
    for (; i < fold.to && i < rows.length; i += 1) {
      const row = rows[i]!;
      if (!seen.has(row.tag)) {
        seen.add(row.tag);
        out.push(formatTraceRow(row));
      } else {
        hidden += 1;
        folded.set(row.tag, (folded.get(row.tag) ?? 0) + 1);
      }
    }
    if (hidden > 0) {
      const at = rows[Math.min(fold.to, rows.length) - 1]?.at ?? 0;
      const counts = [...folded].map(([tag, n]) => `${tag} ×${n}`).join(', ');
      out.push(formatTraceRow({ at, tag: '…', text: `${fold.label}: ${hidden} more rows folded (${counts})` }));
    }
  }
  for (; i < rows.length; i += 1) out.push(formatTraceRow(rows[i]!));
  return out;
}

export interface RunScenarioOptions {
  realTime: boolean;
  /** Overrides on top of the runner's and the scenario's server options (test/redis injects its ports here). */
  server?: Partial<ChatServerOptions>;
}

export async function runScenario(scenario: Scenario, opts: RunScenarioOptions): Promise<ScenarioResult> {
  const realTime = opts.realTime && scenario.realTimers;
  const numbers = realTime ? SCALED_NUMBERS : DESIGN_NUMBERS;
  const time = realTime ? null : new FakeTime(T0);
  const started = Date.now();

  const base: ChatServerOptions = {
    port: 0,
    serverId: 'srv-1',
    seed: true,
    ...(time ? { clock: time, timers: time } : {}),
    moduleOptions: {
      connection: { pingMs: numbers.pingMs, deadAfterMs: numbers.deadAfterMs, sweepMs: numbers.sweepMs },
      presence: { debounceMs: numbers.debounceMs },
      sync: { batchSize: numbers.batchSize },
    },
  };
  const layered = [scenario.server ?? {}, opts.server ?? {}];
  const server = await createChatServer({
    ...base,
    ...Object.assign({}, ...layered),
    moduleOptions: Object.assign({}, base.moduleOptions, ...layered.map((l) => l.moduleOptions ?? {})),
  });
  const trace = server.ctx.trace;
  const t0 = server.ctx.clock.now();
  const clients: ScriptedClient[] = [];
  const folds: Fold[] = [];

  const now = (): number => server.ctx.clock.now();

  const client = (device: FixtureDevice, over: Partial<ScriptedClientOptions> = {}): ScriptedClient => {
    const base: ScriptedClientOptions = {
      url: server.url,
      trace,
      now,
      mirrorRule: { noPingAfterMs: numbers.mirrorMs },
      reconnect: { baseMs: numbers.backoffBaseMs, capMs: numbers.backoffBaseMs * 30, random: () => 0.5 },
      watchBatchMs: numbers.watchBatchMs,
      ...(time ? { timers: time } : {}),
    };
    const c = new ScriptedClient(device, { ...base, ...over });
    clients.push(c);
    return c;
  };

  const connect = async (device: FixtureDevice, over: Partial<ScriptedClientOptions> = {}): Promise<ScriptedClient> => {
    const c = client(device, over);
    await c.connect();
    await c.hello();
    return c;
  };

  /** Devices whose transport will answer the next ping: connected, radio on, pongs allowed. */
  const healthy = (): DeviceId[] =>
    clients.filter((c) => c.connected && !c.radioOff && !c.pongsSuppressed && server.ctx.connections.byDevice(c.device.device_id) !== undefined)
      .map((c) => c.device.device_id);

  const pongSeen = (device_id: DeviceId): Promise<void> => {
    const conn = server.ctx.connections.byDevice(device_id);
    if (!conn) return Promise.resolve();
    let seen = false;
    conn.socket.once('pong', () => { seen = true; });
    return pollUntil(() => seen || conn.closed, 3000, `pong from ${conn.name}`);
  };

  const advance = async (ms: number): Promise<void> => {
    if (!time) {
      await sleep(Math.max(1, Math.round(ms)));
      return;
    }
    for (let left = ms; left > 0; left -= 1000) {
      const step = Math.min(1000, left);
      const tick = numbers.pingMs;
      const crossesPing = Math.floor((time.now() + step - t0) / tick) > Math.floor((time.now() - t0) / tick);
      const pongs = crossesPing ? healthy().map(pongSeen) : [];
      await time.advance(step);
      await Promise.all(pongs);
      await yieldToIo();
    }
  };

  const env: ScenarioEnv = {
    server,
    time,
    realTime,
    numbers,
    t0,
    now,
    client,
    connect,
    advance,
    settle: () => advance(50),
    until: (cond, what, timeoutMs = 3000) => pollUntil(cond, Math.max(2000, timeoutMs), what),
    step: (note) => trace.add('note', note),
    assert(cond, message) {
      if (!cond) throw new ScenarioAssertion(message);
    },
    assertEqual(actual, expected, message) {
      if (!isDeepStrictEqual(actual, expected)) {
        throw new ScenarioAssertion(`${message}: expected ${describe(expected)}, got ${describe(actual)}`);
      }
    },
    async get(path) {
      const res = await fetch(`${server.httpUrl}${path}`);
      return { status: res.status, body: (await res.json()) as never };
    },
    async post(path, body) {
      const res = await fetch(`${server.httpUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as never };
    },
    rows: (tag) => trace.rows().filter((r) => tag === undefined || r.tag === tag).map((r) => r.text),
    traceRows: () => trace.rows(),
    phase: (device_id) => server.ctx.connections.byDevice(device_id)?.phase,
    mode: (device_id) => server.ctx.connections.byDevice(device_id)?.mode,
    async fold(label, fn) {
      const from = trace.rows().length;
      try {
        return await fn();
      } finally {
        folds.push({ from, to: trace.rows().length, label });
      }
    },
  };

  let ok = true;
  let error: string | undefined;
  try {
    await scenario.run(env);
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
    trace.add('note', `FAILED: ${error}`);
  } finally {
    for (const c of clients) c.stop();
    await server.close();
  }
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    design: scenario.design,
    realTime,
    ok,
    trace: renderTrace(trace.rows(), folds),
    durationMs: Date.now() - started,
  };
  if (error !== undefined) result.error = error;
  return result;
}
