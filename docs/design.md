# Design — The Chat System

Decisions made while working through [`specification.md`](specification.md). Each section
states the decision, the numbers it was made against, and the alternative it rejected.
The discussion page [`index.html`](index.html) tracks which layers are still open.

Frame (decided 2026-11-01): **the canonical architecture** from Alex Xu, *System Design
Interview* ch. 12 — stateless API servers, stateful chat servers over WebSocket, a presence
service, a wide-column message store, a per-user message sync queue, Snowflake IDs, push
notifications. Implementation language is still open.

---

## 1. Connection keep-alive, disconnect detection and reconnect

### 1.1 What the heartbeat has to do

Three different jobs, often conflated:

| Job | Who needs the answer | How fast |
|-----|----------------------|----------|
| Keep NATs, load balancers and mobile carriers from dropping an idle socket | the connection | before the idle timeout (typically 60–300 s) |
| Detect an **unclean** drop (radio loss, laptop lid closed, crashed app) so the server can mark the user offline | presence (F7) and routing | within **10 s** (F7) |
| Let the **client** notice a half-open socket and reconnect | delivery (F3, F4) | a few seconds; the user is staring at "sending…" |

A clean close (`FIN`/close frame) is detected immediately by both sides; the heartbeat
exists for the unclean case only.

### 1.2 Decision

**Server-initiated WebSocket ping frames every 5 s. Two consecutive missed pongs mark
the connection dead (≈ 10 s). The client runs the mirror rule: no ping seen for 15 s
means the socket is half-open, close it and reconnect.**

Why server-initiated and protocol-level (opcode `0x9`/`0xA`) rather than an application
JSON message from the client:

- Browsers cannot send ping frames but answer them automatically; the web client needs
  zero code for the keep-alive job.
- Pong is handled in the transport layer on the server (Netty / BEAM / Go all surface it
  as an event), so the heartbeat cannot be starved by application-level backpressure.
- The server owns the clock, so detection latency is uniform across client platforms.

Mobile clients additionally send one application-level `{"t":"hello"}` on connect
carrying the device cursor (§1.4) and app state (`foreground` / `background`), because
the OS will kill the socket in background anyway and presence should show *away*, not a
10-second-stale *online*.

### 1.3 Interval against load and the F7 target

Detection latency for an unclean drop is `interval × misses`. Overhead is one 2–6-byte
frame each way per connection per interval.

| Ping interval | Misses | Worst-case detection | Frames/s per 100 k-conn server | Fleet frames/s at 10 M |
|---------------|--------|----------------------|-------------------------------|------------------------|
| 30 s | 2 | 60 s | 3.3 k | 333 k |
| 15 s | 2 | 30 s | 6.7 k | 667 k |
| **5 s** | **2** | **10 s** | **20 k** | **2 M** |
| 3 s | 2 | 6 s | 33 k | 3.3 M |

20 k tiny frames per second per server is well inside what one Netty or BEAM node does
without noticing; it is *not* the cost that matters. The cost that matters is what the
server does **on each pong**, which is why §1.5 forbids touching Redis on the heartbeat
path.

**Trade-off stated:** the 5 s interval exists only because F7 says 10 s. If product
accepts "offline within 30 s", the interval becomes 15 s and fleet heartbeat traffic drops
3×. This is the single cheapest lever on the page and should be re-asked before launch.

### 1.4 Reconnect

Client state machine:

```
connected ──(no ping 15 s | close | error)──▶ reconnecting ──(open + hello/ack)──▶ connected
     ▲                                              │
     └────────── backoff: 1 s · 2 s · 4 s … 30 s cap, ±30 % jitter ───────────────┘
```

- **Backoff with jitter** so a chat-server crash (100 k clients at once) does not
  thunder-herd the survivors. 100 k clients spread over a 30 s window is ~3 k connects/s,
  which the API layer absorbs.
