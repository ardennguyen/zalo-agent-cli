# Decisions

Lightweight architecture decision records: one file per decision or per decision batch, named
`YYYY-MM-DD-<slug>.md`, newest at the bottom of this list. A decision is recorded here when it
changes how the code is shaped, what the project will or will not build, or how the repos are run.
The reasoning behind day-to-day rules stays in `agent-notes.md`; this folder is for the choices
those rules follow from.

A record is never edited to say something different later. When a decision is reversed, a new
record says so and the old one gets a "Superseded by" line at the top.

| Date | Record | Status |
|---|---|---|
| 2026-10-23 / 2026-10-28 | [v3.0 program decisions D1–D31](2026-10-23-v3.0-program-decisions.md) | accepted (D2 superseded by D28) |
| 2026-10-28 | [Replace zca-js with an in-tree protocol layer](2026-10-28-zca-js-replacement.md) | accepted, scheduled after 3.0.0 |
| 2026-11-03 | [Git workflow: version branches, PR releases, no `-s ours` merges](2026-11-03-git-workflow.md) | accepted |
