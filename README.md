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
- [`docs/design.md`](docs/design.md) — decisions so far (heartbeat and reconnect, history pagination),
  and [`docs/diagrams/high-level.html`](docs/diagrams/high-level.html), the interactive architecture diagram.
- [`docs/specification.md`](docs/specification.md) — the brief: requirements, scale, the
  decisions the design must make, evaluation rubric, follow-up extensions.
- [`docs/estimation.md`](docs/estimation.md) — the numbers, derived, and which decisions they changed.
- `docs/tradeoffs.md` — not yet written (see §6 of the specification).

Companion to the other `vntech-*` systems talks:
[vntech-load-balancer](https://github.com/spartan-trucle/vntech-load-balancer),
[vntech-auth](https://github.com/spartan-trucle/vntech-auth).
