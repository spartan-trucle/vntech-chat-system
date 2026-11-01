# The Chat System — system design practice

Design exercise: a real-time chat service (1:1 and group, multi-device, offline delivery)
at Messenger / WhatsApp scale.

- [`docs/index.html`](docs/index.html) — the discussion page: requirements with their reasoning and
  challenges, scale numbers, and the tech-stack decision board (open / decided per layer).
  Plain HTML, no build step; open the file or serve `docs/` with any static server.
- [`docs/specification.md`](docs/specification.md) — the brief: requirements, scale, the
  decisions the design must make, evaluation rubric, follow-up extensions.
- `docs/estimation.md`, `docs/design.md`, `docs/tradeoffs.md`, `docs/diagrams/` — the design
  itself, produced while working through the brief (see §6 of the specification).

Companion to the other `vntech-*` systems talks:
[vntech-load-balancer](https://github.com/spartan-trucle/vntech-load-balancer),
[vntech-auth](https://github.com/spartan-trucle/vntech-auth).
