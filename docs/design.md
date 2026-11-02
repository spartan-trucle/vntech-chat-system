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

Service discovery (decided 2026-11-02): **there is no registry.** A device reaches a
chat server through a plain load balancer with an application-level health check
(socket accepted, `hello` answered) and random assignment; the "least-loaded" lookup
is dropped. When a chat server dies nobody runs a `mark-all-offline` job: routing heals
from the client side within the 15 s mirror rule, and presence is cleaned by the
existing lease (renew every 2 min, 5 min TTL), so the presence window on a node loss is
up to 5 min, not seconds. ADR: `.memory/decisions/2026-11-02-no-service-registry.md`.

Reply quoting (decided 2026-11-02): **the reply row stores only `reply_to`; no excerpt
is copied.** The quote is resolved from the parent when the reply is rendered, so an
edited or deleted parent shows correctly in every child (its current text, or F10's
"message unavailable" placeholder). The page API carries the referenced parents in one
batched key read (§2.3), so the client never fetches one parent per quote. ADR:
`.memory/decisions/2026-11-02-reply-quote-by-id.md`.

Store replica loss (decided 2026-11-02): **writes and reads go at LOCAL_QUORUM; on a
QUORUM timeout the chat server retries once at ONE and acks.** The store has no
primary (Cassandra, RF 3), so the failure designed for is two of a token range's three
replicas down at once. Normal operation keeps N3 absolute. A degraded range falls to
ONE for its conversations only and only while it is degraded, and N3 reads "absolute
at QUORUM; during a degraded range, once replicated". A write that fails even at ONE
is not acked: the outbox holds it and resends on backoff, and dedup at two layers
makes the resend safe. The 300 ms + 300 ms budget is the author's number to confirm.
§2.7 holds the failure story and the N2 statement. ADR:
`.memory/decisions/2026-11-02-store-quorum-fallback-one.md`.

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

These are two independent detections, not one (prototype, §7.6): a device whose radio
is off sees neither the server's close frame nor its terminate, so the server's death at
≈ t+11 s tells the client nothing; the client must notice on its own at t+15 s.

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
- **Dedup has a second layer on the client** (decided 2026-11-02, ADR
  `2026-11-02-store-quorum-fallback-one.md`). The server's dedup read goes at
  LOCAL_QUORUM and fails open on a timeout: in a degraded range it stores rather than
  refuses the send, so the store may hold two rows for one message. The `deliver`
  frame therefore carries `sender_id` and `client_msg_id`, and the client drops a
  second message with the same pair. The user never sees a double; the unread count
  may be off by one until the next open (§2.7).
- **Resume, not restart.** The `hello` frame carries the device's `last_synced_message_id`
  cursor; the server replays everything newer from the message sync queue before
  delivering live traffic. No separate "fetch what I missed" round trip.
- **Which server to reconnect to** is the load balancer's problem, not the client's
  and not a registry's (decided 2026-11-02, ADR
  `2026-11-02-no-service-registry.md`). The client connects to one address; the
  balancer assigns a healthy node at random. Its health check is application-level,
  a socket accepted and a `hello` answered, so a hung node leaves the pool; a TCP
  check alone would not. "Least-loaded" is dropped: no figure in `estimation.md` shows
  load skew across 200 nodes to be a problem, and the jittered backoff above already
  spreads a crash's 100 k reconnects. `GET /chat-servers` is a static endpoint or
  disappears behind the balancer's address. Random assignment skews load by a few
  percent at 100 k sockets per node; accepted, to be revisited only with measured skew.

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

**Chat-server death** is the only case the lease is for, and the lease is the only
cleanup there is (decided 2026-11-02, ADR `2026-11-02-no-service-registry.md`): no
component watches chat-server liveness and nothing runs a `mark-all-offline(server_id)`
job. Each piece of the dead node's state heals on its own:

- **Routing:** every device that was on the node sees no ping for 15 s (mirror rule,
  §1.2) and reconnects through the balancer within the backoff; its `hello` on the new
  node overwrites `route:{user_id}:{device_id}`. The stale route lives at most that long.
- **A message pushed to the dead node** in that window fails inside the bounded
  per-destination buffer's timeout (board, Component 3; §7.8) and is dropped there. It
  was already appended to the device's stream by the write order store → ack → queue
  (§4.2), so the replay after reconnect delivers it. The ADR's condition is that this
  timeout is shorter than the N1 p99 budget (500 ms), or one dead node raises p99 for
  every sender fanning out to it; the prototype's default is 5 s (§7.8). Sizing it is
  part of the backpressure write-up still open on the board.
- **Presence:** the node's users' leases stop being renewed and expire up to 5 min
  after the last renewal. For a device that reconnects, presence is rewritten on
  `hello` and nothing is lost. For a device that lost its server **and** its network at
  the same moment, presence reads online until the lease expires: **up to 5 min, not
  the seconds this paragraph used to promise.** Accepted as a bounded error on a
  coincidence; the window equals the lease TTL. Expiry publishes nothing on `pres:{user}`;
  a watcher learns the change on its next read of `presence:{user}` (§5.3).

Rejected (ADR): a liveness watcher for that one coincidence, and a 30 s lease TTL to
shrink the window, which forces renewal every ~10 s, 1.5 M Redis writes/s, three times
the 500 k/s the presence ADR already rejected (§5.5). The lease stays at 2 min / 5 min.

