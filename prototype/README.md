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
src/connection/        B1  heartbeat, sweeper, death            (design §1)
src/messaging/         B2  store, dedup, ack, direct push       (design §2.2, §1.4)
src/sync/              B3  queue append after ack, replay       (design §4.2, §4.4, §4.7)
src/history/           B4  page API, summaries, slow path       (design §2.3, §4.3)
src/receipts/          B5  read/delivery cursors, push hints    (design §3)
src/presence/          B6  state machine, watch/unwatch, lease  (design §5)
src/media/             B7  media intent and signed-URL stub     (design §6.2)
src/fixtures.ts        Truc·phone (A1), Truc·laptop (A2), Khanh·phone (B1), bots; c1 c2 c3
test/harness/          ScriptedClient: suppress pongs, blackhole, destroy without close,
                       replay a script, hop trace in the format of docs/prototype/index.html
test/ports/contracts/  one contract per port, reusable by B9 against Redis
test/scenarios/        S1–S6 (B8): one scripted run per scenario over the real server, the
                       framework (scenario.ts), the runner (run.ts) and the vitest wrapper
```

## Rules for a module

- Touch only your module directory (and, for the harness, `test/harness/` in B1).
- Register through `ctx.onFrame`, `ctx.events.on`, `ctx.http.route`; never import
  another module.
- Write order is a property of slot order in `server.ts`: store → ack → queue → push.
- Open decisions stay open in code: one server, no service discovery; `reply_to` is an
  id only (roadmap A3).

## Scenarios

The runtime ADR's definition of done: six scripted runs over the real server with the
fixture devices (Truc·phone A1, Truc·laptop A2, Khanh·phone B1, the bots), each printing
the hop trace in the format of `docs/prototype/index.html` (`HH:MM:SS  tag  text`, server
and devices interleaved) so the two can be compared by eye.

| # | Proves | Design | How it is driven |
|---|---|---|---|
| S1 | An unclean drop (no close frame) is detected by the server within 10 s and the route deleted; the device notices on its own after 15 s without a ping, reconnects with backoff, sends `hello` with its cursor and flushes the outbox with the same `client_msg_id` | §1.2, §1.5, §1.4 | Khanh·phone `suppressPongs()` + `blackhole()` at a ping tick; Truc sends during the outage; Khanh types one message while down; `restoreRadio()` after the mirror rule |
| S2 | Reconnect with the cursor replays exactly the missed messages, in id order, once, scoped to the device's conversations, before live traffic; a cursor moved backwards re-delivers and the device drops duplicates by message id | §4.2, §4.4, §4.7 | Khanh acks one message, closes; Truc sends 7 across c1/c2, Linh one in c3; Khanh reconnects, then again with the old cursor |
| S3 | A retry with the same `client_msg_id` gets the same `message_id`: one store row, one queue entry, one `deliver` | §1.4, §2.2 | Truc sends, gets the ack, re-sends the same frame |
| S4 | The chat list renders from the summary rows before the replay finishes; a cold open during the replay reads the store, not the queue | §4.3, §4.4 | Truc·laptop 250 messages behind: `GET /conversations?since=` first, then `hello`; three batches of 100 acked by hand; `GET /conversations/c1/messages` between batches |
| S5 | `watch` is batched on the device and answered with the current state; a drop at t is seen by the watcher as `offline, last_seen=t` at ≈ t+15–16 s; a reconnect inside the 5 s debounce publishes nothing; `unwatch` stops events; 60 s of pongs never write the presence lease | §5.2–§5.4 | Khanh watches Truc; Truc·phone drops; Truc·laptop drops and the phone is back 12 s later; `unwatch`, then a clean close |
| S6 | A media message carries `media_key` and the §6.2 metadata only: no URL and no byte on either socket; the download URL is HTTP; an intent over 10 MB is refused before any byte moves | §6.2 | `POST /media/intent` (4.2 MB), `msg{media_key, size, mime, sha256}`, `GET /media/<key>/url`, every frame tapped on both sockets; a 12.4 MB intent |

```bash
npm run scenarios                  # fake time with the design's numbers: traces read t, t+10 s, t+15 s
npm run scenarios -- --real-time   # S1 and S5 on real timers, intervals scaled down ×100 (ping 50 / dead 100 / sweep 10 ms, debounce 100 ms)
npm test                           # includes all six on fake time plus S1 and S5 on real timers (test/scenarios/scenarios.test.ts)
```

`SCENARIOS_REAL_TIME=1` is the environment form of the flag. The runner prints each
scenario's trace (bulk sections folded to their first row per tag plus a count; the server
trace itself is never cut), then `| # | scenario | design | result |`, and exits 1 on any
failure. A scenario is a `defineScenario({id, title, design, run})` in `test/scenarios/`;
`run(env)` gets a fresh seeded server, a shared clock and trace, `connect`, `advance`,
`step` (a `note` row narrating like the page) and `assert`.
