# Progress — single source of truth, kept by the hub session

Roadmap: `.planning/roadmap.md`. Only the hub edits this file; lanes report in the
format of roadmap §6 and the hub copies the block here.

Last updated: 2026-11-02, report round 17 (A3.1 on lane A 16276cc and B9 on lane B a639e71, both handed to C; three new design questions from B9)

## Epics

| Epic | Lane | Wave | Status | Branch | Tests | Last report | Blocker |
|---|---|---|---|---|---|---|---|
| A1 tradeoffs.md | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ 181e74f | n/a | 30 entries, one per spec §5 bullet; open ones listed first | none |
| A2 sequence diagrams | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ e8aa5c9 | n/a | nine Mermaid diagrams, parse-checked; flows 2, 5, 9 end at an open note | none |
| A4 rubric run | A | 1 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ a0b512e | n/a | 6 pass / 3 fail (Requirements, Trade-offs, Failure modes); N2 and N6 fail was not predicted | none |
| A3 open decisions | hub + author | 2 | decision 1 ADR on main (6858647); A3.1 design text done on lane A (16276cc), in review (C); 8 more open | main | n/a | six decisions listed in docs/rubric.md (A branch) and below | author |
| A5 followups.md | A | 5 (optional) | todo | | n/a | | |
| B0 scaffold + protocol | B | 0 | merged (3820d58) | claude/b-prototype-297ab9 @ 59a2541..6ba272b | 77 passed + typecheck | eight ports (roadmap said five), per-module options on the server context | none |
| B1 heartbeat + reconnect | B | 1 | merged (6a81830) | claude/b-prototype-297ab9 @ 8accc6e | 111 passed (lane), 95 alone | a blackholed client never sees the server's terminate: server death ~11 s and the client 15 s mirror rule are independent detections; S1 must assert both | none |
| B2 send path, store, dedup | B | 1 | merged (6a81830) | claude/b-prototype-297ab9 @ 4c293da | 111 passed (lane), 93 alone | push pending has tick granularity, the per-destination bound must leave room for one tick's fan-out; loopback only backs up after ~0.5 MB so the backpressure test corks the socket | none |
| B4 history + summary (slow path) | B | 2 | merged (83c4e88) | claude/b-prototype-297ab9 @ a6373d4 | 192 passed (lane), typecheck clean | core router probe moved and three fixtures updated after merge | none |
| B5 receipts + unread | B | 2 | merged (83c4e88) | claude/b-prototype-297ab9 @ be877df | 166 passed (lane), typecheck clean | B5's status test fixture predated the sha256 column added by the B7 fix; one-line fixture fix after merge | none |
| B6 presence | B | 2 | merged (83c4e88) | claude/b-prototype-297ab9 @ b637832 | 221 passed (lane), 140 alone | five assertions in three B0/B1 tests amended (lease interval exists while online; `watch` now answered); core unhandled-frame path has no probe left | none |
| B7 media stub | B | 2 | merged (83c4e88) | claude/b-prototype-297ab9 @ d7ea3ea | 133 passed (lane) | `MsgFrame` carried `media_key` only; roadmap B0 dropped size, mime, sha256 that design §6.2 sends. Hub asked lane B to add them (roadmap error, not a design question) | none |
| B3 sync queue replay | B | 3 | merged (806a9ec) | claude/b-prototype-297ab9 @ 27365ec | 242 passed (lane, 3 runs), 212 alone | core defect: per-connection frame chain held acks behind hello during replay; fixed in core. Client acks on a heuristic (batch size or 20 ms gap) since nothing on the wire marks batch end | none |
| B8 scenario suite | B | 4 | merged (3505098) | claude/b-prototype-297ab9 @ 252f739 | 258 passed (2 runs); scenarios 6/6 fake time and S1+S5 on real timers | S1: server debounce expiry (t+11+5) coincides with the client's first reconnect (15+1), watcher sees offline then online in the same second; 250 queued messages ≈ 1500 trace rows, near the 2000 cap | none |
| B9 real Redis | B | 5 (optional) | done on lane (a639e71), in review (C) | claude/b-prototype-297ab9 @ a639e71 | 258 passed + 37 skipped without Redis; 34 passed + 3 expected failures on Docker Redis | Redis rejects XADD below the stream's top id; MAXLEN ~ is a floor; replay→live handoff has a real window under I/O (kept as an expected-failure e2e test) | none |
| C1 integrate (per epic) | C | continuous | reviewing A3.1 (lane A 16276cc) and B9 (lane B range 252f739..a639e71) | main @ 1a38936 | | | |
| C2 retrospective | C | 4 | done (82c53d1) | main | n/a | 15 findings in design.md §7, six written back in place, four ADRs amended, board section, README and memory links | three questions for the author, listed below |

## Merged to main

| Epic | Merge commit | Date |
|---|---|---|
| A1, A2, A4 | ec786e5 (closing tasks e4b9a80) | 2026-11-01 |
| B0 | 3820d58 (closing tasks e4b9a80) | 2026-11-01 |
| B1, B2 | 6a81830 (no notebook changes needed) | 2026-11-01 |
| B4, B5, B6, B7 | 83c4e88 (no notebook changes needed) | 2026-11-01 |
| B3 | 806a9ec (no notebook changes needed) | 2026-11-01 |
| B8 | 3505098 (closing tasks 4013a9d) | 2026-11-01 |
| C2 | 82c53d1 | 2026-11-01 |

## Surprises collected for C2

