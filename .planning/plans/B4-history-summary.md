# Plan B4 · History page API and conversation summary, the slow path

Epic text: `.planning/roadmap.md` §3 B4 (approved plan). Design §2.3 (open, scroll up, jump), §4.3
(summary row and list), §3.5 (unread derived, capped at 99+), §4.5 / sync-queue ADR condition
(slow path exists and is rate-limited before the queue is relied on). Scenario S4 proper lands in B8.

## Files

- `prototype/src/history/index.ts` — `registerHistory(ctx)`: three HTTP routes, the `message_stored`
  listener that upserts `conv:{id}:summary`, `HistoryOptions` (slow-path token bucket) read from
  `ctx.moduleOptions['history']`
- `prototype/src/history/tokenBucket.ts` — `TokenBucket`: capacity, refill per second, `take()` →
  `{ok:true}` or `{ok:false, retry_after_ms}`; time comes from an injected `now()`
- `prototype/src/history/buckets.ts` — `prevBucket`, `nextBucket`, the backward and forward month walks
  over `MessageStore.readPartition` (one partition read per bucket, by construction)
- `prototype/src/history/preview.ts` — `previewOf(message)`: body cut to 80 chars, `[media]` when the
  body is empty and `media_key` is set
- `prototype/test/history/tokenBucket.test.ts` — unit, fake clock
- `prototype/test/history/buckets.test.ts` — unit, in-memory store, counts `partitionReads`
- `prototype/test/history/history.test.ts` — real server on port 0, seeded fixtures, `fetch` + `ScriptedClient`
- `.planning/plans/B4-history-summary.md` — this file

Not touched: `src/server.ts`, `src/protocol.ts`, `src/ports/**`, `src/messaging/**`, `test/harness/**`,
other modules, docs, README, memory, progress.

## Identity without auth (runtime ADR: no auth)

