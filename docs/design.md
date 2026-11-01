# Design — The Chat System

Decisions made while working through [`specification.md`](specification.md). Each section
states the decision, the numbers it was made against, and the alternative it rejected.
The discussion page [`index.html`](index.html) tracks which layers are still open.

High-level architecture: [`diagrams/high-level.html`](diagrams/high-level.html) (hand-drawn SVG; buttons
highlight the send, offline, and history/media flows).

Latency budget (decided 2026-11-01): N1 is measured **server to server**, chat-server
ingress to recipient-socket write. The budget is spent entirely inside our infrastructure,
so every hop on the delivery path (store write, route lookup, cross-server push) is
accountable to it; mobile radio time is not.

Group ceiling (decided 2026-11-01): 100 members is the product today. Fan-out on write
is sized to it. Discord-style channels at 10 k+ are a different product shape and get
their own design pass (spec §8.3), not a threshold hidden in this one.

Prototype (decided 2026-11-01): the exercise **will** produce a prototype chat server to
exercise the heartbeat, reconnect and replay design in §1 and §4. Prototype runtime: **Node.js + TypeScript with `ws`**, chosen for speed because the
prototype proves protocol correctness, not connection count. Production runtime is not
decided. ADR: `.memory/decisions/2026-11-01-prototype-runtime-nodejs.md`.

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
5 min TTL once every 2 min, in one pipelined batch per server (≈ 0.8 k key writes/s per
server, §5.5). Compare: writing on every pong would be 20 k/s per server, 2 M/s
fleet-wide, for nothing.

**Chat-server death** is the only case the lease is for. If a node crashes, its users'
leases expire within 5 min, which is far slower than F7, so the service-discovery layer
watches chat-server liveness and, on a node loss, runs a `mark-all-offline(server_id)`
job that walks the node's routing set within seconds. The lease is the safety net behind
that job, not the primary mechanism, which is why it can be slow and cheap (§5.5).

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

## 3. Receipts per member, unread state, and notifications

### 3.1 Decisions

- **Read receipts are tracked per member (F8).** The sender of a group message can see
  which members have read it, not only how many.
- **Every new message notifies and marks the conversation unread (F4a).** A push goes to
  the recipient's devices; the conversation shows as unread on every device until it is
  opened on one of them.
- **History is kept forever (F5).** The 5-year number is for sizing only.

### 3.2 Why "per member" is a trap if stored per message

A 100-member group, each member reading each message, is 100 read events per message.
At 150 deliveries per event that is 15 000 pushed receipt frames for one message, a
hundred times the message traffic itself. Stored per message, a busy group writes 100
receipt rows for every one message row.

The fix is to notice that reading is monotonic: a member who has read message 700 has
read everything before it. So the state we need is not "who read message N" but
**"how far has each member read"**, which is one number per member per conversation.

### 3.3 Storage

```
read_cursors (
  conversation_id  uuid,
  user_id          uuid,
  last_read_id     bigint,      -- Snowflake; monotonic, only ever increases
  updated_at       timestamp,
  PRIMARY KEY ((conversation_id), user_id)
);

delivery_cursors (
  conversation_id  uuid,
  device_id        uuid,
  last_delivered_id bigint,
  PRIMARY KEY ((conversation_id), device_id)
);
```

- One partition per conversation holds at most 100 rows (members) or 500 rows (devices).
  Reading "who has read message N" is one partition read and a compare:
  `last_read_id >= N`.
- A message's status for the sender is derived, never stored: *read* if every other
  member's cursor is ≥ its ID, *delivered* if every device cursor is, else *sent*.
- Writes are idempotent and commutative: `SET last_read_id = max(last_read_id, X)`. A
  late or duplicate receipt is harmless, which fits the at-least-once delivery path.

### 3.4 Receipt traffic

The client sends a read receipt when a conversation is on screen and the newest visible
message changes, **coalesced to at most one per conversation per 2 s**. The chat server
writes the cursor, then publishes `{conversation, user, last_read_id}` to the members
who currently have that conversation open; members not looking at it get the cursor
when they next open it, by reading the partition. Nobody is pushed receipts for a chat
they are not watching.

