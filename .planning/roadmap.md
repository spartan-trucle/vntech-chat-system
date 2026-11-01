# Roadmap — from design to prototype

Status: **approved 2026-11-01** by the author, with two changes from the draft: C is the
integration and review lane, and B is an orchestrator that spawns one subagent per epic.
The epic text here is the approved plan for each epic (see §4). Solo practice project; "workstream" here
means a lane of agent runs that can proceed in parallel, not a team.

Source of truth for every epic: `docs/design.md`, the ADRs in `.memory/decisions/`, and
`docs/specification.md` §5–§7. Nothing below re-opens a decided layer; where an epic
needs a decision that is still open, it says so and stops there.

## 0. What is decided, and what the roadmap therefore has to deliver

| Layer (board) | State | Delivered by |
|---|---|---|
| Transport, heartbeat, reconnect (§1) | decided | B1, B3 |
| Message store, IDs, history (§2) | decided | B2, B4 |
| Fan-out, queueing, write order (§4, board C3) | decided | B2, B3 |
| Reconnect, summary, cursors (§4) | decided | B3, B4 |
| Receipts, unread, notifications (§3) | decided | B5 |
| Presence (§5) | decided | B6 |
| Media (§6) | decided | B7 |
| Prototype runtime | decided: Node.js + TS + `ws` | B0 |
| Production runtime | **deliberately open** | nothing; stays open |
| Service discovery | **open** | A3 (decision), not in the prototype |

Spec §6 deliverables not yet written: `docs/tradeoffs.md`, `docs/followups.md`, sequence
diagrams for the nine flows in §4.2. Spec §7 rubric has not been run.

The prototype's definition of done is fixed by the runtime ADR: four scripted scenarios.

| # | Scenario (ADR conditions) | Design | Epic |
|---|---|---|---|
| S1 | Unclean drop detected within 10 s | §1.2, §1.5 | B1 |
| S2 | Reconnect with cursor replays exactly the missed messages | §4.2, §4.4, §4.7 | B3 |
| S3 | Duplicate send deduplicated by `client_msg_id` | §1.4, §2.2 | B2 |
| S4 | Chat list renders from the summary before replay finishes | §4.3, §4.4 | B4 |
| S5 | Presence watch/unwatch and the 5 s debounce (presence ADR condition) | §5.2–§5.4 | B6 |
| S6 | Media message carries a `media_key` only, no bytes (media ADR condition) | §6.2 | B7 |

## 1. Workstreams

```
A  Design close-out (docs only)        ─ runs in parallel with B from day one
B  Prototype (prototype/, Node + TS)   ─ the main lane; an orchestrator running the waves of §2
C  Integration, review, notebook       ─ reviews and merges every finished epic into main; retrospective at the end
```

Dependency graph (arrows = "needs"):

```
A1 tradeoffs.md ──┐
A2 sequence diagrams ──┤──▶ A4 rubric run ──▶ A3 open decisions (service discovery, reply quoting, §5.8) ──▶ A5 followups.md (optional)
                       │
B0 scaffold ──▶ B1 heartbeat ──────────────▶ B6 presence ──┐
          └──▶ B2 send/store/dedup ──▶ B4 history + summary (slow path) ──▶ B3 sync queue replay ──┤──▶ B8 scenario suite ──▶ C2 retrospective ──▶ B9 real Redis (optional)
                                   ├──▶ B5 receipts/unread ─────────────────────────────────────┤
                                   └──▶ B7 media stub ──────────────────────────────────────────┘
```

B4 before B3 is not arbitrary: the sync-queue ADR requires the slow path (summary + load
on open) to exist and be rate-limited before the queue is relied on.

## 2. Waves (what to spawn together)

Each wave is a set of agents that do not touch the same files. One worktree per epic,
branch `feature/<epic-id>-<slug>`, one plan in `.planning/plans/<epic-id>-<slug>.md`
written and approved before the agent starts (CLAUDE.md rule).

