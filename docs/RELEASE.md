# Release checklist

How a version of the engine reaches npm, and what has to follow in the two other repos so that the
wrapper, the wiki and the engine stop drifting apart. AGENTS.md §8 is the short form; this is the
full list. Every step an agent can run, it runs; the user's part is marked **(user)**.

Three surfaces carry a version and all three must be touched, in this order:

| Surface | Where the version lives | Lags behind when forgotten |
|---|---|---|
| Engine `@ardennguyen/zalo-agent-cli` | `package.json`, git tag, `CHANGELOG.md` | — |
| Wrapper `@ardennguyen/zalo-mcp` | `package.json` (the exact engine version it pins) and its `package-lock.json` | wrapper installs serve an old engine |
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
   defaults to `v3.0-dev`, so for a 2.5.x release pass `branch: v2.5-dev`. Run in the wrapper's repository, it sets the
   wrapper's exact engine pin (§2) to the newest published engine version, or to the `engine_version` input when one
   is given.
7. Wait for `ci.yml` (Ubuntu, Node 22 and 26) to pass on the merge commit — the offline suite can fail on
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

A wrapper install serves the engine version its `package.json` pins exactly (`"3.5.1"`, never a range), so the
pin must move with every engine release even when the wrapper's own code did not change. Every npm reads
`package.json`, so `npm install -g`, the scripts' `install`/`init`/`update` and a `git clone` + `npm ci` all get
exactly the pinned engine. `package-lock.json` is the wrapper repository's ordinary lock (CI runs `npm ci`); npm
never publishes it. There is no `npm-shrinkwrap.json`: npm 12, which the wrapper's CI and publish job use, neither
packs it nor runs `npm ci` by it.

1. In `zalo-mcp/` on `v2.0-dev`: set `"@ardennguyen/zalo-agent-cli": "X.Y.Z"` in `package.json` (exact, no `^`),
   then `npm install --package-lock-only`.
2. `npm test`, then `git diff` — only `package.json` (the pin) and `package-lock.json`.
3. Every pin move is a wrapper release: installs get the new engine only once the wrapper carrying the pin is
   published (`npm install -g` and `update` read the published `package.json`). Bump `version` in `package.json`
   (`npm install --package-lock-only` again) and add a section to the wrapper's `CHANGELOG.md` naming the engine it
   installs (from 2.1.0; earlier wrapper history is on its GitHub Releases).
4. Commit `build: pin engine X.Y.Z` and `chore: bump version to A.B.C (engine X.Y.Z)`, push.
5. **(user)** PR `v2.0-dev → main`, tag `vA.B.C`, GitHub Release — the same `publish.yml` path as the engine.
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
  (`docs/agent-notes.md`, and `AGENTS.md` only if a *rule* changed — keep it under 40,000 characters).
