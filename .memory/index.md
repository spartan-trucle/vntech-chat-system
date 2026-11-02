# Memory index — vntech-chat-system

## Decisions
- [2026-11-01] Media: server never processes bytes, client compresses, regional buckets, CDN for groups → `.memory/decisions/2026-11-01-media-no-server-processing.md`
- [2026-11-01] Presence by subscription, 10 s detection, bounded propagation, decoupled lease → `.memory/decisions/2026-11-01-presence-subscription.md` (amended after the prototype: `last_seen` is the drop time, lease only while someone is online; open: debounce versus the client's reconnect)
- [2026-11-01] Sync queue on Redis Streams, 24 h window; cursor ownership → `.memory/decisions/2026-11-01-sync-queue-redis-streams.md` (amended after the prototype: four operations, trim-boundary slow-path rule, replay beside the frame chain; open: batch-end marker)
- [2026-11-02] Replay-to-live handoff and per-stream append order: subscribe live before replay, client sorts and dedups by message_id, `XADD *` with a tail read on the retry path → `.memory/decisions/2026-11-02-live-first-replay-xadd-auto-id.md`
- [2026-11-02] Store replica loss: writes LOCAL_QUORUM with one retry at ONE; dedup at two layers (QUORUM index read that fails open, client dedup by client_msg_id); N2 statement → `.memory/decisions/2026-11-02-store-quorum-fallback-one.md`
- [2026-11-02] Reply quoting resolved by ID, no excerpt copied; the page API returns referenced parents in one batch → `.memory/decisions/2026-11-02-reply-quote-by-id.md`
- [2026-11-02] No service registry: load balancer with app-level health check picks the chat server; the 5 min lease is the only cleanup on node loss → `.memory/decisions/2026-11-02-no-service-registry.md`
- [2026-11-01] Prototype runtime for the chat server: Node.js + TypeScript → `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md` (conditions met: S1–S6 pass, 258 tests)

## What the prototype changed (2026-11-01)
- `docs/design.md` §7: eighteen findings from the build, six written back into §1.2, §3.6, §4.4, §5.2, §5.4 and the sync-queue ADR; five questions for the author (batch end on replay, delivery cursor on ack, debounce versus reconnect timing, replay-to-live handoff, per-stream append ordering). Board section "What the prototype changed" on `docs/index.html`.
- [2026-11-02] §7.9 added after B9 (real Redis): append order per stream is an invariant, `MAXLEN ~` is a floor, the replay-to-live window is real under I/O; sync-queue ADR amended a second time.

Design decisions made in the discussion are recorded in `docs/design.md` and on the
"Arguments" section of `docs/index.html`; the ADR folder holds the ones that have a
verdict format.