| Wave | Spawn in parallel | Why these together |
|---|---|---|
| 0 | B0, A1, A2 | B0 creates `prototype/`; A1/A2 touch only `docs/`. No overlap. |
| 1 | B1, B2, A4 | B1 owns `prototype/src/connection/`, B2 owns `prototype/src/messaging/`; both plug into the server composition B0 left stubs for. A4 is read-only on docs. |
| 2 | B4, B6, B5, B7, A3 | B4 needs B2; B6 needs B1; B5 needs B2; B7 needs B2. Four separate modules. A3 is a decision conversation, not an agent task. |
| 3 | B3 | Needs B2 + B4 (slow path must exist first). Single agent. |
| 4 | B8, C2 | B8 needs everything in B; C2 writes what the prototype taught back into the notebook. C1 runs continuously from wave 0, after every epic report. |
| 5 (optional) | B9, A5 | Only if the practice is worth extending. |

Critical path: B0 → B2 → B4 → B3 → B8. Roughly five agent-days of serial work; A and the
rest of B hide inside it.

## 3. Epics

Every epic ends with the same three closing tasks, done by lane C after the merge, not by
the lane that built the epic: update the board in `docs/index.html` if a state changed,
update `.memory/index.md` if a decision was made, and leave `README.md` pointing at
whatever new thing exists. A and B therefore never edit those three files.

Sizing: each task ≤ half a day; each epic ≤ one agent-day unless marked.

### Workstream A — design close-out

**A1 · `docs/tradeoffs.md`** (spec §6, format chosen / rejected / why)
- Inputs: the "Rejected alternatives" tables in `design.md` §1.6, §2.6, §3.7, §4.6, §5.6, §6.5 and the fan-out rejects on the board.
- Tasks: one row per spec §5 bullet (5.1–5.8), each naming the chosen option, the rejected ones, and the number from `estimation.md` that decided it where one did. Mark §5 bullets with no decision as *open* rather than inventing one.
- Done: every §5.1–§5.8 bullet appears exactly once; open ones are listed at the top.
- Agent: docs writer; read-only on the design, writes one file.

**A2 · Sequence diagrams for the nine flows** (spec §4.2, §6)
- Inputs: `design.md` (the reconnect sequence in §4.4, upload/download in §6.2–6.3 are already drawn as ASCII), the hop trace in `docs/prototype/index.html`.
- Tasks: nine Mermaid `sequenceDiagram`s in `docs/diagrams/flows.md`, one per flow, actors fixed as device / API server / chat server / Redis / message store / object storage / push gateway. Link from `index.html` and `README.md`.
- Done: rubric "Architecture" row: a newcomer traces every flow without a question. Flow 9 (reply) must show the undecided quoting choice as a note, not a guess.
- Agent: docs writer.

**A3 · Close the open decisions** (not an agent task; a conversation with `/arch-debate`, ADR per outcome)
- Service discovery: least-loaded chat server for `GET /chat-servers`, and `mark-all-offline(server_id)` on node loss. Candidates named on the board: etcd, Consul, orchestrator.
- Reply quoting (spec §5.3 last bullet, flow 9): quoted excerpt denormalized into the reply vs resolved by ID on render. `design.md` §2.3 has the fetch-by-ID path but no verdict.
- Spec §5.8: store-primary failure, backpressure (decided on the board, not in `design.md`), the five metrics to page on.
- Done: an ADR per decision, `design.md` section, board row flipped. Production runtime stays open on purpose.

**A4 · Run the spec §7 rubric** (read-only)
- Tasks: score each rubric row against `design.md` + `estimation.md` + diagrams; produce `docs/rubric.md` with pass/fail and the gap behind every fail.
- Done: the gap list is the input to A3. Expected fails today: Architecture (no sequence diagrams), Trade-offs (no `tradeoffs.md`), Failure modes (§5.8 incomplete).
- Agent: reviewer; runs after A1 and A2 land, or runs first to confirm the gap list and again at the end.

**A5 · `docs/followups.md`** (optional, spec §8) — only after A4 passes. Candidate order: typing indicators (cheapest, contrasts with messages), very large groups (the board already names what changes), multi-region.

### Workstream B — the prototype

Scope guard, from the runtime ADR: proves protocol correctness, not connection count. One
process. In-memory adapters behind interfaces so B9 can swap in real Redis without
touching protocol code. `prototype/README.md` states this scope in its first paragraph.

