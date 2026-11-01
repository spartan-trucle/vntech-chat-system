/**
 * `npm run scenarios`: runs S1–S6 over the real server and prints a pass/fail table in
 * the hop-trace format of docs/prototype/index.html. Filled in by B8; until then the
 * table is empty and the exit code is 0.
 */

export interface Scenario {
  id: string;
  title: string;
  run(): Promise<void>;
}

export const scenarios: Scenario[] = [];

async function main(): Promise<void> {
  const rows: Array<{ id: string; title: string; ok: boolean; error?: string }> = [];
  for (const s of scenarios) {
    try {
      await s.run();
      rows.push({ id: s.id, title: s.title, ok: true });
    } catch (e) {
      rows.push({ id: s.id, title: s.title, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  console.log('| # | scenario | result |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.title} | ${r.ok ? 'pass' : `FAIL: ${r.error}`} |`);
  if (rows.length === 0) console.log('| – | no scenarios registered yet (B8) | – |');
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
