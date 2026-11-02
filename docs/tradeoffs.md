# Trade-offs — The Chat System

One entry per bullet of [`specification.md`](specification.md) §5.1–§5.8, in the
spec's *chosen / rejected / why* format. Each entry names the section of
[`design.md`](design.md), the ADR in `.memory/decisions/`, or the component of the
discussion page ([`index.html`](index.html)) where the decision was made, and the
figure from [`estimation.md`](estimation.md) that decided it, where one did.
Nothing here is decided for the first time: a bullet with no verdict in those sources
is listed as **open** below and left open.

Bullet IDs are the spec's section number plus the bullet's position (`5.3.2` is the
second bullet of §5.3).

## Open

Bullets, or halves of bullets, with no decision anywhere in the design. They are the
input to epic A3; they are not answered here. Closed since the first run: 5.2.2 and
5.8.1, by the service-discovery ADR of 2026-11-02, 5.3.5, by the reply-quoting ADR of
the same day, and 5.8.2, by the store-quorum ADR of the same day (entries below).

| ID | Bullet | What is open | Where the raw material is |
|----|--------|--------------|---------------------------|
| 5.8.4 | Observability | the five metrics to page on are not named anywhere | — |

Not a §5 bullet but open on the board for the same reason: **production runtime**
(deliberately undecided; the prototype runtime is decided, ADR
`2026-11-01-prototype-runtime-nodejs.md`).

---

## 5.1 Client ↔ server communication

### 5.1.1 Protocol for the real-time path

- **Chosen:** WebSocket, server-initiated protocol-level ping/pong. The canonical
  frame (Alex Xu ch. 12), adopted 2026-11-01. Design §1.
- **Rejected:** long polling and SSE (request overhead per message, one direction
  only); raw TCP (no browser client, no proxy traversal, nothing gained over a
  WebSocket frame); HTTP long-poll "heartbeat" (design §1.6: reintroduces a request
  per interval, the reason WebSocket was chosen).
- **Why:** N1 is p50 < 100 ms server to server; anything that pays a request per
  message fails the p50 (board, requirement F3). A persistent socket also gives the
  server a place to push presence and receipts.
- **Number:** estimation §2: 15 M sockets at peak, 100 k per chat server, ~200
  servers. That is the fleet the stateful layer has to be.

### 5.1.2 What goes over the socket and what over HTTP

- **Chosen:** the socket carries *new* traffic only: `hello`/`hello_ack`, `msg`/`msg_ack`,
  `deliver` + `ack`, receipts, presence `watch`/`unwatch` and events. Everything
  cacheable or bursty is HTTPS on the API servers: conversation history pages
  (§2.1, §2.3), the conversation summary on reconnect (§4.3), media intent and media
  URL minting (§6.2, §6.3), login and profile (implied by the stateless API layer of
  the frame). `GET /chat-servers` is static or gone behind the load balancer (§1.4,
  5.2.2). Design §2.1, §4.3, §6.
- **Rejected:** fetch history over the WebSocket (§2.6); derive the chat list from the
  queue replay instead of a summary read (§4.6); media bytes through any server (§6.5).
- **Why:** a deep scroll by one user must not compete with live delivery for everyone
  on that chat server; the list must render before the replay drains; media bytes
  dwarf text and must never ride the real-time path.
- **Number:** estimation §3.2: 100 TB/day of media against ~35 MB/s of real-time
  inbound text; estimation §2: 210 MB/s outbound push at peak for the whole fleet.
  The media figure is the one that forbids bytes on the socket.

### 5.1.3 Connection lifecycle: heartbeat, reconnect, what is resent

- **Chosen:** server ping every 5 s, two misses = dead at ≈ 10 s, 1 s sweeper over an
  in-memory `last_pong_at`; client mirror rule: no ping for 15 s → close and
  reconnect. Reconnect with backoff 1 · 2 · 4 … 30 s cap, ±30 % jitter, to whichever
  healthy server the load balancer assigns (5.2.2). After reconnect the client sends `hello` with
  its device cursor and flushes its outbox; each outbox message carries a
  `client_msg_id` the server dedups on for 24 h. Design §1.2–§1.5.
- **Rejected:** client-initiated JSON ping; TCP keepalive only; presence derived from a
  Redis key refreshed on every pong; long-poll heartbeat (all §1.6). A 15 s or 30 s
  ping interval (§1.3 table): would give 30 s or 60 s detection, which fails F7.
- **Why:** F7's 10 s detection sets the interval; the heartbeat must live in the
  transport layer so application backpressure cannot starve it; browsers answer
  protocol pings for free. Jitter so a dead server's 100 k clients do not thunder-herd
  the survivors. The device cursor makes reconnect a resume, not a restart.
- **Number:** estimation §2: 20 k ping frames/s per server, 3 M/s fleet, ~2 MB/s per
  server on the wire, negligible; the forbidden alternative (a Redis write per pong) is
  the same 3 M/s as Redis writes, which is why pongs touch memory only. Design §1.4:
  100 k clients spread over 30 s ≈ 3 k connects/s, which the API layer absorbs.