**B0 · Scaffold and protocol contract**
- `prototype/` with TypeScript, `tsx`, `ws`, `vitest`; `npm test` runs green on an empty suite.
- `src/protocol.ts`: frame types as discriminated unions. Client → server: `hello{device_id, user_id, last_synced_message_id, list_cursor, app_state}`, `msg{client_msg_id, conversation_id, body, reply_to?, media_key?}`, `ack{up_to_stream_id}`, `receipt{conversation_id, last_read_id}`, `watch{user_ids}`, `unwatch{user_ids}`. Server → client: `hello_ack`, `msg_ack{client_msg_id, message_id}`, `deliver{message, stream_id}`, `receipt`, `presence{user_id, state, last_seen?}`.
- `src/ports/`: interfaces `MessageStore`, `SyncQueue`, `RouteTable`, `PresenceStore`, `Summaries`, each with an `InMemory*` implementation and a contract test file that B9 will reuse.
- `src/server.ts` composition root with empty handler slots per module; `src/ids.ts` Snowflake (time-ordered, 41/10/12 layout).
- `test/harness/`: a `ScriptedClient` that can: open a socket, **suppress pongs**, **drop the socket uncleanly** (destroy without close frame), replay a script, and record a hop trace. The three fixture identities from the simulated client: Truc phone, Truc laptop, Khanh phone.
- Done: `npm test` green; a second agent can add a module without editing another module's files.

**B1 · Heartbeat, detection, reconnect** (design §1; scenario S1)
- Server: protocol-level ping every 5 s per connection; `last_pong_at` in memory only; 1 s sweeper closes connections silent > 10 s; on death: remove local entry, delete route, if last device → hand to presence (B6 hook, no-op until then). Intervals injectable for tests (fake timers).
- Client (`ScriptedClient`): mirror rule, no ping for 15 s → close and reconnect; backoff 1·2·4…30 s, ±30 % jitter; outbox with `client_msg_id`, flushed on reconnect; `hello` carries the cursor.
- Tests: pong suppressed → dead at 10 s ± sweep; clean close → immediate; reconnect schedule matches the backoff table; outbox flush order preserved.
- Not in scope: which server to reconnect to (service discovery is open; the prototype has one server).

