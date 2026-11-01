# Plan B2 · Send path: store, IDs, dedup, write order

Epic text: `.planning/roadmap.md` §3 B2 (approved plan). Design §2.2, §1.4, §4.2 (write-order
invariant); board rule "bounded per-destination buffer, drop to stream on budget".

## Files

- `prototype/src/messaging/index.ts` — `registerMessaging(ctx)`: the `msg` handler, `MessagingOptions`
  (`maxPending` 1000, `pushTimeoutMs` 5000) read from `ctx.moduleOptions['messaging']`
- `prototype/src/messaging/pushBuffer.ts` — `PushBuffer`: bounded per-destination pending counter with
  a timeout per push; a push is *pending* from `socket.send` until ws reports it flushed (send callback);
  full → drop now; not flushed within the timeout → counted lost, slot freed
- `prototype/test/messaging/pushBuffer.test.ts` — unit tests on a fake socket (deterministic)
- `prototype/test/messaging/send.test.ts` — real server on port 0 + `ScriptedClient`, seeded fixtures
- `.planning/plans/B2-send-path.md` — this file

Not touched: `src/server.ts`, `src/protocol.ts`, `src/ports/**`, `test/harness/**`, docs, README, memory,
progress.

## Behaviour (what the handler does, in order; each step awaited)

0. `isMember(conversation_id, user_id)` false → `error{code:'not_member'}`, nothing stored.
1. `findByClientMsgId(sender, client_msg_id)` hit → trace `dedup`, `msg_ack` with the original id, return.
2. Build the row: `message_id = ids.next()`, `bucket = bucketOf(id)`, `created_at = clock.now()`,
   `reply_to` id-or-null (comment: quoting undecided, roadmap A3), `media_key` or null, `media_size`/`media_mime`
   null (B7). `insert` → trace `store` → emit `message_stored{message, sender}`.
3. Recipient devices = every registered device of every member (`devices.devicesOf`), minus the sending
   device; member order then registration order. `send(sender, msg_ack)` → trace `ack` →
   emit `message_acked{message, sender, recipient_devices}` (B3 appends to the queue here).
4. For each recipient device: `connections.byDevice`; push only if `phase === 'live'`, through the
   `PushBuffer` of that connection; `deliver{message, stream_id: streamIdOf(id)}`. Accepted pushes →
   `pushed`; trace one `push` row listing the names; a drop → trace `lost`. Then emit
   `message_fanout{message, recipient_devices, pushed}`. The handler never awaits socket drain: a slow
   recipient is that recipient's delay, not the sender's stall.

## Steps (TDD, each red → green → commit)

1. `pushBuffer.test.ts`: accept while below `maxPending`; full → `dropped: 'full'`; flushed callback frees a
   slot; not flushed within timeout → `onLost('timeout')`, slot freed, late callback ignored; `clear()` cancels
   timers. Implement `PushBuffer`. Commit `test(proto): …` then `feat(proto): …`.
2. `send.test.ts` happy path: row stored with the right fields, `msg_ack` to the sender, `deliver` to the
   other member with `stream_id`, non-member rejected. Implement the handler.
3. Dedup: same `client_msg_id` twice → one row, same id in both acks, no second `deliver`, `dedup` trace row.
4. Order: wrap `ports.messages.insert` and the server-side `socket.send` of sender and recipient, record
   events; assert `store, message_stored, ack, message_acked, push, message_fanout`.
5. Fan-out: 3 users × 2 devices, all live → 5 `deliver` frames incl. the sender's other device; seeded c2 with
   bots offline → `recipient_devices` 5, `pushed` only the live ones; a connection held in `replay` gets no
   push.
6. Backpressure: `maxPending: 1`, `pushTimeoutMs` small; laptop `blackhole()` + its server-side TCP socket
   corked (loopback kernel buffers absorb 0.5–10 MB before a blackholed peer backs the writer up, so the
   cork makes "never drains" deterministic); two sends → second dropped as full, first lost on timeout,
   both as `lost` trace rows; `pushed` excludes the laptop; the phone still gets both.
7. Trace rows read like the page (`INSERT messages(c1, dm) #id from truc`, `→ Truc·phone {cid:…, id:#…}`,
   `#id → Khanh·phone, Truc·laptop over the socket`). Whole suite + typecheck green; hand back.

## Test strategy

`npm test` (vitest, real sockets on port 0, no mocks of the server) and `npm run typecheck`, whole suite.
Timing assertions use a 20 ms timeout and 100 ms waits. The buffer logic is unit-tested with a fake socket so
the integration test only has to prove the wiring.

## Risks

- Kernel buffers hide backpressure on loopback → cork in the test, documented above; the unit test carries
  the semantics.
- Awaiting drain in the handler would let one slow recipient block the sender's frame chain → pushes are
  fire-and-forget behind the counter; `pushed` means "handed to the socket", a later timeout is a `lost`
  trace row only.
- B1 changes `test/harness/**` in parallel → the tests use only `connect`, `hello`, `send`, `expect`,
  `received`, `blackhole`, `trace`.
- `reply_to` must not become a guess → stored as an id only with the A3 comment; no lookup, no quoting.