### 1.6 Rejected alternatives

| Alternative | Why not |
|-------------|---------|
| Client-initiated JSON `ping` every N s | Needs code on every platform; competes with application backpressure; browsers already answer protocol pings for free. |
| TCP keepalive only | Kernel default is 2 h; even tuned it is invisible to the application on most mobile stacks and does nothing for the client-side half-open case. |
| Presence derived purely from Redis key TTL refreshed on each pong | 2 M Redis writes/s fleet-wide to answer a question the chat server already knows locally. |
| Long-poll "heartbeat" via HTTP | Reintroduces a request per interval; the reason WebSocket was chosen. |
| A registry (etcd, Consul, the orchestrator) answering "least-loaded chat server" | Solves a load-skew problem no estimate shows; a load balancer with an app-level health check does the job (ADR 2026-11-02). |
| A liveness watcher running `mark-all-offline(server_id)` within seconds of a node loss | The only state it corrects that the client's reconnect does not is presence for a device that lost its server and its network together; a component for a coincidence (ADR 2026-11-02). |
| Lease TTL of 30 s to shrink that presence window | TTL must exceed the renewal interval, so 30 s forces renewal every ~10 s: 1.5 M Redis writes/s, three times what the presence ADR rejected (ADR 2026-11-02). |

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
- `reply_to` is the whole reference: **no excerpt of the parent is stored in the reply
  row** (decided 2026-11-02, ADR `2026-11-02-reply-quote-by-id.md`). The quote is
  resolved from the parent on render, so every message has one source of truth and an
  edit or delete, when §8.5 brings them, touches one row. F10 forbids a parent from
  another conversation; the schema does not, so the `msg` handler rejects a `reply_to`
  whose conversation differs, and the store never checks.
- **Consistency levels** (decided 2026-11-02, ADR
  `2026-11-02-store-quorum-fallback-one.md`): every write and every read of this
  table, the dedup index, the cursor tables and the summary rows goes at
  LOCAL_QUORUM, so normal mode is R + W = 4 > RF 3 and a device reads its own writes
  from any replica. On a QUORUM timeout the writer retries once at ONE and acks; a
  reader serves the page at ONE the same way. Only a token range that has lost two of
  its three replicas takes the fallback, only for the conversations hashed into it,
  only while it is degraded. The dedup index read fails open on a timeout: the server
  stores, because a duplicate row is less harmful than a refused send, and the
  `deliver` frame carries `sender_id` and `client_msg_id` so the client drops the
  double (§1.4). §2.7 has the failure story.

### 2.3 Read paths

**Open a conversation** (device has no cache, or cache is cold):

```
GET /conversations/{id}/messages?limit=50
→ bucket = current month
→ SELECT … WHERE conversation_id=? AND bucket=? LIMIT 50
→ if fewer than 50 rows, repeat for bucket−1, until 50 rows or bucket < conversation.created_bucket
→ parents = every reply_to in the page not already in it, SELECT by key in one batch
→ response: { messages[50], parents: { message_id → message }, next_before: <smallest message_id returned> }
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
→ parents, as above
→ response: { messages, parents, next_before }
```

**`parents`** (decided 2026-11-02, ADR `2026-11-02-reply-quote-by-id.md`): the map of
every message referenced by a `reply_to` in the page and not already in it, so the
client renders each quote from the parent without a request of its own. The server
reads them by key, `(conversation_id, bucket, message_id)`, in one batched request;
the bucket comes from the parent's Snowflake timestamp, so a parent in a cold month is
one slow read, never a walk. Bounded by the page: at most 50 parents, and parents
inside the page are not re-read. The device cache (§2.4) keeps parents it has seen. A
`reply_to` whose parent is gone is absent from the map and renders as F10's "message
unavailable" placeholder, a render rule, not a storage rule.

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
`before` and `after`. Not a scroll-up loop. Unchanged by the quoting decision: the
quote itself never needs this path, since the parent came with the page.

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

### 2.7 When the store loses replicas

Decided 2026-11-02, ADR `2026-11-02-store-quorum-fallback-one.md`. Spec §5.8.2 asks
about "the message store primary"; the store has none. Every partition lives on three
replicas (RF 3), so the failure that threatens N2 is **two of a token range's three
replicas down at once**: the conversations hashed into that range have no write quorum
while the rest of the cluster is unaffected. Loss of the whole cluster or a whole
region is a different event, deferred to spec §8.7.

**The sender's view.** The chat server writes at LOCAL_QUORUM with a 300 ms budget. If
that times out, it retries once at ONE with another 300 ms and acks on success, so the
degraded ack lands inside the N1 p99 of 500 ms plus one retry. The bubble shows "sent"
either way; the sender never sees an error. If even the ONE write fails (no live
replica for the range, or the cluster down), the server does not ack: the outbox keeps
the message, the bubble shows "sending…", and the client resends on its backoff
(§1.4). The two 300 ms budgets are the hub's proposal; the author confirms or changes
them here.

**What N3 means now.** "An acknowledged message is never lost" is absolute at QUORUM,
which is every message in normal operation. During a degraded range it reads "never
lost once replicated": a message acked at ONE rests on one replica until hinted
handoff copies it to the others. The write-order invariant of §4.2 is untouched: the
store, at whatever level, still precedes the ack, and the ack still precedes the
queue append.