- **The client never waits for the heartbeat to send.** Outgoing messages are written to
  the local outbox with a client-generated `client_msg_id` (UUID) and flushed on
  reconnect. The server dedups on `(sender_id, client_msg_id)` for 24 h, so a message that
  was stored but whose ack was lost is not stored twice.
- **Resume, not restart.** The `hello` frame carries the device's `last_synced_message_id`
  cursor; the server replays everything newer from the message sync queue before
  delivering live traffic. No separate "fetch what I missed" round trip.
- **Which server to reconnect to** is the API layer's problem: `GET /chat-servers`
  returns the least-loaded healthy node (service discovery, still open on the board).
  The client does not reconnect to the host it came from.

### 1.5 Server side: who is disconnected, and what happens then

Per connection the chat server keeps, in process memory only:

```
conn_id → { user_id, device_id, last_pong_at, app_state }
```

A sweeper runs every 1 s over the local table and closes any connection with
`now − last_pong_at > 10 s`. On a dead connection, in order:

1. Remove the local entry.
2. Delete the routing key `route:{user_id}:{device_id} → server_id` in Redis.
3. If that was the user's last device anywhere (`SCARD route:{user_id}` → 0), write
   `presence:{user_id} = offline, last_seen=now` and publish on the presence channel.
   If other devices remain, presence does not change.

**Heartbeat traffic never writes to Redis.** Pongs update `last_pong_at` in memory only.
Presence in Redis is a *lease*: the chat server renews every one of its users' keys with a
60 s TTL once every 30 s, in one pipelined batch per server (100 k keys per batch, every
30 s, ≈ 3.3 k key writes/s per server). Compare: writing on every pong would be 20 k/s
per server, 2 M/s fleet-wide, for nothing.

**Chat-server death** is the case the lease is for. If a node crashes, its users' leases
expire within 60 s. That is slower than F7, so the service-discovery layer also watches
chat-server liveness and, on a node loss, runs a `mark-all-offline(server_id)` job that
walks the node's routing set. Two mechanisms, one fast and one safe.

### 1.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| Client-initiated JSON `ping` every N s | Needs code on every platform; competes with application backpressure; browsers already answer protocol pings for free. |
| TCP keepalive only | Kernel default is 2 h; even tuned it is invisible to the application on most mobile stacks and does nothing for the client-side half-open case. |
| Presence derived purely from Redis key TTL refreshed on each pong | 2 M Redis writes/s fleet-wide to answer a question the chat server already knows locally. |
| Long-poll "heartbeat" via HTTP | Reintroduces a request per interval; the reason WebSocket was chosen. |

---

## 2. Message history: keep everything, load the newest, page on scroll

### 2.1 Decision

**All messages are retained server-side for the 5-year window (F5). Opening a
conversation loads only the newest page. Scrolling up fetches older pages by cursor over
plain HTTPS, never over the WebSocket.** The WebSocket carries only *new* traffic
(messages, receipts, presence); history is a cacheable read path with its own scaling.

### 2.2 Storage layout that makes "newest first" cheap

Wide-column store (Cassandra/ScyllaDB), one table for both 1:1 and group chats
(a 1:1 chat is a conversation with two members):