## 5.2 Service decomposition

### 5.2.1 Stateful real-time servers vs stateless API servers

- **Chosen:** the canonical split. Chat servers are stateful: they hold the sockets,
  the per-connection table (`conn_id → user, device, last_pong_at, app_state`), the
  presence watch sets, and they do the fan-out on write (store, ack, route lookup,
  push, queue append). API servers are stateless HTTP: history paging, conversation
  summary, media intent and URL minting, chat-server lookup, login and profile.
  Design frame paragraph, §1.5, §2.1, §4.3, §5.3, §6.
- **Rejected:** the pre-frame lean, a Kafka-backed sync queue in the delivery path
  between chat servers (board Component 3, "How we argued it"); the merged shape where
  the real-time fleet also serves history (§2.6, "fetch history over the WebSocket").
- **Why:** state that must be in memory (sockets, pong times, watch sets) stays with the
  socket; everything else is a cacheable read path that scales on its own and can be
  restarted freely.
- **Number:** none; decided on the frame and on the path separation argued in 5.1.2.

### 5.2.2 Service discovery

- **Chosen (server → server half):** a routing table in Redis,
  `route:{user_id}:{device_id} → server_id`, written on connect, deleted by the
  sweeper on a dead connection, read on every delivery. Design §1.5, §5.3.
- **Chosen (client → server half, decided 2026-11-02):** **no registry.** A plain
  load balancer with an application-level health check (socket accepted, `hello`
  answered) and random assignment. The "least-loaded" requirement is dropped;
  `GET /chat-servers` is a static endpoint or disappears behind the balancer's
  address. Nothing runs `mark-all-offline(server_id)` on a node loss: routing heals
  from the client's reconnect within the 15 s mirror rule, presence from the lease
  (entry 5.8.1). Design §1.4, §1.5; ADR `2026-11-02-no-service-registry.md`.
- **Rejected:** a registry (etcd, Consul, the orchestrator) answering "least-loaded"
  (ADR: solves a load-skew problem no estimate shows); sticky routing of a user to a
  server across reconnects (board Component 2, "Sticky sessions?": sticky by
  connection, by nature of TCP; the inverse lookup is what is needed, never a pin).
- **Why:** delivery needs the inverse lookup at fan-out time, per device, and it must
  be gone within seconds of a drop, which is what the sweeper and the client's
  reconnect give. Choosing a server needs only "healthy", which a balancer answers;
  the jittered backoff already spreads a crash's reconnects, so no component has to
  know the load. A hung node must leave the pool, hence the app-level check.
- **Number:** estimation §2: 15 M route entries × ~100 B = 1.5 GB, one Redis node,
  replicated. For the balancer: design §1.4, 100 k reconnects over a 30 s window ≈
  3 k connects/s, which is what makes least-loaded unnecessary; random assignment
  skews load by a few percent at 100 k sockets per node, accepted.

### 5.2.3 Where presence lives and how it is kept fresh

- **Chosen:** detection is local to the chat server (the sweeper in §1.5). State
  lives in Redis `presence:{user}` with `last_seen`, as a **lease**: each chat server
  renews all of its users' keys every 2 min with a 5 min TTL, one pipelined batch per
  server. The lease is the only cleanup for a dead chat server (ADR 2026-11-02,
  entry 5.8.1); it is never on the pong path. Subscriptions live in
  chat-server memory (`watching[target] → set(conn)`); cross-server fan-out is one
  Redis pub/sub channel per watched user. Design §1.5, §5.3; ADR
  `2026-11-01-presence-subscription.md`.
- **Rejected:** presence key refreshed on every pong (§1.6, §5.6); 30 s detection to
  save heartbeat cost (§5.6): the heartbeat was never the cost, the lease was.
- **Why:** the chat server already knows locally who is connected; writing that to
  Redis on every pong answers a question nobody asked at 3 M writes/s. Decoupling the
  lease from detection kept F7 at 10 s for free.
- **Number:** estimation §2 and §4: lease writes 125 k/s fleet at a 2 min renewal,
  down from 500 k/s at 30 s; that correction is what removed the pressure to relax F7.

### 5.2.4 Where push notification is triggered

- **Chosen:** on the sending chat server, in the fan-out step, after the message is
  stored and the online devices have been pushed over their sockets: for every
  recipient device **without** a route entry, send a push hint
  `{conversation_id, message_id, sender_display_name}` through APNs/FCM, never the
  body; mute and do-not-disturb checked first, per conversation per user. Design §3.6.
- **Rejected:** push with the message body (§3.7).
- **Why:** the body would leave our boundary and go stale on delete or edit; devices
  with a live socket already have the message, so a push to them is noise.
- **Number:** none; decided on the boundary argument.

## 5.3 Message storage

### 5.3.1 Database choice

