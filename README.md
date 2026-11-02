# The Chat System — system design practice

Design exercise: a real-time chat service (1:1 and group, multi-device, offline delivery)
at Messenger / WhatsApp scale.

**Read online:** https://spartan-trucle.github.io/vntech-chat-system/ (the `docs/` folder, served by GitHub Pages).

- [`docs/index.html`](docs/index.html) — the discussion page: requirements with their reasoning and
  challenges, scale numbers, and the tech-stack decision board (open / decided per layer).
  Plain HTML, no build step; open the file or serve `docs/` with any static server.
- [`docs/prototype/index.html`](docs/prototype/index.html) — **the target, simulated**: a clickable client
  (Truc on a phone and a laptop, Khanh on a phone, three scripted group members) with a simulated server
  and a trace of every hop. Drop a network, send, reconnect, read on one device; check the trace against
  `design.md`. Single file, no backend. Not the protocol prototype: that is the Node.js server in design §Prototype.
- [`docs/design.md`](docs/design.md) — the decisions, one deep-dive section per component, and §7
  **What the prototype changed**: what the build found, what was written back, what is now a question for the author.
  Plus [`docs/diagrams/high-level.html`](docs/diagrams/high-level.html), the interactive architecture diagram.
- [`docs/diagrams/flows.md`](docs/diagrams/flows.md) — Mermaid sequence diagrams for the nine flows of
  specification §4.2; open decisions appear as notes, never as arrows.
- [`docs/specification.md`](docs/specification.md) — the brief: requirements, scale, the
  decisions the design must make, evaluation rubric, follow-up extensions.
- [`docs/estimation.md`](docs/estimation.md) — the numbers, derived, and which decisions they changed.
- [`docs/tradeoffs.md`](docs/tradeoffs.md) — every specification §5 bullet as *chosen / rejected / why*, with the
  open ones listed first.
- [`docs/rubric.md`](docs/rubric.md) — the specification §7 rubric run: six pass, three fail, and the decision
  list (A3) that closes the fails.
- [`prototype/`](prototype/) — **the protocol prototype**: a Node.js + TypeScript chat server with in-memory ports,
  a scripted multi-device client, and the six scenarios the runtime ADR defines as done (S1 unclean drop, S2 replay
  from the cursor, S3 dedup, S4 list before replay, S5 presence debounce, S6 media metadata only) plus S7, the replay-mode boundary (B10), all passing. One
  process, no auth, no persistence, no multi-server. Run `npm test` and `npm run scenarios` in `prototype/`; the
  scenario table is in [`prototype/README.md`](prototype/README.md). Optional: `npm run redis:up` and
  `npm run test:redis` run the sync queue, route table, presence lease and presence bus against a real Redis 7
  through the same port contracts, which is what showed the three Redis facts the in-memory adapters hid.

Companion to the other `vntech-*` systems talks:
[vntech-load-balancer](https://github.com/spartan-trucle/vntech-load-balancer),
[vntech-auth](https://github.com/spartan-trucle/vntech-auth).
