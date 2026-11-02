# ADR: Reply quoting resolved by ID; the page API carries referenced parents

Date: 2026-11-02
Status: Accepted
Author: Truc Le

## Context

F10 lets a message reference one earlier message in the same conversation. Design §2.2
stores `reply_to` as the parent's Snowflake ID; §2.3 fetches a parent outside the loaded
window by key. Spec §5.3 and flow 9 asked the remaining half: is the quoted excerpt
denormalized into the reply row, or resolved by ID on render? The rubric (A3 item 2)
listed it as the open half of tradeoffs.md 5.3.5.

## Decision

- **The reply row stores only `reply_to`; no excerpt is copied.** The quote is resolved
  from the parent on render, so an edited or deleted parent shows correctly in every
  child: the current text, or the "message unavailable" placeholder F10 requires.
- **The page API carries the referenced parents.** `GET /conversations/{id}/messages`
  returns, beside the page, a `parents` map of every message referenced by a `reply_to`
  in that page and not already in it, read by key from the store in one batch. The
  client never issues one request per quote; the device cache (§2.4) keeps parents it
  has seen.
- The jump-to-parent path (§2.3) is unchanged: a tap fetches the parent by key and
  pages around it.

## Alternatives Considered

- **Denormalize the excerpt into the reply row:** render needs no second read, but the
  copy goes stale on edit and survives delete; F10's placeholder would need a second
  write path into every child. Rejected: edits and deletes are the spec §8.5
  follow-up and this choice would prebuild their hardest case wrong.
- **Resolve by ID with the client fetching each missing parent:** correct, but a
  reply-heavy page costs one `GET /messages/{id}` per quoted parent outside the page,
  tens of requests per scroll. Rejected for the cost; the server reads the same keys in
  one batch.

## Risks Accepted

| Risk | Mitigation |
|------|------------|
| A page with many distinct parents makes the page read N+1 on the server | bounded by page size (50); parents are read by key in one batched request; parents inside the page are not re-read |
| A parent in a cold month bucket adds a slow partition read to the page | the parent's bucket is derived from its Snowflake ID, one read, no walk; the client caches it afterwards |
| A reply to a parent in another conversation is impossible by F10 but not by schema | the `msg` handler rejects a `reply_to` whose conversation differs; the store never checks |

## Consequences

**Positive:** one source of truth per message; edit and delete, when they come, touch
one row; F10's placeholder is a render rule, not a storage rule.
**Negative:** the page response grows by the referenced parents; a reply-heavy group
page carries up to 50 extra rows.
**Neutral:** the message row keeps its shape from §2.2; only the page API's response
gains a field.

## Conditions

- Design §2.3 documents the `parents` field and the batch key read; flow 9 draws it
  and drops the open note; tradeoffs.md 5.3.5 closes its quoting half.
- The prototype's history route returns `parents` when a later epic touches it; not
  required now.