**Dedup at two layers.** The dedup index read `(sender_id, client_msg_id)` goes at
LOCAL_QUORUM and fails open on a timeout: the server stores, because by this decision
a duplicate is less harmful than a refused send. The `deliver` frame carries
`sender_id` and `client_msg_id`, and the client drops a second message with the same
pair. The user never sees a double. The store may hold two rows for a message acked
during a degraded window, and the unread count may be off by one until the next open;
a repair job that collapses duplicates is out of scope.

**Reads.** History pages, summary rows and read cursors follow the same rule:
LOCAL_QUORUM, falling back to ONE on timeout. Normal mode is R + W = 4 > RF, so a
second device reads the first's writes. A page served at ONE may miss a message that
the replay delivers later; the client dedups by `message_id` (§4.4).

**Recovery.** When the lost replicas return, hinted handoff replays the writes they
missed (default hint window 3 h). Past that window a repair of the range restores
RF 3. No application step is needed. Operators are paged on the count of writes acked
at ONE per minute, which is zero in normal operation.

**Loss bound.** Zero in normal operation. During a degraded window on one range: the
messages acked at ONE on that range, lost only if the single surviving replica also
dies before hints replay. The window is bounded by replica recovery time and by the
conversations in one range, one of ~550 nodes' worth (estimation §3.1).

**N2, stated.** The send/receive path stays available through the loss of up to two
replicas of any range, at the cost of N3 for the messages acked at ONE. Loss of all
three replicas of a range, or of the cluster, is unavailability for the affected
conversations: sends are held in the outbox and delivered when the store returns;
nothing is lost on the client side. Multi-region failover is deferred to spec §8.7.

Rejected (ADR): ONE for every write, always (the author's first choice, revised in the
debate: it opens the loss window on every message at every moment, including rolling
restarts, and breaks read-your-writes for dedup, unread and the second device, while
the 115 k writes/s peak is trivial for the store at QUORUM and the latency difference
is about one internal round trip); QUORUM with no fallback (a two-replica loss
becomes "cannot send" for the affected conversations, against the availability
priority); client dedup by `client_msg_id` only, with no QUORUM index read (every
retry after a lost ack would store a second row in normal operation; kept as the
second layer, not the only one); refusing the send when the dedup read times out
(consistent with N3, inconsistent with the priority this decision sets).

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

**Delivered receipts** follow the same shape, keyed by device (decided 2026-11-02, ADR
`2026-11-02-delivered-receipt-device-stored.md`). *Delivered* means the device stored
the message in its local store; nothing the server can observe (a push handed to the
socket, a flush confirmed) counts. The client sends
`delivered{conversation_id, up_to_message_id}` in replay mode and in live mode alike,
after the message is in the local store, coalesced to at most one per conversation per
2 s, the read receipt's rule and number. The server runs
`SET last_delivered_id = max(last_delivered_id, up_to_message_id)` on `delivery_cursors`
(§3.3), idempotent and commutative, and keeps no per-connection state and no mapping
from stream ids. The prototype's rule, advance the delivery cursor when the push is
handed to the socket, is withdrawn (§7.3). The replay `ack{up_to_stream_id}` is a
different frame with a different key and owner and stays the sync cursor only (§4.4).

Resend after reconnect: the client keeps two ids per conversation, the highest
`message_id` it stored and the highest `message_id` it sent a `delivered` for. After
`replay_done` on a new connection it sends one `delivered` for every conversation where
the two differ, which covers receipts lost when the previous connection dropped inside
the coalescing window. A receipt that reaches a server which dies before the Cassandra
write is accepted as rare and self-healing: `max` means the next delivered message in
that conversation covers it. Derived status (§3.3) is unchanged: for the sender,
*delivered* means every device of every other member has a cursor at or above the id,
and an offline device holds the status at *sent* until it reconnects and stores the
message, which is what F8 means.

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

1. Look up the recipient's devices in the **device directory** (every device the user
   has registered), then the routing table for which of them hold a live connection; the
   routing table alone is the wrong set, it knows only the connected devices (prototype,
   §7.7). Devices with a live connection got the message over the socket already; **no
   push for them**.
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
**Stream ids are Redis-assigned (`XADD … *`), as the block above shows, and the
`message_id` lives in the entry body** (decided 2026-11-02, ADR
`2026-11-02-live-first-replay-xadd-auto-id.md`). Appends to one device's stream need
no ordering: a late append lands behind the top entry and is replayed after the
cursor, where an explicit lower id would be refused by Redis. The retry stays
idempotent on the retry path only: when an `XADD` times out, the appender reads the
tail of the stream (`XREVRANGE sq:{device} + - COUNT 100`) and skips the append if an
entry with that `message_id` is present. The normal path pays nothing. The check is
best effort, since the timed-out `XADD` can still land after the read, so a duplicate
entry remains possible and the client's dedup by `message_id` (§4.4) is the guarantee;
a duplicate costs one `MAXLEN` slot and one extra body join on replay. `MAXLEN ~` is a
floor with node granularity, not an exact cap (prototype, §7.9).

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
  |                                                       |-- subscribe the socket to live pushes, first
  |                                                       |-- replay from cursor -> sync_queue + messages
  |<-- deliver{replay: true}, XRANGE batches back to back, live deliver{replay: false} interleaved --|
  |-- ack{up_to_stream_id} on the client's cadence (persists the cursor, never a credit) -->|
  |<-- replay_done --------------------------------------|                      |
  |<-- live traffic, deliver{replay: false}, stream_id applied to the cursor --|  |
