# Plan B6 · Presence by subscription

Epic text: `.planning/roadmap.md` §3 B6 (approved plan). Design: `docs/design.md` §5.2–§5.4, §1.5. ADR: `.memory/decisions/2026-11-01-presence-subscription.md`. Scenario S5.

## Files

- `prototype/src/presence/PresenceBus.ts` — the pub/sub port of design §5.3: `PresenceEvent {user_id, state, last_seen?}`, `PresenceBus { publish(user_id, event): Promise<void>; subscribe(user_id, handler): () => void }`, and `InMemoryPresenceBus` (one `Set` of handlers per `pres:{user}` channel; `subscribers(user_id)` as instrumentation, like `writes` on the store). One server, so the server is both publisher and the only subscriber; B9 swaps in Redis.
- `prototype/src/presence/index.ts` — `PresenceOptions {debounceMs 5000, leaseRenewMs 120000, leaseTtlMs 300000, bus?}`, `resolvePresenceOptions`, `registerPresence`:
  - state per user in module memory: `Map<UserId, {state: 'offline'|'online'|'pending-offline', last_seen?, timer?, dropped_at?}>`; a user never seen is `offline` without `last_seen`.
  - `device_connected`: `pending-offline` → cancel timer, `online`, emit nothing (trace `truc: reconnected inside the 5 s debounce, nothing published`); `offline`/unknown → `online`, publish `{online}`, write the lease `presence.set(user, {state:'online'}, leaseTtlMs)`; already `online` (another device) → nothing.
  - `device_disconnected`: drop the connection from every watch set (unsubscribe the channel when a set empties). `reason === 'replaced'` → nothing else (the route belongs to the new connection). `last_device: true` → `pending-offline`, timer `debounceMs` on `ctx.timers` (trace `truc: last device gone → pending-offline, 5 s debounce`); on fire → `offline`, write `presence.set(user, {state:'offline', last_seen}, leaseTtlMs)`, publish. `last_device: false` → trace `truc still has another device connected; presence unchanged`.
  - **`last_seen` is the drop time, captured at the disconnect event**, not the time the debounce fires: `conn.last_pong_at` for a dead socket (the last moment the server heard the device, ≈ t in §5.4) and `clock.now()` for a clean close. Design §5.4 says `last_seen=t`; the page uses the same.
  - `watch{user_ids}`: add the connection to `watching[target]`; subscribe to `pres:{target}` on the first watcher (trace `SUBSCRIBE pres:truc (first watcher on this server)`); reply with the current state of each target as a `presence` frame (trace `Khanh·phone watches truc → current state replied`). **`pending-offline` is replied as `online`**: the debounce says the user is not offline yet, and the watcher is now in the set for the offline event if it fires. `unwatch` removes; last watcher gone → unsubscribe.
  - bus handler: push the `presence` frame to every connection in `watching[user]`. Publish row: `PUBLISH pres:truc offline last_seen=HH:MM:SS → Khanh·phone, …` (or `→ no watchers`), at the publish site since one server knows its own watchers.
  - lease renewal: one interval every `leaseRenewMs` renewing every `online` user with `leaseTtlMs` in one batch, trace `lease renewed for N users, 5 min TTL`. **Armed lazily when the first user goes online and cleared when the last goes offline**, so a server with nobody online owns no timer (and B1's `pending()` assertions at registration and after everyone is gone hold). Nothing in the module reads a pong; the only store writes are the online transition, the offline transition and the batch.
  - cleanup on shutdown: clear the batch interval and every debounce timer, unsubscribe every channel, detach the event listeners (so the `shutdown` kills emit nothing into the module).
- `prototype/test/harness/ScriptedClient.ts` (additive) — `watch(user_ids)` / `unwatch(user_ids)` coalesce changes per `watchBatchMs` (default 500) on the client's injected `timers`, net of cancellations (watch then unwatch inside the window sends nothing); `watching: Set` is the client's net view; `flushWatches()` sends the pending batch now; after every `hello_ack` the client re-sends its full `watching` set (the server keeps watch sets per connection, so a reconnected watcher must resubscribe). Existing API untouched.
- `prototype/test/presence/contracts/presenceBus.contract.ts` + `bus.test.ts` — contract reusable by B9 against Redis.
- `prototype/test/presence/presence.test.ts` — state machine and fan-out on `FakeTime`.
- `prototype/test/presence/lease.test.ts` — off the pong path; one batch at 2 min; lazy arm/disarm.
- `prototype/test/presence/fanout.test.ts` — 200 watchers + 20 non-watchers on raw `ws` sockets.
- `prototype/test/presence/realtime.test.ts` — real timers, scaled down.
- `prototype/test/presence/watchBatching.test.ts` — the harness batching.

## Steps (TDD, each red → green; whole suite green before every commit)

1. Bus contract (subscribe → delivered; unsubscribe → not; other channel untouched; two subscribers; publish with nobody listening is fine). Implement `PresenceBus.ts`. Commit `feat(proto): B6 presence bus port with an in-memory channel per watched user`.
2. Harness batching tests on `FakeTime` (watch a,b then 500 ms → one `watch{a,b}`; watch then unwatch inside the window → nothing; unwatch batches; re-watch after `hello_ack`). Implement in `ScriptedClient`. Commit `feat(proto): B6 client-side watch batching per 500 ms in the harness`.
3. Module tests on `FakeTime`: options defaults; watch reply for a user never seen is `offline` without `last_seen`; connect publishes `online` to watchers and writes one lease; S5 drop: Truc·phone `suppressPongs()`+`blackhole()` at t, Khanh·phone sees nothing at t+10, `device_disconnected` at t+11, `presence{truc, offline, last_seen=t}` lands in [t+15, t+17]; S5 variant: Truc·laptop connects at t+12 → nothing emitted, trace row, and a later clean close proves the state was `online`; a device that never watched receives nothing; `unwatch` stops events; second device of an online user → `presence unchanged`; watcher disconnect empties the set and unsubscribes; `close()` leaves no timer. Implement `src/presence/index.ts`. Commit `feat(proto): B6 presence state machine, watch/unwatch fan-out and lease renewal`.
4. Lease tests: 60 s healthy run → `InMemoryPresenceStore.writes` stays at the connect-time 1, checked after every pong; at 120 s exactly one batch (`writes` 2, one `lease renewed for 1 users` row); timer armed only while someone is online. Fan-out test: 220 raw sockets, hello as `w1…w200` (watch truc) and `n1…n20` (no watch); Truc connects, then closes cleanly; after the debounce every watcher has exactly one offline frame after its online one, every non-watcher zero `presence` frames. Real-timer test with `connection {50,100,10}` and `presence.debounceMs 100`: the offline frame lands between 200 ms and 1.5 s. Commit `test(proto): B6 lease off the pong path, 200-watcher fan-out, real-timer window`.
5. `npm test` ×3, `npm run typecheck`, report.

## Timing tests and B1's client loop

The blackholed `ScriptedClient` in the fake-time tests runs with `reconnect: false` and `mirrorRule: false`, so the schedule under test is the server's (B1 dead at t+11, B6 offline at t+16) and not the client's retry; the reconnect variant uses a second device instead. The harness tests of B1 already cover the loop.

## Out-of-scope assertions B6 necessarily changes

B0/B1 tests pinned "the presence slot is empty"; a faithful B6 cannot keep them:

- `test/server.test.ts` ~101: a `watch` after hello expects `error{unhandled}`. Once B6 handles `watch` there is no client frame type left to probe `unhandled` with for long (B5 takes `receipt`). Amend to assert handler order only.
- `test/harness.test.ts` ~85–98: registers its own `watch` stub and expects `received` to be exactly `['hello_ack', 'presence']`; B6's reply adds a `presence` frame before the stub's. Amend to "first is `hello_ack`, a `presence` arrived".
- `test/connection/client.test.ts` 59, 147, 165: exact `pending()` counts after hello (server pinger + sweeper, client deadline); the lease renewal interval adds one while a user is online. Amend by +1 with the comment extended. Lines 153 and 170 (after everyone is gone) hold because the interval is cleared when the last user goes offline.

These hunks are listed in the report for review; they are the only edits outside `src/presence/**`, `test/presence/**`, `test/harness/ScriptedClient.ts` and this plan.

## Test strategy

Deterministic schedule on `FakeTime` shared by server and clients (advance in 5 s steps awaiting the pong, as B1 does, so a healthy connection stays healthy); one real-timer test with scaled intervals (roadmap §5 risk: fake timers hide a real race); a contract test on the bus for B9. Whole suite three times at the end.

## Risks

- `device_disconnected` for `shutdown` arrives after the module's cleanup ran: listeners are detached in cleanup, so no debounce timer is created on a closing server.
- 220 sockets on fake time: the pinger fires once in the 5 s debounce and all raw sockets auto-pong; the test waits with `until` for the frames to land rather than trusting one yield.
- Trace `last_seen` is formatted with `formatClock` (local time), like the page; tests assert on frames, not on that row.
- The 500 ms batch and the 5 s debounce are independent timers; the watch reply carrying the current state is what makes them compose (see the report).
