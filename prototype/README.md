# Chat prototype

**Scope guard (runtime ADR, `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md`):**
this prototype proves protocol correctness, nothing else. One process, everything in
memory, no auth, no persistence, no multi-server. It exists to run the scripted scenarios
below against the heartbeat, reconnect, dedup, replay, presence and media rules of
`docs/design.md`; it is not a product, does not measure connections per node, and none of
its code is meant to be reused in a production runtime (that decision stays open).

## Run

```bash
npm install
npm test            # unit + contract tests (vitest)
npm run typecheck   # tsc --noEmit
npm run scenarios   # the end-to-end scenario table (B8)
npm run dev         # one server on :8080 with the fixture conversations seeded
```

## Layout

```
src/protocol.ts        frame types, encode/decode with validation
src/ids.ts             Snowflake ids: 41 bits ms / 10 bits worker / 12 bits sequence
src/ports/             MessageStore, SyncQueue, RouteTable, PresenceStore, Summaries,
                       Conversations, Cursors, Devices — interfaces + InMemory* adapters
src/server.ts          composition root: sockets, http, connection table, hello, events,
                       trace; one registration slot per module
src/pushBuffer.ts      the bounded per-connection push buffer (B10): the only flow control
                       for live and replay frames, owned by the core as `conn.pushes`
src/connection/        B1  heartbeat, sweeper, death            (design §1)
src/messaging/         B2  store, dedup, ack, direct push       (design §2.2, §1.4)
src/sync/              B3  queue append after ack, replay       (design §4.2, §4.4, §4.7)
                       B10 live-first replay, replay_done, re-replay after a dropped push
src/history/           B4  page API, summaries, slow path       (design §2.3, §4.3)
src/receipts/          B5  read/delivery cursors, push hints    (design §3)
                       B11 the delivered receipt: `delivered{conversation_id, up_to_message_id}`
src/presence/          B6  state machine, watch/unwatch, lease  (design §5)
src/media/             B7  media intent and signed-URL stub     (design §6.2)
src/redis/             B9  Redis adapters for SyncQueue, RouteTable, PresenceStore and
                       the presence bus; createRedisPorts (see "Real Redis" below)
src/fixtures.ts        Truc·phone (A1), Truc·laptop (A2), Khanh·phone (B1), bots; c1 c2 c3
test/harness/          ScriptedClient: suppress pongs, blackhole, destroy without close,
                       replay a script, hop trace in the format of docs/prototype/index.html
test/ports/contracts/  one contract per port, reusable by B9 against Redis
test/scenarios/        S1–S7 (B8, B10): one scripted run per scenario over the real server,
                       the framework (scenario.ts), the runner (run.ts) and the vitest wrapper
test/redis/            B9: the same contracts against the Redis adapters, plus the server
                       end to end over Redis and S7 on the Redis ports; skipped unless
                       REDIS_URL is set
```

## Rules for a module

- Touch only your module directory (and, for the harness, `test/harness/` in B1).
- Register through `ctx.onFrame`, `ctx.events.on`, `ctx.http.route`; never import
  another module.
- Write order is a property of slot order in `server.ts`: store → ack → queue → push.
- Open decisions stay open in code: one server, no service discovery; `reply_to` is an
  id only (roadmap A3).

## Replay (B10)

The two ADRs of 2026-11-02 (`live-first-replay-xadd-auto-id`, `replay-mode-boundary`) are
in the code: on `hello{cursor}` the connection is live at once and the sync module runs
`XRANGE (cursor + COUNT 100` beside live pushes until an empty read, each entry as
`deliver{replay: true}`, then one `replay_done`; it never waits for an ack (the ack is
traced and persists nothing; the device owns the cursor). Stream ids are store-assigned
(`XADD … *`, `<ms>-<seq>` from the clock in memory) and the `message_id` lives in the entry
body; a timed-out `XADD` is followed by a tail read (`XREVRANGE … COUNT 100`) that skips a
present id. The bounded per-connection buffer is the only flow control: a live push it drops
(full, or not taken within the timeout) is reported as `push_dropped`, live pushes to that
connection are suspended, the buffer drains, the same loop runs alone from the dropped
entry, sends `replay_done`, and live resumes; a further drop during the loop lowers its
start. Replay frames are never dropped: the loop waits for room instead. The scripted
client keeps a store by `message_id`, renders it sorted by `message_id` (socket order is
not message order during a replay), is in replay mode from `hello` (and from the first
`replay: true` frame after a `replay_done`) to `replay_done`, acks the highest replay
stream id every 100 replay frames or 500 ms and at `replay_done`, and applies a live
frame's `stream_id` to its cursor only outside replay mode. Scenario S7 checks, after
every frame, that the cursor never passes an entry the device does not hold.

