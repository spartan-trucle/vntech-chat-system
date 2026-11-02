# ADR: Message store replica loss: QUORUM with fallback to ONE, dedup at two layers

Date: 2026-11-02
Status: Accepted
Author: Truc Le

## Context

Spec §5.8.2 asks for the recovery story when "the message store primary" fails, and N2
asks for 99.99 % availability on the send/receive path. The rubric scored both as gaps
(A3 items 3 and 6). The store is Cassandra/ScyllaDB (design §2.2): no primary, RF 3,
every partition on three replicas. The failure that threatens availability is therefore
not "primary loss" but **two of a token range's three replicas down at once**, which
leaves the conversations hashed into that range without a write quorum while the rest
of the cluster is unaffected. Whole-cluster or whole-region loss is a different event
and is deferred (spec §8.7).

The author's priority: the system is write-heavy and availability comes first. The
debate established that with RF 3 and two replicas down there is no third option:
either the sender waits (QUORUM) or the ack rests on one replica (ONE), and ONE weakens
N3 ("an acknowledged message is never lost") to "never lost once replicated".

## Decision

- **Writes go at LOCAL_QUORUM; on a QUORUM timeout the chat server retries once at
  ONE and acks.** Normal operation keeps N3 absolute (two replicas before the ack).
  Only a range that has lost two replicas falls to ONE, only for the conversations in
  that range, only while it is degraded. A write that fails even at ONE (no live
  replica, or the cluster down) is not acked; the client's outbox keeps the message,
  shows "sending…", and resends on its backoff; server dedup makes the resend safe.
- **Budget on the send path** (author's numbers to confirm, proposed by the hub):
  QUORUM attempt 300 ms, ONE retry 300 ms, so the degraded ack lands inside the N1
  p99 of 500 ms plus one retry; beyond that the sender sees "sending…", never an error.
- **Dedup at two layers**, because a ONE write can be invisible to the next read:
  1. The dedup index read `(sender_id, client_msg_id)` goes at LOCAL_QUORUM; if that
     read times out (degraded range) the server **fails open and stores**, because by
     this decision a duplicate is less harmful than a refused send.
  2. The `deliver` frame carries `sender_id` and `client_msg_id`; the client drops a
     second message with the same pair. The user never sees a double; the store may
     hold two rows for a message acked during a degraded window, and the unread count
     may be off by one until the next open.
- **Reads** (history page, summary rows, read cursors) follow the same rule:
  LOCAL_QUORUM, falling back to ONE on timeout. Normal mode is therefore R + W = 4 >
  RF, read-your-writes across devices; degraded mode may serve a page missing a
  message that replay later delivers, and client dedup by `message_id` reconciles.
- **Recovery:** when the lost replicas return, hinted handoff replays the writes they
  missed (default hint window 3 h); past that window a repair of the range restores
  RF 3. No application step is needed. Operators are paged on the count of writes
  acked at ONE per minute, which is zero in normal operation.
- **Loss bound:** zero in normal operation. During a degraded window on one range: the
  messages acked at ONE on that range, lost only if the single surviving replica also
  dies before hints replay. The window is bounded by replica recovery time and the
  number of conversations in one range (one of ~550 nodes' worth).
- **N2 statement:** the send/receive path stays available through the loss of up to
  two replicas of any range, at the cost of N3 for the messages acked at ONE. Loss of
  all three replicas of a range, or of the cluster, is unavailability for the affected
  conversations: sends are held in the outbox and delivered when the store returns;
  nothing is lost on the client side. Multi-region failover is deferred to spec §8.7.

## Alternatives Considered

- **ONE for every write, always** (the author's first choice, revised in the debate):
  removes the fallback logic, but opens the loss window on every message at every
  moment, including routine rolling restarts, and breaks read-your-writes for dedup,
  unread and the second device in normal operation. The 115 k writes/s peak is trivial
  for the store at QUORUM and the latency difference is about one internal round trip.
  Rejected.
- **QUORUM with no fallback:** keeps N3 absolute but turns a two-replica loss into
  "cannot send" for the affected conversations, against the author's availability
  priority. Rejected.
- **Client dedup by `client_msg_id` only, no QUORUM index read:** cheaper, but every
  retry after a lost ack would store a second row in normal operation, not just in
  degraded mode; history and unread would carry the duplicates. Rejected as the sole
  mechanism; kept as the second layer.
- **Refuse the send when the dedup read times out:** consistent with N3, inconsistent
  with the priority this decision sets. Rejected.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A message acked at ONE is lost if the last replica dies before hints replay | accepted; bounded to one range during its degraded window; paged on the ONE-ack counter |
| Two rows for one message after a fail-open dedup read | client drops the second by `(sender_id, client_msg_id)`; unread off by one until the next open; a repair job may collapse duplicates later (out of scope) |
| A history page served at ONE misses a message | replay delivers it; client dedups by `message_id` |
| Fallback logic adds a branch on the hottest path | one retry, one counter, one test (prototype B2 extends its write-order test with a timing-out store) |

## Consequences

**Positive:** rubric rows 1 (N2) and 8 (store failure) gain their story; the write-order
invariant of §4.2 survives unchanged (store, at whatever level, still precedes the
ack); availability under replica loss is a property of the design, not of luck.
**Negative:** N3 is no longer absolute and the spec's wording must say so; the
`deliver` frame grows by two fields; the dedup index read costs a QUORUM round trip on
every send.
**Neutral:** the sync queue, cursors and presence are untouched; they never depended
on store consistency.

## Conditions

- Spec N3 is annotated (not rewritten; the spec is frozen by §6) with a note pointing
  at this ADR: "absolute at QUORUM; during a degraded range, once replicated".
- Design §2.2 states the consistency levels and the fallback; §1.4 and §2.2 state the
  two-layer dedup and the new `deliver` fields; a new §2.7 or a §5.8-style subsection
  holds the failure story and the N2 statement; tradeoffs.md 5.8.2 and N2 close.
- The 300 ms budgets are confirmed or changed by the author in the design text.
- N6 (membership checks at the history API, summary read and `msg` frame; TLS
  sentence) is not covered here and stays open as A3 item 6b.
