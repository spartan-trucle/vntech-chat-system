# B11 · The delivered receipt

Implements `.memory/decisions/2026-11-02-delivered-receipt-device-stored.md` in the
prototype: *delivered* means the device stored the message; the client says so with a
`delivered{conversation_id, up_to_message_id}` frame in both modes; the server's
push-to-socket advance (B5 finding 10) is removed. Base: lane branch head `85037ff`.

## Files

Create: `test/receipts/delivered.test.ts` (server handler, client bookkeeping, resend after
reconnect), this plan.

Modify: `src/protocol.ts` (the one frame), `src/receipts/index.ts` (the handler; the fan-out
hook loses the `pushed` loop), `test/harness/ScriptedClient.ts` (additive: the two maps, the
coalescer, the resend at the first `replay_done` after a `hello`, `deliveredWindowMs` and
`autoDelivered` options, `describeFrame` case), `test/protocol.test.ts`,
`test/receipts/receipts.test.ts`, `test/receipts/status.test.ts`,
`test/scenarios/s7-replay-mode-boundary.ts`, `test/scenarios/scenario.ts` (the window in
`ScenarioNumbers`, 2000 ms design / 20 ms scaled), `README.md`.

Not touched: `src/server.ts`, `src/sync/**`, `src/messaging/**`, `src/ports/**`, `docs/**`,
`.memory/**`, `.planning/progress.md`.

## Design decisions (what the ADR leaves to the implementation)

- **Server handler.** `ctx.onFrame('delivered')` in the receipts module: membership check as
  for the read receipt (`error{not_member}`, nothing written); one `deliveryCursors`
  partition read for the previous value, then `advanceDelivery` (max). Cursor unchanged →
  one trace row saying no-op, nothing else (late or duplicate, §3.3). No existence check on
  the id: the page does none and `max` makes a wrong id harmless for the status of any
  message below it.
- **Trace rows** in the page's style (docs/prototype/index.html line 389):
  `receipt  delivered c1 ≤ #<id> by Khanh·phone`; the no-op row adds
  `: no-op, cursor at #<prev> (late or duplicate)`.
- **The fan-out hook keeps the sender's own cursors.** The sender's read cursor and the
  sending device's delivery cursor still advance on store (the page does the same in
  `store`). That is not the push-to-socket rule the ADR withdraws: the sending device holds
  the message it composed, and it never receives a `deliver` for its own message, so no
  `delivered` frame could ever come from it. Only the `for (device of pushed)` loop goes.
  Push hints still use `pushed` to skip devices that got a live push (unchanged, §3.6).
- **Client bookkeeping** (`ScriptedClient`): `storedUpTo: Map<conversation, message_id>` and
  `deliveredUpTo: Map<conversation, message_id>`. After a `deliver` is stored (not a
  duplicate) in either mode, `storedUpTo` moves and the id is offered to a
  `ReceiptCoalescer` on the client's timers (`deliveredWindowMs`, default 2000). The
  coalescer's send callback goes through `sendDelivered`, which records `deliveredUpTo` only
  when the frame actually left (socket open, radio on) and skips an id not above
  `deliveredUpTo`. The coalescer lives for the client's life; `giveUp()` (the app going
  away) disposes its windows, so `stop()` leaves no timer.
- **Resend.** `hello()` arms `resyncDeliveredAtReplayDone`; the first `replay_done` after
  it sends one `delivered` per conversation where the two maps differ, bypassing the
  coalescer, and traces a `note`. A later `replay_done` on the same connection (a
  re-replay after a dropped push) resends nothing: the ADR ties the resend to a new
  connection.
- **`autoDelivered: false`** turns the automatic frame off so a test can drive the cursor by
  hand and observe the "before" state.
- **Scenario numbers:** `deliveredWindowMs` joins `ScenarioNumbers` (2000 design, 20
  scaled) and the runner passes it to every client, like `watchBatchMs`.

## Steps (TDD, failing test first for each)

1. Protocol: `delivered` round-trips as a client frame, both fields required, refused as a
   server frame.
2. Server handler: non-member refused; cursor advanced; late/duplicate no-op with the trace
   row; a fresh connection with nothing replayed can still say `delivered` (no
   per-connection state).
3. Remove the push-to-socket advance: the B5 test that asserted it now asserts the cursor
   stays put after the push and moves on the client's frame; the trace test loses the
   "(over the socket)" names.
4. Client bookkeeping: one frame per conversation per window with the highest id; replay
   and live frames both trigger; a duplicate does not; the two maps; the window option.
5. Resend after reconnect (test b): a gap inside the window, `destroyWithoutClose()`,
   reconnect, `replay_done` → one `delivered`, the server cursor reaches the stored id;
   the positive case sends nothing.
6. S7 (test a): the delivery-cursor oracle after every frame (the server's cursor never
   above `deliveredUpTo`; below the dropped id until the re-replay stored it and the frame
   left); the window closes, the cursor passes the dropped id. Fake time, real time, and
   the Redis form through `test/redis/s7.test.ts` unchanged.
7. Status tests (test c): the `sent → delivered → read` test drives *delivered* by the
   client's frame, with an explicit `sent` reading after the push and before the frame.
8. README: scenario table row S7, receipts line, a "Delivered receipt (B11)" paragraph.

## Tests expected to change

`test/receipts/receipts.test.ts` (the live-socket advance test; the trace test),
`test/receipts/status.test.ts` (the sent → delivered → read test: explicit trigger),
`test/protocol.test.ts` (one more client frame), S7 (extended), `test/scenarios/scenario.ts`
(numbers). `send.test.ts` asserts the `message_fanout.pushed` payload and the `push` rows,
neither of which changes.

## Risks

- A real-timer coalescer window left armed after a test: `giveUp()` disposes it.
- S7 on fake time: the window never closes on its own; the scenario advances the clock by
  the window once, which is also where the trace shows the cursor move.
- Trace ordering between two devices' `delivered` frames is not deterministic over two
  sockets: the trace test sends them by hand in order.
- The load-sensitive tests (client "S1 round trip", S5 fake time) do not touch receipts.