**B2 · Send path: store, IDs, dedup, write order** (design §2.2, §1.4, board C3; scenario S3)
- `InMemoryMessageStore` keyed `(conversation_id, bucket) → message_id DESC`, same shape as the Cassandra table so the queries in §2.3 are literal.
- Dedup index `(sender_id, client_msg_id)` with a 24 h TTL; a duplicate `msg` returns the original `message_id` in `msg_ack` and stores nothing.
- Fan-out on write: store → `msg_ack` to sender → for each recipient device: route lookup → direct push if a socket exists, else nothing yet (the queue append is B3's; leave the hook). **The order is asserted by a test, not by convention.**
- Bounded per-destination buffer with a timeout (the backpressure rule on the board); on timeout the message stays for the queue.
- Tests: duplicate send → one row, same ID; message store written before the ack is sent (instrumented order); group of 3 users × 2 devices → 5 pushes (sender's other device included).

**B3 · Sync queue and replay** (design §4.2, §4.4, §4.7; scenario S2)
- `InMemorySyncQueue` with exactly three operations named after the Redis commands: `xadd(device, {m, c})` with Snowflake-derived idempotent IDs and `MAXLEN ~100000`, `xrange(device, after_cursor, count=100)`, `xtrim(device, min_age=24h)`; an hourly sweeper.
- Append step added to B2's fan-out, after the ack. `hello` triggers replay in batches of 100 **before** live traffic; bodies joined from the store; `ack{up_to_stream_id}` is the only thing that advances the cursor, which the device sends back on its next `hello`.
- Stream trimmed past the cursor → `hello_ack{slow_path: true}` and no replay; the device uses B4.
- Tests: device offline for N messages across 3 conversations → exactly N delivered, in ID order, none duplicated; cursor sent backwards → duplicates arrive and the client dedups by `message_id`; cursor beyond trim → slow path flag; server crash mid-replay (restart without the ack) → replay restarts from the last acked batch.

**B4 · History page API and conversation summary, the slow path** (design §2.3, §4.3; scenario S4)
- HTTP (plain `node:http`) beside the socket: `GET /conversations/{id}/messages?limit&before` with the month-bucket walk, `GET /conversations/{id}/messages/{message_id}` plus `before`/`after` paging around it, `GET /conversations?since&limit=200` built from `conv:{id}:summary` rows and the read cursors (unread dot; count capped at 99+).
- Summary row updated on every store write in B2.
- Slow path rate limit: a token bucket per server for full-list / cold-open loads (the ADR's precondition for relying on the queue).
- Tests: open after 14 idle months costs ≤ 14 partition reads and returns the right 50; `since` returns only changed rows; the harness shows the list rendered (summary received) before the first replayed `deliver` frame arrives — S4 proper lands in B8 once B3 exists.

**B5 · Receipts, unread, multi-device read state** (design §3)
- `read_cursors(conversation, user) = max(...)`, `delivery_cursors(conversation, device)`; status derived (read / delivered / sent) from cursors, never stored.
- Client coalesces receipts to one per conversation per 2 s; server pushes the cursor to members with that conversation open (watch set reused from B6 if it exists, else a per-conversation "open" set) and to the reader's own other devices.
- Push notifications: a `PushGateway` port that records `{conversation_id, message_id, sender_display_name}` for devices without a socket; never the body. Mute check hook.
- Tests: read on phone → laptop badge clears; late/duplicate receipt is a no-op; group of 100 members → "who has read N" is one partition read.

**B6 · Presence by subscription** (design §5; scenario S5)
- Per-user state machine `offline → online → pending-offline (5 s) → offline`, with `last_seen` on the final transition; `online` is per user, any device.
- `watch`/`unwatch` frames maintain `watching[target] → set(conn)`; the client batches watch changes per 500 ms. Fan-out to watchers only. One-server prototype: the pub/sub channel per watched user is a port with an in-memory implementation (B9 makes it real).
- Lease renewal every 2 min with 5 min TTL against `PresenceStore`, asserted to be **off the pong path** (a test counts store writes during a heartbeat-only run: zero).
- Tests: drop at t, watcher sees offline at ≈ t+15 s; reconnect at t+12 s → nothing emitted; unsubscribed device receives nothing; 200 watchers of one user → one event per watcher, zero to non-watchers.

**B7 · Media stub** (design §6.2; scenario S6) — half a day
- `POST /media/intent {size, mime, sha256}` → reject > 10 MB, else `{media_key: region/yyyy/mm/uuid, put_url: "stub://..."}`; `GET /media/{key}/url` checks conversation membership and returns a signed-looking URL with a 1 h expiry. No bytes anywhere.
- `msg` with `media_key` is stored and delivered as metadata only; a test asserts no frame on the socket ever exceeds a few hundred bytes.

**B8 · End-to-end scenario suite and trace** (the ADR's definition of done)
- `test/scenarios/`: S1–S6 as scripted runs over the real server with the three fixture devices, each printing the same hop trace format as `docs/prototype/index.html` so the two can be compared by eye.
- `npm run scenarios` prints a pass/fail table; CI-able with `npm test`.
- Done: all six green; `prototype/README.md` has the table and how to run it.

**B9 · Real Redis behind the ports** (optional; only after B8)
- `docker-compose` with Redis; `Redis*` implementations of `SyncQueue` (Streams: `XADD MAXLEN ~`, `XRANGE`, `XTRIM MINID`), `RouteTable`, `PresenceStore` (lease TTL), pub/sub for presence; the contract tests from B0 run against both implementations.
- Why optional: outside the runtime ADR's single-process scope. Why worth it: it is the only epic that proves the "three operations map one-to-one onto Redis commands" claim with real commands.
- Explicitly not: Cassandra. The store stays in memory; the schema is already literal.

### Workstream C — integration, review and the notebook

Runs for the whole project, in the main checkout rather than a worktree, because it is
the only lane that commits to `main`.

**C1 · Integrate each finished epic** (continuous, from wave 0)
- Trigger: the hub reports an epic as `done` with a branch (A) or a commit range on the
  B lane branch (B).
- Tasks: review the diff against the epic text above and the design sections it names.
  Checks, in order: tests exist and were written first where there is code; `npm test`
  green on the branch; scope guard respected (no auth, no persistence, no multi-server,
  no guesses on open decisions); no edits to the three notebook files or to
  `.planning/progress.md`. If it passes, merge into `main` (merge commit, no squash, so
  the epic's history stays readable). If not, send the findings back through the hub as a
  `blocked` report; never fix it in lane C.
- Then the closing tasks: board state in `docs/index.html`, `.memory/index.md`, `README.md`.
- Done per epic: merged on `main`; notebook consistent with what now exists.

**C2 · What the prototype taught** (after B8)
- A new section in `design.md` ("What the prototype changed") and a row per surprise on the board; amend or supersede ADRs where a scenario disproved a claim; add the link from `README.md` and the GitHub Pages index.
- Input: the `surprises` lines collected in `.planning/progress.md` across all epics.
- Candidates to watch for while building: whether `ack`-only cursor advance makes batch replay awkward at the client; whether the 500 ms watch batching interacts badly with the 5 s debounce; whether the slow-path rate limit starves a legitimately cold device.

## 4. Sessions and agent routing

Four conversations: a hub and one session per workstream, all started from the hub.

| Session | Where | Branch | Does |
|---|---|---|---|
| Hub (the session that wrote this roadmap) | main checkout | `main` | owns `.planning/progress.md`; routes reports between lanes; nothing else |
| A | worktree | `feature/A-design-closeout` | epics A1, A2, A4 in order, then A5 only on request; A3 is handed back to the hub as a list of decisions for the author, not decided in the lane |
| B | worktree | `feature/B-prototype` (lane branch) | does B0 itself, then runs the waves of §2: one subagent per epic in its own worktree branched from the lane branch, merges each finished epic back into the lane branch, reports per epic |
| C | main checkout | `main` | C1 after every `done` report; C2 at the end |

CLAUDE.md routes backend work to `be-executor` (Kotlin/Micronaut) and frontend to the
`fe-*` agents. The prototype is Node + TypeScript, so B's subagents are `general-purpose`
agents briefed with the epic text, the design sections it names, and the TDD rule (tests
first, `npm test` green before the branch is handed back).

**Plan rule** (decided 2026-11-01 by the author): the epic text in this roadmap is the
approved plan. Each lane still writes `.planning/plans/<epic-id>-<slug>.md` as the
detailed task list before starting an epic, but does not wait for approval on it.

## 5. Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| The prototype grows into a product | B2–B6 | Scope paragraph in `prototype/README.md`; no auth, no persistence, no multi-server. |
| Two agents edit `server.ts` | wave 1 and 2 | B0 leaves one registration slot per module; agents touch only their module directory plus their slot. |
| A lane edits a notebook file and C's merge conflicts | any epic | A and B never touch `docs/index.html`, `README.md`, `.memory/index.md` or `.planning/progress.md`; only C and the hub do. |
| A lane's worktree falls behind `main` | wave 2 onwards | C reports each merge; the hub tells the lanes, which sync their branch from `main` before the next epic. |
| Fake timers hide a real race | B1, B6 | B8 runs S1 and S5 with real timers once, slowly, in addition to the fast fake-timer unit tests. |
| B3 lands before the slow path exists | wave 3 | Ordering rule above; the plan for B3 lists B4 as a prerequisite and the agent verifies the route exists. |
| Open decisions (service discovery, reply quoting) leak into code as guesses | B1, B2 | One server, no discovery; `reply_to` stored as an ID only, quoting left to the client, with a comment pointing at A3. |

## 6. Reporting protocol

Every lane ends each turn with one block per epic it touched, in this exact shape:

```
epic: B2
status: done | in_progress | blocked
branch: feature/B-prototype          (A: feature/A-design-closeout; C: the merge commit on main)
tests: 14 passed                     (docs epics: n/a)
surprises: <one line for C2, or none>
blocker: <what, and who can unblock it, or none>
```

The hub copies each block into `.planning/progress.md`, tells C when an epic is `done`,
and tells the lane when C sends an epic back. No lane edits `progress.md`.

## 7. Approval

Approved 2026-11-01. Wave 0 starts with sessions A, B and C; A begins A1, B begins B0,
C waits for the first `done` report.
