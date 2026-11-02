/**
 * `npm run scenarios`: runs S1–S7 over the real server in order, prints each scenario's hop
 * trace in the format of docs/prototype/index.html (rows prefixed by the scenario id),
 * then a pass/fail table; exit 1 on any failure.
 *
 * Default: fake time with the design's numbers, so the timestamps read like the page.
 * `--real-time` (or `SCENARIOS_REAL_TIME=1`) runs S1, S5 and S7 on real timers with scaled
 * intervals (ping 50 / dead 100 / sweep 10 ms, debounce 100 ms) as well; the other four
 * do not depend on a clock and stay on fake time.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, type Scenario, type ScenarioResult } from './scenario.js';
import { s1 } from './s1-unclean-drop.js';
import { s2 } from './s2-replay-from-cursor.js';
import { s3 } from './s3-duplicate-send.js';
import { s4 } from './s4-list-before-replay.js';
import { s5 } from './s5-presence-debounce.js';
import { s6 } from './s6-media-metadata.js';
import { s7 } from './s7-replay-mode-boundary.js';

export const scenarios: Scenario[] = [s1, s2, s3, s4, s5, s6, s7];

export interface RunMode {
  realTime: boolean;
}

export function parseMode(argv: string[], env: Record<string, string | undefined>): RunMode {
  const flag = argv.includes('--real-time');
  const fromEnv = env['SCENARIOS_REAL_TIME'] === '1';
  return { realTime: flag || fromEnv };
}

export function formatTable(results: ScenarioResult[]): string[] {
  const lines = ['| # | scenario | design | result |', '|---|---|---|---|'];
  for (const r of results) {
    const mode = r.realTime ? ' (real timers)' : '';
    const result = r.ok ? `pass${mode}` : `FAIL${mode}: ${r.error ?? 'unknown'}`;
    lines.push(`| ${r.id} | ${r.title} | ${r.design} | ${result} |`);
  }
  return lines;
}

export async function runAll(mode: RunMode, log: (line: string) => void = console.log): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s, { realTime: mode.realTime });
    results.push(r);
    log(`\n${r.id} · ${r.title} (${r.design})${r.realTime ? ' — real timers, intervals scaled down ×100' : ''}`);
    for (const line of r.trace) log(`${r.id}  ${line}`);
    log(`${r.id}  ${r.ok ? 'pass' : `FAIL: ${r.error ?? ''}`} in ${r.durationMs} ms`);
  }
  log('');
  for (const line of formatTable(results)) log(line);
  return results;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2), process.env);
  const results = await runAll(mode);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
