# Plan A1 — `docs/tradeoffs.md`

Epic text: `.planning/roadmap.md` §3, Workstream A, A1. Lane A, branch
`claude/a-design-closeout-d1e5bf`. Docs only.

## Files

- create `docs/tradeoffs.md`
- create this plan

## Sources (read-only)

- `docs/specification.md` §5.1–§5.8: the bullet list the file must cover, one entry each
- `docs/design.md` "Rejected alternatives" tables §1.6, §2.6, §3.7, §4.6, §5.6, §6.5,
  plus the decisions in the text they follow
- `docs/index.html` Component 2 (Cassandra vs Postgres, Snowflake vs created_at) and
  Component 3 (fan-out on write, direct push, bounded per-destination buffer,
  store → ack → queue write order, Kafka in the hot path, fan-out on read)
- `docs/estimation.md` for the number that decided each entry, where one did
- the four ADRs in `.memory/decisions/`

## Steps

1. Enumerate every bullet of spec §5.1–§5.8 (30 bullets) and give each a stable ID
   (`5.1.1` … `5.8.4`).
2. Sort the bullets into *decided* and *open*. Open = no verdict anywhere in
   `design.md`, the ADRs or the board: service discovery (client-facing half), reply
   quoting, store-primary failure, the five paging metrics, production runtime
   (not a §5 bullet, listed for completeness). Open bullets go in a list at the top
   and are never given a chosen option.
3. For each decided bullet write one entry: **chosen** / **rejected** / **why**, and a
   **number** line naming the `estimation.md` figure that decided it, or "none" when the
   decision was made on a requirement or an argument rather than a number.
4. Where a bullet is half decided (service discovery: the user → server lookup is
   decided, the client → server choice is open; reply: `reply_to` storage decided,
   quoting open; chat-server failure: reconnect decided, mark-all-offline open) say
   which half is which, inside the entry, and list the open half at the top.
5. Cross-check: every §5 bullet appears exactly once; every rejected row in the six
   design tables and the two board components is attributed to a bullet.

## Done

- `docs/tradeoffs.md` exists; 30 entries; open list at the top names 5 bullets.
- No decision invented; every chosen line traces to a section of `design.md`, an ADR
  or a board component.
- Committed as `docs(tradeoffs): ...` on the lane branch.
