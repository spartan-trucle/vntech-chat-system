# C1 — Integrate each finished epic (lane C review checklist)

Status: active from wave 0; one pass per `done` report from the hub.
Source: `.planning/roadmap.md` §3 Workstream C, §5 risks, §6 reporting protocol; scope guard
from `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md` (Conditions + Risks).

Lane C never fixes a branch. A failed check is reported `blocked` with file and line, and the
hub sends it back to the lane that built it.

## 0. Ground rules for this lane

- Works in the main checkout on `main`. The hub shares this folder and only ever edits
  `.planning/progress.md`; stage files by name, never `git add -A`.
- Never switch `main` to another branch. To run tests on a branch, run them in that lane's
  worktree or in a temporary detached worktree (see §3).
- Commits: title only, `type(scope): ...`, under the author's configured git identity. Never push.
- Branches are local worktree branches; no fetch needed. Actual names today differ from the
  roadmap's `feature/*` names:
  - A: `claude/a-design-closeout-d1e5bf` (worktree `.claude/worktrees/a-design-closeout-d1e5bf`)
  - B: `claude/b-prototype-297ab9` (worktree `.claude/worktrees/b-prototype-297ab9`)
  Use whatever name the hub's message gives; record it in the report.

## 1. Inputs per review

From the hub's message: epic id, status `done`, and either a branch (lane A) or a merge-commit
range on the lane branch (lane B). Then:

```
git log --oneline main..<branch>            # or <range> for B
git diff --stat main...<branch>
git diff main...<branch>
```

Read the epic text in roadmap §3 and the design sections it names before reading the diff.

## 2. Checks, in order (stop at the first fail)

### 2.1 Files the branch must not touch

Owned by lane C and the hub only (roadmap §3 preamble, §5 risk "notebook conflict"):

- `docs/index.html`
- `README.md`
- `.memory/index.md`
- `.planning/progress.md`

```
git diff --name-only main...<branch> | grep -E '^(docs/index.html|README.md|.memory/index.md|.planning/progress.md)$'
```

Any hit → blocked. Also flag `docs/specification.md` (spec §6: "do not edit while designing").

### 2.2 Tests exist and came first (code epics only: B0–B9)

- Every module directory under `prototype/src/` touched by the diff has tests under
  `prototype/test/` (or beside it) that exercise the behaviour the epic text lists.
- TDD order: for each commit in `git log main..<branch>`, test files appear in the same or
  an earlier commit than the code they cover. Check with
  `git log --name-status --reverse main..<branch>`. A single commit containing both is
  acceptable only if the plan file for the epic documents the red→green sequence.
- The epic's named assertions are present as tests, not comments (see §4 per-epic list).
- Docs epics (A1, A2, A4, A5): n/a; check the "Done" criterion of the epic instead.

### 2.3 `npm test` green on the branch

Run inside `prototype/` of a checkout at the branch head (§3). Record `<n> passed`.
Also run `npm run scenarios` from B8 onward. Any red → blocked with the failing test name.

### 2.4 Scope guard (runtime ADR + roadmap §5)

The prototype proves protocol correctness, not connection count. Blocked if the diff adds:

- **Auth**: tokens, passwords, sessions, sign-in; `hello` carries ids only.
- **Persistence**: a database, files on disk, Docker, Redis client (B9 excepted, and only
  behind the ports from B0, with the in-memory implementations still passing the contract tests).
- **Multi-server**: more than one chat-server process, service discovery, cross-server
  routing, `GET /chat-servers`. The route table stays in memory in one process.
- **Guesses on open decisions** (board "Still open", progress.md A3 queue):
  - service discovery (least-loaded server, mark-all-offline): must not exist in code;
  - reply quoting: `reply_to` stored as an ID only, with a comment pointing at A3; no
    denormalised excerpt;
  - production runtime: no statement in `prototype/README.md` or docs that picks one;
  - spec §5.8 items (store-primary failure, five paging metrics): not invented in code.
- Anything outside the epic text (a feature from a later epic, a product-shaped addition).
  Roadmap §5: "the prototype grows into a product".

`prototype/README.md` must state the scope in its first paragraph (B0 onward).

### 2.5 Matches the design sections the epic names

Numbers and names in code equal the design's: ping 5 s, dead at 10 s, client 15 s, backoff
1·2·4…30 s ±30 %, replay batches of 100, stream `MAXLEN ~100000`, 24 h trim, receipts
coalesced per 2 s, presence debounce 5 s, watch batching 500 ms, lease 2 min / TTL 5 min,
media cap 10 MB, download URL 1 h, unread cap 99+. Frame names as in B0's protocol list.
Write order store → `msg_ack` → push → queue append, asserted by a test (board C3).

### 2.6 Module boundaries (roadmap §5 "two agents edit server.ts")

- The epic touched only its module directory plus its registration slot in
  `prototype/src/server.ts`; no edits inside another module's directory.
- Ports (`prototype/src/ports/`) changed only by B0, or by an epic whose text says so, with
  the contract test updated in the same change.

