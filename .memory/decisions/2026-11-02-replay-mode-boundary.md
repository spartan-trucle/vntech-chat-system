# ADR: End of replay is a mode boundary: `replay` flag on `deliver`, one `replay_done` frame, re-replay after a dropped push

Date: 2026-11-02
Status: Accepted
Author: Truc Le

## Context

Board item 7 (design §7.3, found in B3): nothing on the wire marks where a replay batch
ends, so the prototype acks after 100 frames or 20 ms of silence, a heuristic. §7.3
offered a `batch_end` flag on the last `deliver` of each batch or a `replay_done` frame
after the last batch. The live-first ADR (`2026-11-02-live-first-replay-xadd-auto-id.md`)
then made an end-of-replay signal required: the client may apply a live frame's
`stream_id` to its cursor only after replay has ended.

The debate moved the problem twice.

1. "Batch" is the server's `XRANGE COUNT 100` read granularity, not a client concern.
   The client needs two things only: to persist its cursor, and to know when replay has
   ended. The ack is cumulative (`ack{up_to_stream_id}`), so the client can ack on its
   own cadence; a late ack only over-replays, which §4.7 allows. `batch_end` is needed
   only if the ack is a flow-control credit the server waits for before the next
   `XRANGE`, which is the structure B3's deadlock lived in. The author ruled: **the ack
   persists the cursor and nothing else**; flow control is the bounded per-destination
   buffer of §5.8.3.
2. A single end marker is not enough, because the live path is not gapless. The
   backpressure rule says a push not taken within budget stays in the device's stream
   and "the device catches up on its own", but the device cannot see a dropped push:
   the next live frame arrives with a higher `stream_id`, the client applies it to the
   cursor, and the dropped entry sits below the cursor for ever. That is under-replay,
   which §4.7 forbids, and it is B5 finding 10 seen from the client side. Only the
   server knows a push was dropped, so the server must act. The author chose re-entering
   replay for that connection over closing the socket.

## Decision

**Frames.** `deliver` gains a boolean field `replay`: `true` for a frame pushed by the
server's `XRANGE` loop, `false` for a live push. One new server frame, `replay_done`,
carries nothing but its type. No `batch_end`, no `replay_start`.

**Server rules.**
- On `hello{cursor}` the server subscribes the connection to live pushes, then runs
  `XRANGE (cursor + COUNT 100` until an empty batch, pushing each entry as
  `deliver{replay: true}`, then sends `replay_done`. It never waits for an ack between
  batches; the bounded per-destination buffer is the only flow control.
- When a live push to this connection is dropped by the backpressure budget, the server
  stops queuing live frames for the connection, lets the buffer drain, runs the same
  `XRANGE` loop from the dropped entry's `stream_id` (exclusive of what was delivered
  before it) until empty, sends `replay_done`, and only then resumes live pushes.
  A further drop during that loop extends it; the loop ends only on an empty read.
  Because the server is the only writer on the socket, no live frame is sent between
  the drop and the first `replay: true` frame; the first such frame is the mode switch,
  which is why no `replay_start` frame is needed (one could not be delivered anyway: the
  buffer was full at the moment of the drop).
- Consequence for the live-first ADR: the initial replay runs alongside live pushes
  (nothing was dropped); a backpressure replay runs alone.

**Client rules.**
- The client acks on its own cadence, `ack{up_to_stream_id}` with the highest
  `stream_id` of the `replay: true` frames it has stored, for example every 100 replay
  frames or 500 ms, whichever first (author's numbers, to confirm). The cursor advances
  only by these acks while in replay mode.
- Replay mode begins at `hello` and at the first `replay: true` frame after a
  `replay_done`; it ends at `replay_done`. Outside replay mode the client applies each
  live frame's `stream_id` to its cursor as today.
- A live frame received in replay mode is stored but its `stream_id` is not applied to
  the cursor; the replay loop will reach that entry and the client dedups by
  `message_id`.
- Socket order is not message order in replay mode; the client renders from its local
  store sorted by `message_id` (live-first ADR).

**Item 8 is tied to this mechanism.** The delivery cursor of §3.4 should advance on the
same ack, not when a push is handed to the socket (B5 finding 10 was the server-side
form of the same bug). Decided separately, but on this mechanism, not another.

## Alternatives Considered

- **`batch_end` flag on the last `deliver` of each batch:** leaks the server's read
  granularity into the protocol, cannot say that a batch is the last one, and is only
  needed if the ack is a credit. Rejected.
- **Ack as a flow-control credit (server waits for the ack before the next `XRANGE`):**
  re-creates the "replay awaits ack" shape that deadlocked in B3 and duplicates the
  bounded buffer. Rejected.
- **A single `replay_done` after the initial replay only:** leaves the dropped-push gap,
  so the cursor can pass an undelivered entry. Rejected.
- **Close the socket on a dropped push, let the reconnect replay from the cursor:**
  no new field, but it turns every slow moment into a reconnect, the storm §1.3 is built
  to avoid, and the client has already applied live `stream_id`s received before the
  drop, so the cursor is above the dropped entry; the reconnect replay would skip it.
  Rejected on both counts.
- **`replay_start` frame at the drop:** cannot be delivered when the buffer is full,
  and the first `replay: true` frame already carries the information. Rejected.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| Replay state is back per connection, where B3 found the ack deadlock | It is a mode flag, not an awaited promise; the server never waits for an ack. Prototype scenario required (see Conditions) |
| A chronically slow device lives in a drop → re-replay loop and repeats `XRANGE` reads | Bounded by that device's own drain rate; each loop ends on an empty read; cost is one device's reads, not the fleet's |
| Client applies a live `stream_id` in replay mode and skips undelivered entries | Client rule above; the scenario asserts the cursor never passes an undelivered entry |
| Server resumes live before `replay_done` is flushed, a live frame overtakes it | Single writer per socket; `replay_done` is enqueued before live is re-enabled |
| Ack cadence too slow → more over-replay on the next reconnect; too fast → ack traffic | Numbers are the author's to confirm; over-replay is harmless by §4.7 |

## Consequences

**Positive:** the ack has one meaning; the client never guesses a batch boundary; a
dropped push is always redelivered without a reconnect; the live-first ADR's cursor
rule becomes precise; B5 finding 10 has a fix path.

**Negative:** one boolean on every `deliver`, one new frame, and per-connection replay
mode on the server; a slow device costs repeated reads.

**Neutral:** "end of replay" is a boundary the connection can cross many times, not an
event that happens once per connection.

## Conditions

- Prototype scenario (lane B): initial replay with live interleaved; a push dropped by
  the backpressure budget; the server re-replays from the dropped entry alone and sends
  `replay_done`; the client's cursor never passes an undelivered entry and every
  message is stored exactly once. The scenario must also cover an ack arriving while a
  re-replay is running.
- Item 8 (delivery cursor) is decided on this ack, not on push-to-socket.
- Item 12 (frame catalog in design.md) lists `deliver.replay`, `replay_done` and
  `ack{up_to_stream_id}` with their meaning.
- Design §4.4 and §4.7 carry the two rule sets; §5.8.3 states what the server does on a
  drop; flow 2 draws a dropped push and the re-replay; §7.3's first bullet is closed.
- The ack cadence numbers are confirmed or changed by the author.
