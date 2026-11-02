# Rubric run — specification §7 against the design

Run on 2026-11-01 (epic A4), updated 2026-11-02 (A3.1 to A3.5) after A3 decisions
1 to 3 closed service discovery, reply quoting and store replica loss (with the N2 half
of item 6), the live-first ADR closed board items 10 and 11 (replay-to-live handoff,
per-stream append order) and the replay-mode ADR closed item 7 (end of replay); no row
was re-scored, only the gaps behind rows 1, 3, 7 and 8 and the delivery lines of row 6
changed. The scores are the author's to re-run.
Run against [`design.md`](design.md),
[`estimation.md`](estimation.md), [`tradeoffs.md`](tradeoffs.md),
[`diagrams/flows.md`](diagrams/flows.md), [`diagrams/high-level.html`](diagrams/high-level.html),
the nine ADRs in `.memory/decisions/` and the discussion page. Each row restates the
spec's pass condition as a checklist, cites where each item is, and scores **pass** or
**fail**. A fail names the concrete gap; the gaps are collected at the end as the input
to epic A3.

| # | Area | Score | Gap behind a fail |
|---|------|-------|-------------------|
| 1 | Requirements | **fail** | N6 (security) is neither addressed nor explicitly deferred; N2 (availability) is addressed since 2026-11-02 (design §2.7) |
| 2 | Estimation | pass | |
| 3 | Architecture | pass | no caveat left: the open notes in flows 2, 5 (service discovery) and 9 (reply quoting) were cleared 2026-11-02 |
| 4 | Storage | pass | |
| 5 | Media | pass | |
| 6 | Delivery | pass | caveat: the fan-out threshold is a product boundary (100 → write, 10 k+ → read), not a computed crossover |
| 7 | Trade-offs | **fail** | one §5 bullet has no decision and so no rejected alternative (five on 2026-11-01; 5.2.2, 5.8.1, 5.3.5 and 5.8.2 closed 2026-11-02) |
| 8 | Failure modes | **fail** | both halves have a recovery story with a stated loss bound since 2026-11-02 (store replica loss in design §2.7); the score waits for the author's re-run, since item 4's buffer-timeout condition still hangs off the single-server half |
| 9 | Clarity | pass | |

Six of nine pass. The three fails are the ones the roadmap predicted, with one change:
Architecture now passes because the sequence diagrams exist, and Requirements fails,
which the roadmap did not predict, on N2 and N6.

---

## 1. Requirements — fail

*Pass if every F\* and N\* in §2 is addressed or explicitly deferred.*

