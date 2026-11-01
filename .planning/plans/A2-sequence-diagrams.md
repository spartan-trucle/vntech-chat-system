# Plan A2 — sequence diagrams for the nine flows

Epic text: `.planning/roadmap.md` §3, Workstream A, A2. Lane A, branch
`claude/a-design-closeout-d1e5bf`. Docs only.

## Files

- create `docs/diagrams/flows.md` (Mermaid source kept in the Markdown)
- create this plan
- not touched: `docs/index.html`, `README.md` (the roadmap's "link from" task is lane
  C's closing task; noted in the report)

## Sources (read-only)

- `docs/specification.md` §4.2: the nine flows and the questions each must answer
- `docs/design.md`: §1 heartbeat and reconnect (flows 2, 4, 5), §2.3 history and
  jump-to-parent (flows 7, 9), §3 receipts and push (flows 2, 4, 6), §4.2–§4.4 fan-out
  write order and the reconnect sequence as drawn (flows 1–4), §5.4 presence flow as
  drawn (flow 5), §6.2–§6.3 upload and download as drawn (flow 8)
- `docs/index.html` Component 3 (direct push, bounded per-destination buffer)
- `docs/prototype/index.html` server trace order: store, ack, XADD, push, apns
- `docs/tradeoffs.md` open list: flow 9 shows the quoting choice as a note

## Rules

- Participants fixed to seven kinds: device, API server, chat server, Redis, message
  store, object storage, push gateway. A flow may show two instances of a kind
  (device A / device B, A's chat server / B's chat server) but no other kind.
- Each diagram answers the spec's questions for that flow in notes on the diagram
  (which hop assigns the ID, which hop acks, where the message waits, when "sent"
  shows, and so on).
- Nothing drawn that the design does not say. Open points (service discovery,
  quoting) are notes marked *open*, not arrows.

## Steps

1. Write the file skeleton: one H2 per flow, the spec's question under it, the
   `sequenceDiagram` block, then a short "what the diagram answers" list.
2. Draw flows 1–3 (send paths) from §4.2's write order and the board's fan-out.
3. Draw flow 4 from §4.4 as drawn plus §3.5 for the read-cursor push.
4. Draw flow 5 from §5.4 as drawn plus §1.5 for the sweeper.
5. Draw flow 6 from §3.3–§3.6; flow 7 from §2.3; flow 8 from §6.2–§6.4; flow 9 from
   §2.2–§2.3 with the open note.
6. Render every diagram with Mermaid in the browser pane and fix parse errors.

## Done

- Nine `sequenceDiagram` blocks, all parse, participants within the seven kinds.
- Flow 9 has a note marked open for the quoting choice and no arrow that guesses it.
- Committed as `docs(diagrams): ...` on the lane branch.