```
messages (
  conversation_id  uuid,
  bucket           int,        -- year*100+month, e.g. 202611
  message_id       bigint,     -- Snowflake: time-ordered
  sender_id        uuid,
  client_msg_id    uuid,
  body             text,
  reply_to         bigint,     -- F10, nullable
  media_key        text,       -- F9, nullable; object-store key
  media_size       int,
  media_mime       text,
  created_at       timestamp,
  PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

- **Partition = (conversation, month).** A 100-member group doing 10 k messages a day is
  300 k rows a month, ~60 MB; well under the 100 MB partition guideline. Without the
  bucket a five-year-old group is one multi-GB partition, the classic Cassandra failure.
- **Clustering DESC** so "newest 50" is the first 50 rows of the latest partition, one
  sequential read.
- `client_msg_id` lives here so the dedup check in §1.4 is a single row lookup via a
  secondary index on `(sender_id, client_msg_id)` with a 24 h TTL table, not a scan.

### 2.3 Read paths

**Open a conversation** (device has no cache, or cache is cold):

```
GET /conversations/{id}/messages?limit=50
→ bucket = current month
→ SELECT … WHERE conversation_id=? AND bucket=? LIMIT 50
→ if fewer than 50 rows, repeat for bucket−1, until 50 rows or bucket < conversation.created_bucket
→ response: { messages[50], next_before: <smallest message_id returned> }
```

The bucket walk is bounded by conversation age and almost always stops at the first
partition. A conversation idle for 14 months costs 14 empty partition reads once; the
client caches the result, so this is not a hot path.

**Scroll up:**

```
GET /conversations/{id}/messages?before={message_id}&limit=50
→ bucket = month(before)    -- Snowflake carries the timestamp; no lookup needed
→ SELECT … WHERE conversation_id=? AND bucket=? AND message_id < ? LIMIT 50
→ same bucket walk backwards if short
```

Cursor pagination, not offset: offsets are O(n) in a wide-column store and break when
messages are inserted while the user scrolls.

**Catch-up on open or reconnect** is the *other* direction and the *other* path: the
per-device `last_synced_message_id` cursor from §1.4, served from the message sync queue
over the WebSocket. So each device holds **two cursors per conversation**:

| Cursor | Direction | Path | Owner |
|--------|-----------|------|-------|
| `oldest_loaded` | backwards (scroll up) | HTTPS, page API | the screen |
| `last_synced` | forwards (new messages) | WebSocket, sync queue | the device |

They never meet: history below `oldest_loaded` is fetched on demand; everything above
`last_synced` arrives by push.

**Jump to a quoted reply's parent (F10)** that is outside the loaded window:
`GET /conversations/{id}/messages/{message_id}` by key, then page *around* it with
`before` and `after`. Not a scroll-up loop.

### 2.4 Client cache

Each device keeps a local store (SQLite on mobile, IndexedDB on web) of the pages it has
seen. Opening a conversation renders from cache first, then runs the catch-up sync. The
page API therefore sees mostly *first opens on a new device* and *deep scrolls*, which is
why it is HTTPS and cacheable rather than part of the real-time service.

Page size 50 is a starting point: large enough to fill a phone screen three times, small
enough that a 2 MB media-heavy page is still metadata only (media bytes are fetched
separately via the object store, §F9).

### 2.5 Retention tiering

"Keep all" for 5 years is 730 TB of text before replication (spec §3). Everything stays
**queryable** in the primary store; what changes with age is the storage class:

- Partitions older than 12 months move to the cluster's cold tier (lower-cost disks,
  higher compaction interval). Same API, higher latency on deep scrolls, which the user
  has already signalled they are willing to wait for by scrolling that far.
- Media objects follow their message's age into a colder object-storage class; the
  signed-URL path is unchanged.
- Deletion of a conversation is a tombstone + TTL, never a synchronous delete across
  60 monthly partitions.

### 2.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| Load full history on open | 5 years × 100-member group is hundreds of MB; F3's p50 is impossible. |
| Offset pagination (`page=3`) | O(n) scans and duplicate/missing rows while new messages arrive. |
| Fetch history over the WebSocket | Ties a cacheable, bursty read path to the stateful real-time fleet; a deep scroll by one user competes with live delivery for everyone on that node. |
| Device-only history (WhatsApp classic) | Fails F5/F6: a new device has no history and a lost phone loses it. |
| One partition per conversation, no bucket | Unbounded partition growth; the known Cassandra failure mode for chat. |

---

## Open on the board after this section

- Runtime (Kotlin/Netty vs BEAM vs Go) — still the first unanswered question.
- Presence fan-out: §1.5 decides how *offline* is detected; it does not decide how 10 M
  state changes reach friends' screens.
- Service discovery: §1.4 and §1.5 both depend on it; ZooKeeper vs etcd vs orchestrator.
