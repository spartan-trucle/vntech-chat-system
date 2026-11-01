# Progress — single source of truth, kept by the hub session

Roadmap: `.planning/roadmap.md`. Only the hub edits this file; lanes report in the
format of roadmap §6 and the hub copies the block here.

Last updated: 2026-11-01, report round 2 (A1 A2 A4 and B0 merged to main; wave 1 running; A3 waiting on the author)

## Epics

| Epic | Lane | Wave | Status | Branch | Tests | Last report | Blocker |
|---|---|---|---|---|---|---|---|
| A1 tradeoffs.md | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ 181e74f | n/a | 30 entries, one per spec §5 bullet; open ones listed first | none |
| A2 sequence diagrams | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ e8aa5c9 | n/a | nine Mermaid diagrams, parse-checked; flows 2, 5, 9 end at an open note | none |
| A4 rubric run | A | 1 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ a0b512e | n/a | 6 pass / 3 fail (Requirements, Trade-offs, Failure modes); N2 and N6 fail was not predicted | none |
| A3 open decisions | hub + author | 2 | blocked on author | main | n/a | six decisions listed in docs/rubric.md (A branch) and below | author |
| A5 followups.md | A | 5 (optional) | todo | | n/a | | |
| B0 scaffold + protocol | B | 0 | merged (3820d58) | claude/b-prototype-297ab9 @ 59a2541..6ba272b | 77 passed + typecheck | eight ports (roadmap said five), per-module options on the server context | none |
| B1 heartbeat + reconnect | B | 1 | in_progress (subagent, own worktree) | claude/b-prototype-297ab9 | | | |
| B2 send path, store, dedup | B | 1 | in_progress (subagent, own worktree) | claude/b-prototype-297ab9 | | | |
| B4 history + summary (slow path) | B | 2 | todo | feature/B-prototype | | | |
| B5 receipts + unread | B | 2 | todo | feature/B-prototype | | | |
| B6 presence | B | 2 | todo | feature/B-prototype | | | |
| B7 media stub | B | 2 | todo | feature/B-prototype | | | |
| B3 sync queue replay | B | 3 | todo | feature/B-prototype | | | |
| B8 scenario suite | B | 4 | todo | feature/B-prototype | | | |
| B9 real Redis | B | 5 (optional) | todo | | | | |
| C1 integrate (per epic) | C | continuous | waiting (4 epics merged) | main @ e4b9a80 | 77 passed on merged tree | none | none |
| C2 retrospective | C | 4 | todo | main | n/a | | |

## Merged to main

| Epic | Merge commit | Date |
|---|---|---|
| A1, A2, A4 | ec786e5 (closing tasks e4b9a80) | 2026-11-01 |
| B0 | 3820d58 (closing tasks e4b9a80) | 2026-11-01 |

## Surprises collected for C2

| Epic | Surprise |
|---|---|
| A4 | N2 and N6 were never addressed or deferred; the roadmap predicted only three gaps |
| A4 | spec §7 row 3 says seven flows, §4.2 has nine (spec typo) |
| B0 | eight ports were needed, not the five the roadmap named |

## Decisions for the author (A3 queue)

Source: `docs/rubric.md` on the A branch, "Input to A3". Each closes a spec bullet and
moves a rubric row.

| # | Decision needed | Closes | Status |
|---|---|---|---|
| 1 | Service discovery: what answers `GET /chat-servers` (least-loaded healthy node) and what watches liveness and runs `mark-all-offline(server_id)`; etcd / Consul / orchestrator | §5.2.2, §5.8.1 | open |
| 2 | Reply quoting: excerpt denormalized into the reply row vs resolved by ID on render; what shows when the parent is deleted | §5.3.5, F10 | open |
| 3 | Message-store primary failure: what the sender sees, how long the ack path waits, what the outbox does, bound on loss, recovery steps | §5.8.2, N2 | open |
| 4 | Backpressure: move the board's bounded per-destination buffer + drop-to-stream rule into `design.md` with its budget (text, not a new decision) | §5.8.3 | open |
| 5 | Observability: the five metrics to page on | §5.8.4 | open |
| 6 | N2 availability statement for send/receive, and N6 membership check at the history API, summary read and `msg` frame plus one TLS sentence, or explicit deferral | N2, N6 | open (new from A4) |

Also flagged by A4: spec §7 row 3 says "seven flows" but §4.2 has nine; a spec typo, not a design gap.
