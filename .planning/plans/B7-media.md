# Plan B7 · Media stub: upload intent, signed-URL download, metadata-only frames

Epic text: `.planning/roadmap.md` §3 B7 (approved plan). Design §6.2 (upload), §6.3 (download), §6.4
(host by conversation type); ADR `.memory/decisions/2026-11-01-media-no-server-processing.md`
(condition: "the prototype's client stub sends a `media_key` reference only; no bytes"). Scenario S6.

## Files

- `prototype/src/media/index.ts` — `registerMedia(ctx)`: two HTTP routes, one `message_stored` listener,
  `MediaOptions` (`region` default `ap-southeast-1`, `capBytes` 10 MiB, `putTtlS` 600, `getTtlMs` 3 600 000)
  read from `ctx.moduleOptions['media']`
- `prototype/test/media/intent.test.ts` — `POST /media/intent` over `fetch` against a real server on port 0
- `prototype/test/media/url.test.ts` — `GET /media/:key/url`: 404, uploader-only before send, membership
  after send, `host` by conversation type
- `prototype/test/media/metadata-only.test.ts` — S6: a `msg` with `media_key` round-trips as metadata; every
  frame on both sockets is small and carries no `put_url`/bytes
- `.planning/plans/B7-media.md` — this file

Not touched: `src/server.ts`, `src/protocol.ts`, `src/ports/**`, `src/messaging/**`, `test/harness/**`, other
modules, docs, README, memory, progress.

## HTTP contract (no auth: `?user_id=` is the stand-in for the caller's identity)

`POST /media/intent?user_id=<uid>` body `{size, mime, sha256}`
- 400 `{error:'bad_request', message}` — missing `user_id`, non-integer or negative `size`, non-string
  `mime`/`sha256`, body not an object
- 413 `{error:'too_large', cap: 10485760}` — `size > 10 MiB`; trace `media`
  `413: 12.4 MB > 10 MB cap; no upload link minted`
- 200 `{media_key, put_url, expires_in_s: 600, content_length: size, content_type: mime}` with
  `media_key = region/yyyy/mm/uuid` (yyyy/mm from `clock.now()` in UTC), `put_url = stub://bucket/<media_key>`.
  Intent remembered in memory `{media_key, uploader, size, mime, sha256, created_at}`. A repeat intent with
  the same `(uploader, sha256)` returns the same key (design §6.2: skip re-upload). Trace `http`
  `POST /media/intent {size:4.2 MB, mime:image/jpeg} ← truc` and `media`
  `pre-signed PUT, 10 min, content-length=4404019 → <media_key>`.

`GET /media/:region/:yyyy/:mm/:uuid/url?user_id=<uid>` (the key has slashes: four params)
- 400 missing `user_id`
- 404 `{error:'not_found'}` — no intent with that key
- 403 `{error:'forbidden'}` — key not yet sent in a message and caller ≠ uploader; or sent in a conversation
  the caller is not a member of
- 200 `{get_url: stub://<host>/<media_key>?sig=<hex>&exp=<expires_at>, expires_at: now + 3 600 000, host}` with
  `host = 'cdn'` for a group conversation, `'bucket'` for a dm, `'bucket'` for an unsent key (uploader preview).
  Trace `http` `GET /media/<uuid>/url ← khanh → member of c2, signed 1 h, host=cdn (group: CDN in front)`.

The module learns which conversation a key was sent in by listening to `message_stored` and recording
`media_key → {conversation_id, message_id}` (first message wins; a forwarded key keeps its first conversation,
which is a simplification noted below).

## Steps (TDD, each red → green → commit)

1. `intent.test.ts`: 413 over the cap with the trace row; 400 on bad fields; 200 shape, key format with the
   clock's year/month and the configured region, intent remembered; same sha256 twice → same key. Implement.
2. `url.test.ts`: 404 unknown; uploader may fetch before any message; a non-uploader may not; after Truc sends
   the key to c1, Khanh (member) gets `host=bucket` and Linh (not a member) gets 403; after a key is sent to
   c2, `host=cdn`; `expires_at` is `now + 1 h`; trace row. Implement.
3. `metadata-only.test.ts` (S6): mint an intent, send `msg{media_key}` from Truc·phone to c1, Khanh·phone
   gets `deliver` with `message.media_key` set and `body` as sent; every frame received on both sockets and
   every frame sent by both clients (wrapped `ws.send`) is `< 600` bytes when encoded; no frame text contains
   `put_url`, `get_url`, `bytes` or the sha256. Nothing to implement if steps 1–2 hold; the test is the
   ADR condition made executable.
4. Whole suite + typecheck green; hand back.

## Test strategy

`npm test` (vitest, real server on port 0 with `seed: true`, `fetch` for HTTP, `ScriptedClient` for sockets)
and `npm run typecheck`. The clock is injected (`clock: { now: () => fixed }`) where the key's yyyy/mm or
`expires_at` is asserted.

## Risks

- The router matches `:param` against one path segment; the key has four segments → four params, joined in
  the handler. A key with a different shape 404s naturally.
- `message_stored` is emitted before `msg_ack`, so by the time a client can ask for a URL the mapping exists;
  no race to test.
- Forwarding (the same key sent to a second conversation) is not modelled: the first conversation wins. A
  forward in the real design would re-check membership of the second conversation; out of scope here.

## Found while building (input for C2)

- Process: the GET route was written in the same commit as POST (be0adb2), so `url.test.ts` was never seen
  red. Compensated with a mutation check (flipping cdn/bucket and disabling the membership check each fail
  two tests); recorded here rather than staging a red after the fact.

- Protocol gap: design §6.2 sends `{body, media_key, size, mime, sha256}` in the message, but `MsgFrame`
  carries `media_key` only, so the stored row's `media_size`/`media_mime` stay null (B2 writes the row). The
  intent table holds size and mime per key; C2 should either widen `MsgFrame` or let the media module fill
  the row from the intent on `message_stored`. Not changed here (`protocol.ts` and `messaging/` are not B7's).

## Follow-up (lane B, after the hub's review of the first report)

The "protocol gap" was a roadmap transcription error; design §6.2 is the authority. Closed on
the lane branch: `MsgFrame` carries `media_size`, `media_mime`, `sha256` (optional, only with
`media_key`; the decoder rejects them alone), the row gains `sha256`, the messaging module
stores all three, and the media module vetoes on the new `message_received` hook when the
claimed size does not match the intent minted for that key or exceeds the cap (`media_size_mismatch`),
when an intent exists but no size is claimed (`media_size_missing`), when a size is claimed
for a key never minted here (`unknown_media_key`), or when mime / sha256 contradict the
intent. A key never minted here with no metadata still passes (uploads outside this
server are not modelled). The S6 frame-size test keeps every socket frame under 600 bytes.
