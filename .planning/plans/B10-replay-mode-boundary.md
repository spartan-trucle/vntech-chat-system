# B10 · Replay-mode boundary

Implements the two accepted ADRs of 2026-11-02 in the prototype:
`2026-11-02-live-first-replay-xadd-auto-id.md` and `2026-11-02-replay-mode-boundary.md`,
plus item 8 (delivery cursor on the ack). Base: lane branch head `a2ec370`.

## Files

Create: `src/pushBuffer.ts` (moved from `src/messaging/pushBuffer.ts`),
`test/pushBuffer.test.ts` (moved from `test/messaging/`), `test/scenarios/s7-replay-mode-boundary.ts`,
`test/redis/s7.test.ts`, this plan.

Modify: `src/protocol.ts`, `src/server.ts`, `src/ports/SyncQueue.ts`, `src/ports/InMemorySyncQueue.ts`,
`src/ports/index.ts`, `src/redis/RedisSyncQueue.ts`, `src/redis/index.ts`, `src/sync/index.ts`,
`src/messaging/index.ts`, `src/receipts/index.ts`, `test/harness/ScriptedClient.ts`,
`test/protocol.test.ts`, `test/server.test.ts`, `test/ports/contracts/syncQueue.contract.ts`,
`test/ports/InMemory.test.ts`, `test/redis/syncQueue.test.ts`, `test/redis/e2e.test.ts`,
`test/sync/replay.test.ts`, `test/sync/harness-replay.test.ts`, `test/sync/options.test.ts`,
`test/messaging/send.test.ts`, `test/receipts/receipts.test.ts`, `test/history/history.test.ts`,
`test/scenarios/{scenario,helpers,run,scenarios.test,s1,s2,s4}.ts`, `README.md`.

## Design decisions (what the ADRs leave to the implementation)

- **Buffer owner: the core.** `Connection.pushes: PushBuffer` is created at socket open and
  cleared at cleanup; options `createChatServer({ push: { maxPending, pushTimeoutMs } })`.
  Two operations: `pushLive(data, onLost) → 'accepted' | 'full' | 'suspended'` (may drop,
  timeout reported later) and `pushReplay(data) → Promise<boolean>` (waits for room, never
  times out, false only when the buffer was cleared). Plus `suspendLive()/resumeLive()`
  (the "stop queuing live frames" gate) and `drained()`.
- **Event added to `ServerEvents`:** `push_dropped{conn, message, stream_id, reason}`
  (emitted by messaging, the module that attempted the live push).
- **Item 7 of the brief (delivery cursor on the replay ack) was dropped mid-epic by the
  coordinator:** receipts keeps B5's rule (cursor advanced on `message_fanout.pushed`) and
  its tests are unchanged; B11 replaces that rule with a client `delivered` frame.
- **Mode:** `Connection.mode: 'live' | 'replay'`, initialised `'live'` by the core and
  written only by the sync module. `phase` keeps `'handshake' | 'live'` (`live` the moment
  `hello_ack` is sent); the `replay` phase is gone.
- **Stream ids:** store-assigned. `message_acked` carries a `queued: Map<DeviceId, StreamId>`
  the sync module fills, so messaging can put the entry id on the live `deliver`.
- **`replay_done` after every hello**, including the slow path (nothing to replay): the
  client enters replay mode at `hello`, so the server must always end it.
- **Re-replay start:** `XRANGE (prev(dropped_id)`, with `prev` the id just below the
  dropped entry's id; a drop while a loop runs lowers that loop's floor.
- **Ack cadence (client):** every 100 replay frames or 500 ms, plus a flush at `replay_done`;
  outside replay mode the live `stream_id` is applied at once and acked on the same cadence.
- **Appender retry:** the sync module catches the adapter's `XaddTimeout`, reads the tail
  (`xrevrange … COUNT 100`), skips if the `message_id` is there, retries once otherwise.

## Steps (TDD, failing test first for each)

1. Protocol: `deliver.replay`, `replay_done`.
2. Push buffer moved to the core: two operations, suspend gate, `drained`; `Connection.pushes`; `push` option.
3. Core: phase `handshake|live`, `mode`, events `push_dropped`/`acked`, `message_acked.queued`.
4. SyncQueue port + both adapters: `xadd(device, {m, c})`, store ids, `xrevrange`, `xaddTimeoutMs`, in-memory fault hook; contract rewritten; Redis contract without `failing` except `MAXLEN ~`.
5. Sync module: live-first replay loop (no waiter), `replay_done`, backpressure re-replay on `push_dropped`, `acked` event, appender retry, sweeper boundary `${now-window}-0`.
6. Messaging: live push through `pushLive` with the queued stream id, drop reporting, suspension.
7. (dropped, see above) Receipts unchanged.
8. ScriptedClient: store by `message_id`, `rendered()`, replay mode, cadence, `onFrame` hook.
9. Scenarios S1/S2/S4 updated; S7 on fake time and real time; S7 under Redis; e2e race rewritten; README.

## Tests expected to change

protocol.test (deliver shape), server.test (phase, buffer), syncQueue.contract + InMemory.test +
redis/syncQueue.test (ids, retry, failing entries), sync/replay.test (phase, ack waiter,
streamIdOf, trim boundary), sync/harness-replay.test (cadence), sync/options.test (ackTimeoutMs),
messaging/send.test (stream id, replay-phase push, backpressure options), messaging/pushBuffer.test
(moved), receipts/receipts.test (delivery cursor, replay hold), history/history.test (replay hold),
scenarios S1/S2/S4 + scenario.ts (phase → mode), redis/e2e.test (race tests).

## Risks

- The replay loop now runs detached from the `device_connected` listener chain: tests that
  held the chain to "hold the replay" must gate `xrange` instead.
- A tiny `maxPending` makes every tick's fan-out drop; S7 uses a moderate bound and a cork.
- Load-sensitive tests (client "S1 round trip", S5 fake time) must not get slower.
