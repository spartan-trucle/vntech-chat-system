# ADR: Sync queue backing and cursor ownership

Date: 2026-11-01
Status: Accepted, amended 2026-11-01 after the prototype (B3, S2; design §7.3)
Author: Truc Le

## Context

The per-device sync queue (design §4) replays missed messages on reconnect. Estimation
put its write rate at 700 k appends/s peak with 50-byte entries. The backing store depends
on the retention window: 30 days is 54 TB live and forces Cassandra or Kafka; the author
set the product requirement that the fast path serves 24 hours of offline and devices
away longer load from the persistent store.

## Decision

Redis Streams, one stream per device, 24-hour retention trimmed hourly, entries carry
message ID and conversation ID only. Live data ~1.8 TB with replication on a cluster of
roughly ten nodes.

Cursors: the device owns and sends its sync cursor; the server never stores it. The read
cursor per user per conversation is server-owned, durable in Cassandra, cached in Redis.
Kafka is not a cursor store. Losing any cursor must cause more replay, never less; a
cursor advances only on device ack.

## Alternatives Considered

- **Cassandra table with TTL:** 12 B expiring rows a day is the tombstone failure mode;
  survivable with daily partitions under TimeWindowCompaction, excessive care for a
  one-day fast path.
- **Kafka, partition per user:** write rate is trivial for it, but 15 M per-device
  consumers at arbitrary offsets is not its model and it cannot hold our cursors.
- **30-day window on any store:** pays 54 TB to serve the few reconnects the slow path
  already handles correctly.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| Redis shard lost with replica: its devices all take the slow path at once | Slow path rate-limited per chat server; message store sized for it as a latency event |
| A device in very many busy groups overflows its stream | `MAXLEN ~ 100000`; overflow takes the slow path |
| Device cursor is trusted, a buggy client could skip messages | Only that client is affected; server-side dedup still protects duplicates |

## Consequences

**Positive:** the queue's three operations map one-to-one onto Redis Streams commands;
no new infrastructure beyond the Redis already in the design.
**Negative:** a 24 h window is a product promise that must be kept visible; extending it
costs ~600 GB of memory per day before replication.
**Neutral:** the message store remains the only source of truth.

## Conditions

- Slow path (summary + load on open) is implemented and rate-limited before the queue is
  relied on in the prototype. **Met**: B4's token bucket landed before B3, verified in
  B3's plan.
- The 24 h window is stated in the spec's non-functional requirements.

## Amendments (2026-11-01, from the prototype)

- **Four operations, not three.** Deciding that a stream was trimmed past a device's
  cursor needs the oldest retained id (`XINFO STREAM`, first entry); `XADD`, `XRANGE`
  and `XTRIM` cannot answer it. The "map one-to-one onto Redis commands" claim holds for
  four commands. `MAXLEN` eviction must feed the same signal.
- **The slow-path rule.** "Cursor below the oldest retained id" is not decidable on its
  own (an idle device and a never-appended stream look alike). The rule that works: the
  device takes the slow path when its cursor is below the last trim boundary that
  actually dropped entries from its stream. It errs towards more replay, as §4.7 requires.
- **Replay beside the frame chain.** The ack of a batch arrives on the socket that sent
  the `hello`; the server must keep handling that connection's frames while the replay
  waits, or it deadlocks (design §4.4, amended).
- **Open, for the author.** Nothing marks a batch end on the wire (`batch_end` flag or
  `replay_done` frame, design §7.3); and with real Redis one more `XRANGE` after the
  switch to live is needed to close the append-after-empty-read window (B9).
