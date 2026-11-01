# Plan B8 · End-to-end scenario suite and trace

Epic text: `.planning/roadmap.md` §3 B8 (approved plan). Design: `docs/design.md` §1.4–§1.5, §4.4, §5.4, §6.2. ADR: `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md` (Conditions). Scenario table: roadmap §0.

## Files

- `prototype/test/scenarios/scenario.ts` — the framework. `defineScenario({id, title, design, realTimers?, run})`; `runScenario(scenario, {realTime})` builds a fresh seeded server on `port: 0` with either a `FakeTime` (design numbers: ping 5 s, dead 10 s, sweep 1 s, debounce 5 s, mirror 15 s, backoff 1 s, batches of 100) or real timers with scaled intervals (ping 50 / dead 100 / sweep 10 ms, debounce 100 ms, mirror 150 ms, backoff 100 ms), and hands `run` a `ScenarioEnv`:
  - `client(device, opts?)` / `connect(device, opts?)`: `ScriptedClient`s sharing the server's `ctx.trace`, clock and timers; every client is stopped and the server closed by the runner whatever happens.
  - `advance(ms)`: fake mode steps the clock 1 s at a time and, across every ping tick, awaits the pong of every healthy connected device (the B6 test pattern); real mode sleeps the scaled duration. `until(cond, what, timeoutMs ≥ 2000)` polls in real time.
  - `step(note)`: a `note` row narrating like the page's scenario bullets. `assert(cond, message)`, `assertEqual(actual, expected, message)`.
  - `get(path)`, `post(path, body)`: HTTP against the server. `rows(tag?)`, `phase(device_id)`, `numbers` (the active interval set), `realTime`, `t0`.
  - `fold(label, fn)`: marks a range of the trace as bulk; the printed trace shows the first row of each tag in the range and one summary line with counts. The server trace itself is never cut; assertions run on the full trace.
  - Result `{id, title, design, realTime, ok, error?, trace: string[], durationMs}`; `trace` is the hop trace in the page's format.
- `prototype/test/scenarios/s1-unclean-drop.ts` … `s6-media-metadata.ts` — one scenario each (below).
- `prototype/test/scenarios/run.ts` — `npm run scenarios`: runs S1–S6 in order, prints each trace prefixed with the scenario id, then `| # | scenario | design | result |`, exit 1 on any failure. `--real-time` or `SCENARIOS_REAL_TIME=1` runs S1 and S5 on real timers (scaled). Exports `scenarios`, `formatTable`, `parseMode`; `main` runs only when executed directly.
- `prototype/test/scenarios/scenario.test.ts` — framework tests (TDD): a passing scenario is `ok` with its trace; a failing assertion is `ok: false` with the message and the trace kept; the runner stops clients and closes the server (no pending fake timer); `fold` renders one summary line; `formatTable` prints the markdown; `parseMode` reads flag and env.
- `prototype/test/scenarios/scenarios.test.ts` — part of `npm test`: one test per scenario on fake time, plus S1 and S5 on real timers; prints the trace only on failure; `testTimeout` 30 s.
- `prototype/README.md` — the Scenarios section and the `test/scenarios/` layout line.

## Scenarios (assertions first, then the steps that satisfy them)

