# Progress — single source of truth, kept by the hub session

Roadmap: `.planning/roadmap.md`. Only the hub edits this file; lanes report in the
format of roadmap §6 and the hub copies the block here.

Last updated: 2026-11-01, report round 9 (wave 2 complete on lane B, range 8accc6e..b637832 handed to C; B3 in flight; A3 waiting on the author)

## Epics

| Epic | Lane | Wave | Status | Branch | Tests | Last report | Blocker |
|---|---|---|---|---|---|---|---|
| A1 tradeoffs.md | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ 181e74f | n/a | 30 entries, one per spec §5 bullet; open ones listed first | none |
| A2 sequence diagrams | A | 0 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ e8aa5c9 | n/a | nine Mermaid diagrams, parse-checked; flows 2, 5, 9 end at an open note | none |
| A4 rubric run | A | 1 | merged (ec786e5) | claude/a-design-closeout-d1e5bf @ a0b512e | n/a | 6 pass / 3 fail (Requirements, Trade-offs, Failure modes); N2 and N6 fail was not predicted | none |
| A3 open decisions | hub + author | 2 | blocked on author | main | n/a | six decisions listed in docs/rubric.md (A branch) and below | author |
| A5 followups.md | A | 5 (optional) | todo | | n/a | | |
| B0 scaffold + protocol | B | 0 | merged (3820d58) | claude/b-prototype-297ab9 @ 59a2541..6ba272b | 77 passed + typecheck | eight ports (roadmap said five), per-module options on the server context | none |
| B1 heartbeat + reconnect | B | 1 | merged (6a81830) | claude/b-prototype-297ab9 @ 8accc6e | 111 passed (lane), 95 alone | a blackholed client never sees the server's terminate: server death ~11 s and the client 15 s mirror rule are independent detections; S1 must assert both | none |
| B2 send path, store, dedup | B | 1 | merged (6a81830) | claude/b-prototype-297ab9 @ 4c293da | 111 passed (lane), 93 alone | push pending has tick granularity, the per-destination bound must leave room for one tick's fan-out; loopback only backs up after ~0.5 MB so the backpressure test corks the socket | none |
| B4 history + summary (slow path) | B | 2 | done on lane (de120aa + fixtures a6373d4), in review (C) with wave 2 | claude/b-prototype-297ab9 @ a6373d4 | 192 passed (lane), typecheck clean | core router probe moved and three fixtures updated after merge | none |
| B5 receipts + unread | B | 2 | done on lane (53b17e9 + fixture fix be877df), in review (C) with wave 2 | claude/b-prototype-297ab9 @ be877df | 166 passed (lane), typecheck clean | B5's status test fixture predated the sha256 column added by the B7 fix; one-line fixture fix after merge | none |
| B6 presence | B | 2 | done on lane (b637832), in review (C) with wave 2 | claude/b-prototype-297ab9 @ b637832 | 221 passed (lane), 140 alone | five assertions in three B0/B1 tests amended (lease interval exists while online; `watch` now answered); core unhandled-frame path has no probe left | none |
| B7 media stub | B | 2 | done on lane (f650565 + fix d7ea3ea), in review (C) with wave 2 | claude/b-prototype-297ab9 @ d7ea3ea | 133 passed (lane) | `MsgFrame` carried `media_key` only; roadmap B0 dropped size, mime, sha256 that design §6.2 sends. Hub asked lane B to add them (roadmap error, not a design question) | none |
| B3 sync queue replay | B | 3 | in_progress (subagent, own worktree, on top of B4) | claude/b-prototype-297ab9 | | | |
| B8 scenario suite | B | 4 | todo | feature/B-prototype | | | |
| B9 real Redis | B | 5 (optional) | todo | | | | |
| C1 integrate (per epic) | C | continuous | reviewing wave 2 (B4 B5 B6 B7, range 8accc6e..b637832) | main @ 6a81830 | | | |
| C2 retrospective | C | 4 | todo | main | n/a | | |

## Merged to main

| Epic | Merge commit | Date |
|---|---|---|
| A1, A2, A4 | ec786e5 (closing tasks e4b9a80) | 2026-11-01 |
| B0 | 3820d58 (closing tasks e4b9a80) | 2026-11-01 |
| B1, B2 | 6a81830 (no notebook changes needed) | 2026-11-01 |

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
| B7 | the roadmap's `msg` frame omitted `media_size`, `media_mime`, `sha256` from design §6.2; the prototype followed the roadmap and left the row's media columns null. Lesson for the retrospective: the roadmap must quote the design's frame, not paraphrase it |

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
