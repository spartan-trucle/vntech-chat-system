# Progress — single source of truth, kept by the hub session

Roadmap: `.planning/roadmap.md`. Only the hub edits this file; lanes report in the
format of roadmap §6 and the hub copies the block here.

Last updated: 2026-11-01 (wave 0 started)

## Epics

| Epic | Lane | Wave | Status | Branch | Tests | Last report | Blocker |
|---|---|---|---|---|---|---|---|
| A1 tradeoffs.md | A | 0 | todo | feature/A-design-closeout | n/a | | |
| A2 sequence diagrams | A | 0 | todo | feature/A-design-closeout | n/a | | |
| A4 rubric run | A | 1 | todo | feature/A-design-closeout | n/a | | |
| A3 open decisions | hub + author | 2 | todo | main | n/a | | |
| A5 followups.md | A | 5 (optional) | todo | | n/a | | |
| B0 scaffold + protocol | B | 0 | todo | feature/B-prototype | | | |
| B1 heartbeat + reconnect | B | 1 | todo | feature/B-prototype | | | |
| B2 send path, store, dedup | B | 1 | todo | feature/B-prototype | | | |
| B4 history + summary (slow path) | B | 2 | todo | feature/B-prototype | | | |
| B5 receipts + unread | B | 2 | todo | feature/B-prototype | | | |
| B6 presence | B | 2 | todo | feature/B-prototype | | | |
| B7 media stub | B | 2 | todo | feature/B-prototype | | | |
| B3 sync queue replay | B | 3 | todo | feature/B-prototype | | | |
| B8 scenario suite | B | 4 | todo | feature/B-prototype | | | |
| B9 real Redis | B | 5 (optional) | todo | | | | |
| C1 integrate (per epic) | C | continuous | waiting | main | | | |
| C2 retrospective | C | 4 | todo | main | n/a | | |

## Merged to main

| Epic | Merge commit | Date |
|---|---|---|

## Surprises collected for C2

| Epic | Surprise |
|---|---|

## Decisions for the author (A3 queue)

| From | Decision needed | Status |
|---|---|---|
| roadmap | Service discovery: least-loaded server + mark-all-offline (etcd / Consul / orchestrator) | open |
| roadmap | Reply quoting: denormalize excerpt vs resolve by ID on render | open |
| roadmap | Spec §5.8: store-primary failure, backpressure in design.md, five paging metrics | open |
