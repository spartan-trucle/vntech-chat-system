# Plan A4 — run the spec §7 rubric

Epic text: `.planning/roadmap.md` §3, Workstream A, A4. Lane A, branch
`claude/a-design-closeout-d1e5bf`. Read-only on the design; writes one file.

## Files

- create `docs/rubric.md`
- create this plan

## Inputs (read-only)

- `docs/specification.md` §2 (every F* and N*), §4.2 (the flows), §5 (the bullets),
  §7 (the nine rows and their pass conditions)
- `docs/design.md`, `docs/estimation.md`, `docs/tradeoffs.md` (A1),
  `docs/diagrams/flows.md` (A2), `docs/diagrams/high-level.html`, the ADRs, the board

## Steps

1. For each of the nine rows, restate the pass condition as a checklist of concrete
   things to find, then look for each one and cite where it is (section, entry, flow).
2. Score pass or fail. A row fails if any item of its checklist has no source; a
   caveat that does not break the condition is noted, not failed.
3. Behind every fail, name the concrete gap: the requirement, bullet or flow that has
   no answer, and what would close it (the A3 decision, or a `design.md` section).
4. Collect the gaps into the A3 input list at the end, each with the spec bullet it
   closes.
5. Note anything the run found that is not a gap in the design but in the inputs
   (spec wording) as a surprise for the hub.

## Done

- `docs/rubric.md` scores all nine rows with evidence; every fail has a concrete gap.
- The A3 list at the end is complete: every open bullet from `tradeoffs.md` appears.
- Committed as `docs(rubric): ...` on the lane branch.