`HttpRequest` carries `method, path, params, query, body` and no headers, so the caller identifies
itself in the query string: `user_id` (required, 400 `missing_user_id` without it) and `device_id`
(optional, only for the trace row's `← Truc·laptop`). Unknown conversation → 404 `not_found`;
a `user_id` that is not a member → 403 `not_member`. This is the stand-in for the session an
authenticated runtime would carry; nothing is verified.

## HTTP contract

### `GET /conversations/:id/messages?user_id&device_id&limit&before|after`

Design §2.3 literally. `limit` default 50, max 200 (400 `bad_limit` otherwise); `before` / `after`
must be decimal Snowflake ids (400 `bad_cursor`); at most one of them.

- No cursor (**cold open**, charged to the slow path): start at `bucketOfTime(clock.now())`, read one
  partition, walk to the previous month while fewer than `limit` rows and `bucket >= created_bucket`.
- `before` (**scroll up**, not charged): start at `bucketOf(before)`, rows strictly below `before`, same
  backward walk. Rows newest-first.
- `after` (page down after a jump, not charged): start at `bucketOf(after)`, rows strictly above
  `after` read with `order:'asc'`, walk forward while fewer than `limit` rows and
  `bucket <= bucketOfTime(clock.now())`. Rows oldest-first.

Response `200 { messages: Message[], next_before: MessageId|null, next_after: MessageId|null }`:
`next_before` is the smallest id returned (null when nothing came back), `next_after` the largest
id returned on an `after` page (null on a backward page). A client scrolling up feeds `next_before`
back as `before`.

### `GET /conversations/:id/messages/:message_id?user_id&device_id&before&after&limit`

Jump to a message by key (design §2.3, F10). 404 `not_found` when the row is absent (`get` is by
key, no walk). `before` and `after` are **row counts** for the window around the anchor (default
`limit`, which defaults to 0, max 200 each): `before` rows strictly older, newest-first (backward walk
from the anchor's bucket); `after` rows strictly newer, oldest-first (forward walk, `order:'asc'`).

Response `200 { message, before: Message[], after: Message[] }`. Paging on from there is the page
route with `before=<smallest id of before>` or `after=<largest id of after>`. Not charged to the slow
path (one key read plus a small window).

### `GET /conversations?user_id&device_id&since&limit`

Design §4.3. `since` default 0 (**full-list load**, charged to the slow path); `since > 0` is an
incremental load and is not charged. `limit` default 200, max 200.

For every conversation of the user: one `summaries.getMany` (one MGET); keep rows with
`last_at > since`; order `last_at` desc (ties by id desc); cap `limit`; then per row
`my_read_cursor = cursors.readCursor(conversation_id, user_id) ?? null` and
`unread_count = messages.countAfter(conversation_id, bucketOf(last_message_id), my_read_cursor ?? '0', 99)`.
Conversations without a summary row are omitted (nothing was ever written).

Response `200 { conversations: Row[], list_cursor: number }` with
`Row = { conversation_id, last_message_id, last_preview, last_sender, last_at, my_read_cursor,
unread_count: number, unread_capped: boolean }` (`unread_capped` is true when the count hit 99; the
client renders "99+"). `list_cursor` is the largest `last_at` returned, or `since` when nothing
changed; the device stores it and sends it back as `since`.

### Slow path rate limit

One token bucket per server, `HistoryOptions { slowPathCapacity: 100, slowPathRefillPerSecond: 50 }`
from `ctx.moduleOptions['history']`. A cold open (page without `before`/`after`) and a full-list load
(`since` absent or 0) each take one token first; when empty →
`429 { error: 'slow_path_rate_limited', retry_after_ms }`. Refill is computed from `ctx.clock.now()`,
so a test injects a fake clock. Scroll-up pages, `after` pages, jumps and incremental `since` loads are
never charged: they are bounded by what the client already has.

### Summary row

On `message_stored{message}` (B2 emits it after the store write, before the ack):
`summaries.upsert({ conversation_id, last_message_id: message_id, last_preview: previewOf(message),
last_sender: sender_id, last_at: created_at })`. One server, ids monotonic, listeners run in order, so
no compare-and-swap; the Redis version would be a Lua `GET`/compare/`SET`.

### Trace rows (tag `http`)

- `GET /conversations?since=0 ← Truc·laptop` / `… ← truc` when no `device_id`
- `GET /conversations/c1/messages?limit=50 ← Truc·phone (bucket 202611)` for one read;
  `(buckets 202703→202602, 14 reads)` after a walk
- `GET /conversations/c1/messages?before=… ← Truc·phone (bucket 202602)`
- `GET /conversations/c1/messages/123 ← Truc·phone` for a jump
- `429 slow path: GET … ← Truc·phone, retry in 20 ms`

## Steps (TDD, each red → green → commit)

1. `tokenBucket.test.ts`: full at start; `take` down to zero; refill by elapsed time from the fake clock, never
   above capacity; `retry_after_ms` = time to the next whole token. Implement. `test(proto): …` then `feat(proto): …`.
2. `buckets.test.ts`: `prevBucket(202601) = 202512`, `nextBucket(202612) = 202701`; backward walk stops at
   `created_bucket` and at `limit`, one `partitionReads` per bucket visited; forward walk stops at the current
   month. Implement `buckets.ts`.
3. `history.test.ts` page route: cold open on seeded c1 after messages were sent through `ScriptedClient`
   returns them newest-first with `next_before`; scroll up with `before` returns the rest; `after` returns
   newer rows oldest-first; missing `user_id` 400, non-member 403, unknown conversation 404, bad `limit`/cursor 400.
4. The 14-idle-months test: fake clock in Feb 2026 generates 60 ids via `server.ctx.ids` into a conversation
   created in 202601, rows inserted with `ports.messages.insert`; clock moved to Mar 2027; cold open → the
   newest 50, `partitionReads` delta exactly 14 (one per bucket 202703…202602), `next_before` = the 50th id;
   second page with `before` → the remaining 10 in 1 read.
5. Jump route: by key, 404 when absent, `before`/`after` window around the anchor in the right orders.
6. Summary: after a `msg` frame `summaries.get('c1')` holds id, preview, sender, `created_at`; 80-char cut;
   `[media]` for an empty body with `media_key`; a second message replaces the row.
7. List: rows from summaries ordered by `last_at` desc; `since` returns only changed rows and `list_cursor`
   advances; conversations with no summary omitted; `unread_count` from the read cursor (0 after
   `advanceRead` to the last id); 120 unread rows → `unread_count: 99, unread_capped: true`.
8. Rate limit: `{ slowPathCapacity: 2, slowPathRefillPerSecond: 1 }` with a fake clock: two cold opens pass,
   the third is 429 with `retry_after_ms` 1000; a `before` page, an `after` page and a `since` load still pass
   while empty; clock +1 s → one more cold open passes; full-list load shares the same bucket.
9. S4 partial: hold a `device_connected` listener open with a promise so the laptop sits in `replay`; while it
   does, `GET /conversations?user_id=truc&device_id=A2` returns usable rows (c1 with the preview of a message
   khanh sent earlier) and the laptop has received no `deliver`; the `http` trace row precedes any `deliver`
   row. Release, close.
10. Trace rows read like the page. Whole suite + typecheck green; hand back.

## Test strategy

`npm test` (vitest, real sockets and HTTP on port 0, no mocks of the server) and `npm run typecheck`, the
whole suite. The token bucket and the bucket walk carry their semantics in unit tests on fake time; the
integration test proves the wiring, the status codes, the shapes and the read-count bound.

## Risks

- Snowflake epoch is 2026-01-01: ids before that are negative and `compareIds` breaks → the idle-months test
  lives in 2026–2027, never earlier.
- `countAfter` counts the sender's own rows too; who advances the sender's read cursor on send is B5's
  (receipts). Until then a sender sees its own last message as unread. Noted for C2, not fixed here.
- Both `before` and `after` on one page request is ambiguous → 400 `bad_cursor`.
- The core's `HttpRequest` has no headers → identity in the query string, stated above; B8 scenarios must
  pass `user_id`.
- `message_stored` runs before `msg_ack`: a summary write failure would fail the send. In memory it cannot
  fail; the production version would be fire-and-forget after the ack. Left as is (one process, no I/O).