## The delivered receipt (B11)

The delivered-receipt ADR of 2026-11-02 (`delivered-receipt-device-stored`) is in the
code: *delivered* means the device stored the message, so the device says so. The client
sends `delivered{conversation_id, up_to_message_id}` after a `deliver` is in its store, in
replay mode and live mode alike, coalesced to at most one per conversation per 2 s with the
highest `message_id` stored (the read receipt's rule and number, design §3.4). The server
runs `max()` on `delivery_cursors` (one partition read, one write; a late or duplicate frame
is a traced no-op) and keeps no per-connection state and no stream-id mapping; the replay
`ack{up_to_stream_id}` is a different frame with a different key and owner and still
persists nothing. B5's rule that advanced the delivery cursor when a push was handed to the
socket (finding 10: a dropped push counted as delivered) is removed, not patched; only the
sender's own cursors still move on store, as on the page. The scripted client keeps
`storedUpTo` and `deliveredUpTo` per conversation (`deliveredWindowMs` sets the window,
`autoDelivered: false` turns the frame off for a test that drives the cursor by hand); at
the first `replay_done` after a `hello` it sends one `delivered` for every conversation
where the two differ, which covers a receipt lost inside the window when the previous
connection dropped. Status (`GET …/status`) is derived from the cursors as before: a pushed
but not yet stored message reads *sent*; the device's frame makes it *delivered*.

## Scenarios

The runtime ADR's definition of done: scripted runs over the real server with the fixture
devices (Truc·phone A1, Truc·laptop A2, Khanh·phone B1, the bots), each printing the hop
trace in the format of `docs/prototype/index.html` (`HH:MM:SS  tag  text`, server and
devices interleaved) so the two can be compared by eye.

| # | Proves | Design | How it is driven |
|---|---|---|---|
| S1 | An unclean drop (no close frame) is detected by the server within 10 s and the route deleted; the device notices on its own after 15 s without a ping, reconnects with backoff, sends `hello` with its cursor and flushes the outbox with the same `client_msg_id` | §1.2, §1.5, §1.4 | Khanh·phone `suppressPongs()` + `blackhole()` at a ping tick; Truc sends during the outage; Khanh types one message while down; `restoreRadio()` after the mirror rule |
| S2 | Reconnect with the cursor replays exactly the missed messages, in stream order, once, each `replay: true`, then `replay_done`, scoped to the device's conversations; the device acks on its own cadence and the server only traces it; a cursor moved backwards re-delivers and the device drops duplicates by message id | §4.2, §4.4, §4.7 | Khanh's phone applies one live frame to its cursor, closes; Truc sends 7 across c1/c2, Linh one in c3; Khanh reconnects, then again with the old cursor |
| S3 | A retry with the same `client_msg_id` gets the same `message_id`: one store row, one queue entry, one `deliver` | §1.4, §2.2 | Truc sends, gets the ack, re-sends the same frame |
| S4 | The chat list renders from the summary rows before the replay finishes; a cold open during the replay reads the store, not the queue | §4.3, §4.4 | Truc·laptop 250 messages behind: `GET /conversations?since=` first, then `hello`; three reads of 100 that wait for no ack (the second held), the laptop acks every 100 frames and at `replay_done`; `GET /conversations/c1/messages` between reads |
| S5 | `watch` is batched on the device and answered with the current state; a drop at t is seen by the watcher as `offline, last_seen=t` at ≈ t+15–16 s; a reconnect inside the 5 s debounce publishes nothing; `unwatch` stops events; 60 s of pongs never write the presence lease | §5.2–§5.4 | Khanh watches Truc; Truc·phone drops; Truc·laptop drops and the phone is back 12 s later; `unwatch`, then a clean close |
| S6 | A media message carries `media_key` and the §6.2 metadata only: no URL and no byte on either socket; the download URL is HTTP; an intent over 10 MB is refused before any byte moves | §6.2 | `POST /media/intent` (4.2 MB), `msg{media_key, size, mime, sha256}`, `GET /media/<key>/url`, every frame tapped on both sockets; a 12.4 MB intent |
| S7 | Replay is a mode boundary: the initial replay runs beside live pushes (frames out of message order on the socket, the store in message order, each message once); a live push the budget drops is re-replayed alone from the dropped entry and ends with `replay_done`, no reconnect; an ack during the re-replay is handled with no waiter; after every frame the cursor has never passed an entry the device does not hold. Delivered is the device's word (B11): after every frame the server's delivery cursor for the phone is never above what its `delivered` frames said, stays below the dropped message until the re-replay stored it and the coalesced frame arrived, then passes it | §3.4, §4.4, §4.7, §5.8.3 | Khanh·phone 150 behind, the second read held while Truc sends 3; then the phone's server-side socket corked, 9 pushes under `maxPending` 8 (one dropped), one more while suspended, uncork, the re-replay's first read held while the 500 ms ack lands; the clock advanced by the 2 s window so the `delivered` leaves |

```bash
npm run scenarios                  # fake time with the design's numbers: traces read t, t+10 s, t+15 s
npm run scenarios -- --real-time   # S1, S5 and S7 on real timers, intervals scaled down ×100 (ping 50 / dead 100 / sweep 10 ms, debounce 100 ms)
npm test                           # includes all seven on fake time plus S1, S5 and S7 on real timers (test/scenarios/scenarios.test.ts)
```

`SCENARIOS_REAL_TIME=1` is the environment form of the flag. The runner prints each
scenario's trace (bulk sections folded to their first row per tag plus a count; the server
trace itself is never cut), then `| # | scenario | design | result |`, and exits 1 on any
failure. A scenario is a `defineScenario({id, title, design, run})` in `test/scenarios/`;
`run(env)` gets a fresh seeded server, a shared clock and trace, `connect`, `advance`,
`step` (a `note` row narrating like the page) and `assert`.

