# Specification — The Chat System

> System design practice brief. The goal is to **design** the system, not to build it.
> This document captures the problem the way an interviewer would hand it over:
> requirements, constraints, scale, and the questions the design must answer.
> It deliberately does **not** contain the solution.

---

## 1. Problem statement

Design a chat service comparable to Messenger, WhatsApp, Slack or Discord that lets
users exchange messages in real time, one-to-one and in groups, across multiple
devices, with reliable delivery even when a recipient is offline.

The design should be defensible in a 45-minute system design interview and
extensible to the follow-up questions in §8.

## 2. Scope

### 2.1 Functional requirements (must have)

| ID | Requirement |
|----|-------------|
| F1 | One-to-one chat between two users |
| F2 | Group chat, up to **100 members** per group. Larger communities (Discord-style channels, 10 k+) are a separate product shape and a follow-up (§8) |
| F3 | Real-time delivery with low latency when both parties are online |
| F4 | Offline delivery: messages sent to an offline user are stored and delivered when they reconnect |
| F4a | **Notify and mark unread:** every new message pushes a notification to the recipient's devices (hint only, body fetched on open) and marks that conversation unread for that user until they open it |
| F5 | Message persistence and chat history, retrievable on any device. **History is kept forever** on the server; retention is a storage-tiering question, not a deletion policy |
| F6 | Multi-device support: one user may be logged in on several devices at once; all devices see the same conversation state |
| F7 | **Online indicator (must have):** every conversation and contact list shows whether the other party is online, offline, or last seen at a time. A change in state must be visible to contacts within **10 seconds** |
| F8 | Message status: sent → delivered → read, **tracked per member** in group chats (the sender can see who has read, not only how many) |
| F9 | **Media messages:** images, video and files up to **10 MB** per attachment, stored and delivered **at full size** (no resizing or transcoding on the server). One attachment per message. Recipients see the message immediately and fetch the media on demand |
| F11 | **Auto-reconnect:** a client that loses connectivity reconnects on its own as soon as the network is back, without user action, and resumes from where it left off with no gap and no duplicates |
| F10 | **Reply to a message:** a message can reference one earlier message in the same conversation (quoted reply, WhatsApp style). The client renders the quoted excerpt; if the parent was deleted, the reply still shows with a "message unavailable" placeholder. Slack-style threads remain out of scope |

### 2.2 Non-functional requirements

| ID | Requirement | Target |
|----|-------------|--------|
| N1 | Delivery latency, both online | p50 < 100 ms, p99 < 500 ms, **measured server to server**: from the sender's frame arriving at a chat server to the frame being written to the recipient's socket. Device radios are outside the budget |
| N2 | Availability | 99.99 % for send/receive path |
| N3 | Durability | A message acknowledged to the sender is never lost |
| N4 | Ordering | Messages within a single conversation are shown in a consistent order on every device |
| N5 | Scalability | Horizontal; no single component is a hard ceiling for §3 numbers |
| N7 | Catch-up window | A device reconnecting within **24 hours** receives every missed message by replay with no gap and no duplicates. A device away longer gets the current chat list immediately and loads each conversation from persistent history on open |
| N6 | Security | Transport encryption everywhere; a user only reads conversations they belong to |

### 2.3 Out of scope (for the first design pass)

- End-to-end encryption (key exchange, device verification)
- Voice and video calls
- Message search
- Bots, integrations, threads, reactions
- Spam and abuse detection
- Compliance / data retention policies

Each of these is fair game as a follow-up (§8) once the core design holds.

## 3. Scale and load assumptions

Use these numbers for back-of-the-envelope estimation. Challenge them if they
seem off, but state the alternative you are using.

| Metric | Assumption |
|--------|-----------|
| Daily active users (DAU) | 50 million |
| Messages sent per user per day | 40 |
| Messages per day | 2 billion |
| Average message size | 100 bytes of text + ~100 bytes metadata |
| Peak-to-average ratio | 5× |
| Concurrent online users at peak | 10 million |
| Devices per user | 1.5 average, 5 maximum |
| Group size | median 5, max 100 |
| Chat history retention | forever (5-year figure used for sizing) |
| Messages carrying media | 10 % of messages |
| Average media size | 2 MB (cap 10 MB) |

