# Release checklist

How a version of the engine reaches npm, and what has to follow in the two other repos so that the
wrapper, the wiki and the engine stop drifting apart. AGENTS.md §8 is the short form; this is the
full list. Every step an agent can run, it runs; the user's part is marked **(user)**.

Three surfaces carry a version and all three must be touched, in this order:

| Surface | Where the version lives | Lags behind when forgotten |
|---|---|---|
| Engine `@ardennguyen/zalo-agent-cli` | `package.json`, git tag, `CHANGELOG.md` | — |
| Wrapper `@ardennguyen/zalo-mcp` | `package-lock.json` (resolved engine), `package.json` range | wrapper installs serve an old engine |
| Wiki `zalo-agent-cli.wiki` | `Home.md` "engine X.Y.Z" line, `(engine X.Y.Z)` notes on feature lines | pages describe flags the install does not have, or miss ones it does |

## 1. Engine

On the active version branch (`v2.5-dev` for 2.5.x, `v3.0-dev` for 3.0):

1. Make sure every change since the last tag has a line under `## [Unreleased]` in `CHANGELOG.md`.
   Write the lines as the release notes a user reads: what changed, what to do differently, the
   commit link. A major version also needs its breaking changes marked and an upgrade section
   (for 3.0: back up the 2.x home before the first 3.0 command, because sealing it is one-way — docs/security.md §6).
2. Re-measure the numbers that docs quote — `node scripts/count-surface.mjs --tests` — and fix every
   doc that quotes a stale one (AGENTS.md §10 lists them).
3. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it,
   add the `[X.Y.Z]: …/releases/tag/vX.Y.Z` link at the bottom and move the `[Unreleased]` compare
   link forward.
4. `npm version X.Y.Z --no-git-tag-version`, then the full gate: `npm run format && npm run lint &&
   npm run format:check && npm test`.
5. Commit as `chore: bump version to X.Y.Z` (stage by path: `package.json`, `package-lock.json`,
   `CHANGELOG.md`, the docs from step 2) and push the version branch.
6. **(user)** Open and merge the pull request `vX.Y-dev → main`. The merge is the release decision.
   `.github/workflows/prepare-release.yml` can do the `npm version` part of step 4 as a PR (manifests only, not the CHANGELOG); it
   defaults to `v2.5-dev`, so for a 3.x release pass `branch: v3.0-dev`.
7. Wait for `ci.yml` (Ubuntu, Node 22) to pass on the merge commit — the offline suite has failed on
   Linux after passing on Windows — then tag the merge commit and push the tag: `git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z`.
   The tag is the only name a release has; never create a branch named after it.
8. Create the GitHub Release from the tag with the CHANGELOG section as its body
   (`gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <section>`). Publishing the Release
   triggers `.github/workflows/publish.yml` (npm trusted publishing, `--provenance`).
   **Never run `npm publish` by hand.**
9. Wait for the publish job, then confirm: `npm view @ardennguyen/zalo-agent-cli version`.
10. Bring the other line up to date: `git cherry-pick -x` the user-facing commits onto `v3.0-dev`
    (or onto `v2.5-dev` when the fix was made on v3 first). Never `merge -s ours` (AGENTS.md §7).

## 2. Wrapper (`zalo-mcp`)

A wrapper install serves whatever engine its lock file resolves, so the lock must move with every
engine release even when the wrapper's own code did not change.

1. In `zalo-mcp/` on `v2.0-dev`: `npm install @ardennguyen/zalo-agent-cli@X.Y.Z --package-lock-only`
   (the `^3.0.0` range in `package.json`, set by wrapper 2.1.0, stays unless the engine's major or minor changed).
2. `npm test`, then `git diff` — only `package-lock.json` (and `package.json` if the range moved).
3. Decide whether the wrapper itself needs a version: a new engine flag the launcher must forward,
   a README change, or a changed range → bump `version` in `package.json` and add a section to the
   wrapper's `CHANGELOG.md` (from 2.1.0; earlier wrapper history is on its GitHub Releases). A lock-only move does not need a wrapper release, but the
   lock bump must still be committed and pushed so a fresh `git clone` + `npm ci` gets the engine.
4. Commit `build: pin engine X.Y.Z in the lock file` (or `chore: bump version to A.B.C …`), push.
5. If the wrapper version moved: **(user)** PR `v2.0-dev → main`, tag `vA.B.C`, GitHub Release —
   the same `publish.yml` path as the engine.
6. Deployed folders update themselves with `zalo-mcp.ps1 update` / `./zalo-mcp.sh update`; never
   `npm install` in a deployed folder (AGENTS.md §9).

## 3. Wiki (`zalo-agent-cli-wiki`)

1. `Home.md` carries one line "Documented against engine X.Y.Z". Update it.
2. Feature lines added for this release carry `(engine X.Y.Z)` — the version a feature *appeared in*,
   so earlier markers are left alone; a sweep that rewrites every marker to the newest version is
   wrong.
3. Every EN page edited gets its VN pair edited in the same commit (`_Sidebar.md` is the pairing).
4. **Before `git push`**, from the wiki checkout: `bash ../zalo-agent-cli/.agents/check-wiki-leaks.sh`
   — exit 0 or do not push. A wiki push publishes instantly.

## 4. After everything

- `agent/docs/release-notes_vX.Y.Z.md` is no longer needed: `CHANGELOG.md` is the record. If a
  draft was written there, delete it once its content is in the CHANGELOG.
- Update the project-wide handoff notes if the release changed a rule
  (`docs/agent-notes.md`, and `AGENTS.md` only if a *rule* changed — mind the 24,000-byte cap).
