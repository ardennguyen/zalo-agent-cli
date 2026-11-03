# Git workflow: version branches, PR releases, no `-s ours` merges

**Date:** 2026-11-03 · **Status:** accepted · **Replaces:** AGENTS.md §7/§8 as written before this date

## Context

The rule file said "always commit to `main` first, then reset the version branch to `origin/main`",
and `prepare-release.yml` targeted `v2.0-dev` for the engine and `v1.1.0` for the wrapper. Actual
practice since 2.5.7 was the opposite: work on `v2.5-dev`, a pull request into `main` per release
(#17, #18, #19), the tag on the merge commit. Local `main` had not been pulled since #16. One branch
per release, reset and force-pushed, had also left branches and tags sharing a name
(`v1.0.5`, `v1.1.0-beta1`, `v2.0.0`), so git printed `refname is ambiguous` on every reference.

Separately, every merge of `main` into `v3.0-dev` since 2.5.7 was made with
`-s ours` ("keeping this branch's tree"). That records `main` as merged while taking no hunk. It was
safe only because each 2.5.x fix had been written on v3 first and re-applied to 2.5 by hand.

## Decision

1. Work lands on the active version branch (`v2.5-dev`, `v3.0-dev`), never on `main`. `main` moves
   only by a pull request from a version branch; that PR is the release and the user approves it.
2. The tag on the merge commit is the only name a release has. No branch is created per release.
   The stale per-release branches and the fully merged ones were deleted locally on 2026-11-03;
   `v2.2-dev` is kept locally because it holds one commit (`c9f8903`) that is on no remote.
3. A change both lines need is written where it is found and `git cherry-pick -x`'d to the other
   branch. `main` is merged into `v3.0-dev` only as a real merge with conflicts resolved. `-s ours`
   is never used.
4. `prepare-release.yml` targets the active version branches and accepts an explicit `branch` input.
5. The release steps for all three repos are in `docs/RELEASE.md`; `CHANGELOG.md` is the committed
   record of each release (previously only gitignored drafts under `agent/docs/`).

## Consequences

- Version-branch names appear in AGENTS.md §7, `prepare-release.yml` and `docs/RELEASE.md`; starting
  a new line (`v2.6-dev`, `v3.1-dev`) means updating those three places.
- A fix made on 2.5 first must be cherry-picked to v3 by the session that made it, in the same
  sitting; nothing else will carry it.