Derive, and write down:

- Average and peak **messages per second** (write QPS).
- Fan-out factor for reads (one message to a 100-person group on 1.5 devices each).
- **Storage per day and per year** for message text + metadata, and separately for media blobs.
- **Concurrent connections** the real-time layer must hold at peak.
- Bandwidth in and out of the real-time layer at peak, and the media upload/download bandwidth that must **not** go through it.

## 4. Actors and core flows

### 4.1 Actors

- **Sender** — a user on one device sending a message.
- **Recipient(s)** — one user (1:1) or up to 100 users (group), each on 0..5 devices, any of which may be offline.
- **Client** — mobile or web app holding a long-lived connection to the service.

### 4.2 Flows the design must walk through end to end

1. **Send 1:1, recipient online** — message leaves device A and arrives on device B. Which hop assigns the message ID? Which hop acknowledges the sender?
2. **Send 1:1, recipient offline** — where does the message wait, how is the recipient notified (push), what happens on reconnect?
3. **Send to group of 100** — how is the fan-out performed, and at what point does the sender get an ack?
4. **Multi-device sync** — user has phone and laptop open; a message read on the phone shows as read on the laptop. Device that was off for a week comes back: how does it catch up?
5. **Presence** — user goes online, goes idle, loses connectivity without logging out. How do friends learn about it, and how fast?
6. **Message status** — sent / delivered / read. Who records each transition and who is notified?
7. **Load chat history** — open a conversation and page back through two years of messages.
8. **Send media to a group** — a 10 MB video to a 100-person group. Upload path, where the bytes live, what the 100 recipients receive first, and when the sender sees "sent".
9. **Reply to a message** — user replies to a message from last month. Is the quoted excerpt stored with the reply or fetched by ID on render? What happens when the parent is outside the device's local cache?

## 5. Design decisions the document must make

The deliverable is a design that explicitly answers each of the following, with the
alternative considered and the reason for rejecting it.

### 5.1 Client ↔ server communication

- Protocol for the real-time path: WebSocket, long polling, SSE, raw TCP, or a mix. Why?
- Which operations go over the persistent connection and which over plain HTTP APIs (login, profile, history, media)?
- Connection lifecycle: heartbeat interval, reconnect strategy, what the client must resend after reconnect.

### 5.2 Service decomposition

- Stateful real-time servers vs. stateless API servers: boundaries and responsibilities.
- Service discovery: how a client finds a chat server to connect to, and how a server finds *which* server another user is connected to.
- Where presence lives and how it is kept fresh.
- Where notification (push to APNs / FCM) is triggered.

### 5.3 Message storage

- Database choice (relational vs. key-value vs. wide-column) for messages, with justification from the access pattern (write heavy, read recent, rarely update).
- Table / key design for 1:1 and group messages. How history for a conversation is paged.
- Message ID generation: requirements (unique, sortable within a conversation, available at high write rate) and the chosen scheme (global sequence, Snowflake-style, per-conversation sequence, …).
- Retention and tiering for 5 years of history.
- Reply reference: how `reply_to` is stored and whether the quoted text is denormalized into the reply or resolved on read.

### 5.4 Media

- Upload path: through the API servers or direct to object storage with a pre-signed URL? Where is the 10 MB limit enforced, and what does the client see on violation?
- How a message references its blob (ID, URL, content hash) and whether the message is sent before, after, or in parallel with the upload.
- Download path and caching (CDN or not) given full-size delivery and no server-side variants; impact on mobile data and on the 100-member fan-out.
- Authorization on blob access: who can fetch a media URL and for how long.
- Retention: do blobs follow the 5-year message retention, and what happens to the blob when the message is deleted.

### 5.5 Message delivery

