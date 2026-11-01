# Memory index — vntech-chat-system

## Decisions
- [2026-11-01] Media: server never processes bytes, client compresses, regional buckets, CDN for groups → `.memory/decisions/2026-11-01-media-no-server-processing.md`
- [2026-11-01] Presence by subscription, 10 s detection, bounded propagation, decoupled lease → `.memory/decisions/2026-11-01-presence-subscription.md`
- [2026-11-01] Sync queue on Redis Streams, 24 h window; cursor ownership → `.memory/decisions/2026-11-01-sync-queue-redis-streams.md`
- [2026-11-01] Prototype runtime for the chat server: Node.js + TypeScript → `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md`

Design decisions made in the discussion are recorded in `docs/design.md` and on the
"Arguments" section of `docs/index.html`; the ADR folder holds the ones that have a
verdict format.
