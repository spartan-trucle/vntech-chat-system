# Sequence diagrams — the nine flows of specification §4.2

One Mermaid `sequenceDiagram` per flow, drawn from [`design.md`](../design.md):
§1 (heartbeat, reconnect), §2.3 (history, jump to a parent), §3 (receipts, push),
§4.2–§4.4 (fan-out write order, reconnect as drawn), §5.4 (presence as drawn),
§6.2–§6.3 (media as drawn), and the fan-out decision on the discussion page
(Component 3). The questions under each heading are the spec's; the diagram answers
them in its notes. Open decisions appear as notes marked **open**, never as arrows.

Participants are the eight kinds the architecture has, and nothing else (the load
balancer joined on 2026-11-02 with the service-discovery decision; it appears only
where a device connects, flows 2 and 5):

| Participant | What it is in `design.md` |
|-------------|---------------------------|
| device | a phone, laptop or web client holding one WebSocket, an outbox and two cursors |
| API server | stateless HTTPS: history pages, conversation summary, media intent and URL minting |
| load balancer | one address for all chat servers; application-level health check (socket accepted, `hello` answered), random assignment; no registry behind it (§1.4, ADR 2026-11-02) |
| chat server | stateful: sockets, pong times, watch sets, fan-out on write |
| Redis | routing table `route:{user}:{device}`, sync streams `sq:{device}`, presence leases and pub/sub, summaries |
| message store | wide-column `messages`, `read_cursors`, `delivery_cursors`, dedup index; no primary, RF 3, LOCAL_QUORUM with one retry at ONE on timeout (§2.7, ADR 2026-11-02) |
| object storage | regional buckets, CDN in front of group media |
| push gateway | APNs / FCM |

