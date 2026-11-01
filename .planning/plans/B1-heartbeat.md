# Plan B1 · Heartbeat, detection, reconnect

Epic text: `.planning/roadmap.md` §3 B1 (approved plan). Design: `docs/design.md` §1.2, §1.4, §1.5. Scenario S1.

## Files

- `prototype/src/connection/index.ts` — `ConnectionOptions {pingMs 5000, deadAfterMs 10000, sweepMs 1000}` read from `ctx.moduleOptions['connection']`; pong handler attached on `connection_opened` (writes `conn.last_pong_at` from `ctx.clock`, never a port); pinger interval; 1 s sweeper that calls `ctx.kill(conn, 'dead')` for `now − last_pong_at > deadAfterMs` (identified or not); returns a cleanup that clears both intervals. Trace (`hb`): one row at registration with the three intervals, one row per *unanswered* ping (bounded: at most two before death), one row when an unidentified socket is swept. The `DEL route:` row stays in the core's `kill`.
- `prototype/test/harness/FakeTime.ts` — one object that is both `Clock` and `Timers` (`now`, `setTimeout`, `setInterval`, `advance(ms)` firing due timers in order and yielding to I/O between them, `pending()`), shared by server and client in unit tests.
- `prototype/test/harness/ScriptedClient.ts` — options `timers`, `mirrorRule` (default on, `noPingAfterMs` 15000, resettable deadline re-armed on every ping), `reconnect` (default on; `baseMs` 1000, `capMs` 30000, `jitter` 0.3, injectable `random`); exported pure `backoffDelay(attempt, opts, random)`; `outbox: MsgFrame[]`, `sendMessage(...)` (generates `client_msg_id`, sends now if connected), outbox entry removed on `msg_ack`, flushed in order after `hello_ack` on reconnect; `hello` already carries `this.cursor`; `reconnectAttempts: number[]` (clock stamps) for schedule assertions; `stop()` for teardown. Reconnect engages only for closes the client did not initiate (server kill, mirror rule, network); `closeCleanly`, `destroyWithoutClose`, `stop` do not reconnect. `connect()` rejects with `no network` while the radio is off, so backoff continues until `restoreRadio()`.
- `prototype/test/connection/heartbeat.test.ts` — server side. `prototype/test/connection/client.test.ts` — client side.

## Steps (TDD, each red → green; green before every commit)

1. Server tests on `FakeTime`: options defaults/overrides; pong refreshes `last_pong_at`; pongs suppressed → alive at 10 s, dead at 11 s (`device_disconnected{reason:'dead'}`, route gone, `missed 2 pings, dead → DEL route:` row); healthy connection survives 30 s; clean close → immediate with no time advance; a socket that never sent `hello` is swept too; `close()` leaves no pending timers; zero port calls during a heartbeat-only run. Implement `src/connection/index.ts`. Commit `feat(proto): B1 heartbeat, sweeper and death on the connection module`.
2. Real-time detection path: `moduleOptions {connection:{pingMs:50, deadAfterMs:100, sweepMs:10}}`, `suppressPongs()` + `blackhole()`, dead between 100 ms and a generous upper bound. Commit `test(proto): ...` if green without changes.
3. Client tests on `FakeTime`: backoff table 1·2·4·8·16·30·30 with `random=0.5`; ±30 % bounds; mirror rule fires 15 s after the last ping, not before, re-armed by pings; reconnect schedule while the radio is off matches the table (attempt stamps); server kill (1006) → reconnect after 1 s → `hello` carries the advanced cursor; outbox: three `sendMessage` while down → flushed in order after `hello_ack`, same `client_msg_id`s, removed on `msg_ack`; client-initiated closes do not reconnect. Implement in `ScriptedClient`. Commit `feat(proto): B1 client mirror rule, backoff reconnect and outbox in the harness`.
4. Round trip on shared fake time: pongs suppressed → server dead at 11 s → client reconnects at +1 s → route re-set. `npm test`, `npm run typecheck`, report.

## Test strategy

Unit tests on fake time (deterministic schedule, no sleeps); one real-timer test with scaled intervals for the detection path (roadmap §5 risk: fake timers hide a real race). Whole suite plus typecheck before every commit.

## Risks

- Fake clock with real sockets: pong and close events arrive asynchronously. `advance()` yields to I/O after each fired timer, and tests that depend on a network event await it explicitly rather than trusting the yield.
- Reconnect loops in teardown: `stop()` in `afterEach`; client-initiated closes never reconnect.
- A device replaced by a second `hello` for the same id gets 1006 and would reconnect and replace back; not special-cased (the protocol has no close code for it; test-only situation).
- `ws.ping()` throws on a non-open socket: guarded.
- Open decisions stay open: one URL, no `GET /chat-servers`.