Delivered receipts follow the same shape, keyed by device, sent by the client when the
sync queue hands it new messages.

### 3.5 Unread state

Unread is also derived, not stored per message:

```
unread(conversation, user) = last_message_id(conversation) > last_read_id(conversation, user)
```

`last_message_id` per conversation is kept in Redis (`conv:{id}:last`) and updated on
every write; the conversation list for a user is built by reading their read cursors
and comparing. An unread *count* needs one more number, the count of messages since the
cursor, which Cassandra answers with a bounded range count on the current bucket; cap the
displayed value at 99+ so deep backlogs never need a full count.

Opening the conversation on **any one device** advances the user's read cursor; the
server pushes the new cursor to the user's other devices, which clear their badge. One
cursor per user, not per device, is what makes multi-device read state consistent (F6).

### 3.6 Notifications

On every stored message, after the fan-out to online devices:

1. Look up the recipient's devices in the routing table. Devices with a live connection
   got the message over the socket already; **no push for them**.
2. For every device without a live connection, send a push through APNs/FCM carrying
   `{conversation_id, message_id, sender_display_name}` and a preview flag. Never the
   body: it leaves our infrastructure and it would go stale if the message is deleted.
3. Push to all offline devices of the user, not only one. The OS shows it where the user
   is; when they open on one device, the read-cursor push in §3.5 clears the others.
4. Mute and do-not-disturb are checked here, per conversation per user, before step 2.

Badge count in the push is the number of unread conversations, read from Redis, so the
icon badge and the in-app list agree.

### 3.7 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| One receipt row per message per member | 100× the message write volume in groups and an unbounded partition per message. |
| Push every receipt to every member | 15 000 frames per message in a full group; nobody looks at receipts for chats they are not in. |
| Per-device read cursor | A user who read on the phone still sees unread on the laptop; breaks F6. |
| Push with message body | Body leaves our boundary; deleted or edited messages show stale text on lock screens. |
| Stored unread counter incremented per message | Hot counter per user under group fan-out, and it drifts from the cursor on any retry. |

---

## 4. Reconnect: the sync queue and the conversation list

### 4.1 Decision

**Keep the per-device sync queue.** On reconnect a device needs two different things,
and they are served by two different reads:

| Need | Shape of the answer | Served by |
|------|---------------------|-----------|
| "Show me my chat list, with which conversations have new messages, now" | one row per conversation: last message ID, preview, sender, unread count | **conversation summary** read (§4.3), one request, bounded by the number of conversations |
| "Give me every message I missed, in order, so each open chat is complete" | a stream of messages, possibly thousands, in ID order | **sync queue** replay from the device cursor (§4.2) |

The challenge in argument 8 ("compare cursors, then page the store") was really a
description of the first read. It is correct for the chat list and wrong for the second
need: paging the store forward across 200 conversations to rebuild a week of messages is
200 range scans that must be stitched into one ordered stream on the client. The queue
already is that stream.

### 4.2 Sync queue, defined

**Backing: Redis Streams, one stream per device, 24-hour retention.** (Decided after
estimation: see §4.7 for the argument and what was rejected.)

```
XADD   sq:{device_id} MAXLEN ~ 100000  *  m <message_id>  c <conversation_id>
XRANGE sq:{device_id} (<cursor_stream_id> +  COUNT 100       -- replay
XTRIM  sq:{device_id} MINID <id 24 h ago>                    -- hourly sweeper
```

Operations, and nothing else:

- **append** on every stored message, once per recipient device (~6 on average, 150 for a
  full group). Entries carry IDs only; bodies are read from the message store on replay,
  so an entry is ~50 bytes and the whole fleet's live data is ~1.8 TB with replication
  (estimation.md §3.3 at a 24 h window).
- **replay** from the device's cursor: `XRANGE` forward in batches of 100, join bodies
  from the message store, push over the socket.
