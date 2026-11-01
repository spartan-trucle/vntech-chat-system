import { describe, expect, test } from 'vitest';
import { runScenario, type ScenarioResult } from './scenario.js';
import { scenarios } from './run.js';

/**
 * The six scenarios of the runtime ADR as part of `npm test`: each on fake time with the
 * design's numbers, and S1 and S5 once more on real timers with scaled intervals (roadmap
 * §5 risk: fake timers hide a real race). Nothing is printed unless a scenario fails; then
 * its hop trace is, so the failure can be read against docs/prototype/index.html.
 */

const check = (r: ScenarioResult): void => {
  if (!r.ok) {
    console.log(`\n${r.id} · ${r.title}${r.realTime ? ' (real timers)' : ''} FAILED: ${r.error}`);
    for (const line of r.trace) console.log(`${r.id}  ${line}`);
  }
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
};

describe('B8 scenarios over the real server', { timeout: 30_000 }, () => {
  for (const s of scenarios) {
    test(`${s.id} · ${s.title} (${s.design}) on fake time`, async () => {
      check(await runScenario(s, { realTime: false }));
    });
  }
  for (const s of scenarios.filter((x) => x.realTimers)) {
    test(`${s.id} · ${s.title} on real timers, intervals scaled down`, async () => {
      const r = await runScenario(s, { realTime: true });
      expect(r.realTime).toBe(true);
      check(r);
    });
  }
});
