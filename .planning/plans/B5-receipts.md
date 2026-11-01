# Plan B5 · Receipts, unread, multi-device read state

Epic text: `.planning/roadmap.md` §3 B5 (approved plan). Design §3 (§3.3 storage, §3.4 receipt
traffic, §3.5 unread and multi-device, §3.6 notifications). Trace rows follow
`docs/prototype/index.html` lines 334–342 and 389–398 (`read_cursors[c1][truc] = max(prev,#id)`,
`read_cursor → Truc·laptop (clears their badge)`, `cursors c1 → Khanh·phone (devices with the chat open)`,
`#id → Khanh·phone: no route → push hint {conv, id, from}, no body`).

## Files

- `prototype/src/receipts/index.ts` — `registerReceipts(ctx)`: the `receipt` frame handler, the
  `message_fanout` listener (delivery cursors + push hints), the status HTTP route, the open set;
  `ReceiptsOptions` + `resolveReceiptsOptions` read from `ctx.moduleOptions['receipts']`
- `prototype/src/receipts/status.ts` — pure `statusOf(message, memberReadCursors, deviceDeliveryCursors,
  members, devices)` → `'read' | 'delivered' | 'sent'` plus the `read_by` / `delivered_to` lists
- `prototype/src/receipts/PushGateway.ts` — `interface PushGateway { push(device_id, hint) }`,
  `PushHint = {conversation_id, message_id, sender_display_name}` (no body field exists on the type),
  `InMemoryPushGateway` recording `{device_id, hint}` rows
- `prototype/src/receipts/coalesce.ts` — `ReceiptCoalescer(timers, windowMs = 2000).offer(conversation_id,
  last_read_id, send)`: client-side helper (design §3.4), not wired into the harness here (B1 owns
  `test/harness/**`; B8 or a later harness change wires it)
- `prototype/test/receipts/coalesce.test.ts` — unit, manual `Timers`
- `prototype/test/receipts/pushGateway.contract.ts` + `pushGateway.test.ts` — contract for the port,
  applied to `InMemoryPushGateway` (B9 can apply it to a real gateway)
- `prototype/test/receipts/status.test.ts` — `statusOf` unit cases, the HTTP route, the 100-member
  one-partition-read assertion
- `prototype/test/receipts/receipts.test.ts` — real server on port 0, `seed: true`, `ScriptedClient`:
  receipt handler, multi-device badge clear, open set, no-op, delivery cursors, push hints, mute, no body,
  trace rows
- `.planning/plans/B5-receipts.md` — this file

Not touched: `src/server.ts`, `src/protocol.ts`, `src/ports/**`, `src/messaging/**`, `test/harness/**`,
other modules, `docs/**`, README, memory, progress.

## Behaviour

### `receipt{conversation_id, last_read_id}` from a device (design §3.4, §3.5)

0. `isMember(conversation_id, user_id)` false → `error{code:'not_member'}`, nothing written.
1. Open set: `open[conn.id] = conversation_id` (rule below), before anything else, so even a no-op receipt
   marks the chat as open.
2. `prev = readCursor(c, u)`; `after = advanceRead(c, u, last_read_id)` (`max` semantics live in the port).
   `after === prev` → trace `receipt` `read_cursors[c][u] no-op: #id ≤ #prev (late or duplicate)` and stop.
   Nothing is pushed: a late or duplicate receipt is harmless and silent.
3. Trace `receipt` `read_cursors[c][u] = max(prev,#id)`.
4. Push the server `receipt{conversation_id, user_id, last_read_id}`:
   (a) to the reader's **other** connected devices (`connections.byUser(u)` minus the sending connection):
       trace `push` `read_cursor → Truc·laptop (clears their badge)`;
   (b) to every connection whose open conversation is `c` (open set), minus the sender and minus the
       connections already served in (a): trace `receipt` `cursors c → Khanh·phone (devices with the chat open)`.
   Each connection gets at most one frame per receipt. Nobody else is told (§3.4: no receipts for a chat you
   are not looking at).

### Open set rule (stand-in for B6's watch set)

