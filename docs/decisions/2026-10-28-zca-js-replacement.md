# Replace zca-js with an in-tree protocol layer

**Date:** 2026-10-28 · **Status:** accepted, scheduled after 3.0.0 · **Supersedes:** D2 (hybrid engine) in the v3.0 program decisions

## Context

The personal-account side of the CLI is built on [zca-js](https://github.com/RFS-ADRENO/zca-js)
2.2.0, carried with a `patch-package` patch and shipped inside the tarball via `bundleDependencies`.
3.0 already owns the parts zca-js got wrong for this use: login and the saved-session login, the
official QR login with a trusted companion device, the socket supervisor, the phone-backed restore
(transfer-sync-v2), zCloud, logout. Those live in `src/zalo/` (21 files on `v3.0-dev`) and
`src/core/sync-v2/`. The rest of the HTTP surface still goes through zca-js, and 14 files reach into
its private `utils.cjs`.

## Decision (D28, D29 of the v3.0 program)

- A complete replacement: no zca-js in `node_modules`, no code in the tree that cannot be edited.
- It ships **after 3.0.0**, as 3.x, in stages behind a facade with a per-function switch and a
  differential oracle against zca-js — not as one big change.
- Scope: every zca-js function still in use that does not overlap what `src/zalo/` already owns.
  Same style as the rest of the code base (JavaScript + JSDoc). Uploads take the new Web/PC path.
- Licensing: the MIT notices of `PhucMPham/zalo-agent-cli` and `zca-js` leave only when a similarity
  scan and per-file history show nothing derived from them remains. Until then they stay.

## Status

Measured on `v3.0-dev` at `530060c` (2026-11-03) with `git grep`:

| | 2.5 (`v2.5-dev`) | 3.0 (`v3.0-dev`) |
|---|---|---|
| `src/` files mentioning `zca-js` | 64 | 89 |
| files that `require(... "zca-js" ... "utils.cjs")` | 7 | 7 |
| `api.<method>(` call sites / distinct methods | — | 129 / 60 |
| files in `src/zalo/` (own protocol layer) | 0 | 21 |

The number to watch is the distinct-method count: it is what has to reach zero. Re-measure with
`git grep -h -o -E 'api\.[a-zA-Z]+\(' -- src | sort -u | wc -l` on the v3 worktree and update this
table when a stage lands. The detailed plan is still a local draft
(`agent/work/…/zca-js-replacement-plan_2026-10-28.md`); when the first stage starts, that plan
moves into `docs/` next to this record.

## Consequences

- Until the cut-over, bumping `zca-js` still means regenerating the patch and re-pinning the exact
  version (`tests/unit/packaging.test.js` enforces both).
- Two implementations of the same protocol exist in the tree during the staged replacement; the
  facade's per-function switch, not the call site, decides which one answers.
