# ADR: Presence delivery and freshness

Date: 2026-11-01
Status: Accepted
Author: Truc Le

## Context

F7 requires an online indicator with a 10 s freshness target. An estimation draft tied a
500 k/s Redis lease cost to that target and suggested relaxing it to 30 s. On examination
the coupling was false: disconnect detection is local to the chat server and the Redis
lease only covers a dead chat server, which service discovery already handles. The real
cost of presence is propagation to other users.

## Decision

- Presence is delivered by **subscription**: a device receives state only for users on
  its screen (open chat, visible list rows), and unsubscribes on leaving.
- Detection stays at 10 s (ping every 5 s, two misses). Propagation to watchers is
  bounded, not instant: within 15 s normally, 30 s worst case; a drop-and-reconnect under
  5 s is debounced and never shown.
- The Redis presence lease renews every 2 min with a 5 min TTL; it is a safety net
  behind service discovery's mark-all-offline on node loss, not the primary mechanism.
- Cross-server fan-out uses one pub/sub channel per watched user, joined only by servers
  that currently have a watcher.

## Alternatives Considered

- **Push every transition to all online contacts:** 50 pushes per flap per user under
  constant mobile flapping, for a contact screen the product does not have.
- **Pull on open only:** the dot would never change while a chat is open.
- **Relax F7 to 30 s:** would have saved nothing once the lease was decoupled.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A very popular user watched by hundreds | pub/sub once per server, local fan-out; bounded by watchers, not contacts |
| Watchers see a user online up to 30 s after they dropped in the worst case | accepted by the author as a bounded error |
| Subscription churn when scrolling a long list | client batches watch/unwatch per 500 ms |

## Consequences

**Positive:** presence cost is proportional to screens, not to social graph size; F7 is
kept at 10 s detection for free.
**Negative:** any future "who is online" directory screen needs a different mechanism.
**Neutral:** the state machine gains a pending-offline debounce state.

## Conditions

- The prototype's scripted client exercises watch/unwatch and the debounce window.
- Revisit for Discord-style communities, where a channel member list is such a screen.
