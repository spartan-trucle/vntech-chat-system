# Rubric run — specification §7 against the design

Run on 2026-11-01 (epic A4), updated 2026-11-02 (A3.1) after A3 decision 1 closed
service discovery; no row was re-scored, only the gaps behind rows 3, 7 and 8 changed.
Run against [`design.md`](design.md),
[`estimation.md`](estimation.md), [`tradeoffs.md`](tradeoffs.md),
[`diagrams/flows.md`](diagrams/flows.md), [`diagrams/high-level.html`](diagrams/high-level.html),
the four ADRs in `.memory/decisions/` and the discussion page. Each row restates the
spec's pass condition as a checklist, cites where each item is, and scores **pass** or
**fail**. A fail names the concrete gap; the gaps are collected at the end as the input
to epic A3.

| # | Area | Score | Gap behind a fail |
|---|------|-------|-------------------|
| 1 | Requirements | **fail** | N2 (availability) and N6 (security) are neither addressed nor explicitly deferred |
| 2 | Estimation | pass | |
| 3 | Architecture | pass | caveat: one flow ends at a note marked open (reply quoting); the service-discovery note in flows 2 and 5 was cleared 2026-11-02 |
| 4 | Storage | pass | |
| 5 | Media | pass | |
| 6 | Delivery | pass | caveat: the fan-out threshold is a product boundary (100 → write, 10 k+ → read), not a computed crossover |
| 7 | Trade-offs | **fail** | three §5 bullets, or halves of bullets, have no decision and so no rejected alternative (five on 2026-11-01; 5.2.2 and 5.8.1 closed 2026-11-02) |
| 8 | Failure modes | **fail** | store-primary loss has no recovery story; single-server loss has a complete one since 2026-11-02 |
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
| F10 quoted reply | `reply_to` storage and jump-to-parent in design §2.2–§2.3; the quoting policy is listed open in `tradeoffs.md` 5.3.5 and routed to A3 | addressed in part, remainder explicitly deferred |
| F11 auto-reconnect | design §1.4, flow 2 | addressed |
| N1 latency p50/p99 server to server | latency-budget paragraph; flow 1 marks the measured span | addressed |
| N2 availability 99.99 % send/receive | **nowhere.** No section states how the send/receive path reaches four nines: replica placement, what a Redis or chat-server loss does to availability as opposed to latency, degraded modes. The board's CAP note ("a partition degrades to delayed, never cannot send") is the only sentence near it | **not addressed, not deferred** |
| N3 durability of an acked message | design §4.2 write-order invariant, RF 3 quorum (board Component 2) | addressed |
| N4 consistent order | design §2.2 Snowflake clustering, `tradeoffs.md` 5.5.4 | addressed |
| N5 horizontal scale | estimation §2 (200 chat servers), §3.1 (store nodes), §3.3 (Redis cluster); design §4.5 | addressed |
| N7 24 h catch-up window | design §4.2, §4.5; ADR sync queue | addressed |
| N6 transport encryption, membership-only reads | **only in part.** Membership is checked at media URL minting (design §6.3). Nothing says the history page API, the summary read or the socket's `msg` frame check conversation membership, and "transport encryption everywhere" appears only as TLS memory per socket in estimation §2. The prototype scope says "no auth", which is fine for the prototype but is not a design statement | **not addressed, not deferred** |

**Gap:** N2 and N6 need either a section each or an explicit deferral line in
`design.md`. N2 overlaps the A3 item on store-primary failure (row 8); N6 is small
(a membership check at three named hops and one sentence on TLS) and is not on the A3
list yet.

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
- **Caveat, not a fail:** one trace ends at a note marked *open*: how the quoted
  excerpt is rendered (flow 9). The newcomer learns that the design has not decided,
  which is an answer; the decision itself is scored in row 7. Under a stricter reading
  this row fails until A3 closes it. On 2026-11-01 flows 2 and 5 carried a second open
  note, which registry answers `GET /chat-servers`; closed 2026-11-02 (no registry, a
  load balancer with an app-level health check; the lease is the only cleanup), and
  the two flows now draw the balancer and the lease expiry.
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
  24 h (§1.4, §2.2); fan-out and queue append retried idempotently on a fixed ID
  (§4.2); replay from the device cursor, cursor advanced only on ack (§4.4, §4.7).
