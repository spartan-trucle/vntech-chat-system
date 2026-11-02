# ADR: Replay-to-live handoff and per-stream append order: subscribe live first, `XADD *`, client sorts and dedups by message_id

Date: 2026-11-02
Status: Accepted
Author: Truc Le (debate run by the hub; the author delegated the close-out)

## Context

B9 ran the sync queue on real Redis 7 and found two gaps that the in-memory adapters hid
(design §7.9):

1. **Replay-to-live window.** The core replays a reconnecting device from its cursor
   with `XRANGE` until an empty batch, then flips the connection to live pushes. An
   append that lands between the last empty `XRANGE` and the flip is in the stream but
   is neither replayed nor pushed, so the device misses it until its next reconnect.
2. **Per-stream append order.** Design §4.2 says `XADD` with an id derived from the
   Snowflake makes retries idempotent. Redis refuses an `XADD` whose id is not greater
   than the stream's top entry, so two appends to one device stream that arrive out of
   message-id order (two senders fanning out at once) make the later, lower one fail,
   and that message is then missing from the device's queue. The code block in §4.2
   already shows `XADD … *`; the prose contradicts it.

§7.9 offered two patches for each. The debate challenged the sequencing that both
patches for item 1 assume: replay first, then live. The author's answer settled the
ordering question: message ids are Snowflakes, the client re-sorts by `message_id` in
its local store anyway because send order is not reliable, so monotonic frame order on
the socket during replay is not a requirement. The author also required that a retried
append stay idempotent.

## Decision

**1. Live first, then replay; the client dedups and sorts by `message_id`.**

- On `hello{cursor}` the chat server subscribes the connection to live pushes *before*
  it starts the replay loop. There is no replay phase in the connection state machine
  and no flip. Replay runs `XRANGE (cursor + COUNT 100` until an empty batch while live
  pushes flow on the same socket.
- Any message appended during replay reaches the device twice: once as a live push and
  once when the replay loop reaches its entry. The client's local store keys messages by
  `message_id`, so the second copy is a no-op write. Frames on the socket are not in
  `message_id` order during replay; the client renders from its store sorted by
  `message_id`, never from socket arrival order. This is the same order the message
  store clusters by (§2.2) and the history page returns, so replay, live and paging
  agree.
- **Cursor rule.** The device cursor advances on replay batch acks only, until the
  server marks the end of replay (the end-of-replay marker is item 7 on the board, still
  open; this decision makes it required). A live frame received before that marker is
  stored but its queue entry id is not applied to the cursor, because entries between
  the replay position and that live entry have not been delivered yet. After the
  marker, each live frame carries its queue entry id and the client advances the cursor
  on it as today.
- Snowflake order is as good as the clocks of the id generators. That is already the
  only system-wide order the design commits to; the client has no better one.

**2. `XADD … *`; `message_id` lives in the entry body; no serialisation per stream.**

- Appends use Redis-assigned ids, as the §4.2 code block shows. The prose about
  Snowflake-derived ids is withdrawn. Appends to one device stream need no ordering:
  a late append lands behind the top entry and is replayed after the cursor, instead
  of being refused.
- **Idempotent retry stays, on the retry path only.** When an `XADD` times out, the
  appender first reads the tail of the stream (`XREVRANGE sq:{device} + - COUNT 100`)
  and skips the append if an entry with that `message_id` is present. The normal path
  pays nothing. The check is best effort: the timed-out `XADD` can still land after the
  read, so a duplicate entry remains possible and the client dedup in (1) is the
  guarantee. A duplicate costs one `MAXLEN` slot and one extra body join on replay.
- The two-layer dedup from the store ADR (`2026-11-02-store-quorum-fallback-one.md`)
  is unchanged: `(sender_id, client_msg_id)` catches a resent `msg`; `message_id`
  catches a re-delivered entry.

## Alternatives Considered

- **One more `XRANGE` after the flip, client dedups the overlap:** keeps the window
  structure and the replay phase; adds a read on every reconnect, which is the
  reconnect-storm path (15 M sockets, §1.3); still leaves a smaller window between
  that read and the flip. Rejected.
- **Buffer live pushes server-side during replay, release deduplicated at the flip:**
  per-connection buffer whose size is unbounded under a slow replay, memory on the
  chat server exactly during a reconnect storm, and it keeps the replay phase in which
  B3 found the ack deadlock. Rejected.
- **Explicit Snowflake stream ids with appends serialised per device stream:** a lock
  or single writer per device on the fan-out path (700 k appends/s at peak, estimation
  §3.3), and a late append is still refused rather than queued. Rejected.
- **`SET NX` dedup key per entry before `XADD *`:** exact idempotency, but it doubles
  Redis writes on the normal path (to ~1.4 M/s at peak) and adds a key per entry. The
  retry-path tail read gives the same property where it matters at no normal-path cost.
  Rejected.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| Client applies a live frame's entry id to the cursor before replay ends and skips undelivered entries | Cursor rule above; the end-of-replay marker (item 7) is required, not optional; scenario test in the prototype |
| UI renders socket arrival order during replay and shows messages out of order | Client renders from the store sorted by `message_id`; a condition on the client, not the server |
| Duplicate stream entries after an `XADD` timeout | Tail read on the retry path; client dedup by `message_id`; cost is one `MAXLEN` slot and one body join per duplicate |
| Snowflake clock skew between id generators orders two near-simultaneous messages differently from send order | Inherent to the id scheme already chosen; the store, history page and client agree, so the order is at least consistent everywhere |
| Replay delivers more frames than before because live and replay overlap | Overlap is bounded by replay duration; entries are ~50 B and bodies are joined once per copy |

## Consequences

**Positive:** the window is gone without an extra read or server buffer; the connection
state machine loses the replay phase; appends need no coordination; a late append is
delivered rather than lost; §4.2 stops contradicting itself.

**Negative:** frames on the socket are not in message order during replay, so a client
that renders in arrival order is wrong; the cursor rule adds one client-side condition
tied to the end-of-replay marker; duplicates on the retry path are possible, if rare.

**Neutral:** `message_id` was already the sort key of the local store and the message
store; this decision makes that the contract rather than an implementation detail.

## Conditions

- Design §4.2 code and prose agree on `XADD … *`; the sentence about Snowflake-derived
  ids is replaced by the retry-path tail read.
- Design §4.4 states the live-first sequencing, the client sort rule and the cursor
  rule; flow 2 in `docs/diagrams/flows.md` shows live subscription before replay.
- The `deliver` frame carries the queue entry id (`stream_id`, as flows 1, 3 and 6 and
  the prototype already show; design.md has no frame catalog and its §6.2 is media
  upload) so the cursor can advance on live traffic after replay ends.
- Item 7 (end-of-replay marker) is decided with this cursor rule as its requirement.
- The prototype adds a scenario: a message appended during replay is delivered once to
  the store, and the cursor never passes an undelivered entry.
- The sync-queue ADR (`2026-11-01-sync-queue-redis-streams.md`) gets a third amendment
  pointing here.
