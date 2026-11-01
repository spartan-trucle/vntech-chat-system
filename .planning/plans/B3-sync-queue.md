# Plan B3 · Sync queue and replay

Epic text: `.planning/roadmap.md` §3 B3 (approved plan). Design §4.2 (three operations, write order),
§4.4 (reconnect sequence), §4.5 (bounds), §4.7 (device-owned cursor, ack-only advance);
`.memory/decisions/2026-11-01-sync-queue-redis-streams.md`. Scenario S2.

## Prerequisite check (sync-queue ADR condition: the slow path exists before the queue is relied on)

Verified on the lane head `a6373d4` before any B3 code:

- `GET /conversations?user_id=truc` on a seeded server (`createChatServer({ port: 0, seed: true })`)
  answers `200 {"conversations":[],"list_cursor":0}` and writes the trace row
  `http  GET /conversations?since=0 ← Truc`.
- `prototype/src/history/index.ts` charges the slow-path token bucket: the bucket is built at line 139
  (`new TokenBucket({ capacity: opts.slowPathCapacity, refillPerSecond: … })`), `chargeSlowPath`
  calls `slowPath.take()` at line 167 and answers `429 slow_path_rate_limited` with `retry_after_ms`
  when empty; the list route at line 254 charges it for `since=0` (full-list load) and the message
  route charges it for a cold open. `test/history/history.test.ts` line 315 onwards asserts the 429.

So a device that gets `hello_ack{slow_path: true}` has somewhere to go: B4's list, then load on open.

## Files

- `prototype/src/sync/index.ts` — `registerSync(ctx)`: append on `message_acked`, slow-path decision on
  `hello`, replay on `device_connected`, `ack` frame handler, hourly sweeper; `SyncOptions`
  (`batchSize` 100, `ackTimeoutMs` 5000, `sweepMs` 3 600 000, `windowMs` 86 400 000) read from
  `ctx.moduleOptions['sync']`; `idAt(ms)` helper for the trim boundary.
- `prototype/test/sync/options.test.ts` — options defaults and `idAt` (pure).
- `prototype/test/sync/replay.test.ts` — real server on port 0, seeded fixtures, `ScriptedClient`s.
- `prototype/test/sync/harness-replay.test.ts` — the client-side additions (dedup, `delivered`, auto-ack).
- `prototype/test/harness/ScriptedClient.ts` — additive block near `ack()` (see below).
- `.planning/plans/B3-sync-queue.md` — this file.

Not touched: `src/server.ts`, `src/protocol.ts`, `src/ports/**`, `src/messaging/**`, `src/history/**`,
other modules, docs, README, memory, progress. `InMemorySyncQueue` is used as is.

## Behaviour

**Append (third in the write order).** `message_acked{message, recipient_devices}` → for every device
`xadd(device, {id: streamIdOf(message_id), m, c})`; every device id ever appended to goes into a
module-level `Set` (the port has no "list streams"; the sweeper walks this set). One trace row
`queue  XADD sq:{device} #id × N devices`.

**Slow-path decision (`hello` listener, runs before `hello_ack` is sent).**
`cursor = frame.last_synced_message_id`.
- `cursor === null` → new or wiped device (design §4.7): `ack.slow_path = true`, no replay, trace
  `queue  sq:{device}: no cursor → slow path (new device)`.
- Else slow path iff `lastTrimmedId.get(device) !== undefined && compareStreamIds(cursor, lastTrimmedId) < 0`,
  where `lastTrimmedId` is the `MINID` boundary of the last sweep that actually dropped entries from
  that stream. Trace `queue  sq:{device}: cursor C behind oldest retained F (trimmed at T) → slow path`.
- Otherwise replay from the cursor. A cursor equal to `first`, or older than `first` when nothing was
  ever trimmed, replays (nothing can have been lost).

Why this rule and not `cursor < first`: `first` alone cannot distinguish "entries between the cursor
and `first` were dropped" from "nothing was ever appended between them" (a device that acked its last
live message and then received nothing has `first ≤ cursor`, but a fresh stream after a restart has
`first === null`). Recording the trim boundary makes it decidable: if the cursor is below a boundary
that dropped entries, entries in `(cursor, boundary)` may have existed, and §4.7 says to err towards
more replay, never less, so the device takes the slow path. It is conservative (a cursor just below the
boundary with no entry actually lost also takes the slow path), which is the allowed direction.
Not covered: silent `MAXLEN ~` eviction inside `xadd`, which the port does not report (see report).

**Replay (`device_connected` listener; `conn.phase === 'replay'` while it runs).**
```
loop:
  batch = xrange(device, cursor, batchSize)
  if batch is empty → return now (no timer, no socket await after the last empty xrange)
  trace queue  XRANGE sq:{device} (cursor + → N entries, join bodies from the store
  messages = messages.getMany(batch refs)   (missing rows skipped, as the port says)
  send one deliver{message, stream_id: entry.id} per entry, in order
  wait for ack{up_to_stream_id ≥ last id of the batch} (ackTimeoutMs on ctx.timers)
    timeout → trace lost, stop; the device keeps its cursor and replays again next hello
    socket closed → stop
  cursor = acked id
```
Returning synchronously after the empty `xrange` is what makes "live traffic begins after replay" hold:
the core flips `phase` to `live` in the same microtask drain, and with in-memory ports B2's handler
runs its append and its phase check inside one macrotask too, so no append can land between the last
`xrange` and the flip without being either in the batch or pushed live.