| Epic | Surprise |
|---|---|
| A4 | N2 and N6 were never addressed or deferred; the roadmap predicted only three gaps |
| A4 | spec §7 row 3 says seven flows, §4.2 has nine (spec typo) |
| B0 | eight ports were needed, not the five the roadmap named |
| B1 | server-side death and client-side mirror rule are independent detections; a blackholed client sees neither close nor terminate |
| B2 | the bounded push buffer must allow one tick of fan-out above its nominal bound; loopback backpressure needs ~0.5 MB before the writer blocks |
| B (orchestration) | Agent-tool worktrees are cut from `origin/main`, not the lane branch; every subagent brief must open with a fast-forward onto the lane branch |
| B6 | `last_seen` is the last-pong time, not the debounce-fire time; the lease timer is armed only while someone is online; a `watch` during pending-offline is answered online and still receives the offline event, so 500 ms client batching can shift but never lose a transition |
| B6 | earlier tests pinned the empty presence slot; once every client frame has an owner, the core's unhandled-frame path is unprobed (B8 or C2 should add a probe with an unknown frame type) |
| B3 | the core handled each connection's frames strictly in order and `hello` awaited the replay, so an `ack` sent during replay could never be handled: a deadlock the design's §4.4 sequence does not show. Fixed by emitting `device_connected` beside the chain |
| B3 | ack-only cursor advance (design §4.7) leaves the client acking on a heuristic (batch size or a 20 ms gap) because no frame marks a batch end; the design should name a batch-end marker or an explicit replay_done frame |
| B3 | with real Redis the "empty XRANGE then switch to live" step needs one more XRANGE after the switch to close the race (for B9) |
| B1 | S1 round-trip test is flaky under full-suite load (1 in ~8), mixes fake and real time; left for B8 |
| B9 | Redis refuses an `XADD` whose id is at or below the stream's top entry; idempotent retries of the same id still work, but fan-out must append to each device's stream in message-id order, which today only equal await depth of concurrent handlers guarantees. Design §4.2's "client-chosen ID derived from the Snowflake" needs an ordering rule or a per-stream serialisation |
| B9 | `MAXLEN ~` is a floor with node-level granularity, not the exact cap the in-memory adapter enforced; design §4.5's "caps the pathological case" is approximate |
| B9 | replay-to-live handoff has a real window under I/O: a message appended between the last empty `XRANGE` and the switch to live is neither replayed nor pushed until the next reconnect; the in-memory adapter hid it. Two fix options are in lane B's hand-over note; a design question, not decided |
| B8, B1 | two load-sensitive tests (S1 round trip, S5 fake-time scenario) each failed once under full-suite load and passed on rerun |
| B8 | S1 timing coincidence: server-side pending-offline expires at t+16 s (dead at t+11 s plus 5 s debounce) exactly when the client's first reconnect lands (15 s mirror rule plus 1 s backoff), so a watcher sees offline then online within the same second. Design §5.2's 5 s debounce and §1.4's 15 s mirror rule were sized independently; the retrospective should ask whether the debounce should exceed mirror + first backoff |
| B7 | the roadmap's `msg` frame omitted `media_size`, `media_mime`, `sha256` from design §6.2; the prototype followed the roadmap and left the row's media columns null. Lesson for the retrospective: the roadmap must quote the design's frame, not paraphrase it |

## Decisions for the author (A3 queue)

Source: `docs/rubric.md` on the A branch, "Input to A3". Each closes a spec bullet and
moves a rubric row.

| # | Decision needed | Closes | Status |
|---|---|---|---|
| 1 | Service discovery: what answers `GET /chat-servers` (least-loaded healthy node) and what watches liveness and runs `mark-all-offline(server_id)`; etcd / Consul / orchestrator | §5.2.2, §5.8.1 | **decided 2026-11-02**: no registry; load balancer with app-level health check, random assignment; lease is the only cleanup. ADR `2026-11-02-no-service-registry.md`; design text in A3.1 (lane A) |
| 2 | Reply quoting: excerpt denormalized into the reply row vs resolved by ID on render; what shows when the parent is deleted | §5.3.5, F10 | open |
| 3 | Message-store primary failure: what the sender sees, how long the ack path waits, what the outbox does, bound on loss, recovery steps | §5.8.2, N2 | open |
| 4 | Backpressure: move the board's bounded per-destination buffer + drop-to-stream rule into `design.md` with its budget (text, not a new decision) | §5.8.3 | open |
| 5 | Observability: the five metrics to page on | §5.8.4 | open |
| 6 | N2 availability statement for send/receive, and N6 membership check at the history API, summary read and `msg` frame plus one TLS sentence, or explicit deferral | N2, N6 | open (new from A4) |

Also flagged by A4: spec §7 row 3 says "seven flows" but §4.2 has nine; a spec typo, not a design gap.

### Added by C2 (design.md §7, end of the open list)

| # | Decision needed | Closes | Status |
|---|---|---|---|
| 7 | Replay batch end: a `batch_end` flag on the last deliver of a batch, or a `replay_done` frame, so the client stops acking on a heuristic | design §4.7 | open |
| 8 | Delivery cursor: advance it on the replay ack instead of §3.4's separate delivered receipt | design §3.4, §4.4 | open |
| 9 | Debounce versus reconnect: `dead + debounce` (11 + 5 = 16 s) must exceed `mirror + first backoff` (15 + 1 = 16 s) by a margin; today it fails by ~1.3 s. Pick the relation and the numbers | design §5.2, §1.4 | open |

### Added by B9 (real Redis)

| # | Decision needed | Closes | Status |
|---|---|---|---|
| 10 | Replay-to-live handoff: close the window between the last empty `XRANGE` and the switch to live (one more `XRANGE` after subscribing to live, or buffer live pushes during replay and dedup); pick one and draw it in §4.4 | design §4.4 | open |
| 11 | Per-stream append ordering: Redis Streams reject out-of-order ids, so either serialise appends per device stream, or mint stream ids from Redis (`*`) and keep the message id in the entry only | design §4.2 | open |
