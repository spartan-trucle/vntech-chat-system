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
exercise the heartbeat, reconnect and replay design in §1 and §4. The runtime question is
therefore load-bearing; see the discussion page, argument 7.

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

One append-only log per device:

```
sync_queue (
  device_id    uuid,
  bucket       int,        -- day; bounds partition size for a device offline for weeks
  message_id   bigint,     -- Snowflake; global order across conversations
  conversation_id uuid,
  PRIMARY KEY ((device_id, bucket), message_id)
) WITH default_time_to_live = 2592000;   -- 30 days, see §4.5
```

Operations, and nothing else:

- **append** on every stored message, once per recipient device (150 appends for a full
  group). Rows are IDs only; bodies are read from the message store on replay, so a
  queue row is ~50 bytes.
- **replay** from `last_synced_message_id`: read rows `> cursor` in order, join bodies
  from the message store in batches of 100, push over the socket.
- **ack**: the device advances `last_synced_message_id`; the server does not delete
  rows, the TTL does. Advancing the cursor is the trim.

The queue is written on the fan-out path, after the message store write and in the same
retry loop, so a message that is stored is eventually in every recipient device's queue.
The write is idempotent (same primary key), so retries are safe.

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

- **Queue size.** A device offline for 30 days with 100 active groups at 1 000 messages a
  day each is 3 M rows, 150 MB. The daily bucket keeps any one partition at ~100 k rows.
- **Expiry.** After 30 days without a replay the queue rows expire. A device returning
  later is treated as new: it gets the conversation summary, and each chat loads from
  the store on open. Nothing is lost; the queue was only the fast path.
- **Write cost.** 2 B messages × ~6 recipient devices on average (estimation.md §1) is
  12 B appends a day, 700 k/s at peak: six times the message store's write rate, on tiny
  rows. That is the queue's real price and the reason rows carry IDs, not bodies.

### 4.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| No queue: compare cursors and page the store per conversation | Right for the chat list, wrong for replay: N range scans stitched client-side, no single ordered stream, and a device in 200 conversations pays 200 reads on every reconnect. |
| Queue rows carry message bodies | 2 KB × 75 devices per message instead of 50 B; bodies change on delete/edit and the queue would go stale. |
| Derive the chat list from the queue replay | The list would appear only after the drain, which can be thousands of messages; the user stares at a spinner. |
| One queue per user, not per device | Cannot express "phone is a week behind, laptop is current". |
| Delete rows on ack instead of TTL | Tombstone storms in Cassandra; the cursor already makes acked rows invisible. |

---

## Open on the board after this section

- Runtime (Kotlin/Netty vs BEAM vs Go) — still the first unanswered question.
- Presence fan-out: §1.5 decides how *offline* is detected; it does not decide how 10 M
  state changes reach friends' screens.
- Sync-queue backing: §4.2 is written as a Cassandra table; Redis Streams or Kafka could
  back the same operations. Decide once the write volume is in `estimation.md`.
- Service discovery: §1.4 and §1.5 both depend on it; ZooKeeper vs etcd vs orchestrator.