- **S1 unclean drop (§1.2, §1.5, §1.4)**: Truc·phone and Khanh·phone connect; Truc sends one message, Khanh acks (cursor set); 30 s of healthy pings → no death, route present, store untouched by heartbeats. At a ping tick t: `suppressPongs()` + `blackhole()`. Truc sends at t+5 s (push to a dead socket, the queue has it). Death row `Khanh·phone missed 2 pings, dead → DEL route:khanh:B1` with route gone at t+10..11 s. Khanh types one message while down (outbox). The client's own `no ping for 15 s → … reconnect in 1 s` row at t+15 s; `restoreRadio()`; reconnect at t+16 s: hello row carries `cursor=<last acked>`, the outbox message gets a `msg_ack` with the same `client_msg_id` and one store row, Truc's t+5 s message is replayed once (`XRANGE sq:B1 … 1 entries`), `duplicatesDropped` 0.
- **S2 replay (§4.2, §4.4, §4.7)**: Truc·phone, Khanh·phone, Linh·bot live; Khanh acks a primed message; Khanh closes; Truc sends 7 across c1/c2, Linh one in c3; Khanh reconnects with its cursor → `slow_path` unset, exactly the 7 in id order, equal to the store rows, `duplicatesDropped` 0, the XRANGE and ack rows; a live message after is a direct push. Cursor moved back to the primed id → 7 duplicates on the wire, `delivered` unchanged, `duplicatesDropped` 7, dedup rows.
- **S3 dedup (§1.4, §2.2)**: Truc·phone sends, gets the ack, re-sends the same frame (a retry after a lost ack) → two `msg_ack` with one `message_id`, one store row, one entry in `sq:B1`, one `deliver` at Khanh, the `dedup` row.
- **S4 list before replay (§4.3, §4.4)**: Truc·laptop live, primed and acked, takes a full list (cold open, one token) and keeps `list_cursor`; closes. Khanh sends 250 in c1 (folded). Laptop wakes: `GET /conversations?since=<list_cursor>` first → rows with preview, `last_message_id` = the 250th id, `unread_count` 99 capped; no `deliver` received yet and the `http` row precedes every laptop `deliver` row. Then connect + hello → three batches (100, 100, 50) acked by hand; between batches the laptop cold-opens c1 over HTTP (one more token) and gets the newest 50 from the store; `delivered` = the 250 ids, `duplicatesDropped` 0.
- **S5 presence (§5.2–§5.4)**: Khanh `watch(['truc'])` batched 500 ms → exactly one `watch` frame, reply `offline`; Truc·phone connects → `online`; 60 s of heartbeats → `InMemoryPresenceStore.writes` unchanged; drop at t → `offline, last_seen=t` at Khanh in [t+15, t+17] s; Truc·laptop connects, drops at t2, Truc·phone reconnects at t2+12 s → `reconnected inside the 5 s debounce, nothing published`, no frame; `unwatch` → a later clean close publishes to no watchers and Khanh gets no frame.
- **S6 media (§6.2)**: tap both sockets; intent 4.2 MB jpeg → `media_key`; `msg{media_key, media_size, media_mime, sha256}` → ack, deliver at Khanh with the metadata; `GET /media/<key>/url?user_id=khanh` → `stub://bucket/…`, host `bucket` (dm); every frame on both sockets < 600 bytes with no `put_url`/`get_url`/`stub://`; 12.4 MB intent → 413.

## Steps (TDD; whole suite green before every commit)

1. Framework tests red → `scenario.ts`, `run.ts` green. Commit `feat(proto): B8 scenario framework and runner`.
2. S1–S3 (each: assertions written, watched failing on an assertion, then driven). Commit `test(proto): B8 scenarios S1–S3 over the real server`.
3. S4–S6 the same way. Commit `test(proto): B8 scenarios S4–S6`.
4. `scenarios.test.ts` in `npm test` (fake + S1/S5 real), README Scenarios section. Commit `docs(proto): B8 scenario table and how to run it`.
5. `npm test` ×3, `npm run typecheck`, `npm run scenarios` both modes; report with C2 candidates.

## Test strategy

The scenarios are the tests; the framework has its own unit tests. Fake time by default for exact design timestamps; S1 and S5 once on real timers with scaled intervals (roadmap §5 risk). `until` budgets ≥ 2000 ms, no exact real-time assertions, windows in real mode.

## Risks

- The server's `Trace` keeps 2000 rows: S4's bulk is sent by a client with a private trace and sized (250 × ~6 server rows) to stay under the cap; the printed trace folds the bulk.
- Fake-time acks: the client's 20 ms ack gap runs on the fake timers, so scenarios advance the clock after a replay batch or ack by hand.
- Real-timer windows under parallel vitest load: S1/S5 real runs assert rows and frames, not elapsed times, apart from loose upper bounds.
- `ScriptedClient.expect` consumes frames; scenarios read `received`/`delivered` with `until` instead.