- **Chosen:** a wide-column store (Cassandra or ScyllaDB), RF 3, quorum writes, with
  SSTable compression and age-based tiering required, not optional. Design §2.2,
  §2.5; board Component 2.
- **Rejected:** sharded Postgres (board Component 2): reads are fine, but the write
  path funnels through one primary per shard and 730 TB of growth is manual sharding
  work. Parked with "nobody here has run Cassandra in anger" noted as the real risk.
- **Why:** the access pattern is append-heavy, read-recent, almost never update;
  commit-log plus memtable with no primary scales writes with nodes. Cross-row ACID
  is given up because nothing needs it: fan-out is retried idempotently on a fixed ID.
- **Number:** estimation §1 and §3.1: 115 k writes/s peak; 730 TB raw over 5 years,
  2.2 PB at RF 3, ~550 nodes for disk against ~15 for throughput, so the cluster is
  storage-bound 30:1. That ratio is what made compression (3–4×, ~600 TB on disk)
  and tiering mandatory.

### 5.3.2 Table and key design; how history is paged

- **Chosen:** one `messages` table for 1:1 and groups (a 1:1 chat is a conversation
  with two members). Partition key `(conversation_id, bucket)` where `bucket` is the
  month; clustering `message_id DESC`. "Open a conversation" reads the newest 50 from
  the current month's partition and walks back a month at a time if short; "scroll
  up" is `?before={message_id}&limit=50`, the bucket chosen from the Snowflake
  timestamp without a lookup. Cursor pagination, never offset. Design §2.2, §2.3.
- **Rejected:** one partition per conversation with no bucket; offset pagination;
  load full history on open (all §2.6).
- **Why:** a five-year-old group as one partition is the known Cassandra failure
  mode; offsets are O(n) and skip or duplicate rows while messages arrive; a full
  load of a 100-member group is hundreds of MB and makes F3's p50 impossible.
- **Number:** none from `estimation.md`; design §2.2's own sizing: a 100-member group
  at 10 k messages a day is ~300 k rows and ~60 MB per monthly partition, under the
  100 MB guideline.

### 5.3.3 Message ID generation

- **Chosen:** Snowflake IDs minted on the chat server that receives the `msg` frame
  (time-ordered, 41-bit ms timestamp, 10-bit node, 12-bit sequence). The ID is the
  sort key, the pagination cursor, the sync cursor, and it selects the month bucket.
  Design §2.2, §2.3; board Component 2.
- **Rejected:** sorting by `created_at` (board Component 2): same-millisecond
  collisions need a tiebreaker anyway and a timestamp is an ambiguous cursor; kept
  as a display column. The spec's other candidates (global sequence, per-conversation
  sequence) were not argued; the design went straight to Snowflake with the frame.
- **Why:** unique, sortable within a conversation, mintable at 115 k/s on any chat
  server without coordination. Clock skew between chat servers is accepted: a quoted
  reply carries its parent ID explicitly, so cross-server ordering by a few ms does
  not break anything that depends on it.
- **Number:** estimation §1: 115 k writes/s peak, which rules out any ID scheme that
  needs a round trip to a sequence.

### 5.3.4 Retention and tiering for 5 years

- **Chosen:** keep everything queryable in the primary store. Partitions older than
  12 months move to the cluster's cold tier (cheaper disks, longer compaction
  interval); media objects follow their message's age into colder object-storage
  classes (90 days, archive at a year); deletion is tombstone + TTL, never a
  synchronous delete across 60 monthly partitions. Design §2.5, §6.4.
- **Rejected:** device-only history (§2.6): a new device has no history and a lost
  phone loses it, failing F5 and F6.
- **Why:** F5 says history is kept forever; retention is a storage-class question,
  not a deletion policy. Deep scrolls are rare and the user has signalled they will
  wait.
- **Number:** estimation §3.1: 730 TB raw text over 5 years, storage-bound 30:1; the
  tiering line in design §2.5 exists because of that ratio.

### 5.3.5 Reply reference

- **Chosen (storage half):** `reply_to bigint` in the `messages` row, the parent's
  Snowflake ID, nullable. A parent outside the device's loaded window is fetched by
  key, `GET /conversations/{id}/messages/{message_id}`, then paged around with
  `before` and `after`. Design §2.2, §2.3.
- **Chosen (quoting half, decided 2026-11-02):** **resolved by ID on render; no
  excerpt is copied into the reply row.** The page API carries the parents:
  `GET /conversations/{id}/messages` returns a `parents` map of every message a
  `reply_to` in the page references and the page does not contain, read by key from
  the store in one batch, bucket from the parent's Snowflake ID. The client never
  issues one request per quote; the device cache keeps parents it has seen. A parent
  that is gone is absent from the map and renders as F10's "message unavailable"
  placeholder, a render rule. The `msg` handler rejects a `reply_to` from another
  conversation. Jump-to-parent is unchanged. Design §2.2, §2.3; ADR
  `2026-11-02-reply-quote-by-id.md`.