### 2.7 Docs epics (A1, A2, A4, A5)

- A1: every spec §5.1–§5.8 bullet appears exactly once in `docs/tradeoffs.md`; open bullets
  listed at the top and marked *open*, none invented; numbers cite `estimation.md`.
- A2: nine `sequenceDiagram`s in `docs/diagrams/flows.md`, fixed actor set
  (device / API server / chat server / Redis / message store / object storage / push gateway);
  flow 9 shows reply quoting as a note, not a choice. Mermaid parses (render check).
  Links from `index.html` and `README.md` are lane C's job, not A's.
- A4: `docs/rubric.md` scores every spec §7 row with the gap behind each fail.
- A5: only after A4 passes; one extension per section, spec §8 numbering.

## 3. Running tests without touching `main`

Preferred: a temporary detached worktree at the reviewed commit, so the lane's own worktree
(which may be mid-edit on the next epic) is untouched.

```
git worktree add --detach "$SCRATCH/review-<epic>" <commit-or-branch>
(cd "$SCRATCH/review-<epic>/prototype" && npm ci && npm test)
git worktree remove --force "$SCRATCH/review-<epic>"
```

`$SCRATCH` = this session's scratchpad directory. Tests run in the background if they are
likely to exceed two minutes.

## 4. Per-epic assertions to look for (from roadmap §3)

| Epic | Must-have tests / artefacts | Design |
|---|---|---|
| B0 | `npm test` green on empty suite; `protocol.ts` unions for every frame listed; five ports with `InMemory*` + contract test each; `ids.ts` Snowflake 41/10/12; `ScriptedClient` can suppress pongs, drop uncleanly, replay a script, record a hop trace; three fixture identities | §1, §2.2 |
| B1 | pong suppressed → dead at 10 s ± sweep; clean close → immediate; backoff table; outbox flush order; intervals injectable; **no** reconnect-target selection | §1.2, §1.4, §1.5 |
| B2 | duplicate → one row, same id; store before ack (instrumented); 3 users × 2 devices → 5 pushes; bounded buffer with timeout; queue hook left for B3 | §2.2, §1.4, board C3 |
| B3 | N missed across 3 convs → exactly N, in order, no dups; cursor backwards → client dedups; past trim → `slow_path: true`; crash mid-replay → restart from last acked batch; replay before live traffic; only `ack` advances cursor | §4.2, §4.4, §4.7 |
| B4 | ≤ 14 partition reads after 14 idle months, right 50; `since` returns changed rows only; summary before first replayed `deliver`; token-bucket rate limit on slow path; summary row updated on every store write | §2.3, §4.3 |
| B5 | phone read → laptop badge clears; late/duplicate receipt no-op; 100-member "who read N" = one partition read; push gateway records no body; mute hook | §3 |
| B6 | drop at t → watcher offline ≈ t+15 s; reconnect at t+12 s → nothing; unsubscribed gets nothing; 200 watchers → one each, zero others; **zero** presence-store writes during heartbeat-only run | §5.2–§5.4 |
| B7 | intent rejects > 10 MB; `media_key` = region/yyyy/mm/uuid; download URL checks membership, 1 h expiry; no socket frame over a few hundred bytes | §6.2 |
| B8 | S1–S6 as scripted runs, hop-trace format matches `docs/prototype/index.html`; `npm run scenarios` pass/fail table; S1 and S5 once with real timers; README table | all |
| B9 | Redis implementations pass the same contract tests as in-memory; no Cassandra | §4 ADR |

## 5. Pass: merge and close

```
git merge --no-ff <branch> -m "merge(<epic>): <slug>"      # no squash; history stays readable
```

Then, in a **separate** commit on `main` (`docs(notebook): close out <epic>`), only what changed:

- `docs/index.html`: flip a board row's state or decision text if the epic changed one
  (rows in the table after "One section per part of the system", `<span class="state ...">`,
  and the matching `<div class="decision ...">` block); add links to new docs
  (`docs/tradeoffs.md`, `docs/diagrams/flows.md`, `docs/rubric.md`, `prototype/`).
- `.memory/index.md`: one line per ADR added or amended by the epic.
- `README.md`: point at anything new; replace the "not yet written" line for `tradeoffs.md`.

Record the merge commit hash in the report. The hub copies it into `progress.md`.

## 6. Fail: report, do not fix

```
epic: C1 (for <epic>)
status: blocked
branch: main
tests: <n passed / failing test name, or n/a>
surprises: <none, or one line>
blocker: <check number> — <file:line> — <what is wrong and what the epic text requires>
```

One blocker line per finding; the hub forwards them to the lane.

## 7. Report shape (every turn, one block per epic touched)

```
epic: C1 (for <epic reviewed>)
status: done | in_progress | blocked
branch: main   plus the merge commit
tests: <n> passed on the merged tree, or n/a
surprises: <one line for C2, or none>
blocker: <findings to send back, or none>
```

`surprises` feeds C2; note anything the merge revealed that the design did not predict.