- **ack**: the device advances its cursor; nothing is deleted on ack. The hourly trim and
  the `MAXLEN` cap bound the stream.

The queue is written on the fan-out path, after the message store write and in the same
retry loop, so a message that is stored is eventually in every recipient device's stream.
`XADD` with a client-chosen ID derived from the Snowflake makes retries idempotent.

**Write order is an invariant: message store first, sender ack second, queue append
third.** Nothing is ever in Redis that is not already in Cassandra, and the stream holds
IDs only. Losing Redis therefore loses no message, only the map of what each device
still lacks; the price is more reads from the persistent store, never a lost or lying
"sent". The reverse order (Redis first, persist later) would make the sender's ack a lie
whenever Redis dies, and is forbidden.

**The queue is a fast path, not a source of truth.** A device offline longer than 24 h
finds its stream trimmed past its cursor and takes the slow path: conversation summary
(§4.3), then each chat loads from the message store on open. Nothing is lost; the device
pays latency instead.

### 4.3 Conversation summary on reconnect

The chat list must render before the queue finishes draining, and it must say which
conversations changed. Served by one HTTPS call, not the socket:

```
GET /conversations?since={list_cursor}&limit=200
→ for each conversation the user is a member of, ordered by last activity desc:
  { conversation_id, last_message_id, last_preview, last_sender, last_at,
    unread_count, my_read_cursor }
```

Where the fields come from:

- `last_message_id`, `last_preview`, `last_sender`, `last_at`: a per-conversation summary
  row (`conv:{id}:summary`), updated on every write, ~150 bytes. Kept in Redis for
  conversations active in the last 30 days (~30 GB, estimation.md §3.5) and read from a
  summary table in the message store for the rest; one `MGET` for the hot part of the
  user's membership list.
- `unread_count`: `last_message_id > my_read_cursor` gives the dot; the count is a bounded
  range count on the current month bucket of the message store, capped at 99+ (§3.5).
- `since`: the device's `list_cursor` is the `last_at` of the newest row it has; the server
  returns only conversations whose summary changed after that. On a short disconnect this
  is a handful of rows; on a new device it is the full list, paged.

So "which conversation has a new message" is answered by the summary, in one round trip,
before a single queued message has been replayed. The device shows the list with unread
dots and previews, then opens the socket and drains the queue in the background;
each replayed message updates the already-visible row.

### 4.4 Reconnect sequence

```
device                         API servers              chat server          stores
  |-- GET /conversations?since --->|                                             |
  |<-- summaries (dots, previews) -|                                             |
  |  render list                   |                                             |
  |-- WS connect + hello{cursor} ------------------------>|                      |
  |                                                       |-- route register --> Redis
  |                                                       |-- replay from cursor -> sync_queue + messages
  |<-- missed messages, in order (batches of 100) --------|                      |
  |-- ack per batch (advance cursor) -------------------->|                      |
  |<-- live traffic begins ------------------------------|                      |
```

The list is usable after step 2. Open chats are complete after the replay. If the user
opens a conversation before its messages have replayed, the client pages that
conversation from the store directly (§2.3, history path) rather than waiting for the
queue; the queue replay later dedups by message ID on the client.

### 4.5 Bounds

- **Window.** 24 h, a product decision: mobile reconnects are seconds to hours; a device
  away longer than a day is rare and the slow path serves it correctly. Each extra day of
  window costs ~600 GB of Redis memory before replication (estimation.md §3.3).
- **Stream size.** A device in 100 active groups at 1 000 messages a day each would see
  100 k entries a day; `MAXLEN ~ 100000` caps the pathological case and such a device
  simply takes the slow path for the overflow.
- **Write cost.** 12 B `XADD`s a day, 700 k/s at peak, spread by device ID across a Redis
  cluster of roughly 10 nodes. Six times the message store's write rate, on tiny entries.
- **Loss.** If a Redis shard is lost with its replica, every device on that shard takes
  the slow path on its next reconnect. The slow path must therefore be rate-limited per
  chat server so a shard loss is a latency event, not a message-store outage.