- **Rejected:** a denormalized excerpt in the reply row (ADR: stale on edit, survives
  delete, and F10's placeholder would need a second write path into every child,
  prebuilding the §8.5 edit/delete follow-up wrong); resolve by ID with the client
  fetching each missing parent (ADR: one `GET /messages/{id}` per quoted parent
  outside the page, tens of requests on a reply-heavy scroll).
- **Why:** the ID reference is forced by F10 (one parent, same conversation) and by
  the Snowflake decision; one source of truth per message makes edit and delete a
  one-row change and the placeholder a render rule; the server reads the same keys
  the client would, in one batch instead of tens.
- **Number:** design §2.3: a page is 50 messages, so `parents` is at most 50 extra
  rows, the accepted cost; a cold-bucket parent is one keyed read, no walk.

## 5.4 Media

### 5.4.1 Upload path and the 10 MB limit

- **Chosen:** direct to object storage with a pre-signed PUT. `POST /media/intent
  {size, mime, sha256}` on an API server validates `size ≤ 10 MB`, mints a 10-minute
  URL with `content-length = size` and `content-type = mime` conditions, and returns
  `{media_key, put_url}`. The bucket rejects anything larger before a byte is
  stored. On violation the client is refused at the intent step, before any byte
  moves (the simulated client shows this for a 12 MB file). Design §6.1, §6.2; ADR
  `2026-11-01-media-no-server-processing.md`.
- **Rejected:** upload through the API servers (§6.5).
- **Why:** every byte would cross our fleet twice to enforce a cap the signed URL
  already enforces.
- **Number:** estimation §3.2: 100 TB/day uploaded, 1.2 GB/s average and ~6 GB/s
  peak; that bandwidth must not touch our servers.

### 5.4.2 How a message references its blob, and when it is sent

- **Chosen:** the message carries `media_key` (`{region}/{yyyy}/{mm}/{uuid}`,
  immutable object), `media_size`, `media_mime` and the `sha256`. The message is
  sent over the socket **after** the upload completes. The client shows the outgoing
  bubble with a progress bar from its outbox in the meantime. The hash lets the
  sender skip re-upload of a file already sent and lets the recipient verify the
  download. Design §6.2; ADR media.
- **Rejected:** sending the message before or in parallel with the upload (the
  other two options in the spec bullet).
- **Why:** the recipient must never see a message whose media does not exist yet;
  the outbox already gives the sender an immediate bubble, so nothing is lost by
  waiting.
- **Number:** none.

### 5.4.3 Download path and caching

- **Chosen:** on demand, when the bubble scrolls into view, never pushed. `GET
  /media/{key}/url` on an API server returns a signed GET, 1 h. Regional buckets;
  the upload URL points at the sender's region and the key records it. CDN **only in
  front of group media**; 1:1 media is served from the bucket. The minting step picks
  the host by conversation type. Design §6.3, §6.4; ADR media.
- **Rejected:** CDN in front of everything; a global bucket (both §6.5).
- **Why:** a 1:1 attachment is fetched ~1.5 times, where a CDN edge adds a hop and a
  miss; a group attachment is fetched up to 150 times in a burst right after send,
  the pattern a CDN exists for. Most conversations are intra-region.
- **Number:** estimation §3.2: ~500 TB/day downloaded, 6 GB/s average, ~30 GB/s peak;
  a 10 MB video to 150 devices is 1.5 GB per send, and "a CDN edge serving it once
  from origin is the only way the origin bucket survives". That number settled the
  CDN split.

### 5.4.4 Authorization on blob access

- **Chosen:** at URL-minting time, against membership of the message's conversation.
  The signed URL is a bearer token with a 1 h life; keys are unguessable and the
  bucket does not list. Design §6.3; ADR media.
- **Rejected:** proxying downloads through our servers for authorization (§6.5).
- **Why:** the proxy reintroduces bytes through our servers to avoid a 1 h bearer
  URL; a leaked URL working for an hour is an accepted risk (ADR risks table).
- **Number:** none.

### 5.4.5 Blob retention and deletion

- **Chosen:** blobs are kept with their messages (F5: forever) and tiered by age:
  colder storage class after 90 days, archive after a year, signed-URL path
  unchanged. When a message is deleted the object is **not** deleted synchronously;
  it expires by lifecycle rule. Design §2.5, §6.2, §6.4.