| Req | Addressed where | Status |
|-----|-----------------|--------|
| F1 1:1 chat | design §2.2: a 1:1 chat is a conversation with two members, one table, one path | addressed |
| F2 groups ≤ 100 | design "Group ceiling" paragraph, §4.2 fan-out sized to 100, 10 k+ deferred to spec §8.3 | addressed, larger deferred |
| F3 real-time, low latency | design §1 (WebSocket, direct push), latency-budget paragraph | addressed |
| F4 offline delivery | design §4.2 sync queue, §4.4 reconnect, N7 window | addressed |
| F4a notify and mark unread | design §3.1, §3.5 (unread derived), §3.6 (push hint) | addressed |
| F5 history forever | design §2.1, §2.5 tiering | addressed |
| F6 multi-device | design §3.5 (one read cursor per user), §4.7 (per-device sync cursor), flow 4 | addressed |
| F7 online indicator | design §5, ADR presence, flow 5 | addressed |
| F8 status per member | design §3.2–§3.3, flow 6 | addressed |
| F9 media ≤ 10 MB, no server processing | design §6, ADR media, flow 8 | addressed |
| F10 quoted reply | `reply_to` storage, the `parents` map on the page API, the deleted-parent placeholder as a render rule and jump-to-parent in design §2.2–§2.3 (quoting decided 2026-11-02) | addressed |
| F11 auto-reconnect | design §1.4, flow 2 | addressed |
| N1 latency p50/p99 server to server | latency-budget paragraph; flow 1 marks the measured span | addressed |
| N2 availability 99.99 % send/receive | design §2.7 (decided 2026-11-02): the send/receive path stays available through the loss of up to two replicas of any range, at LOCAL_QUORUM with one retry at ONE; loss of all three, or of the cluster, holds sends in the outbox for the affected conversations; a chat-server loss is a reconnect (§1.4, §1.5) and a Redis loss costs reads, not messages (§4.2); multi-region failover deferred to spec §8.7. ADR `2026-11-02-store-quorum-fallback-one.md` | addressed, multi-region deferred |
| N3 durability of an acked message | design §4.2 write-order invariant; §2.2, §2.7: absolute at QUORUM, which is every message in normal operation, and "once replicated" for a message acked at ONE during a degraded range (decided 2026-11-02; spec N3 carries a footnote, not a rewrite) | addressed, weakened by decision in a degraded range |
| N4 consistent order | design §2.2 Snowflake clustering, `tradeoffs.md` 5.5.4 | addressed |
| N5 horizontal scale | estimation §2 (200 chat servers), §3.1 (store nodes), §3.3 (Redis cluster); design §4.5 | addressed |
| N7 24 h catch-up window | design §4.2, §4.5; ADR sync queue | addressed |
| N6 transport encryption, membership-only reads | **only in part.** Membership is checked at media URL minting (design §6.3). Nothing says the history page API, the summary read or the socket's `msg` frame check conversation membership, and "transport encryption everywhere" appears only as TLS memory per socket in estimation §2. The prototype scope says "no auth", which is fine for the prototype but is not a design statement | **not addressed, not deferred** |

**Gap:** N6 needs either a section or an explicit deferral line in `design.md`: a
membership check at three named hops and one sentence on TLS. It is A3 item 6b below.
N2 closed on 2026-11-02 with the store replica-loss decision (item 3 and item 6a).

## 2. Estimation — pass

*Pass if QPS, storage and connection counts are derived, not asserted, and drive at
least two design choices.*

- Derived: messages/s from DAU × rate × peak ratio (estimation §1); deliveries per
  message from the assumed traffic mix (§1); sockets and servers from concurrent users
  × devices (§2); storage per day, year and five years for text (§3.1), media (§3.2),
  the sync queue (§3.3), cursors (§3.4) and summaries (§3.5). Every assumption not in
  the spec is marked "assumed here" in §0.
- Drives design choices: estimation §4 lists six, each tied to a `design.md` section:
  fan-out sizing (§4.5), the sync-queue backing (ADR), the presence lease (§5.5),
  compression and tiering (§2.5), client compression and the CDN split (§6), summaries
  in Redis for 30-day-active conversations only (§4.3). `tradeoffs.md` names the
  deciding number on 20 of its 30 entries.

## 3. Architecture — pass, with a caveat

*Pass if a newcomer can trace all seven flows in §4.2 through the diagram without
asking a question.* (§4.2 now lists nine flows; all nine are drawn.)

- `diagrams/flows.md`: nine `sequenceDiagram`s with the seven participant kinds of the
  architecture, each with the spec's question under the heading and the answer in the
  diagram's notes. `diagrams/high-level.html` shows the components and highlights the
  send, offline and history/media paths.
- Every arrow traces to a `design.md` section or the board; nothing is drawn that the
  design does not say.
- **No caveat left.** On 2026-11-01 two traces ended at a note marked *open*: which
  registry answers `GET /chat-servers` (flows 2 and 5) and how the quoted excerpt is
  rendered (flow 9). Both closed 2026-11-02: flows 2 and 5 draw the load balancer and
  the lease expiry (no registry); flow 9 draws the page response carrying `parents`,
  the render from the parent and the deleted-parent placeholder as a render rule.
- Also noted: the spec row says "seven flows" while §4.2 has nine. The spec grew
  (media and reply were added) and the rubric row was not updated. Not a design gap;
  flagged to the hub.

