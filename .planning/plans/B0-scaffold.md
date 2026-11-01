# Plan B0 · Scaffold and protocol contract

Epic text: `.planning/roadmap.md` §3 B0 (approved plan). Runtime: `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md`.

## Files

- `prototype/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` (scope guard first paragraph)
- `prototype/src/protocol.ts` — frame unions client→server (`hello`, `msg`, `ack`, `receipt`, `watch`, `unwatch`) and server→client (`hello_ack`, `msg_ack`, `deliver`, `receipt`, `presence`, `error`), `encodeFrame` / `decodeFrame` with validation
- `prototype/src/ids.ts` — Snowflake 41/10/12, `compareIds`, `bucketOf`
- `prototype/src/ports/` — `MessageStore`, `SyncQueue`, `RouteTable`, `PresenceStore`, `Summaries` (roadmap) plus `Conversations`, `Cursors`, `Devices` (needed by B2/B4/B5 at once; added here so no wave-2 epic edits another module); `InMemory*` for each
- `prototype/src/server.ts` — composition root: http + ws listener, connection table (§1.5), `hello` handshake (identity, device registry, route, `hello_ack`, phases handshake → replay → live), frame dispatch, typed event bus, http router, trace; seven registration slots in write order
- `prototype/src/{connection,messaging,sync,history,receipts,presence,media}/index.ts` — empty `register*` slots
- `prototype/src/trace.ts`, `src/fixtures.ts` — hop-trace format and the page's identities (A1 Truc·phone, A2 Truc·laptop, B1 Khanh·phone; c1, c2, c3)
- `prototype/test/harness/ScriptedClient.ts` — connect, hello with stored cursor, send, expect, replay script, `suppressPongs`, `blackhole` (radio off, socket stays open), `destroyWithoutClose` (1006), trace
- `prototype/test/ports/contracts/*.contract.ts` — one reusable contract per port; `test/ports/InMemory.test.ts` runs all
- `prototype/test/scenarios/run.ts` — `npm run scenarios` table, empty until B8

## Steps (TDD, each red → green)

1. ids and protocol tests → implementations
2. port contract tests → in-memory adapters
3. server core tests (hello, dispatch, events, close/kill/replace, http, trace, seed) → `server.ts`
4. harness tests (pong suppression, blackhole, destroy, replay, fixtures) → `ScriptedClient`
5. README, scenarios stub, three green runs, commit

## Test strategy

`npm test` = vitest over `test/**/*.test.ts`; `npm run typecheck` = `tsc --noEmit`. Real sockets on port 0, no mocks; timing-based assertions use generous windows (300 ms) and were run three times.

## Risks

- `ws` auto-pong hides the server's detection path → harness opens sockets with `autoPong: false` and answers pings itself.
- Two modules editing `server.ts` → every hook is an event or a slot; modules never import each other.
- Open decisions leaking → one server id; `reply_to` is an id with a comment pointing at roadmap A3.