- **Rejected:** synchronous blob delete on message delete (implied by §6.2's "rather
  than deleting synchronously"; no other alternative recorded).
- **Why:** the object is immutable and may be referenced by a forward (same `sha256`
  skips re-upload); a lifecycle rule is the cheap, eventually consistent way to let
  it go.
- **Number:** estimation §3.2: 180 PB over 5 years, 250× the text volume; tiering is
  the only lever on that cost short of the 10 % media rate.

## 5.5 Message delivery

### 5.5.1 Fan-out strategy for groups

- **Chosen:** fan-out on write. The sender's chat server stores the message, acks the
  sender, then for every recipient device (and the sender's other devices) looks up
  the route and pushes directly to that device's chat server; devices without a
  route get a queue entry and a push hint. Sized to the 100-member ceiling; there is
  **no threshold inside this design**. Discord-style channels at 10 k+ are a
  different product shape with their own pass (spec §8.3), where the answer flips to
  fan-out on read. Design "Group ceiling" paragraph, §4.2; board Component 3.
- **Rejected:** fan-out on read (board Component 3: right for 100 k-member channels,
  wrong for groups of 100 where recipients expect delivery without asking); Kafka in
  the hot path (board: its p99 alone can eat most of the 500 ms budget for a
  recipient who could have been pushed to directly).
- **Why:** at the product's group size the average send is small and the worst case
  is bounded; paying a queue's latency on every message to protect against a case
  the product does not have is the wrong trade.
- **Number:** estimation §1: ~6 deliveries per message on average, 150 for a full
  group; 700 k pushes/s at peak. Fan-out on write is sized by the average,
  backpressure by the worst case.

### 5.5.2 Per-device sync queue: structure and overflow

- **Chosen:** one Redis Stream per device, entries carry `message_id` and
  `conversation_id` only (~50 B), 24-hour window trimmed hourly by `XTRIM MINID`,
  `MAXLEN ~ 100000`. Three operations and nothing else: `XADD … *` on fan-out
  (Redis-assigned ids, `message_id` in the entry; 5.5.2b, decided 2026-11-02),
  `XRANGE` from the device cursor in batches of 100
  on replay (bodies joined from the message store), `XTRIM` by time. Nothing is
  deleted on ack. When it fills (`MAXLEN` reached) or the cursor is older than the
  trim, the device takes the **slow path**: conversation summary over HTTPS, then
  each chat loads from the message store on open; nothing is lost, the device pays
  latency. Write order is an invariant: store → sender ack → queue append. Design
  §4.2, §4.5; ADR `2026-11-01-sync-queue-redis-streams.md`; board Component 3.
- **Rejected:** no queue at all, compare cursors and page the store per conversation;
  queue rows carrying bodies; one queue per user; a 30-day window; a Cassandra table
  with TTL; Kafka with a partition per user (all §4.6). Delete on ack (board:
  tombstones where the cursor already hides acked rows).
- **Why:** the queue is exactly the ordered stream a reconnecting device needs across
  200 conversations; bodies would make it 40× larger and stale on edit; per user
  cannot express "phone behind, laptop current". The window decides the backing:
  at 24 h Redis fits and its commands map one-to-one onto the three operations.
  Store-first means losing Redis loses the map of what a device lacks, never a
  message or a true "sent".
- **Number:** estimation §3.3: 700 k appends/s peak, six times the message store's
  write rate; 54 TB live at a 30-day window (forces Cassandra or Kafka, and 12 B
  expiring rows a day is the tombstone failure) against ~1.8 TB at 24 h (fits a
  ten-node Redis cluster). Each extra day of window costs ~600 GB before replication.

### 5.5.2a Replay-to-live handoff

Not a spec bullet: a B9 finding on 5.5.2 (design §7.9), decided 2026-11-02.

- **Chosen:** live first, then replay. On `hello{cursor}` the chat server subscribes
  the connection to live pushes before it starts the `XRANGE` loop; there is no replay
  phase in the connection state machine and no flip. A message appended during the
  replay reaches the device twice, and the client's store, keyed by `message_id`,
  makes the second copy a no-op. Frames are not in `message_id` order on the socket
  during the replay; the client renders from its store sorted by `message_id`, the
  order the message store clusters by and the history page returns. Cursor rule: the
  device cursor advances on replay batch acks only until the end-of-replay marker
  (design §7.3, now required); a live frame before the marker is stored but its entry
  id is not applied; after it, each live frame carries its entry id and advances the
  cursor as before. Design §4.4; ADR `2026-11-02-live-first-replay-xadd-auto-id.md`.
- **Rejected:** one more `XRANGE` after the flip, with the client deduping the overlap
  (keeps the window structure and the replay phase, adds a read on every reconnect,
  which is the reconnect-storm path, and still leaves a smaller window between that
  read and the flip); a server-side buffer of live pushes during the replay, released
  deduplicated at the flip (a per-connection buffer unbounded under a slow replay,
  memory on the chat server exactly during a reconnect storm, and it keeps the replay
  phase in which B3 found the ack deadlock).
- **Why:** both patches assume replay first, then live. The author's answer removed
  that assumption: ids are Snowflakes and the client re-sorts by `message_id` in its
  local store anyway, because send order is not reliable, so monotonic frame order on
  the socket during the replay was never a requirement. Without it the window is gone
  with no extra read and no server buffer, and the state machine loses a phase.
- **Number:** 15 M sockets (estimation §2) is the reconnect-storm path the extra read
  would land on. The overlap is bounded by the replay's duration, at ~50 B per entry
  and one body join per copy.

### 5.5.2b Per-stream append order

Not a spec bullet: a B9 finding on 5.5.2 (design §7.9), decided 2026-11-02.

- **Chosen:** `XADD … *`, Redis-assigned stream ids, `message_id` in the entry body,
  no serialisation per device stream. A late append lands behind the top entry and is
  replayed instead of refused. Idempotent retry on the retry path only: when an `XADD`
  times out, the appender reads the tail (`XREVRANGE sq:{device} + - COUNT 100`) and
  skips the append if that `message_id` is present. Best effort, so the client dedup
  by `message_id` is the guarantee and a duplicate costs one `MAXLEN` slot and one
  body join. The two-layer dedup of 5.8.2 is unchanged. Design §4.2; ADR
  `2026-11-02-live-first-replay-xadd-auto-id.md`.
- **Rejected:** explicit Snowflake-derived stream ids with appends serialised per
  device stream (a lock or single writer per device on the fan-out path, and a late
  append is still refused rather than queued); a `SET NX` dedup key per entry before
  `XADD *` (exact idempotency, but it doubles Redis writes on the normal path and adds
  a key per entry, where the retry-path tail read gives the same property where it
  matters at no normal-path cost).
- **Why:** Redis refuses an `XADD` whose id is at or below the top entry, so explicit
  ids turn an out-of-order fan-out into a lost entry unless something serialises the
  appends. The §4.2 code block already showed `*`; the prose that contradicted it is
  withdrawn. The author's requirement that a retried append stay idempotent is met
  where retries happen, not on every append.
- **Number:** estimation §3.3: 700 k appends/s at peak is what a per-stream lock would
  sit on; a `SET NX` per entry would double Redis writes to ~1.4 M/s at peak.

### 5.5.3 Exactly-once vs at-least-once, and client-side dedup

- **Chosen:** at-least-once everywhere, with dedup at two points. On send, the server
  dedups on `(sender_id, client_msg_id)` for 24 h and answers a retry with the
  original `message_id`, storing nothing. On delivery, the client dedups by
  `message_id`: a replay that overlaps live traffic or a store page is harmless. A
  cursor advances only on the device's ack, so loss of any cursor causes more
  replay, never less. Design §1.4, §2.2, §4.4, §4.7; board Component 2 (CAP: AP with
  quorum writes, duplicates are the price).
- **Rejected:** exactly-once as a transport guarantee, which would need a CP store
  and an atomic fan-out; the board's CAP answer gives that up so a partition
  "degrades to delayed, never cannot send".
- **Why:** every retry loop in the system (outbox flush, fan-out, queue append,
  replay) is idempotent on a fixed ID, the queue append by a best-effort tail read on
  its retry path only (5.5.2b), so duplicates are cheap to absorb and impossible to
  prevent without coordination on the hot path.
- **Number:** none; decided on the idempotency argument.

### 5.5.4 Ordering across devices and group members

- **Chosen:** order within a conversation is the Snowflake `message_id`, minted once
  on the sending chat server; every device sorts by it, replay is in ID order, the
  store's clustering order is by it. Consistent, not causal: two senders on two chat
  servers with skewed clocks may interleave by a few ms, accepted. Design §2.2, §4.2;
  board Component 2.
- **Rejected:** `created_at` as the order (board Component 2).
- **Why:** N4 asks for the same order on every device, which one integer per message
  gives without any cross-server agreement; F10 carries its parent ID explicitly, so
  the only place causality matters does not depend on timestamp order.
- **Number:** none.

## 5.6 Offline and multi-device

### 5.6.1 How each device tracks its sync point

- **Chosen:** the device owns `last_synced_message_id` and sends it in `hello` on
  every connect; the server never stores it. A second device-owned cursor,
  `list_cursor` (newest `last_at` seen), drives the summary read. The server-owned
  cursor is `last_read_id` per user per conversation, durable in Cassandra, cached in
  Redis. A device with no cursor (reinstalled, wiped) is a new device and takes the
  slow path. Design §2.3, §4.7; ADR sync queue.
- **Rejected:** a server-stored copy of the device cursor; Redis or Kafka as a cursor
  store (§4.7).
- **Why:** only the device knows what it has rendered, so only it can say what it
  lacks; a second copy can disagree. Redis loses on a full-cluster failure and would
  convert every device to the slow path at once; a Kafka offset cannot name a
  message ID.
- **Number:** none; decided on the ownership argument.

### 5.6.2 Push notification path and deduplication across devices

- **Chosen:** push hint to **every** device of the recipient that has no live socket;
  none to devices that have one (they got the frame). The hint carries IDs and the
  sender's display name only. When the user opens the conversation on any one device,
  the read-cursor push (§3.5) clears the badge on the others; the OS shows the
  notification where the user is. Badge count = unread conversations, read from
  Redis, so icon and in-app list agree. Design §3.6.
- **Rejected:** push with the body (§3.7); push to one device only (§3.6 step 3
  states "not only one"; no further alternative recorded).
- **Why:** the socket is the dedup: a device either has the message or gets the
  hint, never both; cross-device "already seen" is the read cursor's job, not the
  push gateway's.
- **Number:** none.

### 5.6.3 Read-receipt propagation

- **Chosen:** one read cursor per user per conversation, `SET last_read_id =
  max(last_read_id, X)`, idempotent and commutative. The client sends a receipt when
  the newest visible message changes, coalesced to one per conversation per 2 s. The
  chat server writes the cursor, pushes `{conversation, user, last_read_id}` to the
  members who currently have that conversation open, and to the reader's own other
  devices (which clear their badge). Members not looking get the cursor when they
  next open the chat, from the partition. Delivered receipts follow the same shape
  keyed by device. Sender-side status is derived from the cursors, never stored.
  Design §3.3–§3.5.
- **Rejected:** one receipt row per message per member; push every receipt to every
  member; per-device read cursor; a stored unread counter (all §3.7).
- **Why:** reading is monotonic, so "how far has each member read" is one number
  per member; per message it is 100 rows per message in a full group and 15 000
  pushed frames; a per-device cursor leaves the laptop unread after the phone read
  it, breaking F6; a counter drifts from the cursor on any retry.
- **Number:** estimation §3.4: receipt writes ≈ 25 % of deliveries after coalescing,
  175 k/s peak, to tiny partitions; cursor rows 250 GB + 375 GB. Design §3.2's
  15 000 frames per message is the figure that killed the per-message shape.

## 5.7 Presence

### 5.7.1 Heartbeat design and its cost

- **Chosen:** ping every 5 s, dead after two misses (10 s), the F7 target exactly.
  Pongs update memory only; nothing on the heartbeat path touches Redis. Design §1.2,
  §1.3, §1.5. The trade is stated in §1.3: if product ever accepts 30 s, the interval
  becomes 15 s and fleet heartbeat traffic drops 3×.
- **Rejected:** 15 s and 30 s intervals (§1.3 table); presence key refreshed on each
  pong (§1.6, §5.6); relaxing F7 to 30 s (§5.6, ADR presence: would have saved
  nothing once the lease was decoupled).
- **Why:** detection latency is `interval × misses`; F7 fixes the product of the two.
  The frames are not the cost; what the server does on each pong is, and that is
  nothing.
- **Number:** estimation §2: 3 M frames/s each way across the fleet, 20 k/s per
  server, ~300 MB/s fleet on the wire, negligible. The same §2 corrected the earlier
  500 k/s Redis lease figure that had been (wrongly) charged to the 10 s target.

### 5.7.2 Fan-out of presence changes

- **Chosen:** subscription only. A device `watch`es the users on its screen (the
  other party of an open 1:1, the rendered members of an open group, visible list
  rows) and `unwatch`es on leaving; changes batched per 500 ms. Per-user state
  machine `offline → online → pending-offline (5 s) → offline`, `last_seen` on the
  final transition; a reconnect inside 5 s emits nothing. Propagation bound: within
  15 s normally, 30 s worst case. Cross-server: one pub/sub channel per watched user,
  joined only by servers with a watcher. Where it changes: a 100 k-member Discord
  server, where a member list is a "who is online" screen (spec §8.3). Design §5;
  ADR `2026-11-01-presence-subscription.md`.
- **Rejected:** push every transition to every online contact; pull on open with no
  push; no debounce (all §5.6).
- **Why:** cost proportional to screens, not to the social graph; the dot must change
  while a chat is open (F7); without the debounce every tunnel flaps the dot for all
  watchers and doubles pub/sub traffic.
- **Number:** design §5.5 (derived from estimation §2's 15 M devices): 50 pushes per
  flap per user under constant mobile flapping for the contact-list shape; 15 M
  devices × ~25 watched users ≈ 375 M subscription entries, ~15 GB across 200
  servers for the subscription shape.

## 5.8 Reliability and operations

### 5.8.1 Failure of one chat server

- **Chosen (connections and in-flight messages):** clients notice the dead socket
  within 15 s (mirror rule) and reconnect with jittered backoff through the load
  balancer to a healthy server (5.2.2). In-flight sends are in the client outbox with a
  `client_msg_id` and are flushed on reconnect; a message that was stored but whose
  ack was lost is answered with the same ID. Messages stored for the dead server's
  users are already in their sync streams (write order store → ack → queue), so the
  replay from the `hello` cursor delivers them. Nothing in the chat server's memory is
  a source of truth: the conn table and watch sets are rebuilt by the reconnects.
  Design §1.4, §1.5, §4.2, §4.7.
- **Chosen (routing and presence cleanup, decided 2026-11-02):** nobody runs
  `mark-all-offline(server_id)`. The stale route is overwritten by the device's own
  `hello` on the new node within the mirror rule; a push to the dead node in that
  window fails inside the bounded buffer's timeout and the message is already in the
  stream. Presence is cleaned by the existing lease only: renewed every 2 min, 5 min
  TTL. A device that lost its server and its network together shows online for up
  to 5 min; accepted. Design §1.5; ADR `2026-11-02-no-service-registry.md`.
- **Rejected:** a liveness watcher running `mark-all-offline` within seconds (ADR: a
  component for one coincidence); a 30 s lease TTL to shrink the window (ADR: forces
  renewal every ~10 s, 1.5 M Redis writes/s); plus the alternatives in 5.1.3.
- **Why:** bounded data loss is zero for acknowledged messages by the write-order
  invariant; the cost of a node loss is a reconnect storm, which the jitter bounds,
  and a presence error bounded by the lease TTL on a rare coincidence. Conditions
  (ADR): the balancer's check is application-level, and the bounded buffer's timeout
  is shorter than the N1 p99 budget, which the prototype's 5 s default (design §7.8)
  does not yet meet; that sizing belongs to the backpressure write-up (5.8.3).
- **Number:** design §1.4: 100 k clients over a 30 s window ≈ 3 k connects/s. Lease:
  125 k writes/s at 2 min / 5 min, unchanged; 1.5 M/s at a 30 s TTL, rejected.

### 5.8.2 Failure of the message-store primary

- **Chosen (decided 2026-11-02):** the store has no primary (Cassandra, RF 3), so the
  failure designed for is two of a token range's three replicas down at once. Writes
  go at LOCAL_QUORUM; on a QUORUM timeout the chat server retries once at ONE and
  acks (budget 300 ms + 300 ms, the author's numbers to confirm). A write that fails
  even at ONE is not acked: the outbox shows "sending…" and resends on backoff. Reads
  (history page, summaries, cursors) follow the same rule, so normal mode is
  R + W = 4 > RF. Dedup at two layers: the index read at LOCAL_QUORUM fails open on a
  timeout and stores, and the `deliver` frame carries `sender_id` and `client_msg_id`
  so the client drops a double. Recovery is hinted handoff (3 h window) then a repair
  of the range; operators page on the count of writes acked at ONE per minute. Loss
  bound: zero in normal operation; during a degraded window, the messages acked at ONE
  on that range, lost only if the last replica also dies before hints replay. Design
  §2.2, §2.7; ADR `2026-11-02-store-quorum-fallback-one.md`.
- **N2 statement (same ADR):** the send/receive path stays available through the loss
  of up to two replicas of any range, at the cost of N3 for the messages acked at
  ONE, which now reads "absolute at QUORUM; during a degraded range, once replicated"
  (spec N3 carries a footnote). Loss of all three replicas of a range, or of the
  cluster, is unavailability for the affected conversations: sends are held in the
  outbox and delivered when the store returns; nothing is lost on the client side.
  Multi-region failover is deferred to spec §8.7.
- **Rejected:** ONE for every write, always (the author's first choice, revised in the
  debate: it opens the loss window on every message at every moment, including
  rolling restarts, and breaks read-your-writes for dedup, unread and the second
  device); QUORUM with no fallback (a two-replica loss becomes "cannot send" for the
  affected conversations, against the availability priority); client dedup by
  `client_msg_id` only, with no QUORUM index read (every retry after a lost ack would
  store a second row in normal operation; kept as the second layer, not the only one);
  refusing the send when the dedup read times out (consistent with N3, inconsistent
  with the priority this decision sets).
- **Why:** the system is write-heavy and availability comes first. With RF 3 and two
  replicas down there is no third option between waiting (QUORUM) and resting the ack
  on one replica (ONE), so the fallback is taken only on the range, and only while,
  that choice is forced. The write-order invariant (store, at whatever level, before
  the ack) is unchanged, so the ack never lies about a write that did not happen.
- **Number:** 115 k writes/s peak (estimation §1) is trivial for the store at QUORUM,
  and the QUORUM-to-ONE latency difference is about one internal round trip. ~550
  store nodes (estimation §3.1) bound one range's share of the conversations.

### 5.8.3 Backpressure when a hot group floods a server

- **Chosen (on the board, not yet in `design.md`):** a bounded per-destination buffer
  on the sending chat server's push path. If a recipient server does not take the
  push within budget, the message stays in that device's stream and the device
  catches up on its own through the normal replay; a slow recipient is a delay for
  one recipient, not a stall for the sender. Board Component 3; the roadmap routes
  the `design.md` write-up to A3.
- **Rejected:** a durable queue in the hot path to absorb the burst (Kafka in the hot
  path, board Component 3); unbounded buffering (implied by "bounded").
- **Why:** the sync stream already holds every undelivered message, so the push is
  an optimisation that may be dropped under pressure without losing anything.
- **Number:** estimation §1: backpressure is sized by the worst case, 150 deliveries
  per message to a full group, not by the ~6 average.

### 5.8.4 Observability: the five metrics to page on

- **Open.** See the open list. Nothing in the design names them.