## Real Redis (B9)

The three ports the design puts in Redis, and the presence bus, have Redis adapters in
`src/redis/`; the contracts of `test/ports/contracts/` and `test/presence/contracts/`
run against them unchanged. Everything else stays in memory by decision: the message
store, summaries, conversations, cursors and devices are not Redis in the design, and
the prototype has no Cassandra. Still one chat server process.

| Port | Redis adapter | Commands |
|---|---|---|
| `SyncQueue` | `RedisSyncQueue` | `XADD sq:{device} MAXLEN ~ 100000 * m <id> c <conv>`, `XRANGE sq:{device} (<cursor> + COUNT 100`, `XREVRANGE sq:{device} + - COUNT 100` (retry path), `XTRIM sq:{device} MINID <id>`, `first` = `XRANGE - + COUNT 1` |
| `RouteTable` | `RedisRouteTable` | `route:{user}:{device} → server_id` and the set `routes:{user}` (`SCARD`/`SMEMBERS` of §1.5), both in one `MULTI` |
| `PresenceStore` | `RedisPresenceStore` | `SET presence:{user} <json> PX <ttl>`; `get` is a miss once Redis expired the key |
| `PresenceBus` | `RedisPresenceBus` | `PUBLISH pres:{user}`; `SUBSCRIBE`/`UNSUBSCRIBE` on a dedicated subscriber connection, issued by the first and last local handler |

```bash
npm run redis:up      # docker compose: redis:7-alpine on 127.0.0.1:6399, no persistence
npm run test:redis    # REDIS_URL=redis://127.0.0.1:6399 vitest run test/redis
npm run redis:down
```

Skip rule: every file under `test/redis/` is `describe.skipIf(!process.env.REDIS_URL)`,
prints one line saying so, and `npm test` stays green without Redis. Each file owns a
random key prefix (`test-<hex>:`) and deletes only its own keys afterwards (`SCAN` +
`UNLINK`), so files run in parallel against one Redis and nothing else in it is touched.
`createRedisPorts({url, prefix})` returns `{syncQueue, routes, presence, redis, close}`
for `createChatServer({ports})`; the bus goes in through `moduleOptions.presence.bus`.

What the real commands showed that the in-memory adapters could not, and what B10 did
with each:

- `XADD` with an id at or below the stream's top entry is refused. Closed by the
  live-first ADR: ids are Redis-assigned (`XADD … *`) and the message id lives in the
  entry body, so appends to one stream need no ordering; a timed-out `XADD` is followed by
  an `XREVRANGE` tail read that skips a present id (`test/redis/syncQueue.test.ts`).
- `MAXLEN ~` trims whole radix-tree nodes: the cap is a floor, not an exact length. Still
  a fact, still kept as a `test.fails` with the reason in its name.
- The presence-store TTL runs on Redis's clock: the contract's `advance` sleeps for real,
  with short leases.
- Pub/sub delivery is asynchronous: `publish` returns when Redis has the message, the
  handler runs when the subscriber connection receives it.
- The replay-to-live window (a message appended after the last empty `XRANGE` and before
  the flip was neither replayed nor pushed). Closed by the live-first ADR: there is no
  flip, the connection is subscribed to live pushes before the replay starts, the client
  dedups by `message_id`. `test/redis/e2e.test.ts` holds the empty reply and shows the
  message pushed live and stored once; "late, not lost" survives as harmless over-replay
  on a reconnect with the older cursor. `test/redis/s7.test.ts` runs S7 on the Redis
  ports on real timers.
