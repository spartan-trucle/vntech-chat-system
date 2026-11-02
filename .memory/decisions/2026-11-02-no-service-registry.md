# ADR: No service registry; load balancer for connection, lease for cleanup

Date: 2026-11-02
Status: Accepted
Author: Truc Le

## Context

The board carried "service discovery" as the last open layer. Design §1.4 had the client
call `GET /chat-servers` for the "least-loaded healthy node", and §1.5 had "the
service-discovery layer" watch chat-server liveness and run `mark-all-offline(server_id)`
within seconds of a node loss. Candidates were etcd, Consul and the orchestrator. The
rubric (docs/rubric.md, A3 item 1) scored this as the gap behind two failing rows.

The debate separated the two jobs hidden under one name and challenged each.

## Decision

- **No registry.** Nothing in the design needs one.
- **Choosing a chat server:** a plain load balancer with an application-level health
  check (the node accepts a socket and answers `hello`) and random assignment. The
  "least-loaded" requirement is dropped: no number in estimation.md shows load skew
  across 200 nodes to be a problem, and the jittered 30 s reconnect backoff already
  prevents a thundering herd onto one node. `GET /chat-servers` is a static endpoint or
  disappears behind the balancer's address.
- **Cleanup after a chat-server death:** nobody runs `mark-all-offline`. Routing heals
  from the client side: a device on the dead node reconnects within 15 s by the mirror
  rule (§1.4) and overwrites its route on the new node; a push to the dead node fails
  within the bounded buffer's timeout and the message stays in the device's stream.
  Presence is cleaned by the existing Redis lease (§1.5, §5.5): renewed every 2 min,
  5 min TTL, ~125 k writes/s fleet-wide. The lease's numbers do not change.

## Alternatives Considered

- **etcd / Consul / orchestrator registry answering "least-loaded":** solves a load-skew
  problem no estimate shows; rejected for lack of a problem.
- **A liveness watcher running `mark-all-offline(server_id)` within seconds:** the only
  state it corrects that the client does not is presence for a device that lost its
  server and its network at the same moment; rejected as a component for a coincidence.
- **Lease TTL of 30 s to shrink that window:** TTL must exceed the renewal interval, so
  30 s forces renewal every ~10 s, 1.5 M Redis writes/s, three times the 500 k/s the
  presence ADR rejected when it decoupled the lease from detection. Rejected.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A device that loses its server and its network together shows online for up to 5 min | accepted; the window equals the lease TTL; a bounded presence error on a rare coincidence |
| A push to a dead node is held until the bounded buffer's timeout | the message is already in the device's stream (write order store → ack → queue); the device replays after reconnect |
| Random assignment skews load by a few percent | accepted at 100 k sockets per node; revisit only with measured skew |

## Consequences

**Positive:** one component fewer; §1.4, §1.5 and §5.3 lose their dependency on an
undecided layer; rubric rows 7 and 8 lose this gap; flows 2 and 5 lose their open note.
**Negative:** the presence error window on a node loss is the lease TTL, 5 min, not
seconds; the design must say so where §1.5 promised "within seconds".
**Neutral:** the orchestrator still replaces dead nodes; that is infrastructure, not the
chat design.

## Conditions

- The balancer's health check is application-level (socket accepted and `hello`
  answered), not TCP only, so a hung node leaves the pool.
- The bounded buffer's timeout for an unresponsive destination is shorter than the N1
  p99 budget; otherwise one dead node raises p99 for every sender fanning out to it.
- Design §1.4, §1.5 and §5.3 are rewritten to this decision; tradeoffs.md 5.2.2 and
  5.8.1 get their chosen / rejected rows; flows 2 and 5 drop the open note.