A flow may show two instances of a kind (device A and device B, A's chat server and
B's chat server). When sender and recipient share a chat server the server-to-server
push in flows 1, 3, 6, 8 and 9 is a local socket write.

---

## Flow 1 · Send 1:1, recipient online

*Which hop assigns the message ID? Which hop acknowledges the sender?*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (sender)
  participant CSA as Chat server A
  participant MS as Message store
  participant R as Redis
  participant CSB as Chat server B
  participant B as Device B (online)

  A->>A: outbox append {client_msg_id (UUID), conversation_id, body}
  A->>CSA: msg {client_msg_id, conversation_id, body}
  Note over CSA: this hop assigns the ID: Snowflake message_id minted on the chat server
  CSA->>MS: dedup lookup (sender_id, client_msg_id), 24 h index, LOCAL_QUORUM
  Note over CSA,MS: if the dedup read times out (a degraded range) the server fails open and treats the message as new (decided 2026-11-02)
  alt already stored (a retry after a lost ack)
    CSA-->>A: msg_ack {client_msg_id, original message_id}, nothing stored
  else new, or the dedup read timed out
    CSA->>MS: INSERT messages (conversation_id, bucket, message_id, sender_id, client_msg_id, body), LOCAL_QUORUM at RF 3, 300 ms budget
    alt two of the range's three replicas answer (normal operation)
      MS-->>CSA: written at QUORUM
    else QUORUM timed out, two of three replicas down (decided 2026-11-02)
      CSA->>MS: INSERT again at ONE, 300 ms budget
      MS-->>CSA: written at ONE, counted for the operators' page
      Note over A,CSA: if ONE also fails there is no ack. A keeps the message in its outbox, shows sending, and resends on backoff
    end
    CSA-->>A: msg_ack {client_msg_id, message_id}
    Note over A,CSA: this hop acks the sender, only after the store write at whichever level. The bubble shows sent.
    CSA->>R: SET conv:{id}:summary, conv:{id}:last
    loop every recipient device, plus A's other devices
      CSA->>R: XADD sq:{device} MAXLEN ~100000 {m: message_id, c: conversation_id}
      CSA->>R: GET route:{user}:{device}
      R-->>CSA: server_id (B is online, so a route exists)
      CSA->>CSB: push deliver {message with sender_id and client_msg_id, stream_id}, direct, bounded per-destination buffer
      CSB->>B: deliver {message with sender_id and client_msg_id, stream_id}
      Note over B: B drops a second deliver with the same (sender_id, client_msg_id), the client half of dedup (decided 2026-11-02)
    end
    B->>CSB: ack {up_to_stream_id} (the device advances its own cursor, the server stores nothing)
    B->>CSB: receipt delivered {conversation_id, last_delivered_id}
    CSB->>MS: delivery_cursors (conversation, device) = max(old, new)
  end
  Note over CSA,B: N1 is measured from the msg frame arriving at Chat server A to the deliver frame written to B's socket
```

What it answers: the ID is minted on the sending chat server (§2.2, board Component 2);
the sender is acked by that same chat server after the store write and before any
fan-out (§4.2, write order store → ack → queue); the push to an online device is direct,
server to server, with no queue in the hot path (board Component 3). The store write
and the dedup read go at LOCAL_QUORUM; a range that has lost two of its three replicas
gets one retry at ONE before the ack, and a write that fails even then is not acked
(§2.7, decided 2026-11-02). The `deliver` frame carries `sender_id` and
`client_msg_id` so the client can drop a double from a fail-open dedup read.

## Flow 2 · Send 1:1, recipient offline

*Where does the message wait, how is the recipient notified, what happens on reconnect?*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (sender)
  participant CSA as Chat server A
  participant MS as Message store
  participant R as Redis
  participant PG as Push gateway
  participant B as Device B (offline)
  participant API as API server
  participant LB as Load balancer
  participant CSB as Chat server B (after reconnect)

  A->>CSA: msg {client_msg_id, conversation_id, body}
  CSA->>MS: INSERT messages (message_id minted here), LOCAL_QUORUM, one retry at ONE on timeout as in flow 1
  MS-->>CSA: written
  CSA-->>A: msg_ack {client_msg_id, message_id}
  CSA->>R: XADD sq:{B device} {m, c}
  Note over R: the message waits here, as an ID in B's stream, for 24 h. The body stays in the message store.
  CSA->>R: GET route:{B}:{device}
  R-->>CSA: none, no live socket
  Note over CSA,R: inside the 10 s after an unclean drop the route may still exist: the push goes to a dead socket and only the stream holds the message
  CSA->>R: mute and do-not-disturb check for (B, conversation)
  CSA->>PG: push hint {conversation_id, message_id, sender_display_name, badge = unread conversations}, never the body
  PG-->>B: notification on every B device without a socket

  Note over B: network returns (F11) or the user taps the notification
  B->>API: GET /conversations?since={list_cursor}
  API->>R: MGET conv:{id}:summary for 30-day-active conversations, read cursors
  API->>MS: summary table for the rest, bounded unread count on the current bucket
  API-->>B: changed conversations: last_message_id, preview, last_sender, unread_count, my_read_cursor
  Note over B: the chat list renders now, with the unread dot, before any replay
  B->>LB: WS connect to the one chat address
  Note over LB: a healthy node at random. Health check is socket accepted and hello answered. No registry, no least-loaded lookup (decided 2026-11-02)
  LB->>CSB: connection handed to Chat server B
  B->>CSB: hello {device_id, last_synced_message_id, list_cursor, app_state}
  CSB->>R: SET route:{B}:{device} = server_id, presence online
  Note over CSB: the connection is subscribed to live pushes first, before the replay starts. No replay phase, no flip (decided 2026-11-02)
  par the replay, from the cursor, XRANGE batches back to back, no ack awaited
    CSB->>R: XRANGE sq:{device} (last_synced_message_id, COUNT 100
    R-->>CSB: entries {m, c} newer than the cursor
    CSB->>MS: SELECT bodies by (conversation_id, bucket, message_id)
    MS-->>CSB: messages
    CSB->>B: deliver {message, stream_id, replay: true}, each entry of the batch
    B->>CSB: ack {up_to_stream_id} on B's own cadence, every 100 replay frames or 500 ms (author's numbers). It persists the cursor, never a credit
  and live pushes on the same socket, meanwhile
    CSA->>R: XADD sq:{B device} * {m, c}, a new message from A, Redis-assigned entry id
    CSA->>CSB: push deliver {message, stream_id}
    CSB->>B: deliver {message, stream_id, replay: false}
    Note over B: stored, keyed by message_id. If the replay later reaches the same entry the second copy is a no-op. In replay mode its stream_id is not applied to the cursor
  end
  CSB->>B: replay_done, no payload. Replay mode ends (decided 2026-11-02)
  Note over B: B renders from its store sorted by message_id, never in socket arrival order, the order the store clusters by and the history page returns
  CSB->>B: live traffic continues, deliver {message, stream_id, replay: false}, and B applies each stream_id to its cursor
  Note over B,CSB: part 2, later on the same connection: a live push is dropped by the bounded per-destination buffer
  CSA->>CSB: push deliver for a new message from A
  Note over CSB: B's buffer is full or the push is not taken within budget: dropped. The entry is in B's stream. B cannot see a dropped push, so the server acts (decided 2026-11-02)
  Note over CSB: live frames for this connection stop, the buffer drains. No replay_start frame, it could not be delivered now anyway
  CSB->>R: XRANGE sq:{device} (stream_id below the dropped entry, COUNT 100, back to back until empty
  R-->>CSB: entries from the dropped one on
  CSB->>MS: SELECT bodies
  MS-->>CSB: messages
  CSB->>B: deliver {message, stream_id, replay: true}. The first one puts B back into replay mode
  B->>CSB: ack {up_to_stream_id} on B's cadence
  Note over CSB: a further drop during this loop extends it. The loop ends only on an empty read
  CSB->>B: replay_done
  CSB->>B: live resumes, deliver {message, stream_id, replay: false}
  Note over B,CSB: offline longer than 24 h: the stream is trimmed past the cursor, no replay, each chat loads from the message store on open (slow path, flow 4 part 2)
```

What it answers: the message waits in Redis as an ID in the device's stream (§4.2),
with the body in the store; the recipient is notified by a push hint without the body
(§3.6); on reconnect the list comes from the summary read first and the messages from
the stream replay (§4.3, §4.4). The replay and live pushes share the socket from the
`hello` on: live first, then replay, no flip, so nothing appended during the replay is
skipped; the client dedups and sorts by `message_id`, and the device cursor takes a
live frame's `stream_id` only outside replay mode (§4.4, decided 2026-11-02). Replay mode
begins at `hello` and ends at `replay_done`; `deliver.replay` tells the two kinds of
frame apart, and `ack{up_to_stream_id}` persists the cursor on the client's own cadence
and is never a flow-control credit (§4.7). Part 2 draws the one way the connection
re-enters replay mode: a push dropped by the backpressure budget, after which the server
re-runs the replay alone from the dropped entry and sends `replay_done` before live
resumes (§7.8, decided 2026-11-02).

## Flow 3 · Send to a group of 100

*How is the fan-out performed, and at what point does the sender get an ack?*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (sender)
  participant CSA as Chat server A
  participant MS as Message store
  participant R as Redis
  participant CSn as Chat server n (a recipient's)
  participant Bn as Device n (one of up to 150)
  participant PG as Push gateway

  A->>CSA: msg {client_msg_id, conversation_id (group of 100), body}
  CSA->>MS: INSERT messages, one row whatever the group size
  MS-->>CSA: written
  CSA-->>A: msg_ack {client_msg_id, message_id}
  Note over A,CSA: the sender is acked once, here, after the store write and before any fan-out. Delivered and read come later, derived from cursors (flow 6).
  CSA->>R: SET conv:{id}:summary
  CSA->>R: MGET route:{member}:{device} for 99 members, up to 5 devices each, plus A's other devices
  R-->>CSA: a server per device with a socket, none for the rest
  loop every recipient device (up to 150), fan-out on write, bounded per-destination buffer
    CSA->>R: XADD sq:{device} * {m, c}, Redis-assigned entry id, retried in the same loop as the store write. On a timeout the retry first reads the stream tail and skips a present message_id (decided 2026-11-02)
    alt device has a route
      CSA->>CSn: push deliver {message, stream_id}
      CSn->>Bn: deliver
      Bn->>CSn: ack {up_to_stream_id}
    else no route
      CSA->>PG: push hint, never the body
    end
  end
  Note over CSA,CSn: a destination buffer that is full, or a push not taken within budget, is dropped. The entry is already in that device's stream. The device cannot see the drop, so the server re-enters replay for that connection and sends replay_done before live resumes (flow 2 part 2, decided 2026-11-02). A slow recipient delays one recipient, never the sender.
  Note over CSA: 150 deliveries is the worst case, about 6 is the average (estimation §1). Fan-out on write is sized by the average, the buffer by the worst case. No threshold inside this design: 100 is the product ceiling, 10 k and above is a different design pass.
```

What it answers: fan-out on write by the sending chat server (board Component 3); the
ack is sent once, after the store write and before the fan-out (§4.2); backpressure is
the bounded per-destination buffer with drop-to-stream (board Component 3, not yet in
`design.md`, routed to A3).

## Flow 4 · Multi-device sync

*A message read on the phone shows as read on the laptop. A device off for a week
comes back: how does it catch up?*

```mermaid
sequenceDiagram
  autonumber
  participant P as Device phone (user U)
  participant L as Device laptop (user U)
  participant CS as Chat server
  participant MS as Message store
  participant R as Redis
  participant API as API server

  Note over P,R: part 1, read on the phone, the laptop follows
  P->>CS: receipt read {conversation_id, last_read_id}, coalesced to one per conversation per 2 s
  CS->>MS: read_cursors (conversation, user U) = max(old, new)
  Note over MS: one read cursor per user, not per device, is what makes F6 hold
  CS->>R: cache the cursor for unread and summary
  CS->>L: read_cursor {conversation_id, last_read_id}
  Note over L: badge clears without being touched
  CS->>CS: push the cursor to members with the conversation open (flow 6)

  Note over L,API: part 2, the laptop was off for a week, longer than the 24 h sync window
  L->>API: GET /conversations?since={list_cursor}
  API->>R: MGET conv:{id}:summary (30-day-active), read cursors
  API->>MS: summaries for the rest
  API-->>L: changed conversations: last_message_id, preview, unread_count, my_read_cursor
  Note over L: the chat list renders now
  L->>CS: hello {last_synced_message_id (a week old), list_cursor}
  CS->>R: SET route:{U}:{laptop}
  CS->>R: XRANGE sq:{laptop} (last_synced_message_id
  R-->>CS: stream trimmed past the cursor (24 h window)
  CS-->>L: no replay, slow path
  Note over L: nothing is lost, the laptop pays latency instead
  L->>API: GET /conversations/{id}/messages?limit=50, on each open
  API->>MS: SELECT newest 50 from (conversation, current bucket), walk back a month if short
  API-->>L: messages, next_before
  Note over L: the client dedups by message_id if a page and a live frame overlap
  CS->>L: live traffic from now on
```

What it answers: one read cursor per user, pushed to the reader's other devices (§3.5);
a device beyond the 24 h window gets the chat list from the summary at once and loads
each conversation from the store on open (§4.2, §4.3, §4.7).

## Flow 5 · Presence

*User goes online, goes idle, loses connectivity without logging out. How do friends
learn about it, and how fast?*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (user A)
  participant LB as Load balancer
  participant CSA as Chat server A
  participant R as Redis
  participant CSB as Chat server B
  participant B as Device B (has A's chat open)

  Note over B,CSB: B is looking at A, so B subscribes. Nobody else is told anything.
  B->>CSB: watch {user_ids: A}, batched per 500 ms
  CSB->>R: GET presence:A
  R-->>CSB: state, last_seen
  CSB->>B: presence {A, state, last_seen}
  CSB->>R: SUBSCRIBE pres:A (first watcher of A on this server)

  Note over A,CSA: A goes online
  A->>CSA: WS connect, hello {app_state: foreground}
  CSA->>R: SET route:A:{device}, presence:A = online (lease, 5 min TTL)
  CSA->>R: PUBLISH pres:A {online}
  R-->>CSB: pres:A {online}
  CSB->>B: presence {A, online}, immediate

  Note over A,CSA: A goes idle: the mobile OS backgrounds the app and kills the socket within seconds, so idle becomes the unclean-drop case below. The hello on the next connect carries app_state, so the indicator shows away rather than a stale online (§1.2).

  Note over A,CSA: A loses connectivity without logging out (unclean drop at t)
  CSA->>A: ping (every 5 s), no pong
  CSA->>A: ping, no pong
  Note over CSA: t plus 10 s: the 1 s sweeper sees last_pong_at older than 10 s and closes the socket
  CSA->>R: DEL route:A:{device}
  CSA->>R: SCARD route:A
  R-->>CSA: 0, that was A's last device
  Note over CSA: state = pending-offline, 5 s debounce timer. With another device still connected nothing changes.
  alt A reconnects within 5 s (any device)
    A->>CSA: hello
    Note over CSA: timer cancelled, nothing published, B never sees a flap
  else the timer fires at t plus 15 s
    CSA->>R: SET presence:A = offline, last_seen = t
    CSA->>R: PUBLISH pres:A {offline, last_seen}
    R-->>CSB: pres:A {offline, last_seen}
    CSB->>B: presence {A, offline, last seen just now}
    Note over B: about t plus 15 s, within the 15 s target, 30 s worst case
  end
  loop every 2 min, per chat server
    CSA->>R: renew the presence leases of all local users (5 min TTL), never on the pong path
  end
  opt Chat server A itself dies (decided 2026-11-02, nobody runs mark-all-offline)
    Note over CSA: node lost. Its conn table and watch sets die with it. Its routes and leases stay in Redis until overwritten or expired
    alt A's device still has network
      Note over A: no ping for 15 s (mirror rule), then backoff
      A->>LB: WS connect
      LB->>CSB: a healthy node at random (here B's server)
      A->>CSB: hello {app_state}
      CSB->>R: SET route:A:{device} = CSB, overwriting the stale route, and presence:A = online, lease renewed
      Note over CSA,R: the stale route lived about 16 s. A push sent to it meanwhile failed inside the bounded buffer's timeout. The message is already in A's stream and replays now
    else A lost its network at the same moment
      Note over R: nobody renews presence:A. The lease expires up to 5 min after the last renewal. Nothing is published on pres:A, a watcher learns it at its next GET presence:A. Accepted as a bounded error (ADR 2026-11-02)
    end
  end
  B->>CSB: unwatch {user_ids: A}, leaving the screen
  CSB->>R: UNSUBSCRIBE pres:A (last watcher gone)
```

What it answers: only watchers learn (§5.1, §5.3); detection within 10 s, visible
within 15 s, 30 s worst case, a drop under 5 s never shown (§5.2, §5.4); the Redis lease
is off the pong path and exists only for a dead chat server (§1.5, §5.5).

## Flow 6 · Message status: sent, delivered, read

*Who records each transition and who is notified?*

```mermaid
sequenceDiagram
  autonumber
  participant S as Device S (sender)
  participant CSS as Chat server S
  participant MS as Message store
  participant CSR as Chat server R
  participant Rd as Device R (a recipient)

  S->>CSS: msg
  CSS->>MS: INSERT messages
  MS-->>CSS: written
  CSS-->>S: msg_ack
  Note over S: sent: recorded by the store write, shown on the ack
  CSS->>CSR: push deliver
  CSR->>Rd: deliver {message, stream_id}
  Rd->>CSR: ack {up_to_stream_id}
  Rd->>CSR: receipt delivered {conversation_id, last_delivered_id}, sent when the stream hands it new messages
  CSR->>MS: delivery_cursors (conversation, device R) = max(old, new)
  Note over MS: delivered for message N is derived: every other device's cursor is at least N. Never stored per message.
  CSR->>CSS: cursors {conversation, read, delivered}, to the members who have the conversation open
  CSS->>S: cursors
  Note over S: renders delivered

  Note over Rd: R opens the conversation, the newest visible message changes
  Rd->>CSR: receipt read {conversation_id, last_read_id}, coalesced to one per conversation per 2 s
  CSR->>MS: read_cursors (conversation, user R) = max(old, new), idempotent and commutative
  CSR->>CSR: push read_cursor to R's other devices (badges clear) and to members with the chat open
  CSR->>CSS: cursors
  CSS->>S: cursors
  Note over S: read: who has read N is the members whose last_read_id is at least N, one partition read. Per member, not a count.
  Note over S,Rd: members not looking at the chat are not pushed, they read the cursors partition on next open. A late or duplicate receipt is a no-op because of max.
```

What it answers: sent is recorded by the store and shown on the ack; delivered and read
are cursors written by the recipient's chat server (§3.3); the sender and anyone with
the chat open are notified, nobody else (§3.4); status is derived from the cursors,
never stored (§3.3).

## Flow 7 · Load chat history

*Open a conversation and page back through two years of messages.*

```mermaid
sequenceDiagram
  autonumber
  participant D as Device
  participant API as API server
  participant MS as Message store

  Note over D: open a conversation: render from the local cache (SQLite or IndexedDB) first, then catch up over the socket (flow 2)
  D->>API: GET /conversations/{id}/messages?limit=50
  API->>MS: SELECT from messages WHERE conversation_id = ? AND bucket = current month, LIMIT 50 (clustering message_id DESC)
  loop fewer than 50 rows and bucket not before conversation.created_bucket
    API->>MS: same query, bucket minus one month
  end
  API-->>D: {messages (50), next_before: smallest message_id returned}
  D->>D: oldest_loaded = next_before

  Note over D,MS: scroll up, repeated, two years back
  D->>API: GET /conversations/{id}/messages?before={oldest_loaded}, limit=50
  API->>API: bucket = month(before) read from the Snowflake timestamp, no lookup
  API->>MS: SELECT WHERE conversation_id = ? AND bucket = ? AND message_id < ?, LIMIT 50, same walk backwards if short
  Note over MS: partitions older than 12 months sit on the cold tier: same query, higher latency, which a user two years deep has accepted
  API-->>D: {messages, next_before}
  Note over D: history is HTTPS and cacheable, never the socket. New messages arrive above last_synced over the socket. The two cursors never meet.
```

What it answers: newest 50 from the current month's partition, cursor paging by
`before`, the bucket chosen from the Snowflake timestamp (§2.3); history never rides
the WebSocket (§2.1); old partitions are on a cold tier (§2.5).

## Flow 8 · Send media to a group

*A 10 MB video to a 100-person group. Upload path, where the bytes live, what the 100
recipients receive first, and when the sender sees "sent".*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (sender)
  participant API as API server
  participant OS as Object storage (regional bucket, CDN for group media)
  participant CSA as Chat server A
  participant MS as Message store
  participant R as Redis
  participant CSn as Chat server n
  participant Bn as Device n (one of 150)

  Note over A: a video goes as-is under the 10 MB cap. An image would be compressed on the device first, target 500 KB or less, unless the sender picks send original.
  A->>API: POST /media/intent {size: 10 MB, mime, sha256}
  Note over API: validate size, 10 MB or less. A 12 MB file is refused here, before any byte moves.
  API-->>A: {media_key: region/yyyy/mm/uuid, put_url}, pre-signed PUT, 10 min, content-length = size, content-type = mime
  A->>OS: PUT bytes, direct, never through the fleet
  OS-->>A: 200 (the bucket rejects anything larger than the signed content-length)
  Note over A: meanwhile the outgoing bubble shows a progress bar from the outbox
  A->>CSA: msg {body, media_key, media_size, media_mime, sha256}, sent only after the upload completed
  CSA->>MS: INSERT messages, metadata only, about 200 bytes
  MS-->>CSA: written
  CSA-->>A: msg_ack
  Note over A: the sender sees sent now, after upload plus store write
  loop up to 150 recipient devices, fan-out as in flow 3
    CSA->>R: XADD sq:{device}
    CSA->>CSn: push deliver {message with media_key}, metadata, no bytes
    CSn->>Bn: deliver
    Note over Bn: the bubble renders at once with a placeholder. This is what the 100 recipients receive first.
  end
  Note over Bn: when the bubble scrolls into view, fetch on demand
  Bn->>API: GET /media/{key}/url
  API->>MS: membership check on the message's conversation (authorization at minting time)
  API-->>Bn: {get_url, expires in 1 h}, host is the CDN because the conversation is a group
  Bn->>OS: GET bytes through the CDN edge
  OS-->>Bn: 10 MB (origin serves it once, the other 149 devices hit the edge cache)
  Note over A,Bn: 1.5 GB per group send leaves the origin once (estimation §3.2). 1:1 media skips the CDN and is served from the bucket. No media byte ever crosses a chat server.
```

What it answers: upload is direct to object storage with a pre-signed PUT, the cap
enforced at the intent step and by the bucket (§6.1, §6.2); the bytes live in a
regional bucket (§6.4); recipients first receive the message with a `media_key` and
fetch on demand (§6.2, §6.3); the sender sees sent after the upload and the store write
(§6.2).

## Flow 9 · Reply to a message

*User replies to a message from last month. Is the quoted excerpt stored with the reply
or fetched by ID on render? What happens when the parent is outside the device's local
cache?*

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A (replier)
  participant CSA as Chat server A
  participant MS as Message store
  participant R as Redis
  participant CSB as Chat server B
  participant B as Device B
  participant API as API server

  Note over A: the user replies to a message from last month. The parent is on A's screen, so its message_id is known.
  A->>CSA: msg {client_msg_id, conversation_id, body, reply_to: parent message_id}
  Note over CSA: the handler rejects a reply_to whose conversation differs (F10, one parent, same conversation)
  CSA->>MS: INSERT messages (reply_to = parent message_id), the parent's Snowflake ID only, no excerpt copied (decided 2026-11-02)
  MS-->>CSA: written
  CSA-->>A: msg_ack
  CSA->>R: XADD sq:{device}, route lookup, as in flow 1
  CSA->>CSB: push deliver
  CSB->>B: deliver {message, reply_to: parent message_id}
  alt the parent is in B's local cache (B saw it earlier, or it came with a page)
    B->>B: render the quote from the cached parent, its current text
  else B has not got the parent
    Note over B: the quote waits for the next page read. No request per quote is ever made.
  end

  Note over B,API: B opens the conversation later, or scrolls up to the reply
  B->>API: GET /conversations/{id}/messages?limit=50 (or before=)
  API->>MS: SELECT the page from (conversation_id, bucket)
  API->>MS: SELECT by key every parent a reply_to in the page references and the page lacks, one batch, bucket from each parent's Snowflake ID
  MS-->>API: page rows and the parents found
  API-->>B: {messages, parents: {message_id to message}, next_before}
  Note over B: render rule. Parent in the page or in parents: quote its current text. Parent absent, because deleted: the reply still shows, with a message unavailable placeholder (F10). The cache keeps every parent seen.

  opt the user taps the quote to jump to the parent (F10, design §2.3, unchanged)
    alt parent is in B's local cache
      B->>B: scroll to it
    else parent is outside the loaded window (last month)
      B->>API: GET /conversations/{id}/messages/{parent message_id}
      API->>MS: SELECT by (conversation_id, bucket = month(parent message_id), message_id)
      API-->>B: the parent, or not found
      alt found
        B->>API: GET /conversations/{id}/messages?before= and ?after= the parent, page around it, not a scroll-up loop
        API-->>B: the surrounding pages
      else parent deleted
        Note over B: the reply still shows, with a message unavailable placeholder (F10)
      end
    end
  end
```

What it answers: `reply_to` is stored as the parent's ID and nothing else (§2.2); the
quote is resolved from the parent on render, with the page API carrying the referenced
parents in one batched key read and the deleted-parent placeholder as a render rule
(§2.3, ADR 2026-11-02); a parent outside the loaded window is fetched by key and paged
around only when the user jumps to it (§2.3).
