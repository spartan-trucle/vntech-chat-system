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
test/scenarios/        S1–S6 (B8)
```

## Rules for a module

- Touch only your module directory (and, for the harness, `test/harness/` in B1).
- Register through `ctx.onFrame`, `ctx.events.on`, `ctx.http.route`; never import
  another module.
- Write order is a property of slot order in `server.ts`: store → ack → queue → push.
- Open decisions stay open in code: one server, no service discovery; `reply_to` is an
  id only (roadmap A3).

## Scenarios

Filled in by B8.
