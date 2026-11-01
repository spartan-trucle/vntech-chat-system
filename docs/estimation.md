# Estimation — The Chat System

Back-of-the-envelope numbers derived from the assumptions in
[`specification.md`](specification.md) §3. Every figure here is meant to change a
decision; the last section says which ones did. Round numbers on purpose.

## 0. Inputs

| Input | Value | Source |
|-------|-------|--------|
| Daily active users | 50 M | spec |
| Messages per user per day | 40 | spec |
| Peak / average | 5× | spec |
| Concurrent users at peak | 10 M | spec |
| Devices per user | 1.5 avg, 5 max | spec |
| Message text + metadata | 200 B | spec |
| Messages carrying media | 10 % | spec |
| Media size | 2 MB avg, 10 MB cap | spec |
| Group size | median 5, max 100 | spec |
| Traffic mix | 60 % of messages in 1:1 chats, 40 % in groups averaging 8 members | **assumed here**; the spec gives only the median group size |
| Conversations per user | 50 total, 10 active in any month | **assumed here** |
| Sync-queue row | 50 B (IDs only) | design §4.2 |
| Retention | forever; 5 years used for sizing | spec |

## 1. Messages

```
messages/day     = 50 M × 40                 = 2.0 B
average QPS      = 2.0 B / 86 400            ≈ 23 k writes/s
peak QPS         = 23 k × 5                  ≈ 115 k writes/s
```

**Recipient devices per message** (the number everything downstream multiplies by):

```
1:1 message   → 1 recipient
group message → 8 − 1 = 7 recipients
avg recipients = 0.6 × 1 + 0.4 × 7           = 3.4 users
× 1.5 devices                                 = 5.1 devices
+ sender's other devices (1.5 − 1)            = 0.5
avg deliveries per message                    ≈ 5.6  → call it 6
```

The 100-member group is the worst case (150 deliveries), not the typical case. Fan-out
on write is sized by the average, backpressure by the worst case.

```
deliveries/day   = 2.0 B × 6                 = 12 B
average          ≈ 140 k pushes/s
peak             ≈ 700 k pushes/s
```

## 2. Connections and the real-time fleet

```
peak connections        = 10 M users × 1.5 devices        = 15 M sockets
per chat server         = 100 k (conservative for Netty/BEAM)
chat servers needed     = 150, run 200 for headroom and node loss
memory per socket       ≈ 20 KB (buffers + TLS state)       → 2 GB per server for sockets alone
```

Heartbeat (design §1.3): ping every 5 s, 15 M sockets.

```
frames/s fleet          = 15 M / 5 s                        = 3 M each way
frames/s per server     = 100 k / 5 s                       = 20 k each way
bytes on the wire       ≈ 100 B per frame incl. TCP/TLS     → 2 MB/s per server, 300 MB/s fleet
```

Negligible per node. The cost that would matter is a Redis write per pong, which the
design forbids.

Presence lease (design §1.5, §5.5): each server renews its users' keys every 2 min.

```
key writes/s per server = 100 k / 120 s                     ≈ 0.8 k
key writes/s fleet      = 15 M / 120 s                      = 125 k   (pipelined, in 200 batches)
```

An earlier draft had this at 500 k/s with a 30 s renewal and called it the reason to
relax F7. That was wrong: detection is local to the chat server and never touches
Redis, and a dead server's users are marked offline by service discovery, so the lease
is only a safety net and can be slow. The 10 s target costs ping frames, nothing more.

Routing table: `route:{user}:{device} → server`

```
entries                 = 15 M
size                    ≈ 100 B each                        = 1.5 GB
```

Fits one Redis node; replicated for availability.

Real-time bandwidth:

```
inbound  peak           = 115 k msg/s × 300 B frame         ≈ 35 MB/s fleet
outbound peak           = 700 k push/s × 300 B              ≈ 210 MB/s fleet, ~1 MB/s per server
```

Trivial. Media bytes must not be added to this (next section).

## 3. Storage

### 3.1 Message text and metadata

```
per day                 = 2.0 B × 200 B                     = 400 GB
per year                = 146 TB
5 years                 = 730 TB raw
replication factor 3    = 2.2 PB on disk
```