### 4.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| No queue: compare cursors and page the store per conversation | Right for the chat list, wrong for replay: N range scans stitched client-side, no single ordered stream, and a device in 200 conversations pays 200 reads on every reconnect. |
| Queue rows carry message bodies | 2 KB × 6 devices per message instead of 50 B; bodies change on delete/edit and the queue would go stale. |
| Derive the chat list from the queue replay | The list would appear only after the drain, which can be thousands of messages; the user stares at a spinner. |
| One queue per user, not per device | Cannot express "phone is a week behind, laptop is current". |
| 30-day window | 54 TB live, which forces Cassandra or Kafka, to serve the small fraction of reconnects the slow path already handles correctly. |
| Cassandra with TTL as the queue | 12 B expiring rows a day is the classic tombstone failure; survivable only with daily partitions dropped whole under TimeWindowCompaction, which is a lot of care for a 24 h fast path. |
| Kafka, one partition per user | Handles the write rate trivially, but 15 M per-device consumers reading from arbitrary offsets is not Kafka's model, and Kafka cannot hold the cursor for us either. |

### 4.7 Cursors: who owns them, and what happens when they are lost

Three cursors exist (§2.3, §3.3, §4.3). The rule for all of them: **losing a cursor must
make the system replay more, never less.** Over-replay is harmless because the client
dedups by message ID; under-replay loses messages silently.

| Cursor | Primary owner | Durable copy | Cache | If lost |
|--------|---------------|--------------|-------|---------|
| `last_synced_message_id` (per device) | **the device**, sent in `hello` on every connect | none needed: the device is the owner | none | device reinstalled or wiped → it has no cursor → treated as a new device: slow path. Server never needs to remember it. |
| `last_read_id` (per user per conversation) | the server, because other users and other devices read it (receipts, unread) | Cassandra `read_cursors` | Redis, for unread and summary | Redis lost → read from Cassandra, one slower round trip. Cassandra row lost (should not happen at RF 3) → treated as "never read": the conversation shows unread, the user taps it, cursor is rewritten. Annoying, not wrong. |
| `list_cursor` (per device, newest `last_at` seen) | the device | none | none | device sends `since=0` → full summary list, paged. Slow, not wrong. |

Why the server does not store the device cursor: it would be a second copy that can
disagree with the device's. The device is the only party that knows what it has rendered,
so it is the only party that can say what it has not. The server trusts the `hello` cursor
and replays from there; if the device lies forward it loses messages, which is its own
device, and if it lies backward it gets duplicates, which it dedups.

Why Redis and Kafka are not cursor stores: Redis is memory and loses on a full-cluster
failure, which would convert every device to the slow path at once; Kafka offsets are
positions inside Kafka topics, not positions in our message store, so they cannot name a
message ID.

Invariant: **a cursor advances only after the device has acked the batch**, never when
the server has merely sent it. The ack is the only thing that moves the number.

---

## 5. Presence: detect locally, deliver only to watchers

### 5.1 Decisions

- **Subscription model.** A device receives presence only for users it is currently
  looking at: the other party of an open 1:1 chat, the members of an open group that are
  rendered on screen, and the users whose rows are visible in the chat list. Leaving the
  screen unsubscribes. There is no "all my contacts, always fresh" feed.
- **Freshness, stated as numbers** (spec F7): a drop is detected within 10 s (design
  §1.2); the change reaches watchers within 15 s normally and 30 s worst case; a user
  who drops and is back within 5 s is never shown as offline.
- **Detection and the Redis lease are decoupled.** Detection is local to the chat server
  and costs nothing in Redis. The lease exists only for the case where the chat server
  itself dies, and is renewed every 2 min with a 5 min TTL.

### 5.2 State machine per user

```
                  connect (any device)
   offline ───────────────────────────▶ online
      ▲                                   │
      │   last device dead for ≥ 5 s      │  all devices dead (§1.5 sweeper)
      │   (debounce window)               ▼
      └──────────────────────────── pending-offline
                                          │  a device reconnects within 5 s
                                          └──────────▶ online   (no event emitted)
```