A device has a conversation **open** from the moment it sends a `receipt` for it until it sends a `receipt`
for a different conversation or its connection ends (`device_disconnected`). One open conversation per
connection; kept in a `Map<conn.id, conversation_id>` inside the module. The protocol has no `open` frame
(the page's `open` is not in `protocol.ts`), so the receipt itself is the signal: a client that is reading a
chat is sending receipts for it. A comment marks where B6's watch set may replace this.

### `message_fanout{message, recipient_devices, pushed}` (design §3.3, §3.6)

1. Sender's own cursors, as the page does on store: `advanceRead(c, sender, id)` and
   `advanceDelivery(c, sender_device, id)`. No frame is pushed for this: the sender's other devices get the
   `deliver` itself and can infer. One trace row `receipt` `delivery_cursors[c] ← #id for <names>`.
2. For every device in `pushed`: `advanceDelivery(c, device, id)` (it got the `deliver` over a live socket).
   Acks of a replay batch advancing delivery cursors is B3's business.
3. Push hints for `recipient_devices − pushed`: look the device up (`devices.get`) for its user; if the device
   still has a route (`routes.get(user, device)`), it is live but in replay or back-pressured and the queue
   carries the message → no hint (§3.6 step 1, "devices with a live connection got it already"). Otherwise
   run `isMuted(conversation_id, user_id)` (default `false`; injectable): muted → trace `apns`
   `#id → Name: muted, no push`; else `pushGateway.push(device_id, {conversation_id, message_id,
   sender_display_name})` with the name from `USERS` (fallback: the user id) and trace `apns`
   `#id → Name: no route → push hint {conv, id, from}, no body`. The hint type has no `body` field and the
   handler never reads `message.body`.

### `GET /conversations/:id/messages/:message_id/status?user_id=`

- `user_id` missing → 400 `{error:'user_id_required'}`; not a member → 403 `{error:'not_member'}`;
  message not in the store → 404 `{error:'not_found'}`.
- Reads: `conversations.get` (members), `messages.get`, **one** `readCursors(c)`, **one** `deliveryCursors(c)`,
  `devices.devicesOf` per member (the device directory, not the cursor partition). Then `statusOf`.
- 200 `{status, read_by: UserId[], delivered_to: DeviceId[]}`.

### `statusOf` (design §3.3, pure)

Others = members minus the sender. `read_by` = others whose read cursor ≥ id. `delivered_to` = devices of
others whose delivery cursor ≥ id. `status` = `read` if every other member is in `read_by`; else `delivered`
if every other member has at least one device and all of their devices are in `delivered_to` (a member with
no device has not received it anywhere, so the vacuous reading is rejected on purpose); else `sent`. A
conversation with no other member is `read` (nothing outstanding). Comparison is `compareIds` (numeric).

### `ReceiptCoalescer` (design §3.4, client side)

`offer(conversation_id, last_read_id, send)`: no window open for that conversation → `send` now and open a
window of `windowMs`; window open → remember the id (keeping the larger). When the window ends: a pending id
→ `send` it and open a new window (sustained reading yields one receipt per window, carrying the newest id);
none → the window just closes. An id not greater than the last sent one is dropped. `dispose()` clears timers.

## Options (`ctx.moduleOptions['receipts']`, exported `ReceiptsOptions`)

```ts
interface ReceiptsOptions {
  pushGateway: PushGateway;                        // default: new InMemoryPushGateway()
  isMuted(conversation_id, user_id): boolean | Promise<boolean>; // default: () => false
}
```
Tests pass their own `InMemoryPushGateway` and read it back; a mute test passes `isMuted`.

## Steps (TDD, each red → green → commit)

1. `coalesce.test.ts` with a hand-rolled `Timers`; implement `ReceiptCoalescer`.
2. `pushGateway.contract.ts` + `pushGateway.test.ts`; implement `PushGateway`, `InMemoryPushGateway`.
3. `status.test.ts` unit cases for `statusOf`; implement `status.ts`.
4. `receipts.test.ts`: handler happy path (cursor written, non-member refused), read on phone → laptop gets
   the server `receipt` (badge clears), the open set (Khanh with c1 open gets Truc's cursor; after a receipt
   for c2 he does not; after disconnect he does not), late/duplicate is a no-op with no frames and the trace
   row; implement the handler and the open set.
5. Delivery cursors on fan-out (pushed devices and the sender's device), sender read cursor.
6. Push hints: Truc·laptop offline gets a hint without the body (no `body` key, body text nowhere in the
   recorded object); live devices get none; a device in replay gets none; mute hook blocks; `apns` trace rows.
7. Status route + the 100-member test (`conversations.create` with 100 members, truc sends one `msg`, 99
   cursors advanced through the port, `readCursors` wrapped to count calls → exactly one; status flips
   sent → delivered → read).
8. Trace rows read like the page. Whole suite + typecheck green; hand back.

## Test strategy

`npm test` and `npm run typecheck`, whole suite, before every commit. Server tests use real sockets on
port 0 and `seed: true`; messages go through `msg` frames so B2's events fire. Pure parts (`statusOf`,
coalescer, gateway) are unit tests with no server. Negative assertions ("gets nothing") use a short wait
(30 ms) after the positive assertion that proves the server has processed the frame.

## Risks

- B6 later owns "who has the chat open" → the open set is isolated behind two functions and a comment;
  swapping it for the watch set touches one place.
- Pushing a hint to the sender's own offline device: the page does it (`targets` = every member device
  except the sending one) and §3.6 step 3 says all offline devices, so this follows the page; a product
  decision could exclude them later, one filter.
- `recipient_devices − pushed` includes live-but-replaying devices; the route check keeps the queue, not
  APNs, responsible for those, matching §3.6 step 1. Asserted by a test.
- Vacuous "delivered" for a member with no device is rejected explicitly (see `statusOf`).
- The coalescer is not wired into `ScriptedClient` (harness is B1's); it is unit-tested only, documented.