## 4. Storage — pass

*Pass if the schema and ID scheme are concrete enough to write the queries for "load
last 50 messages" and "sync since cursor".*

- Schema: `messages` with `PRIMARY KEY ((conversation_id, bucket), message_id)` and
  `CLUSTERING ORDER BY (message_id DESC)`, design §2.2; `read_cursors` and
  `delivery_cursors`, §3.3.
- ID: Snowflake, time-ordered, minted on the chat server; the month bucket is derived
  from its timestamp (§2.2, §2.3; board Component 2 gives the layout).
- "Load last 50": written out in §2.3 with the bucket walk and the `before` cursor;
  flow 7 draws it.
- "Sync since cursor": `XRANGE sq:{device} (cursor + COUNT 100` then a body read by
  `(conversation_id, bucket, message_id)`, §4.2; flow 2 draws it. The slow-path
  equivalent (summary by `since`, then the page query) is in §4.3.
- Dedup lookup by `(sender_id, client_msg_id)` on a 24 h index, §2.2.

## 5. Media — pass

*Pass if upload and download paths bypass the real-time layer and the 10 MB limit and
blob authorization are enforced at a named hop.*

- Bypass: bytes go device ↔ object storage over pre-signed URLs; chat servers and API
  servers see metadata only (design §6.1, §6.2, §6.3; flow 8; ADR media).
- 10 MB limit, named hops: the API server at `POST /media/intent` validates the size
  and mints a URL with a `content-length` condition; the bucket rejects anything
  larger before storing a byte (§6.1, §6.2).
- Authorization, named hop: the API server at `GET /media/{key}/url`, membership of
  the message's conversation, 1 h bearer URL (§6.3). The leaked-URL risk is accepted in
  the ADR.

## 6. Delivery — pass, with a caveat

*Pass if the at-least-once path and client-side dedup are spelled out and group
fan-out has a stated threshold.*

- At-least-once: outbox with `client_msg_id` flushed on reconnect, server dedup for
  24 h (§1.4, §2.2); fan-out retried idempotently on a fixed ID, and the queue append
  by a best-effort tail read on its retry path, `XADD … *` with the message id in the
  entry (§4.2, decided 2026-11-02); replay from the device cursor with the socket
  subscribed to live pushes first, `deliver.replay` telling replay frames from live
  ones, cursor advanced only on `ack{up_to_stream_id}`, which persists the cursor and is
  never a credit, and in replay mode (from `hello` or a dropped push until
  `replay_done`) on replay acks only; a push dropped by the backpressure budget makes
  the server re-replay that connection alone (§4.4, §4.7, §7.8, decided 2026-11-02).
- Client-side dedup: by `message_id` when a replay overlaps live traffic or a store
  page (§4.4), which since 2026-11-02 is the normal case rather than the edge case,
  because live pushes and the replay share the socket and the client sorts its store
  by `message_id`; and since 2026-11-02 by `(sender_id, client_msg_id)` on the `deliver`
  frame, the second layer behind a dedup read that failed open in a degraded range
  (§1.4, §2.7); `tradeoffs.md` 5.5.3 collects the whole path.