- `online` is per user, not per device: one live device anywhere means online.
- `pending-offline` is the debounce. Mobile radios drop and recover in a second or two;
  without the window every tunnel and lift would flap the dot for all watchers.
- `last_seen` is written on the transition to offline, from the server's clock.

### 5.3 Where the state lives and who moves it

| Thing | Where | Written by | Read by |
|-------|-------|-----------|---------|
| Which devices are connected, and where | Redis routing table `route:{user}:{device}` (§1.5) | chat servers on connect/disconnect | chat servers on delivery |
| Presence state + `last_seen` | Redis `presence:{user}` with 5 min TTL | the chat server that observed the last transition | the summary read (§4.3) and subscription setup |
| Subscriptions: who is watching whom | in the watcher's chat server memory: `watching[target_user] → set(conn)` | chat server on `watch`/`unwatch` frames from the client | the fan-out step below |
| Cross-server fan-out | Redis pub/sub channel `pres:{user}` | the chat server emitting a transition | every chat server with at least one watcher of that user |

A chat server subscribes to `pres:{user}` when its first watcher of that user appears and
unsubscribes when the last one leaves, so the pub/sub fan-out is only to servers that
currently care. Within the server the event is pushed to the watching connections.

### 5.4 Flow

```
A's phone drops (unclean)
  t+0     A's chat server stops seeing pongs
  t+10 s  sweeper closes the socket, removes the route, A has no other device
          → state = pending-offline, timer 5 s
  t+15 s  timer fires, no reconnect → presence:A = offline, last_seen=t
          → PUBLISH pres:A {offline, last_seen}
  t+15 s  B's chat server (B has A's chat open) receives, pushes to B's socket
          → B sees "last seen just now" at ~t+15 s          (within the 15 s target)

A's phone reconnects at t+12 s instead
  t+12 s  hello arrives on some chat server, route written, state online again
          → pending-offline timer cancelled, nothing published; B never saw a flap
```

Online transitions are immediate: `hello` publishes `online` at once, debounced only in
the sense that a `pending-offline → online` cancel emits nothing.

### 5.5 Cost, revisited against estimation.md §2

- **Detection:** 20 k ping frames/s per server, in memory. Unchanged.
- **Lease:** 15 M keys renewed every 2 min instead of 30 s → ~125 k Redis writes/s fleet,
  down from 500 k. The 10 s target did not move; only the crash-recovery lease did,
  because service discovery already marks a dead server's users offline faster than any
  lease can (§1.5).
- **Fan-out:** bounded by watchers, not contacts. A user is typically watched by the
  handful of people who have a chat with them open. The worst case is a popular member
  of many open groups; at 100-member groups that is still at most a few hundred watchers,
  pushed once through pub/sub and then locally per server.
- **Subscriptions:** a device watches at most what fits on its screen, roughly 20 to 30
  users; 15 M devices × 25 = 375 M subscription entries fleet-wide, in chat-server memory,
  ~40 bytes each → 15 GB across 200 servers. Fine.

### 5.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| Push every transition to every online contact | 50 pushes per flap × constant mobile flapping × 10 M online users; the largest hidden cost on the page for a screen nobody has open. |
| Pull on open, no push at all | The dot never changes while a chat is open; F7 asks for change to be visible. |
| Presence key refreshed on every pong | 2 M Redis writes/s for a question the chat server already answers locally (§1.5). |
| No debounce | Every tunnel flaps the dot for all watchers and doubles pub/sub traffic. |
| 30 s detection to save heartbeat cost | The heartbeat was never the cost; the lease was, and it is now decoupled. |

---

## 6. Media: the server never touches the bytes

### 6.1 Decision

F9's "full size" protects **simplicity, not fidelity** (decided 2026-11-01): there is no
server-side media pipeline because a transcoding system is a system of its own, with
queues, workers and failure modes that are not the subject of this design. Consequences:

