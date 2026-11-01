# ADR: Presence delivery and freshness

Date: 2026-11-01
Status: Accepted, amended 2026-11-01 after the prototype (B6, S5, S1; design §7.4, §7.5)
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
  **Met** (S5): watch batched per 500 ms and answered with the current state; offline
  seen at ≈ t+15–16 s with `last_seen = t`; a reconnect inside the debounce publishes
  nothing; 60 s of pongs write no lease.

## Amendments (2026-11-01, from the prototype)

- `last_seen` is the drop time: the last pong from the user's last device, not the
  moment the debounce fired.
- The lease renewal runs only while at least one user is online on the server.
- A watcher that subscribes during `pending-offline` is told `online` and still
  receives the `offline` that may follow; the 500 ms batching can shift a transition but
  never lose one.
- **The "never shown" claim is narrower than written.** "A drop-and-reconnect under 5 s
  is debounced and never shown" holds for clean closes and app restarts. For a half-open
  drop, the client cannot reconnect before ≈ t+16 s (15 s mirror rule plus backoff) and
  the debounce fires at t+15–16 s, so the watcher sees offline then online however short
  the outage was. **Open, for the author** (design §7.4): the relation the debounce, the
  mirror rule and the first backoff must keep.
- Revisit for Discord-style communities, where a channel member list is such a screen.
