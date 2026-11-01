# ADR: Media handling

Date: 2026-11-01
Status: Accepted
Author: Truc Le

## Context

Spec F9 said media is stored and delivered "at full size, no server-side resizing or
transcoding". Estimation showed that at a 2 MB average this made media a thousand times
the text volume and the dominant cost of the system. Asked what "full size" protects,
the author answered: simplicity. A media pipeline is not the subject of this design.

## Decision

- The server never processes media bytes; there is no transcoding, resizing or scanning
  pipeline. Bytes move client ↔ object storage directly over pre-signed URLs.
- Clients compress images by default (target ≤ 500 KB) and may send originals; video
  and files go as-is under the 10 MB cap, which the pre-signed upload URL enforces.
- The message is sent only after the upload completes and references the object key.
- Regional buckets. CDN only in front of group media; 1:1 media is served from the
  bucket.
- Authorization at URL-minting time against conversation membership; download URLs are
  1 h bearer tokens.

## Alternatives Considered

- **Originals by default:** 400 TB/day instead of 100 TB; fidelity nobody asked for.
- **Upload through API servers:** bytes cross the fleet twice to enforce a cap the
  signed URL already enforces.
- **CDN for all media:** a hop and a cache miss on every 1:1 download, the majority.
- **Proxy downloads for authorization:** reintroduces bytes through our servers.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A leaked download URL works for up to 1 h | accepted; short life, no listing, keys are unguessable |
| Client compression quality varies by platform | a shared target (≤ 500 KB, longest edge 1600 px) in the client spec |
| No server-side scanning of uploads | out of scope; abuse detection is a spec §8 follow-up |

## Consequences

**Positive:** media cost down four times; no second system to operate; the real-time
fleet never sees a media byte.
**Negative:** no thumbnails or previews from the server; clients render their own.
**Neutral:** the 10 % media rate remains the next lever to question.

## Conditions

- The prototype's client stub sends a `media_key` reference only; no bytes. **Met**
  (S6, 2026-11-01): the message carries `media_key`, size, mime and sha256 as §6.2 says;
  every frame on both sockets is under 600 bytes and carries no URL; the intent over
  10 MB is refused before any byte moves. The roadmap had paraphrased the §6.2 frame
  without the metadata; the design was the authority (design §7.1, row 8).
- Revisit the CDN split if cross-region conversations become common.