- **Bytes go client ↔ object storage directly.** Chat servers and API servers handle
  only metadata and signed URLs. No media byte ever crosses the real-time fleet.
- **Compression is the client's job.** Images are compressed on the device by default
  (target ≤ 500 KB); the sender may choose "send original". Video and files go as-is
  under the cap. This is allowed because the requirement forbids server processing,
  not client processing, and it cuts the dominant cost four times (estimation §3.2).
- **The 10 MB cap is enforced by the storage, not by us.** The pre-signed upload URL
  carries a content-length condition; the bucket rejects anything larger before a byte
  is stored.

### 6.2 Upload

```
client                     API server                object storage
  |-- POST /media/intent ----->|                            |
  |   {size, mime, sha256}     |-- validate size ≤ 10 MB    |
  |<-- {media_key, put_url} ---|   mint pre-signed PUT      |
  |                            |   (10 min, content-length = size, content-type = mime)
  |-- PUT bytes --------------------------------------------->|
  |<-- 200 ------------------------------------------------- |
  |-- send message over WebSocket {body, media_key, size, mime, sha256}
```

- The message is sent **after** the upload completes; the recipient never sees a message
  whose media does not exist yet. The client shows the outgoing bubble with a progress
  bar in the meantime, from its outbox.
- `media_key` is `{region}/{yyyy}/{mm}/{uuid}`; the object is immutable. A deleted
  message leaves the object to expire by lifecycle rule rather than deleting
  synchronously.
- The `sha256` lets the client skip re-upload of a file it already sent (forward the
  same object) and lets the recipient verify what it downloaded.

### 6.3 Download

```
recipient                  API server                CDN / object storage
  |-- GET /media/{key}/url --->|                            |
  |                            |-- check membership of the message's conversation
  |<-- {get_url, expires} -----|   signed, 1 h
  |-- GET bytes --------------------------------------------->|
```

- Authorization is at URL minting time, against conversation membership. The URL itself
  is a bearer token with a 1 h life; a forwarded URL works for an hour, which is
  accepted (the alternative, proxying bytes through our servers, is exactly what the
  design forbids).
- Media bytes are fetched on demand when the bubble scrolls into view, never pushed.

### 6.4 Regional buckets, CDN for group media only

Estimation §3.2 at the revised numbers: 100 TB/day uploaded, ~500 TB/day downloaded.

- **Buckets are regional.** The upload URL points at the bucket in the sender's region;
  the key records the region. Most conversations are intra-region, so most downloads
  are regional too, and replication across regions is not needed for correctness, only
  for latency if a product wants it later.
- **CDN only in front of group media.** A 1:1 attachment is downloaded roughly once per
  recipient device (1.5×); a CDN edge adds a hop and a cache miss for nothing. A group
  attachment is downloaded up to 150 times in a burst right after send; that is the
  cache hit pattern a CDN exists for, and it is what keeps the origin bucket's request
  rate flat. The minting step picks the URL host by conversation type.
- **Lifecycle tiering.** Objects move to a colder storage class after 90 days and to
  archive after a year. Download latency for old media rises; the signed-URL path does
  not change.

### 6.5 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| Upload through the API servers | Every byte crosses our fleet twice; the only thing gained is a central place to enforce the cap, which the pre-signed URL already does. |
| Server-side thumbnails / transcoding | A pipeline of its own; explicitly out of scope by F9. Clients render their own thumbnails from the downloaded file. |
| Originals by default | 2 MB average → 400 TB/day; four times the cost for a fidelity nobody asked for in a chat. |
| CDN in front of everything | Pays a hop and a miss on every 1:1 download, the majority of traffic. |
| Proxy downloads for authorization | Reintroduces bytes through our servers to avoid a 1 h bearer URL; the trade is not worth it. |
| Global bucket | Cross-region writes for intra-region chats, higher latency, no correctness gain. |

---

## Open on the board after this section

- Production runtime — deliberately undecided; the prototype is Node.js (ADR above).
- Service discovery: §1.4 and §1.5 both depend on it; ZooKeeper vs etcd vs orchestrator.