With Cassandra and ~4 TB usable per node, that is **~550 nodes for storage alone**,
while write throughput (115 k/s peak) needs perhaps 15. The cluster is storage-bound by
a factor of 30. Two consequences: text compresses 3 to 4× with LZ4 or Zstd at the
SSTable level, so plan for ~600 TB on disk, not 2.2 PB; and tiering (design §2.5) is
not optional, partitions older than a year belong on cheaper disks.

### 3.2 Media

```
media/day               = 2.0 B × 10 %                      = 200 M objects
bytes/day               = 200 M × 2 MB                      = 400 TB
per year                = 146 PB
5 years                 = 730 PB
```

**A thousand times the text volume.** The media store is the largest system in this
design by a wide margin, and the object storage bill dwarfs everything else combined.
Two things to challenge before accepting this: the 2 MB average (WhatsApp compresses
images to ~100 KB; the spec forbids that, so the number stands unless the spec changes),
and the 10 % media rate. Either one halving halves the dominant cost.

Media bandwidth:

```
upload   avg            = 400 TB / 86 400 s                 ≈ 4.6 GB/s, peak ≈ 23 GB/s
download avg            = 400 TB × ~5 fetching devices      ≈ 2 PB/day ≈ 23 GB/s, peak ≈ 115 GB/s
```

The download number settles the CDN question for groups: a 10 MB video to 150 devices is
1.5 GB per send, and a CDN edge serving it once from origin is the only way the origin
bucket survives. For 1:1 chats the CDN adds nothing, so **regional buckets with a CDN in
front for group media** is the shape to design for.

### 3.3 Sync queue (design §4)

```
appends/day             = 12 B (one per delivery)
appends/s avg           ≈ 140 k, peak ≈ 700 k
bytes/day               = 12 B × 50 B                       = 600 GB
live data (30-day TTL)  = 18 TB raw, 54 TB with RF 3
```

The queue's write rate is **six times the message store's** and its live data is small.
That shape, high write rate, tiny rows, time-bounded, is the input to the backing
decision. In Cassandra the TTL expiry means tombstones at 12 B rows a day, which is the
classic queue-in-Cassandra failure unless the daily bucket partitions are dropped whole.
Redis Streams at 54 TB is too big for memory. Kafka at 700 k small appends/s is routine
and retention by time is native, but per-device consumers at 15 M devices is not how
Kafka is used. This decision needs its own argument; the number is now on the table.

### 3.4 Receipts and cursors (design §3)

```
read-cursor rows        = users × conversations             = 50 M × 50 = 2.5 B rows, ~100 B each = 250 GB
delivery-cursor rows    = devices × conversations           = 3.75 B rows, ~375 GB
receipt writes          ≈ 25 % of deliveries after coalescing  = 3 B/day ≈ 35 k/s avg, 175 k/s peak
```

Small storage, moderate writes, all to tiny partitions. No decision changes.

### 3.5 Conversation summary (design §4.3)

```
active conversations    = 50 M users × 10 active / 2.5 avg members ≈ 200 M
summary row             ≈ 150 B                              → 30 GB in Redis
```

Too large to keep every conversation in Redis forever. Keep summaries for conversations
active in the last 30 days in Redis (30 GB, a modest cluster) and fall back to the
message store for the rest. **This changes design §4.3**, which assumed Redis held all
summaries.

## 4. What these numbers changed

| Finding | Decision it touches |
|---------|---------------------|
| Average deliveries per message is ~6, not 75 | design §4.5 corrected; fan-out on write is comfortably affordable at the average, backpressure is sized by the 150-device worst case |
| Sync queue writes at 700 k/s peak, 54 TB live, time-bounded | the backing-store argument now has its input; Cassandra-with-TTL is at risk from tombstones |
| Presence lease was 500 k Redis writes/s only because it was coupled to detection | decoupled: lease every 2 min (125 k/s), detection stays local, F7 keeps 10 s; presence delivered by subscription, not to all contacts (design §5) |
| Message store is storage-bound 30:1 | compression and tiering move from "nice to have" to required |
| Media is 1000× text and 23 GB/s download average | regional buckets, CDN for group media only; the 2 MB average is the single most expensive assumption in the spec |
| Conversation summaries do not all fit in Redis | design §4.3: Redis for 30-day-active conversations, store for the rest |