- Threshold: fan-out on write up to the 100-member product ceiling; fan-out on read is
  named as the answer for 10 k+ channels in a separate design pass (design "Group
  ceiling" paragraph; board Component 3). **Caveat:** the point where the strategy
  flips is a product boundary, not a computed crossover; nothing is said about a
  group of, say, 2 000, by decision rather than omission.

## 7. Trade-offs — fail

*Pass if every decision in §5 names a rejected alternative.*

- `tradeoffs.md` has one entry per §5 bullet (30) in chosen / rejected / why form,
  and 29 of them name at least one rejected alternative from the design's own tables
  or an ADR.
- **Gap:** the one bullet that is open in `tradeoffs.md` has no decision and
  therefore no rejected alternative:
  - 5.8.4 the five metrics to page on
- Closed 2026-11-02: 5.2.2 client-facing half and 5.8.1 cleanup half (ADR
  `2026-11-02-no-service-registry.md`: a registry, a liveness watcher and a 30 s lease
  TTL rejected), 5.3.5 quoting half (ADR `2026-11-02-reply-quote-by-id.md`: a
  denormalized excerpt and per-quote client fetches rejected), and 5.8.2 (ADR
  `2026-11-02-store-quorum-fallback-one.md`: ONE always, QUORUM without fallback,
  client-only dedup and refusing the send on a dedup timeout rejected). These were the
  other four gaps on 2026-11-01.
- Also thin, though not failing: 5.3.3 (only `created_at` was argued against
  Snowflake; the spec's other candidates were not), 5.4.2 and 5.4.5 (the rejected
  option is the one implied by the chosen sentence, with no table row behind it).

## 8. Failure modes — fail

*Pass if single-server loss and store-primary loss both have a recovery story with
bounded data loss.*

- Single chat-server loss: the recovery story exists for connections (mirror rule,
  jittered backoff, reconnect elsewhere, §1.4), for in-flight messages (outbox and
  dedup, §1.4) and for stored messages (already in the sync streams by the write-order
  invariant, §4.2); bounded loss is zero for acknowledged messages. The routing and
  presence cleanup, which on 2026-11-01 was the gap here (`mark-all-offline` with no
  owner), is closed 2026-11-02: nobody runs it, the client's reconnect overwrites the
  route within the mirror rule and the lease is the only presence cleanup, with the
  5 min window stated in §1.5. Remaining on this half: the ADR's condition that the
  bounded buffer's timeout is shorter than the N1 p99 budget (500 ms) is not met by
  the prototype's 5 s default (§7.8); it belongs to the backpressure write-up (item 4
  below), which is decided on the board but still has no `design.md` section.
- Store loss: the recovery story exists since 2026-11-02 (design §2.7, ADR
  `2026-11-02-store-quorum-fallback-one.md`). The store has no primary; the failure
  designed for is two of a range's three replicas down. What the sender sees: an ack
  after LOCAL_QUORUM, or after one retry at ONE, inside 300 ms + 300 ms (the author's
  numbers to confirm); a write that fails even at ONE is not acked and the outbox
  resends on backoff. Bounded loss: zero in normal operation; in a degraded window,
  the messages acked at ONE on that range, if the last replica also dies before hints
  replay. Recovery: hinted handoff, then repair; operators page on the ONE-ack count.
  Dedup at two layers covers the resend. The N2 gap in row 1 closed with it.

## 9. Clarity — pass

*Pass if the design fits a 45-minute walkthrough and details live in deep-dive
sections, not in the overview.*

- The walkthrough is the discussion page: a components table with one line per
  decision and its status, then one section per component in the order a message
  travels, each with problem / numbers / decision / rejected / how we argued it folded.
- `design.md` opens with four short framing paragraphs (latency budget, group ceiling,
  prototype, the canonical frame) and a link to the architecture diagram, then six
  deep-dive sections; all numbers are in `estimation.md`; all rejected options in
  `tradeoffs.md`; all flows in `diagrams/flows.md`.
- Minor: `design.md` has no overview section of its own beyond those paragraphs; the
  overview lives on the page. A reader who starts from `design.md` alone meets §1
  before seeing the whole. Not a fail; the README points at the page first.

---

## Input to A3 — decisions the author must make

Each item names the spec bullet it closes and the rubric row it moves.

