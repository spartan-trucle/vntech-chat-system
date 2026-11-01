import { describe, expect, test } from 'vitest';
import { DEVICES } from '../../src/fixtures.js';
import { defineScenario, DESIGN_NUMBERS, runScenario, SCALED_NUMBERS, type ScenarioEnv } from './scenario.js';
import { formatTable, parseMode } from './run.js';

/**
 * The B8 framework: a scenario is a function over a fresh server with shared trace and
 * clock; the runner owns setup and teardown and turns assertions into a row of the table.
 */

describe('B8 scenario framework', () => {
  test('a passing scenario is ok, its trace is the server trace in the page format, note rows narrate', async () => {
    const s = defineScenario({
      id: 'S0', title: 'smoke', design: '§0',
      async run(env: ScenarioEnv) {
        env.step('Khanh connects.');
        const khanh = await env.connect(DEVICES.khanhPhone);
        env.assert(khanh.connected, 'khanh connected');
        env.assert(env.phase('B1') !== undefined, 'khanh has a connection');
        expect(env.realTime).toBe(false);
        expect(env.numbers).toEqual(DESIGN_NUMBERS);
      },
    });
    const r = await runScenario(s, { realTime: false });
    expect(r).toMatchObject({ id: 'S0', title: 'smoke', design: '§0', ok: true, realTime: false });
    expect(r.error).toBeUndefined();
    expect(r.trace.some((line) => /^\d\d:\d\d:\d\d  note      Khanh connects\.$/.test(line))).toBe(true);
    expect(r.trace.some((line) => /^\d\d:\d\d:\d\d  hb        hello from Khanh·phone cursor=none → SET route:khanh:B1$/.test(line))).toBe(true);
  });

  test('a failing assertion is ok: false with the message; the trace up to the failure is kept', async () => {
    const s = defineScenario({
      id: 'S0', title: 'fails', design: '§0',
      async run(env) {
        env.step('before');
        env.assertEqual(1 + 1, 3, 'arithmetic');
        env.step('never');
      },
    });
    const r = await runScenario(s, { realTime: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('arithmetic');
    expect(r.error).toContain('expected 3');
    expect(r.trace.some((l) => l.endsWith('note      before'))).toBe(true);
    expect(r.trace.some((l) => l.endsWith('note      never'))).toBe(false);
  });

  test('the runner stops every client and closes the server: no fake timer is left armed, the port is released', async () => {
    let probe!: { pending: () => number; httpUrl: string };
    const s = defineScenario({
      id: 'S0', title: 'teardown', design: '§0',
      async run(env) {
        await env.connect(DEVICES.trucPhone);
        await env.connect(DEVICES.khanhPhone);
        probe = { pending: () => env.time!.pending(), httpUrl: env.server.httpUrl };
        throw new Error('boom');
      },
    });
    const r = await runScenario(s, { realTime: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
    expect(probe.pending()).toBe(0);
    await expect(fetch(`${probe.httpUrl}/health`)).rejects.toThrow();
  });

  test('advance on fake time crosses ping ticks with healthy devices still healthy', async () => {
    const s = defineScenario({
      id: 'S0', title: 'advance', design: '§0',
      async run(env) {
        const khanh = await env.connect(DEVICES.khanhPhone);
        await env.advance(30_000);
        env.assert(khanh.connected, 'still connected after 30 s');
        env.assertEqual(env.time!.now() - env.t0, 30_000, 'clock moved 30 s');
        env.assertEqual(env.rows('hb').filter((t) => /dead →/.test(t)), [], 'no death');
        env.assertEqual(khanh.lastPingAt, env.t0 + 30_000, 'the client saw the ping at t+30 s');
      },
    });
    const r = await runScenario(s, { realTime: false });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  test('real timers: scaled numbers, a real clock, advance sleeps the duration it is given', async () => {
    const s = defineScenario({
      id: 'S0', title: 'real', design: '§0', realTimers: true,
      async run(env) {
        expect(env.realTime).toBe(true);
        expect(env.time).toBeNull();
        expect(env.numbers).toEqual(SCALED_NUMBERS);
        const before = Date.now();
        await env.advance(2 * env.numbers.pingMs);
        expect(Date.now() - before).toBeGreaterThanOrEqual(90);
        expect(Date.now() - before).toBeLessThan(2000);
      },
    });
    const r = await runScenario(s, { realTime: true });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.realTime).toBe(true);
  });

  test('a scenario that cannot run on real timers runs on fake time even when real time is asked for', async () => {
    const s = defineScenario({ id: 'S0', title: 'fake only', design: '§0', async run(env) { expect(env.realTime).toBe(false); } });
    const r = await runScenario(s, { realTime: true });
    expect(r.ok).toBe(true);
    expect(r.realTime).toBe(false);
  });

  test('fold: the printed trace keeps the first row of each tag in the range and one summary line; the server trace keeps every row', async () => {
    const s = defineScenario({
      id: 'S0', title: 'fold', design: '§0',
      async run(env) {
        env.step('outside');
        await env.fold('bulk', async () => {
          for (let i = 0; i < 5; i += 1) env.server.ctx.trace.add('store', `row ${i}`);
          for (let i = 0; i < 3; i += 1) env.server.ctx.trace.add('ack', `ack ${i}`);
        });
        env.step('after');
        env.assertEqual(env.rows('store').length, 5, 'all rows kept in the server trace');
      },
    });
    const r = await runScenario(s, { realTime: false });
    expect(r.error).toBeUndefined();
    const texts = r.trace.map((l) => l.slice('HH:MM:SS  '.length));
    const outside = texts.findIndex((t) => t === 'note      outside');
    const after = texts.findIndex((t) => t === 'note      after');
    expect(outside).toBeGreaterThanOrEqual(0);
    expect(texts.slice(outside + 1, after)).toEqual([
      'store     row 0',
      'ack       ack 0',
      '…         bulk: 6 more rows folded (store ×4, ack ×2)',
    ]);
  });

  test('formatTable and parseMode', () => {
    const table = formatTable([
      { id: 'S1', title: 'Unclean drop', design: '§1.2', realTime: false, ok: true, trace: [], durationMs: 10 },
      { id: 'S5', title: 'Presence', design: '§5.2', realTime: true, ok: false, error: 'no offline frame', trace: [], durationMs: 10 },
    ]);
    expect(table).toEqual([
      '| # | scenario | design | result |',
      '|---|---|---|---|',
      '| S1 | Unclean drop | §1.2 | pass |',
      '| S5 | Presence | §5.2 | FAIL (real timers): no offline frame |',
    ]);
    expect(parseMode([], {})).toEqual({ realTime: false });
    expect(parseMode(['--real-time'], {})).toEqual({ realTime: true });
    expect(parseMode([], { SCENARIOS_REAL_TIME: '1' })).toEqual({ realTime: true });
    expect(parseMode([], { SCENARIOS_REAL_TIME: '0' })).toEqual({ realTime: false });
  });
});
