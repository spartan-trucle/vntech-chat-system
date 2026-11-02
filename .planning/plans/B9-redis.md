# Plan B9 · Real Redis behind the ports

Epic text: `.planning/roadmap.md` §3 B9 (optional, approved). Design: `docs/design.md` §4.2 (the three Streams commands), §1.5 (route keys, presence lease), §5.3 (`pres:{user}`). ADR: `.memory/decisions/2026-11-01-sync-queue-redis-streams.md` — its "three operations map one-to-one onto Redis commands" is the claim under test.

Scope guard unchanged: one chat server process. Redis replaces three in-memory adapters (`SyncQueue`, `RouteTable`, `PresenceStore`) and the presence bus; the message store, summaries, conversations, cursors and devices stay in memory by decision. No Cassandra.

## Files

- `prototype/docker-compose.yml` — `redis:7-alpine` on host port 6399, `--save "" --appendonly no`, healthcheck `redis-cli ping`.
- `prototype/package.json` — `ioredis` dependency; scripts `test:redis` (`REDIS_URL=redis://127.0.0.1:6399 vitest run test/redis`), `redis:up` (`docker compose up -d --wait`), `redis:down` (`docker compose down`).
- `prototype/src/redis/client.ts` — `createRedisClient({url?})` (default `REDIS_URL`, then `redis://127.0.0.1:6399`), `keyOf(prefix, name)`, `flushPrefix(redis, prefix)` (SCAN MATCH `prefix*` + UNLINK; the only cleanup tests use).
- `prototype/src/redis/RedisSyncQueue.ts` — `sq:{device}`: `XADD … MAXLEN ~ <maxLen> <id> m <m> c <c>`, `XRANGE … (<after> + COUNT <n>` (`-` for null), `XTRIM … MINID <minId>` (returns the count), `first` = `XRANGE - + COUNT 1`. `XADD` with an id at or below the top entry is rejected by Redis; the adapter treats it as an idempotent retry only when the id already exists (`XRANGE id id`), otherwise it surfaces the Redis error with the key in the message.
- `prototype/src/redis/RedisRouteTable.ts` — `route:{user}:{device}` string + `routes:{user}` set; `set`/`delete` in one MULTI; `devicesOf` = SMEMBERS.
- `prototype/src/redis/RedisPresenceStore.ts` — `presence:{user}` JSON with `SET … PX <ttlMs>`; `get` undefined once expired (Redis's own clock).
- `prototype/src/redis/RedisPresenceBus.ts` — `PUBLISH pres:{user}` on the shared client; `SUBSCRIBE`/`UNSUBSCRIBE` on a duplicated subscriber connection; `subscribe` returns `off`, which unsubscribes when the last local handler of that user is gone; `publish` waits for pending (un)subscribes first so a subscribe-then-publish in one process is ordered. Instrumentation `settled()`: resolves once every message this instance published to a channel it is itself subscribed to has come back (the Redis equivalent of the in-memory bus's synchronous delivery).
- `prototype/src/redis/index.ts` — exports + `createRedisPorts({url?, prefix?})` → `{ syncQueue, routes, presence, redis, close() }`.
- `prototype/test/redis/support.ts` — skip rule (`REDIS_URL` unset → whole file skipped with one printed line), per-file random prefix, `flushPrefix` in `afterAll`.
- `prototype/test/redis/{syncQueue,routeTable,presenceStore,presenceBus}.test.ts` — the B0/B6 contracts against the Redis adapters, plus Redis-only facts (`MAXLEN ~` evicts once a node fills; the top-id error text).
- `prototype/test/redis/e2e.test.ts` — the real server over `createRedisPorts` + `RedisPresenceBus`: S2's core (Khanh offline, Truc sends 3 across c1/c2, reconnect with cursor → exactly those 3 in order, trace shows `XRANGE sq:B1`), the ack-wait race (a message sent while the device is in `replay` waiting on an ack arrives exactly once), the empty-XRANGE window race (held reply), and presence over the Redis bus.
- Contract parametrisation (minimal, in-memory run identical): `presenceStore.contract.ts` gets an awaitable `advance` and fixture-supplied lease numbers (defaults are today's literal numbers); `presenceBus.contract.ts` gets an optional `settle` hook awaited after each publish; `syncQueue.contract.ts` gets an optional `failing` map (case name → reason) that turns a named case into `test.fails` with the reason in its name.
- `prototype/README.md` — "Real Redis (B9)" section.

## Steps (TDD: each contract watched red against a missing adapter, then green; `npm test`, `npm run typecheck`, `npm run test:redis` green before every commit)

1. Plan file. Commit `docs(proto): B9 plan for real Redis behind the ports`.
2. Compose, `ioredis`, scripts, `client.ts`, test support. Commit `chore(proto): redis 7 compose on 6399, ioredis client and the test:redis scripts`.
3. SyncQueue contract against Redis (red: module missing) → `RedisSyncQueue`. Expected divergences recorded as `test.fails` with reason: out-of-order `XADD`, exact `MAXLEN`. Commit `feat(proto): RedisSyncQueue over XADD MAXLEN ~, XRANGE and XTRIM MINID with the B0 contract`.
4. RouteTable contract → `RedisRouteTable`. Commit `feat(proto): RedisRouteTable with route:{user}:{device} and the routes:{user} set`.
5. PresenceStore contract with real sleeps and small leases → `RedisPresenceStore`. Commit `feat(proto): RedisPresenceStore with SET PX leases on Redis's clock`.
6. PresenceBus contract with `settle` → `RedisPresenceBus`. Commit `feat(proto): RedisPresenceBus over PUBLISH/SUBSCRIBE pres:{user}`.
7. `createRedisPorts` + e2e. Commit `test(proto): S2 core, replay races and presence over real Redis end to end`.
8. README. Commit `docs(proto): Real Redis (B9) section`.
9. `npm run test:redis` ×3, `docker compose down`, report.

## Risks

- `XADD` with an id ≤ top is an error in Redis 7: the in-memory adapter sorts on insert, Redis refuses. Fan-out order per stream becomes an invariant the pipeline must guarantee (C2 input).
- `MAXLEN ~` is approximate (whole radix nodes, ~100 entries): the cap is a floor, not an exact length.
- Pub/sub delivery is asynchronous: a contract written for a synchronous bus needs a settle point; `publish` must not pretend otherwise.
- Replay's last empty `XRANGE` is a real round trip now: a message appended in that window may be skipped by the live push (`phase === 'replay'`) and missed by the replay. Written as a `test.fails` if real; `src/sync/**` and `src/messaging/**` are not touched.