- Client-side dedup: by `message_id` when a replay overlaps live traffic or a store
  page (§4.4); `tradeoffs.md` 5.5.3 collects the whole path.
- Threshold: fan-out on write up to the 100-member product ceiling; fan-out on read is
  named as the answer for 10 k+ channels in a separate design pass (design "Group
  ceiling" paragraph; board Component 3). **Caveat:** the point where the strategy
  flips is a product boundary, not a computed crossover; nothing is said about a
  group of, say, 2 000, by decision rather than omission.

## 7. Trade-offs — fail

*Pass if every decision in §5 names a rejected alternative.*

- `tradeoffs.md` has one entry per §5 bullet (30) in chosen / rejected / why form,
  and 27 of them name at least one rejected alternative from the design's own tables
  or an ADR.
- **Gap:** the three bullets, or halves of bullets, that are open in `tradeoffs.md`
  have no decision and therefore no rejected alternative:
  - 5.3.5 reply quoting (denormalized excerpt vs resolved by ID on render)
  - 5.8.2 message-store primary failure
  - 5.8.4 the five metrics to page on
- Closed 2026-11-02 (ADR `2026-11-02-no-service-registry.md`): 5.2.2 client-facing
  half and 5.8.1 cleanup half, which were the other two gaps on 2026-11-01. Both
  entries now name their rejected alternatives (a registry, a liveness watcher, a
  30 s lease TTL).
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
- Store-primary loss: **no recovery story.** The board's CAP answer (RF 3, quorum
  writes, a partition degrades to delayed) and the write-order invariant (no ack
  before the store write, so a degraded store delays "sent" rather than lying) are the
  raw material, but nothing says what the sender sees during a replica-set outage,
  how long the ack path waits, what the client does with an unacked outbox, or what
  the bound on loss is. This gap is also most of the N2 gap in row 1.

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
| 1 | **Closed 2026-11-02.** Service discovery: no registry; a load balancer with an application-level health check and random assignment chooses the server, "least-loaded" dropped; nobody runs `mark-all-offline`, the client's reconnect heals routing and the 5 min lease is the only presence cleanup. ADR `2026-11-02-no-service-registry.md`; written into design §1.4, §1.5, §5.3, §5.5, tradeoffs 5.2.2, 5.8.1, flows 2 and 5 (A3.1) | §5.2.2, §5.8.1 (cleanup half) | done: rows 7 and 8 lost this gap, the open notes in flows 2 and 5 are gone; both rows still fail on items 2 to 5 |
| 2 | Reply quoting: quoted excerpt denormalized into the reply row, or resolved by ID on render; what the reply shows when the parent is deleted | §5.3.5, F10, flow 9 | row 7; clears the open note in flow 9 |
| 3 | Message-store primary (replica-set) failure: what the sender sees, how long the ack path waits, what the outbox does, the bound on loss, and the recovery steps | §5.8.2, N2 | rows 1, 8 |
| 4 | Backpressure: move the board's bounded per-destination buffer and drop-to-stream rule into `design.md` with its budget | §5.8.3 | row 8 (the design text, not a new decision) |
| 5 | Observability: the five metrics to page on | §5.8.4 | row 7 |
| 6 | N2 and N6: an availability statement for the send/receive path (may fall out of item 3) and a membership check at the history page API, the summary read and the socket's `msg` frame, plus one sentence on TLS, or an explicit deferral of each | N2, N6 | row 1 |

Item 6 is new from this run; the roadmap's A3 text lists items 1 to 5.
