# ADR: Delivered means the device stored it. The client sends a `delivered` receipt per conversation in both modes. The replay ack stays a sync cursor.

Date: 2026-11-02
Status: Accepted
Author: Truc Le

## Context

Spec F8 defines message status as sent, then delivered, then read, tracked per member.
Design §3.3 derives *delivered* for the sender from the table
`delivery_cursors(conversation_id, device_id, last_delivered_id)`. If every device
cursor is at or above the message id, the message is delivered. Design §3.4 says that
the sync queue hands the client new messages, and the client then sends a delivered
receipt.

The B0 protocol shipped only the read receipt. The prototype therefore advanced the
delivery cursor at the moment the server handed a push to the socket. B5 finding 10
noted the problem.
A push dropped by the backpressure budget counts as delivered. Design §7.3 proposed a
different trigger. Advance the cursor on the replay `ack{up_to_stream_id}` and drop the
separate receipt. That proposal is board item 8.

The item 7 ADR (`2026-11-02-replay-mode-boundary.md`) changed the ground. The ack
exists only in replay mode. It persists the device's sync cursor and nothing else.
Outside replay mode the client applies each live frame's `stream_id` locally and sends
nothing. The debate then asked what *delivered* must mean. The author ruled that
*delivered* means that the device stored the message in its local store. That rule
excludes every server-side definition (handed to the socket, flush confirmed). It makes
a client-sent signal in both modes necessary.

The last question was the shape of that signal. One option extends the ack to both
modes and lets the server map `stream_id` to `(conversation_id, message_id)` per
connection. The other option keeps a receipt keyed the way the table is keyed. The
author chose the receipt.

## Decision

- **Frame.** `delivered{conversation_id, up_to_message_id}`, from client to server.
  The client sends it in replay mode and in live mode alike, after the message is in
  the local store. The client coalesces it to at most one per conversation per 2 s.
  That is the same rule as the read receipt in §3.4, and the 2 s is the design's
  existing number.
- **Server.** The server runs `SET last_delivered_id = max(last_delivered_id,
  up_to_message_id)` on `delivery_cursors` (§3.3). Section 3.3 already states that this
  write is idempotent (safe to repeat) and commutative (order does not matter). The
  server keeps no per-connection state and no mapping from stream ids. The old rule,
  advance the cursor at the push-to-socket moment, is withdrawn.
- **The replay ack is unchanged.** `ack{up_to_stream_id}` persists the sync cursor and
  nothing else (item 7). The two frames carry different keys for different owners. The
  sync cursor is one Redis stream id per device, and the device owns it. The delivery
  cursor is one Snowflake per conversation per device, and the server owns it for F8.
- **Resend after reconnect.** The client keeps two ids per conversation: the highest
  `message_id` it stored, and the highest `message_id` it sent a `delivered` for. After
  `replay_done` on a new connection, the client sends one `delivered` for every
  conversation where the two ids differ. If the previous connection dropped inside the
  coalescing window, this resend covers the receipts lost there.
- **Derived status is unchanged** (§3.3). For the sender, *delivered* means that every
  device of every other member has a cursor at or above the id. An offline device holds
  the status at *sent* until it reconnects and stores the message. That is what F8
  means.

## Alternatives Considered

- **Advance the delivery cursor at the push-to-socket moment (prototype, B5 finding
  10).** This overstates delivery for a dropped push. After item 7 the window lasts
  until the re-replay completes. If the connection dies first, the window lasts until
  the next reconnect. Rejected by the author's definition.
- **Advance it on the replay ack only (the §7.3 proposal).** The ack exists only in
  replay mode. The common case, an online recipient that receives a live push, then
  produces no delivered signal at all. Rejected.
- **Extend the ack to both modes and map `stream_id` to conversations on the server.**
  One frame type, but the server must keep every pushed `stream_id` with its
  `(conversation_id, message_id)` per connection until the ack arrives. If the server
  dies, that state belongs to nobody. The client cannot resend, because it keeps
  nothing per conversation. Rejected.
- **Delivered at the moment the socket flush is confirmed.** TCP accepted is not stored. A
  device that crashes after the read shows delivered for a message it will replay
  later. Rejected by the definition.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A receipt reaches a server that dies before it writes Cassandra. The sender sees *sent* for a message the device holds. | `max` semantics: the next delivered message in that conversation covers it. The resend rule covers the coalescing window. The server-side loss is accepted as rare and self-healing. |
| Receipt traffic | Estimation §3.4 already budgets about 175 k receipt writes per second at peak after coalescing. This receipt was in that number. |
| Client bookkeeping per conversation | Two integers per conversation, in the local store that already sorts by `message_id`. |
| Two frames where one was proposed | They have different keys and owners. One frame moves the key mapping to the server. |

## Consequences

**Positive:** *delivered* means what the sender assumes. The server does not guess. The
server keeps no per-connection state. The §3.4 receipt is confirmed, not replaced. The
ack keeps its single meaning from item 7.

**Negative:** one more client frame type for the item 12 catalog. The client must track
two ids per conversation and resend after reconnect.

**Neutral:** B5 finding 10 is closed by the removal of the push-to-socket advance, not
by a patch to it.

## Conditions

- Prototype (lane B, after B10): add the `delivered` frame to the protocol and the
  client. Remove the push-to-socket cursor advance. Add a test where the backpressure
  budget drops a push. The test asserts that the delivery cursor does not move until
  the re-replay stores the message and the receipt arrives. Add a test for the resend
  after reconnect.
- Design §3.4 restates the receipt with both modes and the resend rule. The §7.3 third
  bullet and §7.1 row 10 are closed. The open list drops item 8.
- Item 12 (frame catalog) lists `delivered{conversation_id, up_to_message_id}` beside
  `ack{up_to_stream_id}`, with a one-line distinction of key and owner.
