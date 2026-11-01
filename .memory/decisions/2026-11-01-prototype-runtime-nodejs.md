# ADR: Prototype runtime for the chat server

Date: 2026-11-01
Status: Accepted; conditions met 2026-11-01 (design §7)
Author: Truc Le

## Context

The chat-system design practice (docs/design.md) will produce a prototype chat server
whose job is to prove the heartbeat, reconnect and sync-queue replay protocol (design §1
and §4) is correct. Connection count per node, memory and CPU are explicitly not goals of
the prototype. Candidates were narrowed by the author to Kotlin (the team's production
stack) and Node.js. The selection criterion stated by the author: fastest path to a
working prototype.

## Decision

**Node.js with TypeScript, using the `ws` library**, for the prototype chat server and a
scripted multi-device client.

Why it is the fastest: `ws` exposes protocol-level ping/pong and the `pong` event
directly, which is exactly the server-initiated heartbeat in design §1.2; one process,
one file, no build pipeline beyond `tsx`; the sibling repo vntech-load-balancer already
uses Node + TypeScript for its demo, so the pattern and tooling are known.

## Alternatives Considered

- **Kotlin on Netty / Ktor:** the production stack, so a prototype here would transfer
  to real work. Rejected for this prototype because the framework setup costs half a day
  before the first line of protocol logic, and the prototype's goal is protocol
  correctness, not a reusable service.
- **Elixir / BEAM:** the canonical runtime for this problem and the richest lesson about
  connection handling. Rejected because the prototype does not test connection count,
  and the author narrowed the choice to Kotlin or Node.js.
- **Go:** not in the author's shortlist.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| The prototype turns into the product | It lives under `prototype/` with a README that states its scope; the production runtime is a separate decision when there is a product. |
| Single-threaded Node gives no transferable lesson on connections per node | Out of scope by the stated goal; if that question becomes real, a second prototype in Kotlin or BEAM is the honest way to answer it. |
| Protocol bugs hidden by `ws` conveniences (automatic pong) | The scripted client must be able to suppress pongs and drop sockets uncleanly to exercise the server's detection path. |

## Consequences

**Positive:** a running heartbeat, reconnect and replay loop within a day; easy to script
multi-device clients and chaos (half-open sockets, lost acks, duplicate sends).
**Negative:** none of the prototype code is reusable in the Kotlin stack; numbers about
memory per socket will not be representative.
**Neutral:** the design documents stay runtime-agnostic, as the canonical frame intended.

## Conditions

- The prototype proves, with scripted clients, the four scenarios in design §1.4 and §4.4:
  unclean drop detected within 10 s, reconnect with cursor replays exactly the missed
  messages, duplicate send is deduplicated by client message ID, chat list renders from
  the summary before the replay finishes.
- Production runtime is re-decided separately if the exercise ever moves past practice.

## Outcome (2026-11-01)

Built under `prototype/` in one day of parallel agent lanes: eight in-memory ports with
contract tests, seven modules behind one composition root, a scripted client that can
suppress pongs, blackhole its radio and drop sockets uncleanly. The four scenarios above
plus presence (S5) and media (S6) pass as scripted runs over the real server, on fake time
with the design's numbers and (S1, S5) on real timers; 258 tests. Two core changes were
needed after the scaffold, both test-first: a veto hook before the store write, and the
replay running beside the connection's frame chain (design §4.4). What the build changed
in the design is in `docs/design.md` §7. The "prototype turns into the product" risk did
not materialise: no auth, no persistence, one process, open decisions left open in code.