```

The list is usable after step 2. Open chats are complete after the replay. If the user
opens a conversation before its messages have replayed, the client pages that
conversation from the store directly (§2.3, history path) rather than waiting for the
queue; the queue replay later dedups by message ID on the client.

**The replay runs beside the connection's frame handling, not inside the `hello` handler**
(prototype, §7.2). The server must keep handling the device's frames while the replay
runs, because the acks arrive on the same socket; a server that processes one
connection's frames strictly in order and lets `hello` block until the replay is done
deadlocks on the first batch. Since 2026-11-02 the server never waits for an ack
between batches at all (below): the ack is not a credit, and the shape B3's deadlock
lived in is gone.

**Live first, then replay** (decided 2026-11-02, ADR
`2026-11-02-live-first-replay-xadd-auto-id.md`). On `hello{cursor}` the chat server
subscribes the connection to live pushes *before* it starts the replay loop. There is
no `replay` phase in the connection state machine and no flip: the replay runs
`XRANGE (cursor + COUNT 100` until an empty batch while live pushes flow on the same
socket, so the window B9 found between the last empty `XRANGE` and the flip (§7.9)
does not exist. Three rules follow:

- **The client dedups by `message_id`.** A message appended during the replay reaches
  the device twice, once as a live push and once when the replay loop reaches its
  entry; the client's local store keys messages by `message_id`, so the second copy is
  a no-op write.
- **The client sorts by `message_id`.** Frames on the socket are not in `message_id`
  order during the replay. The client renders from its store sorted by `message_id`,
  never from socket arrival order. That is the order the message store clusters by
  (§2.2) and the history page returns, so replay, live and paging agree. It is as good
  as the clocks of the Snowflake generators, which is the only system-wide order the
  design commits to; the client has no better one.
- **Cursor rule.** The device cursor advances on replay acks only while the
  connection is in replay mode. A live frame received in replay mode is stored, but
  its queue entry id (`stream_id` on the `deliver` frame, as flows 1, 3 and 6 draw it)
  is not applied to the cursor, because entries between the replay position and that
  live entry have not been delivered yet. Outside replay mode each live frame's
  `stream_id` is applied to the cursor as today (§4.7). Where replay mode begins and
  ends is the next block.

**End of replay is a mode boundary** (decided 2026-11-02, ADR
`2026-11-02-replay-mode-boundary.md`). "Batch" is the server's `XRANGE COUNT 100`
read granularity, not a client concern; the client needs two things only, to persist
its cursor and to know when the replay has ended. And a single end marker is not
enough, because the live path is not gapless: a push dropped by the backpressure
budget (§7.8) is invisible to the device, whose next live frame would carry a higher
`stream_id` and leave the dropped entry below the cursor for ever, the under-replay
§4.7 forbids. Only the server knows a push was dropped, so the server acts.

Frames. `deliver` gains a boolean field `replay`: `deliver{replay: true}` for a frame
pushed by the server's `XRANGE` loop, `deliver{replay: false}` for a live push. One
new server frame, `replay_done`, carries nothing but its type. No `batch_end`, no
`replay_start`.

Server rules:

- On `hello{cursor}` the server subscribes the connection to live pushes, then runs
  `XRANGE (cursor + COUNT 100` until an empty batch, pushing each entry as
  `deliver{replay: true}`, then sends `replay_done`. It never waits for an ack between
  batches; the bounded per-destination buffer is the only flow control.
- When a live push to this connection is dropped by the backpressure budget, the
  server stops queuing live frames for the connection, lets the buffer drain, runs the
  same `XRANGE` loop from the dropped entry's `stream_id` (exclusive of what was
  delivered before it) until empty, sends `replay_done`, and only then resumes live
  pushes. A further drop during that loop extends it; the loop ends only on an empty
  read. The server is the only writer on the socket, so no live frame is sent between
  the drop and the first `replay: true` frame; that frame is the mode switch, which is
  why no `replay_start` frame is needed (one could not be delivered anyway: the buffer
  was full at the moment of the drop).
- The initial replay runs alongside live pushes (nothing was dropped); a backpressure
  replay runs alone.

Client rules:

- The client acks on its own cadence, `ack{up_to_stream_id}` with the highest
  `stream_id` of the `replay: true` frames it has stored, for example every 100 replay
  frames or 500 ms, whichever first (the author's numbers, to confirm). The cursor
  advances only by these acks while in replay mode (§4.7).
- Replay mode begins at `hello` and at the first `replay: true` frame after a
  `replay_done`; it ends at `replay_done`. Outside replay mode the client applies each
  live frame's `stream_id` to its cursor as today.
- A live frame received in replay mode is stored but its `stream_id` is not applied to
  the cursor; the replay loop will reach that entry and the client dedups by
  `message_id`.
- Socket order is not message order in replay mode; the client renders from its local
  store sorted by `message_id` (above).

"End of replay" is therefore a boundary the connection can cross many times, not an
event that happens once per connection.

**The delivered receipt rides beside the ack, not on it** (decided 2026-11-02, ADR
`2026-11-02-delivered-receipt-device-stored.md`). In both modes the client also sends
`delivered{conversation_id, up_to_message_id}` after each store write, coalesced per
conversation (§3.4). The two frames carry different keys for different owners:
`ack{up_to_stream_id}` is one Redis stream id per device, owned by the device, and
persists the sync cursor only; `delivered` is one Snowflake per conversation per
device, owned by the server for F8. Item 8 (B5 finding 10 in §7.1) was decided on the
receipt, not on this ack.

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

Invariant: **a cursor advances only after the device has acked what it stored**, never
when the server has merely sent it. The ack is the only thing that moves the number.

**The ack persists the cursor and nothing else** (decided 2026-11-02, ADR
`2026-11-02-replay-mode-boundary.md`). `ack{up_to_stream_id}` is cumulative, so the
client sends it on its own cadence, with the highest `stream_id` of the
`deliver{replay: true}` frames it has stored: for example every 100 replay frames or
500 ms, whichever first (the author's numbers, to confirm). A late ack only
over-replays on the next reconnect, which this section allows; a fast one costs ack
traffic. The ack is never a flow-control credit: the server runs its `XRANGE` batches
back to back and never waits for it, and flow control is the bounded per-destination
buffer (§7.8). In replay mode the cursor advances by these acks only; outside replay
mode the client applies each live frame's `stream_id` as it arrives (§4.4). Nothing on
the wire marks a batch end, and nothing needs to: the end of the replay is
`replay_done` (§4.4), and the prototype's "ack on a count or 20 ms of silence" is
replaced by the cadence above.

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
- `last_seen` is written on the transition to offline and is the **drop time**: the
  server's last pong from the user's last device, not the moment the debounce fired
  (prototype, §7.5).
- The lease renewal timer (§1.5) runs only while at least one user is online on the
  server; an idle server writes nothing (prototype, §7.5).

### 5.3 Where the state lives and who moves it

| Thing | Where | Written by | Read by |
|-------|-------|-----------|---------|
| Which devices are connected, and where | Redis routing table `route:{user}:{device}` (§1.5) | chat servers on connect/disconnect | chat servers on delivery |
| Presence state + `last_seen` | Redis `presence:{user}` with 5 min TTL, renewed every 2 min; the TTL is the only cleanup after a chat-server death (§1.5, ADR 2026-11-02) | the chat server that observed the last transition | the summary read (§4.3) and subscription setup |
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
the sense that a `pending-offline → online` cancel emits nothing. A watcher that
subscribes during `pending-offline` is told `online` and still receives the `offline`
that may follow (prototype, §7.5).

**Timing caveat (prototype, §7.4, open):** with §1.4's numbers a client that suffered a
half-open drop reconnects at ≈ t+16 s, the same second the debounce above fires at
t+15–16 s, so a watcher sees offline then online for every unclean drop whose network is
back within 15 s. The 5 s debounce protects clean closes; the relation it should keep to
the mirror rule and the first backoff is a question for the author.

### 5.5 Cost, revisited against estimation.md §2

- **Detection:** 20 k ping frames/s per server, in memory. Unchanged.
- **Lease:** 15 M keys renewed every 2 min instead of 30 s → ~125 k Redis writes/s fleet,
  down from 500 k. The 10 s target did not move; only the crash-recovery lease did.
  Nothing marks a dead server's users offline faster than the lease (§1.5, ADR
  2026-11-02): on a node loss a device that also lost its network shows online for up
  to the 5 min TTL. A 30 s TTL would close that window at 1.5 M writes/s and was
  rejected; the numbers here are unchanged by the decision.
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

## 7. What the prototype changed

Written 2026-11-01, after the prototype under `prototype/` (Node.js + TypeScript, one
process, in-memory ports, a scripted multi-device client) reached the runtime ADR's
definition of done: six scripted scenarios over the real server, all passing on fake time
with the design's numbers and, for S1 and S5, on real timers; 258 tests; typecheck clean.
Every surprise the build reported is listed here. The ones that change design text are
written back into the section they touch, marked "(prototype, §7.n)". Nothing here
decides an item on the A3 list; the new open questions are added to it at the end.
Rows 16 to 18 and §7.9 were added on 2026-11-02 after B9 put real Redis behind the
ports.

### 7.1 Every surprise, and whether it changed the design

| # | Found in | What the build found | Design change |
|---|----------|----------------------|---------------|
| 1 | B3, S2 | An `ack` sent during a replay could never be handled: the server handled one connection's frames strictly in order and `hello` awaited the replay, so the replay waited for an ack that sat behind the hello in the same chain. §4.4 drew the replay and the acks as one lane and hid the deadlock. | **Yes**, §4.4 (7.2) |
| 2 | B3 | Nothing on the wire marks where a replay batch ends. §4.2 says batches of 100 and §4.7 says only the ack moves the cursor, but neither says how the device knows a batch is complete; the prototype acks on a count or on 20 ms of silence, which is a heuristic, not a protocol. | **Open**, §4.7 (7.3) |
| 3 | B8, S1 | With the design's numbers the server publishes `offline` at t+16 s (dead at t+11 s, plus the 5 s debounce) in the same second the client's own reconnect lands (15 s mirror rule plus 1 s backoff). A watcher sees offline then online for every half-open drop, however short the outage. §5.2's debounce and §1.4's reconnect were sized independently. | **Question for the author**, §5.4 (7.4) |
| 4 | B6, S5 | Three rulings the design left implicit: `last_seen` is the drop time (the last pong), not the time the debounce fired; the lease renewal timer exists only while some user is online; a watcher arriving during `pending-offline` is told `online` and still receives the `offline` that may follow, so the client's 500 ms batching can shift a transition but never lose one. | **Yes**, §5.2, §5.4 (7.5) |
| 5 | B1, S1 | Server-side death (two missed pongs, seen by the 1 s sweeper at ≈ t+11 s) and the client's 15 s mirror rule are independent detections: a device whose radio is off sees neither the close nor the terminate. S1 asserts both. | **Yes**, §1.2 (7.6) |
| 6 | B0, B5 | Eight ports were needed, not five. Besides membership and the cursor tables of §3.3, a **device directory** is required: push hints (§3.6) go to every device a user has, and the routing table only knows the connected ones. | **Yes**, §3.6 (7.7) |
| 7 | B2 | "Pending" on the bounded per-destination buffer has tick granularity: the socket library reports a flush on the next tick, so every push issued within one tick counts as pending even on a healthy socket; the bound must leave room for one tick's worth of fan-out. On loopback the kernel absorbs about 0.5 MB before a blackholed peer backs the writer up, so the backpressure test corks the socket. | Input to the backpressure write-up, A3 item 4 (7.8) |
| 8 | B7, S6 | The roadmap's `msg` frame omitted `media_size`, `media_mime` and `sha256`, which §6.2 sends; the build followed the roadmap until the gap showed and was fixed across the protocol, the core and the messaging module. | **No**: the design was right. A plan must quote the design's frame, never paraphrase it |
| 9 | B3 | Two notes for real Redis (B9): "empty `XRANGE`, then flip to live" leaves a window where an append lands after the empty read and before the flip, so one more `XRANGE` after the flip is needed; in one process the flip is in the same microtask drain, so the prototype is safe without it. And deciding "trimmed past the cursor" needs the stream's oldest retained id (`XINFO STREAM`), a fourth operation; `MAXLEN` eviction must be reported the same way. | **Yes**, sync-queue ADR amended (7.3) |
| 10 | B5, C review | Delivery cursors advance when the push is handed to the socket, not on a client-sent delivered receipt as §3.4 says, because the protocol has no such frame. A push lost to the backpressure timeout therefore still counts as delivered. | **Closed 2026-11-02** by removal of the push-to-socket advance: the client sends `delivered{conversation_id, up_to_message_id}` after its store write in both modes (§3.4, 7.3, ADR `2026-11-02-delivered-receipt-device-stored.md`) |
| 11 | B4 | The HTTP router is first-match, so a core test's probe route collided with the real page route; the unread count has no sender filter until the sender's own read cursor advances on store, which B5 does. | No |
| 12 | B6 | Once every client frame type has a handler, the core's unhandled-frame path has no test probe left. | No (prototype note) |
| 13 | B1 | One client test mixes fake and real time and fails about once in ten full-suite runs under load; the scenarios use larger budgets. | No (prototype note) |
| 14 | A4 | N2 (availability) and N6 (security) were neither addressed nor deferred; spec §7 row 3 says seven flows where §4.2 has nine. | N2 closed 2026-11-02 (§2.7, ADR `2026-11-02-store-quorum-fallback-one.md`); N6 stays open as A3 item 6b in `rubric.md`; the second is a spec typo |
| 15 | B, orchestration | Agent worktrees were cut from `origin/main`, not the lane branch; every subagent brief had to open with a fast-forward onto the lane branch. | No (process note) |
| 16 | B9, Redis | Redis refuses an `XADD` whose id is at or below the stream's top entry. The in-memory queue sorted on insert, so it hid that appends to one device's stream must be issued in message-id order; today only the equal await depth of concurrent handlers keeps them ordered. A retry of the same id is still the idempotent case of §4.2. | **Closed 2026-11-02**, §4.2: `XADD … *`, message id in the entry, tail read on the retry path (7.9, ADR `2026-11-02-live-first-replay-xadd-auto-id.md`) |
| 17 | B9, Redis | `MAXLEN ~` trims whole radix-tree nodes: the cap is a floor with node-level granularity (about 100 entries), not the exact length the in-memory adapter enforced. §4.5's "caps the pathological case" is approximate. | Noted in §4.2 and the sync-queue ADR (7.9) |
| 18 | B9, Redis | The replay-to-live handoff has a real window under I/O: a message whose `XADD` lands after the replay's last empty `XRANGE` and whose fan-out runs before the connection flips to `live` is neither replayed nor pushed until the next reconnect. The in-memory "same microtask drain" argument in the sync module is false once `XRANGE` is a round trip; the driver's reply FIFO is what usually saves it. Kept as an expected-failure test with its trace. | **Closed 2026-11-02**, §4.4: live first, then replay, no flip, client dedups and sorts by message id (7.9, same ADR) |

### 7.2 §4.4: the replay runs beside the connection's frame handling

The sequence in §4.4 shows `hello{cursor}`, then missed messages in batches, then an ack
per batch, then live traffic, as if they were one lane. They are not. The replay has to
**wait** for the device's ack of each batch (§4.7), and that ack arrives on the same
socket as the `hello` that started the replay. If the server processes a connection's
frames strictly in order and the hello handler does not return until the replay is done,
the ack can never be processed and the replay never ends. The prototype hit exactly this
and fixed it in the core: the handshake returns as soon as `hello_ack` is sent, the replay
runs as a detached task for that connection, and frames that arrive meanwhile (acks, the
outbox flush of §1.4, receipts) are handled normally. The prototype kept the connection
in a `replay` phase, so the fan-out of §4.2 did not push to it directly and a message
sent during the replay reached it through the queue, once. The detached replay was
written into §4.4; the `replay` phase was removed on 2026-11-02 by the live-first
decision (§4.4, §7.9), which subscribes the connection to live pushes before the replay
starts and leaves the dedup to the client.

### 7.3 §4.2, §4.7: a batch end, the queue's fourth operation, and delivered receipts

Three things the queue section does not say, found while building B3 and B5.

- **What marks a batch end.** "Replay in batches of 100, ack per batch" assumes the device
  can tell where a batch ends. It cannot: a batch of 100 and the first 100 of a batch of
  200 look the same, and the last batch is short. The prototype acks after 100 frames or
  after 20 ms of silence, which works and is not a protocol. Two candidates were offered,
  a `batch_end` marker on the last `deliver` of each batch or a `replay_done` frame after
  the last batch. **Closed 2026-11-02** (ADR `2026-11-02-replay-mode-boundary.md`):
  nothing marks a batch end, because a batch is the server's read granularity and the ack
  is not a credit. `deliver` carries a `replay` flag, `replay_done` ends replay mode, the
  client acks `ack{up_to_stream_id}` on its own cadence, and a push dropped by the
  backpressure budget re-enters replay for that connection (§4.4, §4.7).
- **The queue needs four operations, not three.** Deciding "the stream was trimmed past
  this cursor" (§4.2 last paragraph) needs the oldest retained id, which `XRANGE`,
  `XADD` and `XTRIM` cannot give; Redis has it as `XINFO STREAM` (first entry). The
  prototype also found that "cursor below the oldest retained id" is not decidable on its
  own: a device that acked its last live message and then received nothing has a cursor
  above the oldest entry, while a stream that was never appended to looks empty. The
  rule that works is **cursor below the last trim boundary that actually dropped entries
  → slow path**, which errs towards more replay as §4.7 requires. `MAXLEN` eviction must
  feed the same boundary. The sync-queue ADR is amended accordingly.
- **Delivered receipts.** §3.4 says the client sends a delivered receipt when the queue
  hands it new messages; the protocol (B0) has only the read receipt, so the prototype
  advances the delivery cursor when the push is handed to the socket. That overstates
  delivery for a push dropped by the backpressure timeout. The replay `ack` already says
  exactly what the device received, so the proposal was to advance the delivery cursor
  on `ack{up_to_stream_id}` and drop the separate delivered receipt from §3.4. **Closed
  2026-11-02** the other way (ADR `2026-11-02-delivered-receipt-device-stored.md`): the
  ack exists only in replay mode and stays the sync cursor (item 7), so an online
  recipient receiving live pushes would produce no delivered signal at all. The §3.4
  receipt is confirmed as `delivered{conversation_id, up_to_message_id}`, sent after the
  local store write in both modes; the push-to-socket advance is withdrawn, which closes
  B5 finding 10 by removal rather than by a patch.

### 7.4 §5.2 and §1.4: the debounce and the client's reconnect were sized independently

The timeline S1 and S5 produce with the design's numbers, for a device whose radio drops
at t and is back at any time before t+15 s:

```
t        radio off; no close frame; last pong was at t
t+10–11  server: two missed pings; the 1 s sweeper kills the socket, deletes the route
         → user's last device → pending-offline, 5 s timer
t+15     client: no ping for 15 s → closes the half-open socket, schedules reconnect
t+15.7–16.3  client reconnects (1 s base, ±30 % jitter) → hello → online
t+15–16  server: debounce fires → offline, last_seen = t → PUBLISH → watcher sees offline
```

The last two lines land in the same second. The debounce was written for "a drop and a
reconnect within 5 s is never shown" (§5.1), with the reconnect at t+12 s in the §5.4
example; but a client that follows §1.4 cannot reconnect before t+15.7 s after a
half-open drop, because it only notices at t+15 s. So for the unclean case, which is the
case the heartbeat exists for (§1.1), every drop whose network is back within 15 s shows
the watcher an offline-then-online flap, and the debounce protects only clean closes and
app restarts.

**Question for the author, not decided here.** The two numbers need a stated relation.
For the reconnect to land inside the debounce, `dead_max + debounce > mirror + backoff_max`,
with the design's numbers `11 + 5 > 15 + 1.3`, which is false by about 1.3 s. Three ways
to make it hold, each with a cost: lengthen the debounce to about 7 s (offline shown at
t+18 s, past the 15 s "normal" target in §5.1); shorten the client's mirror rule below the
server's detection, say 10 s (the client then reconnects at ≈ t+11 s, inside the window,
at the price of a client that gives up on a slow-but-alive socket sooner); or accept the
flap for half-open drops and state that the debounce covers clean closes only. Added to
the open list at the end of this document.

### 7.5 §5: three rulings written back

- `last_seen` is the drop time: the server's last pong from the user's last device. The
  prototype keeps `last_pong_at` on the dead connection and writes it on the final
  transition, so a watcher reads "last seen" as the moment the person was really there,
  not 15 s later. Written into §5.2.
- The lease renewal timer runs only while at least one user is online on the server; an
  idle server writes nothing. The ADR's "renew every one of its users' keys" assumed a
  server always has users. Written into §5.2.
- A watcher who subscribes during `pending-offline` is told `online` (the state as the
  outside sees it) and is in the set for the `offline` that may follow. That is what lets
  the client's 500 ms batching (presence ADR) and the 5 s debounce compose without a lost
  transition. Written into §5.4.

### 7.6 §1.2: two detections, not one

The heartbeat is two independent mechanisms: the server's (two missed pongs, swept once a
second, so death at t+10 to t+11 s) and the client's mirror rule (no ping for 15 s). The
design wrote them as one decision; the prototype showed why they must be asserted
separately: a device whose radio is off sees neither the server's close frame nor its
terminate, so nothing the server does tells the client anything. The client must notice
on its own. Written into §1.2.

### 7.7 §3.6: push hints need a device directory

Step 1 of §3.6 says "look up the recipient's devices in the routing table". The routing
table holds `route:{user}:{device}` for **connected** devices only (§1.5), which is the
wrong set: the devices that need a push are exactly the ones not in it. The system needs
a device directory, every device a user has registered, read on fan-out and on push; the
routing table then says which of those are live. Written into §3.6.

### 7.8 Board, Component 3: the bounded buffer has a tick

For the backpressure write-up that A3 item 4 moves into this document: a per-destination
bound counts pushes between "handed to the socket" and "flushed", and the socket library
reports the flush asynchronously, so all pushes issued within one event-loop tick are
pending at once even on a healthy socket. The bound must be sized as `max(worst-case
fan-out per tick) + headroom`, not as a small number; the prototype's default is 1 000 with
a 5 s timeout. A push that times out is dropped. The board's rule, "the device catches
up through its queue on its own", held under test but is false as written since
2026-11-02 (ADR `2026-11-02-replay-mode-boundary.md`): the device cannot see a dropped
push, so the server that dropped it stops queuing live frames for that connection,
lets the buffer drain, re-runs the `XRANGE` loop alone from the dropped entry until
empty, sends `replay_done`, and only then resumes live pushes (§4.4). The entry is still
in the device's stream, as the board says; what changed is who notices.

### 7.9 §4.2, §4.4: what real Redis showed (B9)

B9 put the three Redis ports and the presence bus on a real Redis 7 behind the same
contracts, with everything else still in memory and still one process. The in-memory
runs keep their numbers; against Redis, 34 contract and end-to-end cases pass and three
are kept as named expected failures rather than weakened, because each documents a fact
the in-memory adapters hid.

- **Per-stream append ordering (row 16).** Redis Streams are append-only in id order;
  an `XADD` with an id at or below the top entry is an error, not a reorder. §4.2's
  "client-chosen ID derived from the Snowflake makes retries idempotent" holds for a
  retry of the same id and nothing else. Two concurrent sends to the same recipient can
  reach the `XADD` for that device's stream out of id order unless something serialises
  them. **Closed 2026-11-02** (item 11, ADR
  `2026-11-02-live-first-replay-xadd-auto-id.md`): Redis mints the stream id
  (`XADD … *`) and the message id lives in the entry only; a late append is replayed,
  not refused. The idempotent retry survives on the retry path as a tail read that
  skips a present message id, best effort, with the client's dedup by `message_id` as
  the guarantee (§4.2).
- **`MAXLEN ~` is a floor (row 17).** The cap evicts whole radix nodes once one fills;
  the stream can hold up to about a hundred entries more than the cap. The design's
  "overflow takes the slow path" (sync-queue ADR) still holds; the boundary is fuzzy by
  one node, which only matters to the trim-boundary rule of §7.3 if eviction is not
  reported, so the adapter must feed evictions into the same boundary.
- **The replay-to-live window (row 18).** §4.4 ends the replay when an `XRANGE` comes
  back empty and then flips the connection to `live`. With a real round trip there is a
  gap between the empty read and the flip; a message appended in that gap is skipped by
  the replay (the range was empty) and by the push (the phase was still `replay`). It
  is not lost, it is in the stream and arrives on the next reconnect, which may be hours
  away. **Closed 2026-11-02** (item 10, same ADR), with neither patch: the connection is
  subscribed to live pushes before the replay starts, so there is no flip and no
  window; the client dedups and sorts by `message_id`, and the device cursor advances
  on replay acks only until `replay_done`, decided the same day (§4.4).

Also observed, no design change: pub/sub delivery and the presence TTL run on Redis's
clock asynchronously; the server tolerated both unchanged, only the contracts written
for the synchronous in-memory bus and clock needed a settle point and real sleeps.

---

## Open on the board after this section

- Production runtime — deliberately undecided; the prototype is Node.js (ADR above).
- N6 (A3 item 6b): membership checks at the history page API, the summary read and
  the socket's `msg` frame, and one sentence on transport encryption, or an explicit
  deferral of each. Store replica loss and N2 left this list on 2026-11-02 (§2.7).
- Items 7 (end of replay) and 8 (delivery cursor) left this list on 2026-11-02
  (§4.4, §3.4).
- Presence debounce versus the client's reconnect: the relation the 5 s debounce, the
  15 s mirror rule and the first backoff must keep (§7.4).