| # | Decision | Closes | Moves |
|---|----------|--------|-------|
| 1 | **Closed 2026-11-02.** Service discovery: no registry; a load balancer with an application-level health check and random assignment chooses the server, "least-loaded" dropped; nobody runs `mark-all-offline`, the client's reconnect heals routing and the 5 min lease is the only presence cleanup. ADR `2026-11-02-no-service-registry.md`; written into design §1.4, §1.5, §5.3, §5.5, tradeoffs 5.2.2, 5.8.1, flows 2 and 5 (A3.1) | §5.2.2, §5.8.1 (cleanup half) | done: rows 7 and 8 lost this gap, the open notes in flows 2 and 5 are gone; both rows still fail on items 3 to 5 |
| 2 | **Closed 2026-11-02.** Reply quoting: resolved by ID on render, no excerpt stored; the page API returns a `parents` map read by key in one batch; a deleted parent renders as F10's placeholder by a render rule; jump-to-parent unchanged. ADR `2026-11-02-reply-quote-by-id.md`; written into design §2.2, §2.3, tradeoffs 5.3.5, flow 9 (A3.2) | §5.3.5, F10, flow 9 | done: row 7 lost this gap, row 3 has no caveat left; row 7 still fails on items 3 and 5 |
| 3 | **Closed 2026-11-02.** Store replica loss: no primary, RF 3; writes and reads at LOCAL_QUORUM with one retry at ONE on timeout (300 ms + 300 ms, the author's numbers to confirm); a write that fails even at ONE is not acked and the outbox resends; dedup at two layers (fail-open index read, `deliver` carries `sender_id` and `client_msg_id`); hinted handoff then repair; loss bound stated. ADR `2026-11-02-store-quorum-fallback-one.md`; written into design §1.4, §2.2, §2.7, tradeoffs 5.8.2, flows 1 and 2, one footnote under spec N3 (A3.3) | §5.8.2, N2 | done: rows 1 and 8 lost this gap, row 7 lost 5.8.2; row 7 still fails on item 5, row 8 waits for the author's re-run |
| 4 | Backpressure: move the board's bounded per-destination buffer and drop-to-stream rule into `design.md` with its budget | §5.8.3 | row 8 (the design text, not a new decision) |
| 5 | Observability: the five metrics to page on | §5.8.4 | row 7 |
| 6a | **Closed 2026-11-02.** N2: the availability statement fell out of item 3 (design §2.7, tradeoffs 5.8.2): available through the loss of up to two replicas of any range; all three, or the cluster, holds sends in the outbox; multi-region deferred to spec §8.7 | N2 | row 1 |
| 6b | N6: a membership check at the history page API, the summary read and the socket's `msg` frame, plus one sentence on TLS, or an explicit deferral of each | N6 | row 1 |

Item 6 is new from this run; the roadmap's A3 text lists items 1 to 5. It was split on
2026-11-02 into 6a (closed with item 3) and 6b (open).

Board items 10 (replay-to-live handoff) and 11 (per-stream append order), the two B9
findings of design §7.9, were never rows of this table; this run carried them only
through row 6's delivery lines and §7.9's open notes. **Closed 2026-11-02** by ADR
`2026-11-02-live-first-replay-xadd-auto-id.md`: live first, then replay, no flip, client
dedups and sorts by `message_id`, cursor on replay acks only until the end-of-replay
marker; `XADD … *` with the message id in the entry and a tail read on the retry path.
Written into design §4.2, §4.4, §7.9, tradeoffs 5.5.2a and 5.5.2b, flow 2 (A3.4).

Board item 7 (end of replay, design §7.3, found in B3), likewise never a row of this
table, **closed 2026-11-02** by ADR `2026-11-02-replay-mode-boundary.md`: no `batch_end`;
`deliver` gains a boolean `replay`, one new frame `replay_done`, `ack{up_to_stream_id}`
persists the cursor on the client's cadence (100 frames or 500 ms, the author's numbers to
confirm) and is never a credit; replay mode runs from `hello` or from a dropped push to
`replay_done`, and a dropped push makes the server re-replay that connection alone.
Written into design §4.4, §4.7, §7.3, §7.8, tradeoffs 5.5.2c and 5.8.3, flows 2 and 3
(A3.5). Item 8 (delivery cursor, B5 finding 10) stays open and is to be decided on this
ack, not on push-to-socket.
