# Release notes and preparation

[Tiếng Việt](README.vi.md)

[Proposed 2.1.0 notes](v2.1.0.md) follow the latest published
[2.0.0 release](https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.0.0):
package/version, a short outcome, Highlights, compatibility/fixes, Known limits
and Upgrade. Only the structure is reused; no previous live-test claims are
carried into this proposal. CHANGELOG.md remains source history.

Version 2.1.0 is a proposal for the additive features, not a version already
written to package.json (upstream currently says 2.0.1), tagged or published.
Merge feature PRs #2/#3/#4 into `v2.0-dev` and validate the integrated candidate
before finalizing the notes. Maintainers may choose a different version; update
both note files and package manifests together if so.

## Preparation through GitHub, not a local coding PC

[prepare-release.yml](prepare-release.yml) is an inactive template shared with
the wrapper proposal. Install it once as `.github/workflows/prepare-release.yml`
on the upstream default branch using a reviewed PR. Enable Actions to create
PRs (`contents: write`, `pull-requests: write`). A maintainer then selects
**Actions → Prepare release PR → Run workflow**, enters `2.1.0`, and reviews
`chore/release-2.1.0` → `v2.0-dev`.

The runner checks out the trusted upstream target, rejects an already published
version, runs `npm version <version> --no-git-tag-version --ignore-scripts`,
and generates the real lockfile with:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci
npm run format
npm run lint
npm run format:check
npm test
```

Only package.json/package-lock.json are committed and immediately pushed to a
new branch; a PR is opened, and both manifests are also available as a workflow
artifact. No direct release-branch push, tag, npm publication or deployment.
Existing preparation branches are never force-pushed. GitHub may require
**Approve workflows to run** for the bot-created PR's CI.

After reviewing/merging the preparation PR, promote the reviewed development
branch to main per upstream's existing policy. Use GitHub's release UI to tag
the exact version from main and paste the notes (remove the proposal banner
only after its conditions are met). Existing `publish.yml` handles publication
through npm trusted publishing. No manual npm publish or maintainer PC is needed.

Publish the engine first. Then the wrapper can resolve `^2.0.1` and prepare its
1.1.0 lockfile/PR. Each repo owns its own lockfile: never copy the engine lock
into the wrapper. `npm ci` checks consistency and does not fix a stale lock.
For the current wrapper PR, its contributor can regenerate and push the lock
to that same PR after publication; a bot is optional, not a merge prerequisite.

The template must be on the default branch for the manual Actions entry point,
and `v2.0-dev` must exist. It checks out no fork code with a privileged token.
It has static YAML/shell validation only; no upstream run, new release or live
account test is claimed. The existing publish workflow remains unchanged.

References: [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/),
[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
[manual Actions runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[GITHUB_TOKEN and PR checks](https://docs.github.com/en/actions/concepts/security/github_token).