**Waiting for the ack without a core change.** The core handles one connection's frames strictly in
order (`chain = chain.then(...)` in `server.ts`), and `hello` is handled inside that chain while it
awaits `device_connected`. An `ack` sent during the replay therefore sits behind the `hello` in the
chain and would never reach `ctx.onFrame('ack')` until the replay returned: waiting on the frame
handler deadlocks. The module instead taps `conn.socket.on('message')` for the duration of the replay
(a `ws` socket emits to every listener), decodes the frame, and resolves the waiter on `ack`; it also
taps `close` to abort the wait. Acks consumed by the tap are counted per connection so the regular
`ack` handler, which sees the same frames once the chain drains, does not trace them twice. Live acks
(after replay) go through `ctx.onFrame('ack')` and are traced
`queue  Truc·phone ack sid=… (device-owned cursor; server stores nothing)`. The server stores nothing.

**Sweeper.** `ctx.timers.setInterval(sweep, sweepMs)`; `minId = streamIdOf(idAt(clock.now() − windowMs))`
where `idAt(ms)` is the Snowflake with that timestamp, worker 0, sequence 0 (clamped at the epoch).
For every known device: `dropped = xtrim(device, minId)`; `dropped > 0` → `lastTrimmedId.set(device, minId)`.
One trace row `queue  XTRIM MINID <minId> : N entries across M streams` when N > 0. Cleanup clears the
interval and aborts pending ack waits.

**Harness (additive block near `ack()` in `ScriptedClient`).**
- `seen: Set<MessageId>`, `delivered: Message[]` (unique, arrival order), `duplicatesDropped: number`;
  a `deliver` whose `message_id` is already in `seen` is counted and traced
  `dedup  Truc·phone already has sid S (#id), dropped` (page line 518); `received` still holds every frame.
- `autoAck` option (default on), `ackBatchSize` (default 100), `ackGapMs` (default 20): every
  `deliver` (duplicates included: the server waits for the batch's last id) is pending; at
  `ackBatchSize` pending or after `ackGapMs` on the client's timers with no further frame, the client
  `ack()`s the last `stream_id` seen. Same rule for live frames.
- One line in the `message` handler to route `deliver` into the block; one line in `stop()` to clear the
  gap timer; three option fields; one constructor line. Nothing else reformatted (B6 edits the same file).

## Steps (TDD, each red → green → commit)

1. `options.test.ts`: defaults, partial override, `idAt` round-trips through `timestampOf` and clamps
   below the epoch. Implement `SyncOptions`, `resolveSyncOptions`, `idAt`. Commit.
2. `replay.test.ts` append: a message to c2 lands in every recipient device's stream after the ack
   (`xrange` on the port), with the `XADD` trace row; the sender's device gets no entry.
3. `hello` with `cursor === null` → `hello_ack.slow_path === true`, no deliver, trace row.
4. S2 core: phone primes a cursor (one live deliver, acked), goes offline; Khanh and the bots send N
   messages across c1, c2, c3; phone reconnects → exactly N `deliver`s, in id order, none duplicated,
   `delivered` equals the store rows, `phase === 'live'` after the drain; batches of `batchSize`
   (set small) each waited on an ack; `XRANGE` trace rows.
5. Cursor sent backwards → wire has duplicates (`received`), `delivered` does not, `duplicatesDropped`.
6. Message sent during the replay (while the server waits for a batch ack, sent by hand with
   `autoAck: false`) arrives exactly once, via the replay, not as a push (`message_fanout.pushed` empty).
7. Ack timeout (FakeTime): no ack within `ackTimeoutMs` → `lost` row, connection goes live, the client's
   cursor is unchanged, next hello replays the same batch.
8. Cursor beyond trim (FakeTime with a small `windowMs`/`sweepMs`): messages sent, everyone offline,
   `advance()` past the window → sweeper trims (`XTRIM` row) → hello with the old cursor →
   `slow_path === true`, zero `deliver`s, and `GET /conversations?user_id=truc` answers 200 (B4).
   A cursor equal to or older than `first` with nothing trimmed replays.
9. Server crash mid-replay: ports built once, server 1 replays the first batch, no ack, `close()`,
   server 2 on the same ports, reconnect with the unchanged cursor → replay restarts from the last
   acked batch; after client-side dedup nothing is lost and nothing is duplicated.
10. Live acks are traced; sweeper interval is cleared on close (`FakeTime.pending()` is 0).
11. Harness tests (`harness-replay.test.ts`): dedup bookkeeping, auto-ack at batch size, auto-ack after
    the gap, `autoAck: false` sends nothing. Whole suite + typecheck green three times; hand back.

## Test strategy

`npm test` (vitest, real sockets on port 0, no server mocks) and `npm run typecheck`, whole suite.
Timing-sensitive waits (`ackTimeoutMs`, the sweeper) run on `FakeTime`; the heartbeat options are
scaled up in those tests so `advance()` does not fire thousands of heartbeat ticks. Pure helpers
(`idAt`, options) are unit-tested.

## Risks

- The per-connection frame chain in the core serializes `ack` behind `hello` → socket tap during replay,
  documented above and in the report; a core change (dispatching `device_connected` outside the chain, or
  `ack` out of band) would remove the tap.
- `xadd` evicts silently on `MAXLEN ~` → not detected by the trim rule; reported as a port gap.
- Client batch boundary is a heuristic (count or gap) because only the ack moves the cursor and the
  server does not mark batch ends → the gap timer guarantees progress whatever the sizes; reported for C2.
- B6 edits `ScriptedClient.ts` in parallel → one contiguous block plus single-line hooks.