- Fan-out strategy for groups: on write vs. on read, and the threshold where the answer changes.
- Per-user inbox / message-sync queue: structure and what happens when it fills.
- Exactly-once vs. at-least-once semantics and how duplicates are handled on the client.
- Ordering guarantee across devices and across group members.

### 5.6 Offline and multi-device

- How each device tracks the point up to which it has synced (cursor / `cur_max_message_id`).
- Push notification path and deduplication when several devices are online.
- Read-receipt propagation to the sender and to the reader's other devices.

### 5.7 Presence

- Heartbeat design: interval, timeout, and the cost at 10 M concurrent users, given the 10-second freshness target in F7.
- Fan-out of presence changes: push to all friends, or pull on demand? Where does the answer change (small friend list vs. a 100 K-member Discord server)?

### 5.8 Reliability and operations

- Failure of one chat server: what happens to its connections and in-flight messages?
- Failure of the message store primary.
- Backpressure when a hot group floods a server.
- Observability: the five metrics you would page on.

## 6. Deliverables

Place the design in this repository as follows:

| Path | Content |
|------|---------|
| `docs/specification.md` | This brief (do not edit while designing; file an issue if a requirement is wrong) |
| `docs/estimation.md` | Back-of-the-envelope numbers from §3 |
| `docs/design.md` | High-level architecture, then deep dives answering every item in §5 |
| `docs/diagrams/` | Architecture, sequence diagrams for the flows in §4.2 |
| `docs/tradeoffs.md` | Each decision in §5 as *chosen / rejected / why* |
| `docs/followups.md` | Answers to the extensions in §8 that were attempted |

Diagrams may be Mermaid in Markdown or exported images; keep the source.

## 7. Evaluation rubric

Score the finished design against this before considering it done.

| Area | Pass if… |
|------|---------|
| Requirements | Every F* and N* in §2 is addressed or explicitly deferred |
| Estimation | QPS, storage and connection counts are derived, not asserted, and drive at least two design choices |
| Architecture | A newcomer can trace all seven flows in §4.2 through the diagram without asking a question |
| Storage | Schema and ID scheme are concrete enough to write the queries for "load last 50 messages" and "sync since cursor" |
| Media | Upload and download paths bypass the real-time layer; the 10 MB limit and blob authorization are enforced at a named hop |
| Delivery | At-least-once path and client-side dedup are spelled out; group fan-out has a stated threshold |
| Trade-offs | Every decision in §5 names a rejected alternative |
| Failure modes | Single-server loss and store-primary loss both have a recovery story with bounded data loss |
| Clarity | Design fits in a 45-minute walkthrough; details live in deep-dive sections, not in the overview |

## 8. Follow-up extensions

Pick these up only after the core design passes §7.

1. **Media processing** — thumbnails, image resizing, video transcoding, and multiple attachments per message (the core brief ships full-size, single attachment, no processing).
2. **End-to-end encryption** — key distribution across multiple devices, group key rotation on membership change.
3. **Very large groups / channels** — 100 K to 1 M members (Telegram channels, Discord servers). How fan-out and presence change.
4. **Message search** — full text across a user's history; indexing cost vs. freshness.
5. **Edits, deletes, reactions, threads** — mutation of already-delivered messages across devices.
6. **Typing indicators** — ephemeral, high-frequency, lossy events; how they differ from messages.
7. **Multi-region deployment** — users in two regions chatting; where messages are written, cross-region latency, conflict handling.
8. **Rate limiting and abuse** — per-user send limits, spam heuristics, and where they sit in the pipeline.

## 9. Reference reading

- Alex Xu, *System Design Interview*, Vol. 1, Chapter 12 "Design a Chat System"
- Discord Engineering, "How Discord Stores Billions of Messages" (and the later "Trillions" follow-up)
- Slack Engineering, "Real-time Messaging" and "Flannel: An Application-Level Edge Cache"
- WhatsApp / Erlang Factory talks on connection handling at scale
- Facebook Engineering, "Building Facebook Messenger" (Iris sync service)
