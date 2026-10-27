# Agent notes — the background behind `AGENTS.md`

`AGENTS.md` is capped at 24,000 bytes, because Google Antigravity silently truncates any single
rule file past that limit — no warning, no marker; the tail simply never reaches the model. So
`AGENTS.md` carries **rules**, and this file carries everything a rule points at: the annotated
tree, the lookup tables, the command sequences, and the incidents that produced each rule.

This file has no size limit. When a rule in `AGENTS.md` needs a paragraph of justification, the
rule stays there and the paragraph comes here.

---

## Repository layout (§2)

```
src/
├── index.js              # Commander entry point — registers every command group
├── cli.test.js           # CLI-surface tests (--help/--version, no Zalo session)
├── commands/             # One file per command group; each exports register<X>Commands(program)
│   ├── login.js  msg.js  friend.js  group.js  conv.js  account.js  profile.js
│   ├── poll.js   reminder.js  auto-reply.js  quick-msg.js  label.js  catalog.js
│   ├── listen.js sync.js  mcp.js
│   └── oa.js     oa-init.js   oa-listen.js
├── core/                 # Session, storage, and sync primitives
│   ├── zalo-client.js    # zca-js API singleton + autoLogin/clearSession
│   ├── credentials.js    # CONFIG_DIR (~/.zalo-agent-cli), 0600 credential files
│   ├── accounts.js       # Multi-account registry + per-account data dir wipe
│   ├── oa-client.js      # Official OA REST client
│   ├── db.js             # SQLite (better-sqlite3, WAL) message/thread cache
│   ├── sync.js           # SyncManager — socket backfill, gap tracking, freshness debounce
│   ├── sync-v2/          # transfer-sync-v2 — the REAL phone-backed history restore
│   │   ├── index.js      # SyncV2.restore() — socket cmd 590/591 conversation + message rounds
│   │   ├── assets.js     # libzproto WASM fetch + cache from Zalo's CDN
│   │   ├── media.js      # the ONLY media downloader
│   │   └── gid.js        # opaque convId → real threadId mapping for non-friend DMs
│   ├── daemon-channel.js # loopback HTTP transport to a running daemon (transport only)
│   ├── daemon-sync.js    # the sync stage bodies daemon-channel injects as runners
│   ├── lock.js           # daemon.lock — one listen/db writer per account
│   └── live-store.js     # live socket events → rows (shared by listen, mcp, sync)
├── mcp/                  # MCP server
│   ├── mcp-tools.js      # SOURCE OF TRUTH for the MCP tool list
│   ├── mcp-server.js     # stdio transport
│   ├── mcp-http-transport.js  # Express + StreamableHTTP + bearer auth + /health
│   ├── mcp-config.js     # ~/.zalo-agent-cli/mcp-config.json defaults & merge
│   └── message-buffer.js  thread-filter.js  thread-name-cache.js  notifier.js
└── utils/                # Pure helpers (bank BINs, proxy masking, QR, output, quote, …)
skill/                    # Agent-facing skill (SKILL.md + references/ + evals/)
docs/official-account.md  # Full OA reference (Vietnamese)
docs/agent-notes.md       # This file
patches/                  # patch-package patches against zca-js
tests/                    # Test suite — see tests/README.md
├── helpers/              # sandbox (temp HOME), CLI harness, target guard, live gates
├── unit/                 # Offline: accounts, credentials, lock, db, mcp-config, oa-client, helpers
├── cli/                  # Offline: full command-surface manifest + pre-network validation guards
├── e2e/                  # Live, tiered 1–5 by blast radius; gated behind ZALO_TEST_LIVE=1
├── run-e2e.js            # Orchestrator — runs tiers sequentially, one process each
└── targets.json          # Disposable live targets (GITIGNORED; template in targets.example.json)
```

### Per-account runtime storage

```
~/.zalo-agent-cli/
├── accounts.json                 # Registry (0600); changed under accounts.json.lock, replaced atomically
├── accounts.json.bak             # The registry before the last change
├── credentials/cred_<ownId>.json # Session credentials (0600)
├── mcp-config.json               # Optional MCP config
├── accounts/<ownId>/
│   ├── zalo.db                   # SQLite cache (messages, threads, contacts, sync_state, sync_gaps)
│   ├── media/                    # Auto-downloaded attachments
│   ├── sync/                     # transfer-sync-v2 assets (zproto-cache/)
│   ├── daemon.lock               # Held by a running `listen` daemon or `mcp start`
│   └── daemon-channel.json       # Loopback port + token of that daemon's upload channel (0600)
└── qr.png
```

---

## Numbers repeated across docs — sources and check commands (§10)

| Invariant | Current | Source of truth | How to check |
|---|---|---|---|
| CLI commands | **227** invokable leaves (195 personal + 32 OA) | the live commander tree | walk it (see below) — counting strings in `tests/cli/surface.test.js` gives the wrong answer |
| Command groups | **26** containers — 18 top-level + 7 OA subgroups + `mcp webhook` | the live commander tree | walk it. `src/index.js` makes **20** `register*` calls, which is neither number: `oa` registers 7 nested subgroups of its own, and `login`/`sync` register leaves, not groups |
| MCP tools | **27** | `src/mcp/mcp-tools.js` | `grep -c 'server.registerTool' src/mcp/mcp-tools.js` |
| OA commands | **32** | `src/commands/oa.js` | `OA_SUBGROUPS` in the surface test |
| Offline tests | **3470** as of 2026-10-27 (3461 pass, 9 skipped, 0 todo, 0 fail) | `npm test` | the run's own summary line |

The test count is a snapshot, not a contract — re-measure rather than trusting it. It has been
reported wrong before: a count of 1153 came from globbing only `tests/`, omitting the suites that
still live next to their module (`src/utils/bank-helpers.test.js`, `src/mcp/*.test.js`). `npm test`
globs both locations.

The MCP tool list has drifted before — docs claimed 4 tools while the code registered 7.

### Counting the CLI surface — walk the tree, do not count strings

Two sessions got this wrong on the same day, in opposite directions, and both
answers looked reasonable:

- **201** came from grepping quoted strings out of `tests/cli/surface.test.js`.
  That sweeps up `FLAG_CONTRACT` keys and quoted text inside comments, which are
  not commands.
- **204** came from walking the tree but missing that `update` is registered
  inline in `src/index.js` with `.command("update")` rather than through a
  `register*Commands` function, so a walk of those functions cannot see it.

The number to quote is **invokable leaf commands**: what a user can actually
type. It excludes the 21 group containers (`msg`, `oa`, `oa follower`, ...),
which is the convention `command-reference.md` already uses.

To measure it, parse the import/call pairs out of `src/index.js` rather than
hardcoding them — three exports do not follow the plural pattern
(`registerListenCommand`, `registerOACommands`, `registerMCPCommands`), and
guessing those names silently drops OA's 32 commands and MCP's 3. Load each into
a fresh `Command`, walk it, count nodes with no children, and add the inline
top-level commands found by scanning `src/index.js` for `.command("...")`.

Measured (2026-10-21): **222 leaves, 24 containers, 246 nodes**. Measured again 2026-10-26, after `msg search`: **223 leaves, 24 containers, 247 nodes**; after `read`: **225 leaves, 25 containers, 250 nodes**; after `write`: **227 leaves, 26 containers, 253 nodes**.
By group: group 35, oa 32, friend 26, msg 25, conv 21, top-level 12, profile 14,
catalog 10, account 7, poll 7, mcp 7 (`start`, `wait`, `mark-read`, and the four `webhook`
leaves), reminder 6, fleet 6, bank 5, auto-reply 4, quick-msg 4, label 2, read 2, write 2, listen 1. (Was 190 at `99d5a97` before `mcp` gained `wait` and `mark-read`, and
184 at `a719c99` before `conv` gained pin/unpin/archive/unarchive
and `msg` gained pin/unpin.) A separate audit confirmed zero drift between that live tree and the
manifest in `tests/cli/surface.test.js`, in both directions, so the manifest is
trustworthy as the *contract* even though counting its string literals is not
how you get the number.


### Why AGENTS.md says to plant a sample in the leak check

A check that only ever prints "clean" is indistinguishable from a broken one.
It is the same green-check-hiding-a-problem shape as the four commands that had
never once worked while every test passed: nothing in the output distinguishes
"looked and found nothing" from "did not look". The leak check has three
categories and a denylist it reads from disk, so it can degrade silently in at
least two ways — a regex that no longer matches, and a terms file that is
missing or empty. Planting one sample per category and confirming a non-zero
exit is what separates those. `.agents/check-wiki-leaks.sh` exits 2 rather than
0 when the terms file is absent for the same reason.

### The copyright holder's name is the one intentional leak-check exception (2026-10-13)

The 2.0.1 relicense put the author's name in `LICENSE`, `NOTICE` and the README
license line. That string had been on the confidential-terms denylist since the
2026-09-30 scrub, which treated it as identity data from chat fixtures. Two
different things share one string: a name inside test data is a leak; a
copyright holder named on the licensor's own license is the point of a license.

The maintainer confirmed it is intentional. So the entry was removed from the
gitignored `.agents/confidential-terms.txt` (one exact line, matched by
whole-line equality rather than substring), and AGENTS.md section 10 now states
the exception with its date instead of claiming "0 on every remote ref".

The removal was verified, not assumed. A page carrying the README license line
exits 0. A planted company term, a planted 19-digit id, and each of the six
remaining personal-name terms still exit 1. The point of that last check is that
editing a denylist can silently weaken it; it is cheap to prove it did not.

Any other occurrence of that name outside those three files is still worth a
second look: the exception is for the license notice, not a general permission.

### Why the wiki check flags 12 digits and the test flags 15

They do different jobs, so they are not meant to be equal.

`tests/unit/no-real-ids.test.js` runs over code, tests and fixtures, where fake
ids must be allowed (it has a convention for them) and where 13-digit epoch
millisecond values are normal. Real Zalo ids are 18 or 19 digits, so a 15-digit
floor misses nothing real and keeps the false-positive rate near zero.

`.agents/check-wiki-leaks.sh` runs over prose. It has no allowlist and no fake
convention, and wiki pages should contain no long digit run at all, so the
stricter 12-digit floor costs nothing: the wiki currently has zero hits. If a
wiki page ever needs an epoch-millisecond example the check will flag it, which
is the right nudge toward a placeholder.

Do not "align" them by lowering the test (its convention depends on the floor)
or raising the script (the wiki has no review gate and no test run in front of it).

### What CI actually runs

AGENTS.md section 6 says CI runs "exactly these". It runs `npm run lint`,
`npm run format:check` and `npm test` (not the auto-fixing `npm run format`),
then `node src/index.js --version` and `--help`, and a final step that imports
every `tests/e2e/*.test.js` file with no live session. The sentence is left as
written because the byte budget on AGENTS.md could not afford the exact wording.

### Four commands that had never once worked

The crash-only-assertion rule in AGENTS.md section 12 comes from this: four
commands were found in a single day to have never worked at all, each hidden
the same way. This CLI reports an API failure as a printed `✗` and exits 0, so
an assertion that only checks the process did not crash cannot tell a working
command from one that fails on every invocation. Assert the success the command
claims, not the absence of a stack trace.

---

## Release: the reset-and-retag sequence (§8)

Release branches (`v1.x.x`) and tags are always reset to `main`'s HEAD; tag, branch and `main` must
point at the same commit. Never cherry-pick from `main` to a release branch.

```bash
git checkout v1.x.x && git reset --hard origin/main
git push origin refs/heads/v1.x.x --force
git tag -d v1.x.x && git push origin :refs/tags/v1.x.x
git tag v1.x.x && git push origin refs/tags/v1.x.x
git checkout main
```

A GitHub Release created from the tag triggers `.github/workflows/publish.yml`, which publishes
`@ardennguyen/zalo-agent-cli` with `--provenance`. Never run `npm publish` manually.

It authenticates with **npm trusted publishing**, not a token: on npmjs.com the package lists this
repository and `publish.yml` as its trusted publisher (with "Allow npm publish"), and the job's OIDC
identity (`id-token: write`) is exchanged for a short-lived credential. That needs npm >= 11.5.1,
which Node 22 does not ship, so the workflow upgrades npm before anything else. The repository's old
`NPM_TOKEN` secret is unused. It replaced one that silently expired (set 2026-07-05; the publish of
2.0.0 on 2026-10-13 got a bare `404 Not Found - PUT`, which is how npm reports a rejected
credential). If a publish ever fails the same way now, check the trusted-publisher entry on
npmjs.com (repository, workflow filename, environment left empty) before suspecting the code.

---

## Why the patched zca-js is bundled, not patched on install (§13)

We patch zca-js to add `logoutV2`, and to modify `loginQR` and `sendMessage`. Without them `logout` and `account remove` die on
"is not a function". Getting that patched copy into a consumer's tree took two goes, both found on
2026-09-29 against npm 11.17.0 / Node 24.19.0.

**First defect — the tarball would not install at all.** `postinstall: patch-package` with
patch-package in `devDependencies` and `patches/` missing from `files`: the install ran a binary
that was not there, against patches that were not shipped, and aborted with
`'patch-package' is not recognized`, exit 1, before `node_modules/zca-js` existed. Fixed in
1b182da by moving patch-package to `dependencies` and adding `patches/` to `files`.

**Second defect — the fix only worked for `npm i -g`.** patch-package resolves `node_modules/zca-js`
relative to its own cwd, which is the installed package directory.

- Global install: npm nests dependencies under the package, so `zca-js` is right where
  patch-package looks. It printed `zca-js@2.2.0 ✔` and the patch applied.
- Installed as a *dependency*: npm **hoists** `zca-js` to the consumer's root. patch-package cannot
  see it and fails with `Patch file found for package zca-js which is not present at
  node_modules/zca-js` — but the install still exits 0, so the patch silently did nothing and
  `logoutV2` was simply absent at runtime.

That second case is not hypothetical: `zalo-mcp` takes this package as a plain dependency and its
`zalo-mcp.ps1` / `.sh` update path runs `npm install @ardennguyen/zalo-agent-cli@latest`.

**The arrangement now.** Stop patching in the consumer's tree at all:

- `prepare: patch-package` — runs on a dev `npm install`, on a `github:` install, and before
  `npm pack`/`publish`, so `node_modules/zca-js` is always patched before the tarball is built.
  It does **not** run for a consumer installing the published tarball.
- `bundleDependencies: ["zca-js"]` — `npm pack` copies that patched tree into the tarball, and npm
  unpacks it nested under our package where hoisting cannot reach it. npm still resolves and
  installs zca-js's own 8 dependencies, placing them beside it.
- patch-package is back in `devDependencies`: consumers never run it, and the `github:` path gets
  devDependencies anyway (verified — npm installs them so `prepare` can run).

This is why `bundleDependencies` must never be dropped and `zca-js` must stay pinned to the exact
version its patch filename names. `tests/unit/packaging.test.js` fails the build on either.

Verified on all three install paths — local dependency, global, and `git+file://` standing in for
`github:` — with the resolved zca-js carrying `dist/apis/logoutV2.js` in each. Re-run that check by
packing and installing into an empty directory; the tarball is ~2 MB because it carries zca-js.

### Both of zca-js's builds are patched, deliberately

zca-js ships two trees — ESM at `dist/` and CJS at `dist/cjs/` — and its exports map wires
`"require": "./dist/cjs/index.cjs"`. Until 2026-09-29 only the ESM half was patched, on the
reasoning that this package is `"type": "module"` and so can never load the CJS bundle. That
reasoning was correct and is still asserted, but it was the wrong conclusion: a library that
ships two entry points should not have one that works and one that silently lacks `logoutV2`,
every client-id stamp, and the
device-fingerprint client hints. "Correct today because nothing takes that path" is not the same
as correct.

The patch now covers both, which is why it is ~1,700 lines across 31 files rather than ~900
across 16. Mirroring is mechanical but not free:

- The CJS twins are rollup output — `var X = require('./p.cjs')` with namespaced access
  (`Enum.ThreadType`, `ZaloApiError.ZaloApiError`) and a trailing `exports.X = X`. The function
  bodies are otherwise byte-identical to the ESM ones, so the edits transfer directly.
- Five of the files are **created**, not edited, so the CJS side needed five new `.cjs` files
  plus require + constructor wiring in `dist/cjs/apis.cjs`. A patched file that is never wired
  onto the API class is invisible to a per-file check — that is what the call-shape assertion in
  `tests/unit/send-apis-return-client-id.test.js` exists to catch.
- `loginQR` is functional, not cosmetic. `src/core/zalo-client.js` puts `secChUa` /
  `secChUaMobile` / `secChUaPlatform` on ctx; without the mirror the CJS build would ignore the
  fingerprint and always claim Chrome 130 on Windows.

Three assertions pin it: the patch touches both trees, it creates the four methods in both, and
this package stays ESM. All are mutation-tested. **Mutation-test any assertion you add here** —
the first version of the parity check matched `response.cliMsgId =`, which also matches the
helper's own body, so deleting a call site still looked patched. It was decorative and reading it
did not reveal that; breaking the code and watching the test stay green did.

### Why a stale zca-js cannot reach the tarball

`bundleDependencies` packs the **working tree's** `node_modules/zca-js`, which raises the obvious
worry: pack from a checkout whose patch was never applied and you ship unpatched bytes silently.

That is not reachable through the normal path, for a reason worth writing down rather than
rediscovering:

- `npm pack` and `npm publish` both run `prepare` themselves, so `patch-package` re-applies
  immediately before anything is packed.
- `.github/workflows/publish.yml` is `npm ci`, lint, test, then `npm publish --access public --provenance` —
  no `--ignore-scripts` anywhere — and `npm config get ignore-scripts` is false on this machine.

So only an explicit scripts-disabled pack could ship a stale copy. If you ever add
`--ignore-scripts` to the release workflow, or npm changes when `prepare` runs, that guarantee is
gone and the patch has to be verified in the tarball instead of assumed.

Re-verified at `eea5680`, after the patch gained three hunks for attachment `cliMsgId`: all three
install paths resolve zca-js at `node_modules/@ardennguyen/zalo-agent-cli/node_modules/zca-js` —
nested under the package where hoisting cannot reach it — each carrying the patched bytes.
Verifying the bytes arrive is not the same as verifying runtime behaviour; that was proved
separately over a live socket.

---

## Why the rule files are four byte-identical copies

`AGENTS.md`, `CLAUDE.md`, `.clinerules` and `.cursor/rules/project.mdc` hold the same bytes because
each tool looks only for its own filename and none of them reads the others. A pointer file was
tried first and rejected: a rule an agent has to follow a link to read is a rule it will skip.

Until 2026-09-29, `.gitignore` listed `AGENTS.md`, `CLAUDE.md` and `.agents/`, so the ruleset's own
opening claim — "this file is committed and is the canonical ruleset" — was false. Every rule an
agent followed, and every correction written into it, lived on one machine and reached no clone, no
CI and no reviewer. Two sessions updated the test-count invariant on the same day and both edits
were local-only. The files are tracked now; write them as if a stranger will read them, because one
can.

`.agents/` is still ignored on purpose: it holds machine-local overrides and absolute paths, which
must not follow the repo to another machine. Antigravity also reads `.agents/AGENTS.md`
cumulatively with the root file, so a copy there would be redundant context, not extra coverage.

---

## Incidents behind §13

### The 2026-09-18 file-content anomaly

`zalo-agent-cli/package.json` briefly reverted to a state matching the older pinned version of
`zalo-mcp`. Git history was confirmed clean, so it was not a checkout or reset. Cause unidentified.
Hence the rule: re-read a file after writing it, especially when another agent or process may be
running in this folder tree.

### Two anomalies that turned out to be mundane (2026-09-19)

Both were traced during the test-suite work, and neither was mysterious:

1. `tests/fixtures/document.pdf` was rewritten in place by an installed PDF handler, turning a
   hand-written 453-byte PDF 1.4 into a 4674-byte linearized PDF 1.6.
2. Credential files under the test home were owned by `BUILTIN\Administrators` and undeletable,
   because `zalo-agent login` had been run from an elevated PowerShell — confirmed by the user,
   after the agent had first attributed it to something vaguer.

So before recording an anomaly as "cause unidentified", check file ownership and ACLs (`Get-Acl`),
whether an external handler or editor touched the file, and whether the command was run elevated —
then ask the user rather than guessing.

### Elevated login: diagnosis and recovery

Nothing in this tool needs elevation. Running `zalo-agent login` from an elevated shell leaves
credential files owned by `BUILTIN\Administrators`. An unelevated session can then read and rewrite
them but not delete them, so `logout --purge` and `account remove` fail with `EPERM` while
everything else appears to work. Full diagnosis and recovery steps are in the environment-gotcha
section of `agent/work/transfer-sync-v2/NOTES.md` (gitignored — local only).

### `.gitattributes` and line endings

Git's system config on this machine sets `core.autocrlf=true`. `.gitattributes` (added 2026-09-28,
commit `69b2793`) sets `* text=auto eol=lf` and marks `tests/fixtures/** -text`. Two problems it
fixed:

1. `tests/fixtures/notes.txt` and `data.csv` are pinned by size and SHA-256 in
   `tests/fixtures/index.js`. A CRLF checkout grew them from 358 to 367 and from 149 to 152 bytes,
   so `verifyFixtures()` reported "the file changed on disk" and
   `tests/unit/image-metadata.test.js` failed on every Windows clone — while `git status` stayed
   clean, hiding the cause.
2. `npm run format` rewrote every file to LF (prettier's `endOfLine` default), leaving ~115 files
   listed as modified by `git status` with zero content change.

Two consequences that are not obvious:

- **`git add --renormalize .` or a broad `git add` stages the corruption**, because the fixtures are
  `-text`. That breaks CI for everyone, since CI runs on Linux where the bytes were always correct.
  Restore with `rm tests/fixtures/notes.txt tests/fixtures/data.csv && git checkout -- tests/fixtures/`
  and confirm with `node --test tests/unit/image-metadata.test.js`. There is no renormalization
  sweep owed: every tracked text blob is already stored LF.
- **Git reads `.gitattributes` from the working tree, not from the commit you have checked out.** A
  stray untracked copy on a branch cut before `69b2793` puts `-text` in force *there*, so CRLF
  fixture copies become a real difference against the LF blobs and `git rebase` aborts with "cannot
  rebase: You have unstaged changes" naming only those two files. Rebasing onto `69b2793` is
  otherwise fine — this is not a reason to adopt a "merge, never rebase" rule. Pre-flight such a
  branch with `git status --porcelain` empty, no untracked `.gitattributes` in the worktree, and
  `git rebase --abort` first if an earlier attempt died.

Because `eol=lf` overrides `core.autocrlf`, the working tree is LF on Windows too — so a file's
on-disk byte count equals its blob byte count, which is what makes the 24,000-byte budget on
`AGENTS.md` measurable with a plain `wc -c`.

### One WebSocket per account

Zalo permits one web session per account. `listen`, `mcp start`, `sync-mobile` and a browser Zalo
Web session cannot coexist; a duplicate closes the connection with code 3000, and that is fatal by
design.

A non-inline attachment can only be sent over a socket, so `msg send-file` / `send-image` used to
open their own — and Zalo evicted the running daemon, losing every message that arrived during its
~6s reconnect. The `sync` socket stages had the same collision and a worse workaround: they were
skipped outright while a daemon ran, so closing a coverage gap meant stop → sync → restart, and the
stop/restart opened a fresh ~70s hole with no repair path.

A daemon now publishes `daemon-channel.json` (loopback port + token, 0600) and does both jobs on its
own socket: `POST /send-attachments` for uploads, and `POST /sync/messages` / `POST /sync/reactions`,
which stream NDJSON progress back so the CLI prints the run as it happens. Callers fall back to
their own socket only when no daemon is up. `tests/unit/sync-socket-rules.test.js` fails the build
when a `run*` command in `sync.js` calls `connectListener` without first calling `getDaemonChannel`.

`src/core/daemon-channel.js` must stay a transport. The stage bodies live in
`src/core/daemon-sync.js` and are injected as `runners`, because `src/commands/msg.js` imports the
channel at the top level for `sendViaDaemon` — importing SyncV2 there would put the libzproto
decrypt stack, the CDN asset fetcher and the sqlite writes into every `msg` invocation.
`tests/unit/daemon-channel.test.js` enforces that the channel imports nothing but node builtins.

Routing a sync through the daemon removes the second WebSocket, not the phone confirmation. The
daemon must never start a phone-backed stage on its own — see the "How the daemon self-heals"
note in `src/commands/listen.js`: its own catch-up reads only Zalo's offline message queue, which
needs no phone, and it never starts `transfer-sync-v2`, which does.

### A stage that loses its socket inside a daemon (2026-10-20)

A 100,000-message restore run by a daemon used to end as "partial" on any lost socket (close 1006 has
no close frame and is not on the server's retry list), and the next run asked the phone again. The
runner in `src/core/daemon-sync.js` now hands `SyncV2.restore()` a `reconnect` that **only
waits**: `waitForDaemonSocket()` watches `getApi()` until the daemon's own re-login has an open
socket that is not the one the stage lost, and the restore follows the new api
(`reconnectedApi()`, `src/core/sync-v2/index.js`). The rule the old test pinned still holds and is
still tested: a stage never starts, stops or logs in anything, because `listen` / `mcp` rebuild the
api themselves and a stage opening a socket would race that. A daemon allows 3 resumes (the CLI
allows 1); a resume can cost the owner one more phone tap, and the restore says so.

Not measured live: the resume needs a restore that drops mid-run. Offline tests cover the waiting
and the rebinding, not Zalo's behavior after a re-login.

The same change made the daemon log say what a stage is doing. `src/core/daemon-log.js` writes
each stage's parameters, phases (with elapsed time), a once-a-minute "still running" line, and its
result or failure; an event-loop stall monitor (the restore decodes and stores on the thread that
answers the socket's pings); and the socket's age plus the running stage on every drop. Profile
lookups (`src/core/user-info.js`) are paced, retried on a rate limit, stopped when it persists, and
log Zalo's own code and message, which had never been captured: the pattern that recognizes a rate
limit (`isRateLimitError`) is a guess until a log shows the real text.

### One media downloader

There used to be three folder layouts for the same conversation, depending on which command
fetched it. `src/core/media-downloader.js` and `src/mcp/media-downloader.js` are both deleted;
`src/core/sync-v2/media.js` is the only downloader left, and everything routes through it —
`listen`, `msg history`, `mcp start`, `sync`, `sync-media`, `sync-mobile`, and the MCP tools.

Destination is `<accountDir>/media/<threadId>/` with filenames
`<YYYY-MM-DD-HH-mm>_<msgIdTail>[_n]_<name>.<ext>` (`destPath()` in that module).
`mcp-config.json`'s `media.downloadDir` is passed as `mediaRoot` and overrides the root for the MCP
server only; when it is null, `mcp-tools.js` passes `undefined` and the module falls through to
`resolve(accountDir, "media")` — the same per-account path as everything else. The
`// default: ~/.zalo-agent-cli/media/` comment `mcp-config.js` used to carry described the old
account-agnostic MCP downloader that no longer exists; it now names the per-account path.

Docs have repeatedly invented a second media path out of that stale comment. There is one path.

`wipeAccountDir()` in `src/core/accounts.js` removes `CONFIG_DIR/accounts/<ownId>` and nothing else,
so default media is purged along with the account. Attachments written outside that directory by a
configured `media.downloadDir` survive `logout --purge`, `logout --delete-history` and
`account remove`. That gap is documented as a warning in `Security.md` / `Bảo-Mật.md` and
`INSTALLATION.md`, and is **not** fixed in code.

### Every text attachment was downloaded and thrown away (2026-09-29)

`classifyResponse()` in `src/core/sync-v2/media.js` decided whether a 200 carried the file or one of
Zalo's error envelopes. A lapsed CDN signature answers **200 with a JSON body**
(`{"err_code":"1","message":"Invalid signature"}`), so the body has to be read — but the sniff was
entered for `application/json` **and any `text/…`**, and its final branch was a bare
`return "throttled"`. An ordinary CSV matches neither error regex, so it reached that branch. Every
`.csv`/`.txt`/`.md`/`.log` attachment was fetched in full, discarded, and reported as rate limiting.

Measured: two healthy 149-byte `data.csv` rows stuck across four runs — `sync` at concurrency 4,
`sync-media` at 2, then at 1, then a fresh `sync --from`. Plain unauthenticated `curl` on one of the
stuck URLs returned `200`, `content-type: text/csv`, `content-disposition: attachment`, and the
full 149 bytes. Nothing was wrong with the link, and nothing the user could do would have helped.

Two rules came out of it:

- **A 200 is the file unless the body says otherwise about itself.** The sniff now runs only when a
  response has no `content-disposition` naming a file, and only classifies a body as an error when
  it parses as a JSON object carrying an error key, or is a sub-1 KB blob matching a known error
  phrase. `looksLikeErrorBody()` holds that test.
- **The summary may only report what was observed.** 403 was the catch-all's biggest occupant, and
  the code's own comment already said Zalo returns it "both for a lapsed signature and under load" —
  yet `sync-media` printed "almost certainly rate limiting, not expiry" and advised waiting. The
  verdicts are now four: `expired` (404/410 or a lapsed-signature body), `throttled` (429/5xx or a
  server-busy body), `unknown` (403, an unrecognized body, no response), and `failed`. `unknown`
  retries exactly like `throttled` — the split changed the reporting, not the policy — and
  `stats.reasons` carries the observed codes so the summary prints `HTTP 403 ×3` instead of a guess.
  A lapsed signature is renewable only by a fresh mobile sync, and not always even then: the
  `urlToRenew`/`thumbUrlToRenew` hints are mobile-only (see `message-types.js`), and a re-sync was
  measured returning the same URLs for two files and a video while refreshing one photo.

`tests/unit/sync-v2-media.test.js` covers both: a `text/csv` attachment must land on disk, and a 403
must not be reported as rate limiting — the latter partly as a source guard on `src/commands/sync.js`,
since the counters can be right while the sentence built from them is still wrong.

### Six agent sessions in one working tree (2026-09-28/29)

Six sessions shared this checkout with no isolation. What it cost:

- A commit went out carrying 37 lines another session was still writing, caught only because that
  session spoke up. Staging by explicit path — never `git add -A` or `git add .` — is the fix.
- Three sessions in 24 hours completed green work and exited **without committing**, because the
  file they had touched also held another session's unfinished change. Their work had to be
  recovered and committed later, with attribution to whoever wrote it. Snapshot such work before
  touching it: `git diff` to a patch plus copies of untracked files, under `agent/work/`.
- The stash stack is shared across worktrees, so one session can pop another's stash. Use a
  temporary WIP commit instead of `git stash`, and avoid `git rebase --autostash` for the same
  reason.
- A stale `.git/worktrees/<name>/rebase-merge/` from one interrupted rebase made every later attempt
  fail on the leftover state, reporting *that* rather than the original blocker. `git rebase --abort`
  clears it.
- `git diff --name-only` disagreeing with `git status --porcelain` meant something stateful was in
  play; it was worth chasing rather than ignoring.

Giving each new session its own git worktree costs minutes to merge afterwards. Recovering work from
a shared tree costs hours and depends on someone noticing.

### Windows shell traps (§5)

All hit on 2026-09-28; each reports success, or reports an error that names the wrong cause.

- **Git Bash `kill` does not work on native Windows PIDs.** `kill -TERM` and `kill -0` both report
  success while the process keeps running — this nearly caused a redundant phone tap on a daemon
  that was still alive. Use PowerShell `Stop-Process -Id <pid> -Force`, and verify with
  `Get-Process` rather than trusting the PID in `daemon.lock`.
- **MSYS rewrites any argument starting with `/`.** The Zalo reaction code `/-strong` reached the
  API as `C:/Program Files/Git/-strong` and came back as error 114. Every reaction code starts with
  `/`, so set `MSYS2_ARG_CONV_EXCL="*"` for `msg react` and `msg send --react`.
- **Backslashes do not survive being written into a file through the shell.** `"F:\\Coding\\…"`
  landed as `"F:\Coding\…"`, which JS then read as escapes and stripped to `F:Codingzalo-mcp`. Same
  class: a regex written through `node -e` lost its backslash and `/^\d+$/` silently became
  `/^d+$/`. Use forward slashes — Windows accepts them — and write scripts to a file rather than
  `node -e` when they contain escapes.
- **PowerShell `Start-Process` does not inherit `$env:X` set in an earlier command**, and a process
  it starts may die when the session tears down. A daemon started that way died with "No active
  account" because `USERPROFILE` had not carried over. For a long-running daemon, `nohup … &` from
  Bash survived where `Start-Process` did not.

### `zalo-mcp`: pass-through launcher and published engine dependency

Starting in `zalo-mcp` `2.0.0` (`2.0.1` adds leading `--account <id>` CLI pass-through), `mcp-server.js`
is a full pass-through launcher: when invoked with no CLI subcommand (`zalo-mcp` or `node mcp-server.js`),
it spawns `zalo-agent mcp start` and forwards `--account`, `--http`, `--auth`, `--host`, `--config`,
`--no-self-heal`, `--no-delivered-receipts`, and all global storage flags (`--env-file`, `--config-dir`,
`--credentials-dir`, `--data-dir`, `--media-dir`, `--oa-dir`). When invoked with any CLI subcommand
(`zalo-mcp [--account <id>] <cmd> ...`), it forwards all arguments directly to `zalo-agent`. (Historically,
`zalo-mcp` `1.0.x` forwarded only `--http` and `--auth` and silently dropped `--host` and `--config`.)

Its `package.json` depends on `@ardennguyen/zalo-agent-cli` (`^2.1.0` in `zalo-mcp` `2.0.x`). Whatever
version is installed in a deployed wrapper's `node_modules/` is what it actually serves, so an MCP tool
or flag added here is not reachable through `zalo-mcp` until the engine is published to npm and the
deployment runs `zalo-mcp.ps1 update` / `./zalo-mcp.sh update`.


---

## Four commands that had never once worked (2026-09-29)

Found in a single day, all by the same mechanism, none by reading code:

| Command | Defect |
|---|---|
| `msg forward` | zca-js is `forwardMessage(payload, threadIds, type)` with `payload = {message}` and `threadIds` an **array**. The CLI passed the msgId string as the payload and a bare string as the thread list, so the API threw "Missing message content" on its first line — every type, both `-t 0` and `-t 1`. |
| `msg delete` | The same shape. |
| `conv mute` | zca-js is `setMute(params, threadID, type)` with the **options object first**. The CLI passed `(threadId, type, duration)` positionally, so `params` got the thread id string and the request went out with `toid: 0`. |
| `conv unmute` | The same call. |

A fifth, different defect sat alongside them: **attachment sends always delivered**, but the
response carried no `cliMsgId`, and `msg undo` / `msg delete` refuse without one. So every image
and file the CLI had ever sent was permanently unrecallable. That is a missing return value, not a
broken command — worth keeping distinct when describing it.

### Why the suite could not see any of them

This CLI catches API failures and prints a clean `✗ <message>` line, then exits 0. An assertion
shaped like

```js
assert.doesNotMatch(r.all, /at Command\.|Unhandled/, "should not crash");
```

therefore passes whether the command worked or failed on every invocation in its history. The
forward assertion carried a comment rationalising it — "a clean error is an acceptable outcome" —
which is how it survived review. `msg delete`'s was `hasSuccess(...) || errorLineOf(...)`, true for
literally every possible outcome.

**An assertion that only checks "did not crash" is not a test.** Assert the success the command
claims. This is now a rule in AGENTS.md §12.

---

## The listener lifecycle, and five ways it lost messages (2026-09-29)

All five were invisible in normal operation, which is why none had a test. Fixed in `6e8584f` and
`db84dab`; guarded by `tests/unit/listener-lifecycle-rules.test.js`.

**A1 — the reconnect that actually happens recorded nothing, then claimed it had.** Gap filing sat
behind `if (reconnectCount > 0)`, and `reconnectCount` is incremented only in the `closed` handler.
Measured against a local `ws` server: **`closed` never fires for any code on zca-js's
`close_and_retry_codes` list** — it emits `disconnected`, retries internally, then emits
`connected`. Those codes are precisely the *recoverable* ones, so on the ordinary drop path no
`sync_gaps` row was written, nothing was printed, and `markConnected()` then asserted coverage over
the outage. Since `sync` is driven off exactly that advice, messages lost to a routine reconnect
were lost permanently and silently. It self-healed only after the first non-retryable close, which
set the counter to 1 for the rest of the process's life.

**A2 — the heartbeat stamped "connected" while the socket was down.** `markConnected()` means
"coverage is good up to now", and a 60s timer called it with no liveness check — through the
internal retry, the 5s re-login wait and the 30s retry wait. A crash mid-outage then left the next
launch computing its startup gap from a moment nothing was connected, and the outage disappeared.

**A3 — `mcp start` had no `SyncManager` at all.** No gap tracking, no `markConnected`, no startup
check. An agent-driven install that only ever ran `mcp start` — the deployment shape, since it is
the mode with the MCP tools and `/health` — had zero loss detection. And because it never wrote
`lastConnectedAt`, a later `listen` read whenever *listen* had last run and filed a bogus gap
clamped to the 14-day maximum over a window that was fully covered.

**A4 — Ctrl-C left a zombie holding the account's session.** `listener.stop()` emits `closed(1000)`,
indistinguishable from a real drop, so SIGINT ran the *recovery* path. Measured: ~5s after the user
sees "Stopped", the process re-logs in and opens a fresh socket — with `daemon.lock` already
released and `daemon-channel.json` already deleted. The next `listen`/`mcp`/`sync` then took the
free lock and the two sessions flapped over code 3000.

**C1 — `msg history` opened a second web session.** The DM path, and any group whose REST call
threw, called `listener.start()` with no daemon check and no lock, evicting the daemon with 3000.
Fixed by adding a `history` runner to `daemon-sync.js` and `/sync/history` to the channel route
table, so the scan pages on the daemon's own socket.

The shared bookkeeping now lives in `src/core/listener-lifecycle.js`: down-ness is observed rather
than inferred from a counter, the first drop of a flap wins, the heartbeat may not claim coverage
while down, and a deliberate stop is not a drop.

---

## The cache has exactly two writers, by decision

Arden ruled on 2026-09-29, in response to a proposal that `msg send` write its own row:

> "truth write and cache coming from listener and sync only, no auto write. Even if you're sure you
> can handle all write the way live socket and sync write to db, still no."

So `zalo.db` message rows come from the listener and from sync. Nothing else writes them — not even
a command that could do it correctly.

The consequence to state honestly rather than paper over: **a message you just sent is not
quotable, forwardable or recallable until the listener observes its echo.** With a daemon running
that is near-instant; with no daemon it never happens. `msg history` cannot substitute — it was
measured returning nothing for a same-day group message, so help text pointing users there was
wrong and was corrected.

The tempting fix had a real cost behind it: Zalo's send response is `{msgId, cliMsgId}` with no
timestamp, so a self-written row's `ts` would be an approximation (`Number(cliMsgId)`, the clock
reading zca-js actually posted) that only self-corrects once the listener catches up. And AGENTS.md
§13 already says one db writer per account, while an audit found `msg.js` and `conv.js` writing
without taking the lock — so "just write it" would have been a decision about an existing invariant
violation, not a fresh one.

---

## The webhook outbox is its own file, and why (2026-10-21)

`mcp start -w` and `listen -w` used to `fetch` once with a 5 second timeout and forget, so a receiver
that was down lost the message and nothing said so. Both now write each event to
`accounts/<ownId>/webhook-outbox.db` first and deliver from it (`src/core/webhook-outbox.js`, one
implementation behind both entry points, as §13 requires).

- **Separate file, not a table in `zalo.db`.** The cache's message rows have three writers by decision
  (§13); an outbox in the same file would either be a fourth or blur what "writer" means. A damaged
  outbox can be deleted without touching the cache, and `mcp webhook status|list|retry|purge` open it
  directly (SQLite WAL) beside the daemon.
- **At least once, in order.** A row is deleted only after a 2xx. The head's backoff holds the whole
  queue, so a later message never overtakes an earlier one; the cost is that one sick event stalls
  the rest until it is delivered or dead-lettered. 400, 413 and 422 dead-letter at once (the
  receiver said the payload is malformed; retrying would only block), and a batch refused that way is
  split so one bad event does not take its neighbors. 401, 403, 404, 429 and 5xx are retried: a wrong
  secret or a sick receiver is the operator's to fix, not a reason to drop messages.
- **Dedupe is only for rows still queued.** `UNIQUE(event_key)` keeps a live message and its
  catch-up repeat from queuing twice, but a delivered row is deleted, so a repeat after delivery is
  sent again. The receiver de-duplicates on the message id; the sample receivers do.
- **Nothing wakes the dispatcher when another process changes the file**, so it looks at the queue
  every 30 s (`pollMs`). Without that, `mcp webhook retry` would sit until the next message arrived.
- **Live test shape.** The receiver in `agent/work/live-receiver.mjs` answers from a mode file
  (`ok`, `503`, `422`, `hang`). `listen` includes the account's own messages, so a sent message
  comes back as an event; `mcp start` skips them by design, so its enqueue path needs a message from
  a second account (the test group has one). A hard kill (`Stop-Process -Force`) mid-backlog and a
  restart is the crash test: the queued events were still delivered after it.

---

## Health and metrics: one object, two entry points, and what stays unauthenticated (2026-10-21)

`GET /health` used to answer `ok` with an uptime and a thread count whether the socket had been down
for a minute or a week, so nothing outside the process could tell which account had gone quiet.
`src/core/daemon-health.js` is now the one thing both `mcp start` and `listen` build (§13: no
asymmetry between them): the socket state machine, event ages and counts, plus sources plugged in
later (webhook outbox, message buffer, pending gaps, stage lock).

- **Two surfaces.** `mcp start --http` serves `/health`, `/ready`, `/status`, `/metrics`; both
  daemons answer `POST /status` on the loopback channel, which `--status` prints. `listen` has no
  HTTP port, so the channel is the only way its health reaches anyone.
- **What is unauthenticated, and why.** `/health` keeps its old fields and adds `socket` and
  `ready`; `/ready` is 200/503 on the socket. Both reveal only "the process answers" and "the
  socket is up". Everything with counts, account ids, backlog or error text (`/status`,
  `/metrics`) is behind the bearer token. `/health` stays HTTP 200 whatever the socket does: it is
  liveness, and a supervisor that restarts on a 503 there would restart a daemon that is already
  reconnecting by itself. Readiness is `/ready`.
- **An age with no value is omitted from `/metrics`, never 0.** 0 would read as "just now" to an
  alert like `zalo_last_event_age_seconds > 3600`. The same for NaN and Infinity.
- **`cipher_key` is never subscribed to.** `attach()` lists its events explicitly; a test fails if
  that one ever appears, because the event carries the session's key material.
- **The two ways a down socket is reported.** `noteDown` runs on both `disconnected` and `closed`
  and keeps the first drop's clock (a repeat does not restart it); `stopping` is sticky, so a late
  `connected` or `closed` during shutdown cannot flip it back. The 2-minute "socket down" warning
  exists because a reconnect in progress is normal.
- **Not live-tested: a socket that really drops.** Cutting a live account's network, or opening a
  second session to force a close, would end the test account's daemon rather than show a `down`
  state (a duplicate-session close is fatal by design), so the down paths are covered by unit tests
  that emit the listener events; the live runs covered up, event counts, the webhook backlog and
  its recovery, and `--status` on both daemons.

---

## Shared files are written atomically, and a damaged registry is an error (2026-10-21)

`accounts.json` is shared by every login, `account` command and name refresh, and a fleet of daemons
refreshes names concurrently. It was read, edited in memory and written back with a plain
`writeFileSync`. Measured with six processes: writers lost each other's changes, a reader could catch
the file truncated and not yet refilled and take it for "no accounts", and a damaged file read as an
empty list, so the next `login` replaced it with a registry of one. `src/utils/atomic-file.js` now
holds the two guarantees, used by the registry (`src/core/accounts.js`), credentials, `mcp-config.json`
and the OA credentials:

- **`writeFileAtomic`**: a temp file beside the target, created exclusively at the final mode (a secret
  is never readable by others, even for the moment `saveCredentials` used to leave between its write
  and its `chmod`), flushed, renamed over the target. The `.bak` copy skips the flush
  (`durable: false`): it is a convenience, not the record. On Windows a rename fails with `EPERM` while
  a reader has the file open; a tight loop of readers made that exceed a quarter of a second, so it is
  retried for a second or two with jitter.
- **`withFileLock`**: an `O_EXCL` lock file holding the pid. A lock whose holder is dead, or older than
  30 s, is taken over, after re-reading it to remove only what was judged stale. The release removes the
  lock only if it is still the holder's own. The takeover has a window (two waiters judging the same
  stale lock at once) that needs a crashed holder and a three-way race, and is accepted.
- **A registry that exists but cannot be read is a `RegistryError`**, never `[]`. Reads fall back to
  `accounts.json.bak` (once-only warning); the next change replaces the damaged file and keeps it as
  `accounts.json.corrupt-<ms>`; with no good backup nothing is touched and the message says to fix it
  or move it aside. `src/index.js` turns the error into a message instead of a stack trace.
- **The name refresh must not take a daemon down.** `updateAccountName` is called from event handlers:
  it answers a name it already has without taking the lock, waits at most 3 s for it, and on any
  failure logs and returns `false`.
- **What the tests prove.** `tests/unit/registry-safety.test.js` runs real processes and was red
  against the old `accounts.js` (11 failures: lost renames, lost adds, every unreadable-file case, the
  backup). Live, on a copy of the test home with a running daemon: 60 parallel adds, five writers and
  two readers for 15 s alongside a daemon's own name refresh, then twelve rounds of hard-killing
  writers: no lost rename, no bad read, no damaged file, a dead holder's lock taken over at once, no
  leftover temp file (a sweep removes the ones a killed writer left, `sweepStaleTemps`).
- **Not covered:** other writers in this tree still use plain writes where a torn file is cheap (logs,
  the channel descriptor, `oa` token refresh outside `saveOACreds`). Several machines sharing one
  config directory over a network file system is not supported: `O_EXCL` and rename are not reliable there.

---

## Batch pull: `limit` and `settleMs` on every wait (2026-10-21)

`GET /events/wait`, `zalo_wait_for_message` and `mcp wait` returned one message per call, so a bot
behind a busy account made one round trip per message. All three now build their reply in one place
(`src/mcp/wait-result.js`) from `MessageBuffer.waitForMessages`, so they cannot drift.

- **Compatible by construction.** `limit` defaults to 1 and the old fields keep their meaning:
  `message` is the first message, `cursor` is the last one returned (for one message, its own).
  `messages`, `count` and `hasMore` are additions. A daemon from before batching answers the
  channel with only `message`; `waitViaDaemon` reads that as a batch of one.
- **`since=cursor` is the whole protocol.** The reply's `cursor` is the last message's, so the next
  call continues exactly where the batch ended, and `hasMore` says whether to call again at once.
  Measured live on 28 buffered messages: three calls at `limit=10`, every message once, in cursor order.
- **Settling.** `settleMs` waits that long after the FIRST message (or after buffered ones, if fewer than
  `limit`) so a burst lands in one reply; a full batch never waits, and an abort ends the wait at once.
- **A buffer test needs a real timestamp.** `MessageBuffer` evicts anything older than its max age on
  every push; a fixture message with `timestamp: 1` is gone before the test reads it, and so is one
  with no timestamp. This cost an hour of "the buffer returns nothing".
- **Live shape.** The test account is the owner's real account, so `mcp start` recovers real incoming
  messages into the buffer at startup (28 in seven conversations in one run); that is what the live
  batch tests drained, with nobody needing to send anything.

---

## Log levels: a filter on free text, applied where the file is written (2026-10-21)

`daemon.log` was everything a daemon printed, forever: a line per HTTP request, a line per message with
its text (`listen` prints every event), no timestamps, and a file that only grew. `src/core/log-sink.js`
sits between the daemon's stdout/stderr and the file (`attachDaemonLogIfChild`).

- **Only three kinds of line are explicitly `debug`**, marked with `DEBUG_MARK` at the call site: the
  HTTP request line, `[mcp] Buffered …`, and `listen`'s event lines when running as a daemon child
  (`emitEvent`). Everything else is classified by its wording (`classifyLine`): that is a filter on free
  text, so a missed line is merely one written as plain text, and `error`/`warn` levels are best-effort.
  Do not "fix" a misclassified line by adding more regexes; mark the noisy call site instead.
- **Default `info`** drops those lines. That is a change for anyone who grepped `daemon.log` for received
  messages; `--log-level debug` or `ZALO_LOG_LEVEL=debug` brings them back, and the message text no longer
  sits in a log by default.
- **The sink writes through its own fd, so rotation is a rename.** On POSIX the spawn now also sets
  `ZALO_DAEMON_LOG` (it only did on the Windows WMI path), so the child owns the file there too; the
  inherited stdio fd keeps pointing at the rotated file and only carries a native crash. A rename can
  be refused on Windows while another process has the file open: the daemon keeps appending and
  looks again after another megabyte (`rotateAt`).
- **The account is the log's directory name** (`<data dir>/<ownId>/daemon.log`), which is how the child
  resolves `ZALO_LOG_LEVEL_<ownId>` before the account is known; `--log-level` is applied later by
  `configureLogging`.
- **The launcher is never filtered.** `mcp start -d` and `listen -d` print their own result to the user;
  an early version filtered that parent's stderr too and put a timestamp on "MCP server started". Only a
  real foreground run (and only when a level or format is asked for) filters its stderr; stdout, which
  is the output, never is.
- **`mcp` commands write human output to stderr** (`ZALO_JSON_MODE` is set for them), so a test of the
  stdout path has to use a command outside `mcp`, such as `account list`.

---

## `fleet`: many accounts on one machine (2026-10-21)

One account is one daemon, so a hundred accounts are a hundred of them. `src/core/fleet.js` and
`src/commands/fleet.js` do what an operator scripted by hand: a port table, one status table, batched
start/restart, and the supervisor files.

- **Fleet commands must not log in.** Every command not on a short list auto-logs in as the active
  account before it runs (`src/index.js`, `skipAutoLogin`), and `--account` pins the process to one
  account. `fleet` acts on all of them and only reads files and each daemon's loopback channel, so it
  is on both lists. The first live run found it logging in as the active account on every `fleet
  status`; the offline suite had missed it because no sandbox account has credentials, so
  `tests/cli/fleet.test.js` plants a saved login and asserts nothing logs in (red without the fix).
- **The port table is `fleet.json`, assigned once.** A port never moves and a freed one is reused, so
  adding an account cannot shift another's. `fleet status` only reads it; `ports`, `start`, `restart`
  and `generate` assign. A table that exists but cannot be read is an error that changes nothing, the
  same rule as the account registry.
- **Health is asked over the loopback channel**, not over each port, so no token or port is needed and a
  `listen` daemon (no HTTP) appears too. `unresponsive` is a lock held by a live process that does not
  answer; `down` is a socket down at least `--down-for` (180 s). `restart --unhealthy` acts on those two
  only: a webhook backlog is the receiver's problem and a restart does not fix it. A bare `restart`
  restarts nothing, on purpose.
- **Start-up is shuffled batches with a pause** (`planBatches`), the same idea as the unit's
  `sleep $((RANDOM % 30))`, for hosts without systemd. Per-account secrets go to each daemon through
  `--env-dir` into its own environment (`spawnDaemonProcess({ env })`, merged into the Windows WMI
  spawn too), never onto a command line.
- **The generated files are the documented samples.** The unit, `common.env` and the multi-account
  Caddyfile are embedded in `src/core/fleet-templates.js` because `docs/` is not in the npm package,
  and `tests/unit/fleet.test.js` asserts the embedded text equals the sample byte for byte. Edit one and
  the other fails until it follows. The generated Caddy blocks answer 404 for `/metrics` and `/status`.
- **Tokens:** 256 random bits per account, written at mode 600, never returned or printed; an existing
  env file keeps its token even under `--force`, and only `--rotate-tokens` replaces one.
- **Live run** (a copy of the test home with the real login plus three accounts that have none):
  `fleet generate`, then `fleet start --batch 2 --stagger 4 --env-dir` started the real account on its
  table port with its generated token and reported the three others as failed with the reason, in two
  shuffled batches 4 s apart; `status` showed `ok`, `--check` exited 1 then 0 for the named account;
  `restart <id>` replaced the pid and kept the kind; `stop` stopped it. Not exercised live: a daemon
  that is `down` or `unresponsive` (it would need a real outage), so `restart --unhealthy` on one is
  covered by the classification tests only.

---

## Start-up spreading inside the daemon (2026-10-21)

Every start logs in and loads the friend and group lists; a fleet that restarts together does all of it at
once against Zalo. The unit's `sleep $((RANDOM % 30))` and `fleet start`'s batches are the supervisor's
doing, and neither exists for a daemon started by hand or by another supervisor.
`src/core/startup-gate.js` puts the protection in the engine, off by default.

- **Order: lock, jitter, slot, login, lists, release.** `daemon.lock` is taken first, so a duplicate is still
  refused at once; the random wait (`ZALO_START_JITTER`) comes next, then the slot (`ZALO_LOGIN_SLOTS`), so
  arrivals are spread before they are capped. The slot is released after the thread-name cache has
  loaded in `mcp start` and after the cache is open in `listen` (which loads no lists).
- **A slot is a file, `O_EXCL`, holding the pid** — the same mechanism as every other lock here. Reclaimed
  when its owner is dead or it has been held 300 s (a start-up is seconds). A daemon that exits holding one
  gives it back through a `process.on("exit")` hook; `leave()` removes the file only if its content is
  still its own, so a daemon that was stuck long enough to be replaced cannot free the new holder's slot.
- **Waiting is bounded** (`ZALO_LOGIN_SLOT_WAIT`, 900 s) and then it goes ahead anyway, logging why. A
  slot that never frees must not keep an account offline; the cost is that the cap is a soft one.
- **Measured live** with the real daemon on the test account: another process held the only slot, the
  daemon logged `waiting for a login slot`, started when the holder exited (`got login slot 1 of 1 after
  9.9s`) and left no slot file behind. Six processes against two slots never had more than two inside
  (`tests/unit/startup-gate.test.js`, which also shows the same six overlapping without the cap).

---

## Markdown replies arrived raw (2026-10-21)

A second account that replied through the MCP server sent Markdown (`**bold**`, `- item`) and Zalo showed
it as typed. A Zalo message is plain text plus style ranges (`{ start, len, st }`, UTF-16 offsets); the apps
draw bold, bullets and sizes only from those, and `zalo_send_message` sent plain text. `msg send --md`
existed, but it was a Markdown-ish syntax of its own (`__x__` is underline there, bold in Markdown) with no
bullets or headings, and the tool had no pass at all.

- **The target shape was read from real messages**, not guessed: Zalo's own clients send a bullet as the
  line's text with no marker, covered whole by `lst_1` (start at the line start, length of the line without
  its newline), a heading as a bold line, and bold inside an item as a second overlapping range. The cached
  `raw_data` of such a message is `action: "rtf"` with `params.styles`; a message we send with `styles`
  comes back from Zalo in exactly that shape (checked live, both senders).
- **`src/utils/markdown.js` is conservative where Markdown is ambiguous**, because most text is not
  Markdown: `snake_case` (an underscore inside a word never opens emphasis), `2 * 3 * 4`, a lone `*`, an
  unclosed `**` and `5 > 3` stay as written; an emphasis marker must hug its text. Ordered lists keep their
  numbers as typed, as Zalo's clients do, instead of relying on `lst_2` numbering; links become
  `text (url)` because Zalo links a bare URL itself. An `@[uid]` mention token passes through whole, so
  `@[123](x)` is not read as a link.
- **Order: Markdown, then mentions, then `shiftStyles`.** The ranges are counted before `@[uid]` expands
  to a longer name, and `shiftStyles` (already used by `--md`) moves them across; a range spanning a
  mention grows with it.
- **Defaults differ on purpose.** The tool defaults to `markdown` (what calls it is a model); the CLI to
  plain (what types into it is a person). `ZALO_SEND_FORMAT` moves either, an explicit `format` /
  `--markdown` wins. `--md` is unchanged. Not converted: `link` captions (a different endpoint) and
  `send-image`/`send-file` captions on the CLI; the tool converts a file's caption.
- **Not verified by machine: how it looks.** The server accepts the ranges and echoes them back as
  `rtf`, which is all a test can see. That the bullets, indent (`ind_10` for a nested item) and heading
  size render as intended is for a person to confirm on a phone.

---

## v3.0 development: rules that differ from v2.5 (2026-10-24)

`v3.0-dev` is a long-lived branch in its own worktree; `v2.5-dev` stays shippable and is
never edited by v3.0 work. What differs while v3.0 is in progress:

- **Nothing observed from Zalo's own clients is committed.** Capture files, bundles, build
  manifests, reports, redacted samples and the scripts that make them live under `agent/`
  (gitignored). Git receives product code, tests and rules. A test that needs to know what the
  official client does uses a shape written by hand (`tests/helpers/replay/shapes.js`), with
  names and fixed values only.
- **No npm release, and no release candidate, until the v3.0 work is finished and approved.**
  The branch is pushed after green commits as a backup; that is not a release.
- **Compare with the official client through the harness, not by eye.** The fake Zalo
  (`tests/helpers/fake-zalo/`) and the replay harness (`tests/helpers/replay/`) exist for that;
  see the "Checking requests against the official client" section of `tests/README.md`.
- **Identity values live in `src/zalo/profile.js`**: the announced version and type, the computer
  name, the device label and the browser presets. Change one there, never at a call site.

## The socket supervisor, and what a phone's "no" looks like (v3.0, 2026-10-24)

**Where it lives.** `src/zalo/socket.js` keeps one socket alive (it drives a zca-js `Listener` that is started
with no retry of its own); `src/zalo/retry.js` is the arithmetic of "when do I try again";
`src/core/socket-host.js` is what `listen` and `mcp start` do around it, written once so the two cannot differ.

**A duplicate session ends the daemon.** The old recovery ladder (zca-js retries, then a login after 5 s, again after
30 s, then exit) reconnected on a duplicate-session close until its retries ran out. Each reconnect evicted the
other session, which reconnected and evicted this one: the flapping §13 describes, produced by the daemon itself.
Now the duplicate frame (`cmd 3000`), a frame with `error_code 600` or an HTTP 600 puts the supervisor in a terminal
`kicked` state; the daemon releases its lock and exits with code **3**, and only a person taking the account back
(`takeover()`) leaves that state. A saved login that Zalo refuses three times in a row exits with code **4**. A
login that fails for lack of a network is asked again, slowly, for as long as it takes. The shipped systemd unit
has `RestartPreventExitStatus=3 4`, so neither is restarted into the same state.

**Retries follow the server's table.** `settings.features.socket` carries a per-key `{times, max}`; every close is
mapped to a key by the official client's rules (1006 asks the network first, 1001-1015 is `internal`, Zalo's own
codes keep their number), the delay is spread by `retry_noise_factor` and a week of persisted error history, a
spent key rotates to the next endpoint, and after that the delay is Fibonacci and never ends. A key the server did
not describe waits the last default delay; zca-js threw a TypeError there.
Differences, all on the slow side: the counters start over only after a connection has stayed authenticated for a
minute, and a close that nobody asked for is brought back by the 10 s interval check.

**A phone's "no" is not an empty window.** The restore decided that the phone had confirmed with `status >= 4`.
Statuses 6 to 10 (rejected, cancelled, busy, low storage, signed out) are all above 4, so a rejection read as
"confirmed, and this window has nothing", and the run recorded success and closed the coverage gap it was meant to
repair. Only 4 and 5 confirm now; 6 to 10 end the run with the phone's reason, release the session with reason 2
(0 for a cancel) and record nothing. Batches that fail are failed per partition, not per shard, a batch the phone
sends twice is one batch, a session with an `isLast` batch is finished only when every earlier index has arrived,
and a run stops after ten failed batches or when more than half of ten or more have failed. The wait for a
confirmation is ten minutes. The rules are in `src/core/sync-v2/transfer.js` as pure functions, so they are tested
without a phone or the decryption assets.

**Why a kick happened (L12b).** After a kick the Web client asks `POST {aext}/api/session/kickout-info` (form
`token=<viewer_key>`). The `{viewer_key, enk}` pair is the getLoginInfo answer's `auth_ext_info` (not `zcloud`, which
Zalo answers with error 112); `login.js` keeps it in the context and `src/zalo/kickout.js` reads it, so the socket host
can hand every supervisor a `kickoutInfo` that needs no key from the caller. The reply is sealed with `enk`, not the
session key a kick has just ended, in the session cipher's shape. The host logs the server's own words for the source
(`kick_out_config`) and the time. The lookup returns null for any failure and never raises: the kick is already handled.

## The saved-session login is ours, and what it sends (v3.0, 2026-10-25)

**Where it lives.** `src/zalo/login.js` logs in with a saved session and hands the result to zca-js's own `API`
class, so every API factory, the listener and the patched calls are unchanged. `Zalo.login()` is no longer used for
this (the QR login still is). `src/zalo/headers.js` adds the browser headers, `src/zalo/upkeep.js` the two timers.

**What the official Web client does, and we now do:** `getServerInfo`, then `getLoginInfo`, then `getServerInfo`
again. Both server-info calls carry `sp_mtn` and `bkt`: the `settings.features.dr_config` values the last answer
held (`supportMaintenance`, `bucketId`), kept in `accounts/<ownId>/dr-config.json`, or -1 and -1 when none are
stored. The first adds `viewerKey` when one is stored, the second `floatMenuPos` (sent as the text `null`), and the
`signkey` covers every field of its own call. `getLoginInfo` announces the version as `client_version` only: no
`zpw_ver`, no `zpw_type`. Parameters are encrypted unless the server's `authen.encryption.enable` says otherwise,
and an answer of error 19000 means "not encrypted, please": we ask once more without encryption. HTTP 500-504 on
`getLoginInfo` is asked again every 10 s for up to 120 s; every login call has a 10 s timeout; the npm registry
is not asked whether zca-js is current. The server's key is `setttings` (three t's) in some answers; both spellings
are read.

**Cookies are written back.** When a login changed the cookie jar (name, value, domain, path or expiry; access times
are ignored) the saved credentials are rewritten atomically at 0600. Whether Zalo rotates cookies is unverified (it
needs days of use, see the P7a notes); the write is harmless when it does not. A login that does not know its account (a first QR login) saves nothing.

**Browser headers.** `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `priority: u=1, i` and
`sec-fetch-dest/mode/site` are derived from the saved User-Agent, so a session shows one coherent browser. A
User-Agent that is not Chromium (an old login made with a Firefox one) gets the `sec-fetch-*` headers only. The
capture's `cache-control`, `pragma` and `dnt` were DevTools and user settings, and are not sent.

**Upkeep.** Settings are asked again every hour. A keepalive runs only when the server's `settings.keepalive` asks
for one (`alway_keepalive`, or a `keepalive_duration`; 120 s when 0), is reset by other requests and stops after
`time_deactive` seconds (300) without one. The captured session's settings asked for neither, so by default we add no
keepalive traffic. (The official client's code defaults the duration to 120 s when it is 0; whether it then really
sends one was not seen in the capture. This is the more cautious reading.)

**The offline CLI preload stubs the login calls, not `Zalo.prototype.login`.** `tests/unit/support/offline-session.js`
used to replace that method; our login never calls it, so the preload now answers `getServerInfo` and
`getLoginInfo` at the fetch level and the real login code runs in every offline CLI test. An unpatched
`sendMessage` (`ZALO_OFFLINE_UNPATCHED`) is reproduced by a setter on `API.prototype`.

## `logout` signs the device out, and says so only after looking (v3.0, 2026-10-25)

**Why it changed.** The old logout (the production `GET api/login/logOut`, then `logoutV2`) ended only the session
*key*. The saved cookie kept logging in and the phone kept listing the device (measured 2026-09-30). Zalo Web's own
sign-out is six calls, and on a test account the saved cookie was refused after them. `src/zalo/official-logout.js`
makes those calls in the official order: a token from `id.zalo.me/jr/logout-token`, `profile/deactive`, the `v2`
logout on `stg-wpa` (time in unix seconds), `id.zalo.me/account/logout` with the token, each `setsid` URL the answer
lists, and the login page. The same six run whether local data is kept or deleted; that choice is local.

**What the code does not trust.** The `setsid` URLs come out of a page Zalo served, so only `https` URLs on
`jr.zaloapp.com` and `jr.chat.zalo.me`, path `/jr/setsid`, are followed. A failing step does not stop the others (the
key can be ended without the token); steps that need the token are skipped without one.

**"Signed out" is claimed after a look.** `serverLogout` probes the session key (as before) and, when the caller gives
it the saved login, tries that login once in a login of its own (`probeSavedLogin` in `src/core/zalo-client.js`:
no session is set, no timers run, nothing is rewritten). Zalo refusing it (error 600, or a login that fails) is the
only success line; a login that works is a warning; anything else (no network, a timeout, nothing saved to try) is
"unverified". `--keep-session` is the pre-v3.0 key-only logout, unchanged, and still deletes the credentials locally.
`account remove` uses the official sequence too.

**Seen live, 2026-10-25.** On the test account: a QR login with the official flow, `whoami`, a 274 s `listen` with no
drop, then `logout --delete-history`. All six steps answered; the same saved cookie, tried again afterwards, was refused
with error **102** ("the session key was improperly submitted or has reached its timeout"), where the old logout left it
valid. Zalo wraps that refusal in a *sealed envelope* (`{error_code, error_message, data: null}` inside the encrypted
`data`), and the first version read the envelope as login data, which printed "context init failed" and an
"unverified" verdict. `unseal` in `src/zalo/login.js` now tells the two apart; 102 and 600 both count as a refusal.

**Left for the release:** the public wiki still describes the old logout. It is updated with the v3.0 release,
not before: a wiki push is public immediately.

## The official QR login (v3.0, 2026-10-25; the second QR added 2026-10-27)

`src/zalo/qr-login.js` is the QR login the captured Web client makes. zca-js's flow differs: it announces
`continue=https://zalo.me/pc` to three calls, calls `verify-client` (which the official client never does), leaves out
`cliGenQR`, and ends with a `jr/userinfo` request. The official sequence is the login page (whose script name carries the
build `v`), `logininfo`, `generate` with `cliGenQR=1`, the `waiting-scan` long poll (asked again while the answer is 8),
**the second QR when the scan asks for it**, the `waiting-confirm` long poll with the proof as `bundle`, then `checksession`
and the redirects it starts: `syncsession`, `pushsession` (which sets `zpw_sek`) and the chat page.

**The second QR (the "swapped" QR), and why the first official version failed.** On 2026-10-25 a login with the first
version (`cliGenQR=0`, no `bundle`) worked. On 2026-10-27 the phone said "QR is not valid" to it twice, and the scan answer
carried no display name. The login page's own capture (HARs `CS6-*-login-again`, two logins) shows what the page does that
this client did not: it asks for the QR with `cliGenQR=1`, shows the server's image, and when the phone scans it the server
answers `status 4` with `new_qr_supported: true`, a `master_id`, the account's `chatUid`, and a **new `code` and `token`**.
The page then makes a second QR itself, from that token, with its trusted-device WebAssembly module, shows it in place of
the first (that is the swap), and polls `waiting-scan` again on the new code. That answer carries the name and
`link_data {enc_link_hmac, enc_link_data}`; the module turns it into signatures, and `waiting-confirm` sends them as
`bundle` (base64 of `{encLinkMetaData, encAccSign, encDeviceSign, encCompPubKey}`). The confirm answer carries the device
list (`devices`). The first version took the status-4 answer for the scan, confirmed on the first code, and the phone
refused it. What is not known is why the same login worked on 2026-10-25 with `cliGenQR=0`: whether the server began to
ask every chat-domain login for a second QR, or the account's state changed. Both captures were made with `cliGenQR=1`,
so that is what the code sends now.

**How this client makes the second QR.** `src/zalo/trust-wasm.js` runs the page's own module in Node: the login script
names it (`https://stc-zlogin.zdn.vn/wasm/libzproto_wasm_bg.<hash>.wasm`), so it is fetched from the page at login time
(`loadTrustFromPage`, cached by URL) and never shipped in this repository. The loader around it is ours: the
`wasm-bindgen` calling convention (a table of JS values behind small integers, strings and bytes copied through the
module's allocator, a four-word result slot on its stack), for six calls: `zprotoEd25519GenerateKeyPair` (33-byte public
key, 32-byte private key), `zprotoTrustGenerateLinkingSecretKey` (32 bytes), `zprotoTrustGenerateLinkingQr(publicKey,
secret|undefined, qrToken, timestamp, platform, relinkId|undefined)` (a 129-character text), `zprotoTrustGetRelinkId`,
and `zprotoTrustCreateCompanionLinkingProof(publicKey, privateKey, secret, primaryLinkingData, linkingHmac, platform)`.
Facts read in the page's own code and checked offline: the platform is 1 (Web), the timestamp is milliseconds (the app's
clock), the QR's error correction is H for a text under 150 characters and M above (`src/zalo/qr-image.js` draws it as a
PNG), and `link_data` is plain base64 (the module parsed the real answer recorded in the capture to the MAC check, where
hex or UTF-8 failed at the encoding). The module throws plain `{code, message}` objects, not Errors; the loader converts
them, keeping `code` (`TrustInvalidKeyType`, `TrustInvalidDataEncoding`, `TrustInvalidLinkingMAC`, ...).

**This client becomes a companion device.** A confirmed login with a proof adds it to the account's trusted-device list,
which the phone signs. The identity (key pair, linking secret, link id, primary key, the device list the server
answered) is kept in `accounts/<ownId>/trusted-device.json` at 0600 (`src/zalo/trust-store.js`; a secret, never logged,
gone with the account's data), written only after the login went through. The next login on the same account finds it
and links again as the same device (a relink id, no secret in the QR) instead of adding a companion each time; a refusal
(`-21`) clears it and the login is run again. The page's own relink case was seen in the capture (second login, no new keys).
The device list is stored as the server sent it; its signature is not verified here (the phone and the server do).

**Status.** Offline, everything above is covered: the fake `id.zalo.me` follows the captured sequence whole (the replay
harness reports no difference), the module's calls run in tests on the real wasm when `ZALO_TRUST_WASM` points at a copy,
and a stand-in for the module is asserted on in the unit tests. **No live login with the second QR has been made yet**, so the
default stays zca-js's flow (`ZALO_QR_FLOW=official` selects this one) until one is seen to work; flipping it is one line
in `resolveQrFlow` plus the docs that name the default (`docs/configuration.{md,vi.md}`, `INSTALLATION.{md,vi.md}`,
`skill/references/command-reference.md`).

**The QR page.** `src/utils/qr-http-server.js` serves a plain login page (white card, the QR in a frame with blue corners,
one line of instruction, no script or style from elsewhere), in English and Vietnamese: the `lang` query, then a saved
choice, then the browser's language, with a switch under the card. It follows the login: it says when the code was
replaced by the second one, who scanned it, and when it is done. Text that comes from the phone is set as text, never
markup. The command-line login prints the same hint for the second QR and `--json` gives each QR a `layer`.

**A header trap that cost a real bug.** zca-js's request helper merges headers by key, case-sensitively, and spells its
own defaults `Accept`, `Origin` and `Referer`. A caller that passes `origin` besides it sends both, and a real fetch
joins them into one value (`https://chat.zalo.me, https://id.zalo.me`). The fake records headers through `Headers`, which
joins the same way, so the tests assert the exact value. The fake also follows a redirect itself unless the caller said
`redirect: "manual"`, as fetch does, so a flow that forgets it loses the cookie each hop sets and a test fails.

## The sync request channel, and what a restore now waits for (v3.0, 2026-10-25)

**Where it lives.** `src/core/sync-v2/channel.js` sends the `590` request and the `591` release and reads their
acknowledgements; `download.js` fetches the batches. `SyncV2.restore()` no longer builds frames itself.

**Every request is acknowledged, and the restore waits for it.** The ack is `{reqId, err, ts}` on the same command.
It is awaited for 10 s; a refused request (`err` not 0) is sent again after 1 s and 2 s, three attempts in all; a
timeout is not retried (the answer may only be late, and the phone may already be preparing), nor is error 211 ("this
client is not supported", reported as such). A timeout on a socket that has closed meanwhile is reported as a closed
socket, which the restore then answers with its one reconnect. Requests are ack-paced: each goes out after the one
before it was acknowledged, instead of on a 600 ms timer. The cap of four sessions in flight stays: it is ours, Web
sends all of them one after the other, and a full-history run on the test account (421,000 messages) completed with
it. A run without it was never made and is not needed: four is Web's own pace.

**Counters.** `reqId` is `req_<n>` from one counter; `ussidx` counts the sessions of a run from 0 (it was 0 for every
session, and `reqId` carried the session id). `deviceName` stays the honest label (decision D4).

**A release names why.** 0 cancelled, 1 finished, 2 failed, 3 outdated, acknowledged within 3 s and three attempts. The
phone's own "no" releases with its reason; a run that did not settle its window releases with 2 (it always sent 1
before, and twice for a session already released). A session released before its request was acknowledged is released
the moment the ack lands. Sessions are written to `accounts/<ownId>/sync/open-sessions.json` when requested and
forgotten when their release is acknowledged; a run that died leaves them there, and the next run releases them with
reason 3 before it starts. On a dead wire releasing fails at once rather than waiting out each ack.

**Downloads.** A batch starts downloading when the phone announces it, two at a time, 60 s each, three retries one
second apart; 404 and other refusals are not retried. One that cannot be downloaded fails its scopes (they count among
the failed batches and can stop the run) instead of being skipped without a word; a conversation list with a missing
batch ends the run, because a list with a hole in it is not a list.

**Smaller parts.** A sender that does not resolve, and a `gid/decrypt` batch that fails (a rate limit excepted), are
asked for twice more after 0.5 s and 1.5 s. The restore's own heartbeat now defaults to the interval the server advised
at login (180 s), where it was a third of it: a live socket held 274 s on the server's interval alone. A daemon's
restore still runs it besides the supervisor's pings (same cadence); that is redundant, and left alone because two guard
tests pin it.

## Queue items are acknowledged after the write, and the Web-shaped pulls (v3.0, 2026-10-25)

**The acks (Y10, D7).** Zalo wants to be told which queue items a client holds, and repairs what it was not told
about. `src/core/queue-verify.js` sends the `532` frame `{queueName, ids: [{actionId}], nretry, reqId}` once
`max_msg_verify + 2` ids are pending or `interval_verify` (30 s in a capture) has passed, and reads the answer
(`error` 0 done, 1 some items never reached us and follow as `534` pushes, -1 stop verifying on this connection). The
rule is the order: **an id is acknowledged only after the row it names is committed to zalo.db.** A live push is
acknowledged when every message in it is stored (`noteDelivered`, after the storing handler), an offline page when
its rows were written without a failed write, a `534` re-push after it is stored and handed on. A write that failed
(`storeHistoryMessage` now says `failed: true`, as against a row it deliberately skips) holds the acknowledgement
back, so the server delivers the item again. A new connection forgets what was waiting on the old one. Zalo Web does
not verify offline batches (`skip_offline_verify`); acknowledging them is our choice, so the server can let go of
what it delivered. **Seen live (2026-10-25):** an ack is `{queueName, ids: [{actionId}], nretry, reqId}` and Zalo
answers `{error: 0, reqId}`. **Still not seen:** the server's own settings for our identity, and the `534` payload.

**One request counter, and `reqId` on every pull (X5, Y7).** `src/zalo/req-id.js` is the process-wide `req_<n>` counter
the sync channel, the offline-queue drain and the pulls share. `installOfficialPulls` makes the listener's old-message
and old-reaction pulls (510, 511, 610, 611) send `{first, reqId, lastId, preIds}`: zca-js sent `req_id`, a key Web never
sends. `src/zalo/pulls.js` also has builders for the connect-time requests we do not send (the pulls of 515, 517, 518
and 603, the key-id request 564, the conversation-state request 577, the paged action list 537). They are not wired
to anything: what the server answers to them has not been decoded in a session of ours, and a pull may consume what it
returns, so sending them blind could lose items. A controlled live session is the next step.

**The control queues (X4).** Every `601` names the cursors of `603_1`, `603_0` and `604_0`. They are kept (forward
only, in `sync_state` like the message queues') and a control this client has no handler for is named once in the log.
Nothing acknowledges a control: they are acted on in memory, not stored. (Since the closing sweep the cursors are also used:
see "Connect-time pulls" at the end of this file.)

## A restore remembers what it settled, and a partial run is not a success (v3.0, 2026-10-25)

**The table.** `sync_ranges` (in `zalo.db`, `src/core/db.js`) holds, per conversation partition (the phone's opaque
`oneone/<id>` or `group/<id>`), the window a restore settled for it and whether that is `done`, `failed` (with why) or
`pending`. `src/core/sync-v2/ranges.js` is the arithmetic: a partition settled for a window that covers this one, up to
its last message, is skipped; one settled only up to an earlier last message is asked for from there (incremental); the
rest in full; an unfinished range for a conversation that is gone is dropped (an orphan). `--full-resync` ignores it all.

**What changed in a run.** Each shard's partitions are settled after the shard is stored: done when the phone served
them (or the session finished), failed when it reported them failed or a batch could not be downloaded, pending when
the session ended early (a resume asks for those). A failed partition is asked for once more in the same run, in
sessions of its own; if it fails again it stays failed for the next run. **Only a run that settled its whole window
records success** (`lastSyncOkAt`); a partial one used to, so the "synced recently" shortcut could hide the rest of
the work. `checkSyncFreshness` also refuses to skip while a range is pending or failed (`unfinished-ranges`).

**A conversation the phone no longer has** (error **502**, `PartitionNotFound` in the Web sync worker's error table; not
yet seen on the wire) has its range dropped and is not asked for again, and it is no failure. **Not done.** The client-side
`MSG_IMPORT_FAILED` (keep the range for the next run) has no equivalent here: a row that cannot be written is skipped
without a word, as it always was. Y5d is implemented as dropping orphans: what the official client means by
"promoting" them is not clear from its code. The shortcut's one-hour age rule stays (readiness from ranges alone would
let `sync` never ping the phone again, a change of behavior nobody asked for); only unfinished work overrides it.
The resume asks the phone to confirm again: the conversation round is always sent first, as in Web.

**The test harness.** `tests/helpers/fake-zalo/phone.js` plays a phone (acks, statuses, batches, failures, a decline)
and serves the batches from a fake download host; `SyncV2.restore` takes `opts.codecs` (the decryption and decoding),
so `tests/unit/sync-v2-restore-flow.test.js` runs the whole restore, request to released session, against it. It is
the only test that runs the real restore; the unit tests of the parts cannot see how they are put together.

## `npm run format` covers `src/` and `tests/` only

A session ran `npx prettier --write` on `skill/SKILL.md` and
`skill/references/command-reference.md` alongside its source edits. Neither has ever been
prettier-formatted, so instead of formatting the hunk it imposed prettier's markdown style on both
whole files: **115 changed lines in SKILL.md and 560 in command-reference.md**, from a one-sentence
correction.

They caught it in `git diff --stat`, confirmed both files had been clean at HEAD moments earlier,
backed them up, ran a path-scoped `git checkout --` on exactly those two paths, and re-applied the
content with anchored edits. Final diff: 10 lines and 2.

It ended there only because those two files happened to be clean that minute. With four sessions
writing to one tree, a 675-line reformat landing on someone's uncommitted work is not recoverable
by noticing. Hence the §4 rule: edit anything outside `src/` and `tests/` by hand.

## Lint warnings fail the gate (§4)

Until 2026-09-30 `npm run lint` was plain `eslint src/ tests/`, and `eqeqeq` and
`no-unused-vars` are set to `warn`. A warning prints but exits 0, so the gate passed with eight
of them standing in `src/core/db.js`, `src/core/lock.js` and `src/commands/sync.js`. Every
session saw them in its lint output and walked past, because nothing told it to stop — the
controller included, while noting them as "pre-existing". Arden asked why they had been left so
long; the honest answer was that no check ever failed on them.

That is the same shape as the commands that had never worked: a green check hiding a problem.
The script now runs `eslint --max-warnings 0`, verified by planting one unused variable and
watching lint exit 1 ("ESLint found too many warnings (maximum: 0)").

The eight fixes were behavior-neutral: six unused `catch (e)` bindings became `catch {`;
`ms == null ||` in `formatAge` was redundant with the `!Number.isFinite(ms)` right after it;
and `r.threadId != null`, a deliberate null-or-undefined test, was spelled out rather than
changed. `== null` is a common idiom, which is exactly why each one wants reading before
"fixing" — `=== null` alone would have let `undefined` through.

## Real ids in the repo, and why the rule alone did not stop them (2026-09-30)

AGENTS.md §0 #6 already forbade real user ids in tests and docs. On 2026-09-30 the tree still
held them in 24 places, found in two sweeps:

- **b0f267c** (the controller, prompted by the group-history fix agent): nine files. The owner's
  uid sat in a comment in `src/commands/group.js` (and `src/` ships in the npm tarball) and in a
  test alongside his display name. The retired disposable group's id sat in
  `src/core/sync-v2/conv-state.js` comments, in `command-reference.md`, and in a test under the
  heading "Fictional ids of the real length". A DM contact's id **and name** sat in
  `tests/fixtures/data.csv`, and again inside `archive.zip`, where no text search can see them.
- **The guard's first run**: 10 more digit-run ids and 5 *noised* ids. Two conv-state "fictional"
  ids matched a captured real thread id; the others were a captured sender id, a reminder topic id
  and an OA follower id in `eval-scenarios.md`. A noised id is the 32-character form sync stores in
  place of a uid, and `/api/gid/decrypt` turns one back into a uid and a display name, so it is an
  identifier too. One sat in a comment in `src/utils/quote.js`.

How they got in: values copied from live captures and logs into tests and comments, then called
fakes without anyone checking. Why the rule did not stop it: nothing checked the rule.
`tests/unit/no-real-ids.test.js` now does, in `npm test` and therefore in CI. Every 15+ digit
run and every 32-character noised id in tracked and unignored files, zip entries and paths must
match the fake convention documented at the top of that file. An allowlist of three entries covers
constants that are not ids (2^63, `Number.MAX_SAFE_INTEGER`, one rounded fake). It was proven by
planting a real-looking id in a file and inside a zip entry; both went red.

What a pushed leak costs: the values stay in history and in every clone. The remedy is a history
rewrite (Arden approved one for `main..v2.0-dev` on 2026-09-30), plus accepting that clones made in
the window keep them. Measured at the time: all three forks predate the leak; GitHub counted about
212 clone events after it. Names have no automatic check. The local leak check in `.agents/`
(§10) covers the wiki, not this repo.

### A local branch can outlive a scrub (2026-09-30)

The `main..v2.0-dev` history rewrite scrubbed every leaked value from every commit reachable
on GitHub. But a feature branch cut *before* the rewrite still has the old values in its tree
and in its own commits. On the night of the rewrite that was `fix/self-heal-backfill` (an agent
worktree, based on the pre-scrub daemon-writer branch): `git log --all -S'<noised id>'` returned
3 in that clone even though every remote ref returned 0. Verified local-only — no remote ref
contained any of the three commits.

So `git log --all -S` is a whole-object-store scan: it sees unmerged local branches, and it sees
GitHub's unreferenced-commit views until they expire. "0 on every remote ref" is the guarantee
the rewrite gives; a local non-zero from a stale branch is that branch, not a failed scrub.

The fix is never to push or merge such a branch. Take its diff, apply it onto the scrubbed tip
(where the leaked files are already fake), let `tests/unit/no-real-ids.test.js` prove the result
is clean, and delete the old branch. Merging it instead would put every scrubbed value straight
back on GitHub — exactly what the rewrite undid.

## Finishing P0 to P3: what was closed, and what was decided against (v3.0, 2026-10-25)

**Ctrl+C in a restore (Y6b).** `SyncV2.restore()` takes `opts.signal`. An abort is looked at between waits: while a
session waits for the phone, before each wave, and before the one retry round. A stopped run keeps every shard it
already stored, asks for nothing more, releases the sessions still waiting with reason 0 (cancelled) and the ones that
had finished with reason 1, records no success, and resolves `reason: "cancelled"` (not an error, so `sync` can say
what was kept). `src/utils/interrupt.js` wires SIGINT to it for `sync` and `sync-mobile`; a second Ctrl+C exits 130.
A restore routed through a daemon is not stopped by the CLI's Ctrl+C: the daemon's stage runs on, and stopping it from
the channel is a separate change.

**The maintenance question carries the stored numbers (L3).** `GET {maintenance}/api/chk?bkt=..&spt_mtn=..` takes the
`bucketId` and `supportMaintenance` of the `dr_config` the session's login learned (`maintenanceKeysOf`), for the
supervisor and for the wait after a login that failed with 70. The names `bkt` and `spt_mtn` are the Web bundle's.
What 71 means is still an inference (an announced window; it does not block).

**The official QR is opt in** (`ZALO_QR_FLOW=official`) until a live login with its second QR is seen to work; see the section above.

**Decided against, with the reason.**
- *Copy-then-delete when a Windows rename keeps failing (X7).* Not added. A copy over the target is not atomic: a
  reader or a crash can see half a file, and these files hold credentials and the account registry. After the
  2 s retry window the write fails loudly and the old file is intact, which is the better failure. The retry never ran
  out in any measurement.
- *Re-reading `archivedchat` and `recentsearch` on recovery (X2).* Not applicable: this client keeps no copy of
  either list (`conv archive` reads the list from Zalo each time it needs the version), so there is nothing to refresh.
- *Domain rotation and the `config_vesion` refresh (L2d, L2e).* The login has one host, and the refresh needs the
  keepalive answer, which has not been seen. Left until a live capture shows it.
- *A red-first reproduction of zca-js's TypeError on a missing `retries` entry (L11a).* The supervisor never lets
  zca-js retry (`retryOnClose: false`), and the retry engine's tests pin the replacement (an undescribed key waits the
  last default delay, key 3003 included). A test of the upstream defect itself would only test zca-js.
- *Encrypt 2 and 3 on the fake socket (P0).* The fake plays plain frames. The cipher path our own code reads
  (`decodeFrame`, used by the restore and the socket tap) has unit tests for both; zca-js decodes the live frames.

**Still needs a live session (a QR login).** `agent/work/probe-pulls.mjs` (local, not committed) sends the pulls 564, 537,
577, 515, 517, 518 and 603 one at a time to the test account and prints only the shape of each answer; it refuses to
run outside the test home and refuses the consuming pulls without `--i-accept-consuming`. Also open: a full-history
restore past the four-session cap (Y4b), a `532` ack with a real message (Y10), automatic sync (Y8), and the keepalive
question (L9).

## What the first live full-history restore found (v3.0, 2026-10-25)

Measured on an account with 2,367 conversations and about 750,000 messages; two defects, both old, neither seen by an
offline test because the fake phone's conversations are tiny.

**The restore stalled its own event loop (`findMessageByClientId`).** A synced message without a server id is stored
under the id of an already-stored live row with the same client id, found by `json_extract(raw_data, '$.cliMsgId')`.
That read and parsed the JSON of every row of the thread, once per message: 190 ms per lookup on a 42,000-row thread.
A CPU profile of the daemon (46 of 113 s in that one function, 9.6 s more re-preparing its statement) showed the
event loop blocked for 5 to 77 s at a time; pings went unanswered and Zalo closed the socket (1006). The same cause is
the likeliest reading of the September "1006 at batch 0" runs. There is now an index on the client id (`idx_messages_cli`,
with the same `json_valid` guard, so a lookup must use `CLIENT_ID_EXPR` to use it), the lookup sorts its few matches
itself because an `ORDER BY` made SQLite walk the timestamp index instead, and the statements are prepared once per
connection. 20,000 lookups take 150 ms. The index builds in 0.3 s per 57,000 rows, once, at the first open.

**The phone serves about 32 open sessions and then stops.** Message sessions were released only at the end of the run
(only the conversation session was released at once). The first full run stored 29 shards, had 3 in flight, and went
silent; the phone then showed no sync status, and the next start found 32 sessions open to release as outdated. Zalo
Web lets go of a session when it has what it asked for, and so does the restore now: each shard's session is released
as soon as it is stored (finished, or failed when it had an error), in the retry round too. The channel sends one
release per session however many callers ask.

**A live kick (L12b), 2026-10-26.** Opening Zalo Web on the account while the daemon ran: the socket closed with code
**3003 and the reason `KICKOUT_BY_WORKER`**; the supervisor, treating 3003 as retryable, reconnected 2 s later and the
new socket was refused at once with error 600, which ended the daemon (exit 3, "Another Zalo session took this account").
The newcomer is the one the server refuses, so the extra reconnect evicts nobody. The saved login was then refused (102):
a kick by Zalo Web ends the saved session, and the next start needs a QR. The `kickout-info` lookup first answered HTTP 200
`{error_code: 112, data: null}`: it had been given the zCloud viewer key, which is not the right one. The right pair is
`auth_ext_info: {viewer_key (334 characters), enk (24)}` in the **getLoginInfo** answer (found in the Web client's
`setDataKeyGetKickoutInfo` and in the captured request's token). With it the lookup answers error 0 and a sealed
`data` that opens, in the session cipher's shape with `enk` as a base64 key, to `{kickoutSrc: 2, kickoutTs}`;
`kickoutTs` is the second the session was replaced. What the source means is the server's own table,
`settings.features.kick_out_config[src]`: source 2 is titled "Device changed" ("You previously logged into Zalo on a
different browser"). The listener now logs that text and the time. Treating 3003 `KICKOUT_BY_WORKER` as terminal at once was considered and not done: 3003 is also in
Zalo's retry list, and a wrong guess would end a healthy daemon.

**Auto sync at login (Y8), 2026-10-26.** With "auto sync" ticked on the phone's QR confirmation, the phone puts two
`transfer_sync2 / transfer_after_login` controls in the control queues (603_1 and 603_0), stamped at the login:
`{temp_key (64 characters), imei: null, pc: 0}`. Zalo Web uses the latest one that has a key and `pc` 0 (the web; the PC
app is 1) and is under 10 s old, and sends the key as `tempKey` in its conversation request. Live: the request went out
15 s after the login with that key and the phone showed no prompt (no status 3 at all); the same request with a key 765 s old
got the prompt. `login --sync` does this (`src/core/sync-v2/auto-sync.js`): it reads the control the moment the
socket is up, accepts a key up to two minutes old (the 10 s of Web is not needed: our request goes out after about 15 s,
and the limit is only a guard), and puts the key in the conversation request only. It is an explicit command: the daemon
never starts a phone-backed stage by itself.

**What the phone does while Zalo is in use.** Zalo open and in use on the phone seems to pause the transfer; leave it
idle for a long restore. This is not proven (the run that went silent also had 32 sessions open).

**Other live results.** A window of 30 days (13,910 messages) restores in under a minute; a full restore stores 90,000
messages in its first shard. Every 590 and 591 is acknowledged with `err 0`; a `532` for a live push is answered
`{error: 0}`; the pulls 515, 517 and 518 answer in the shape of the old-message queues; 603/0 and 603/1 answer pages
of 50 `transfer_sync2` controls with `more`; the keepalive answers `{config_vesion}`, and a change in it now refreshes
the settings at once.

## Search: what Zalo does, what we do, and what it cost (v3.0, 2026-10-26)

**What Zalo's clients do** (read in the Web and PC bundles; the captured session sent no search request at all):
search is local, in the client's own store. The keyword and the text are folded alike by `simpleStripVietnamese`
(lowercase, every Vietnamese vowel with its marks to the bare letter, `d` for `đ`), then matched as a substring; the
keyword is at most 100 characters; a hit is shown as 70 characters before the match and 30 after; results come in
pages and the footer says how far back the local data reaches. No ranking exists in the code (F10): results are in time
order. The media tab filters by sender, by a substring of the title (folded), by extension group and by a date range
that is whole days. We follow all of that except the extension groups. The server switch `enable_matching_enhance` is
off for everyone and is not followed either.

**What we do.** `src/utils/vn-text.js` is the fold: it strips exactly the eight Vietnamese marks (grave, acute, tilde,
hook above, dot below, breve, circumflex, horn) from a, e, i, o, u, y, and leaves every other letter alone (`ñ`, `ç`
and `ü` keep theirs, as in the official function). It is built on decomposition, so the composed and the decomposed
spelling fold alike. `messages.text_norm` holds the fold of `text`; the three message writers keep it (every one of
them goes through `insertMessage`, `insertMessageIfAbsent` or `markMessageRecalled` in `db.js`, so nothing else had to
change). Rows written before the column existed are filled in once from `text` and never from `raw_data`, only where
the fold is empty. That backfill and the index below are **derived data, not message writes**: no `text`, `type` or other
column changes, and running them beside a live daemon changes nothing it should not.

`src/core/search.js` is the search: a keyword cut to 100 characters, `accents: "fold"` (default) or `"exact"` (the fold
finds the candidates and the accents are checked on each, case-insensitively and in either Unicode form), filters (thread,
sender, dates, types), pages keyed on `(timestamp, msgId)` so a message arriving meanwhile shifts nothing, the tabs'
numbers (matches by type), context around a hit, previews, and the coverage note (how far back the cache reaches, whether
a phone restore has finished, the pending gaps and the `sync --from` command). `msg search` and `zalo_search_messages` are
thin around it. `msg search` is marked local-only, so the program's pre-action login is skipped: it reads `zalo.db` and
nothing else.

**The index, and why it is built the way it is.** Measured on a copy of the 421,000-message test account while the machine
was at 100% CPU for other reasons: a scan of `text_norm` costs 0.8 to 2 s, and 6 s for a keyword nobody wrote. An FTS5
trigram index of `text_norm` (+53 MB on 384 MB, 17 s to build) answers a rare keyword in 3 ms and the tab counts of a
common one in 0.14 s; a global `(timestamp DESC, msgId DESC)` index (5.5 s to build) lets a short or very common keyword
stop after its first twenty hits. They cannot be built in one go beside a live daemon (a long write lock would make its
writes fail), so `ensureSearchIndex` builds a slice per search, up to 2 s: the fold first, then the triggers that keep the
index current **before** the existing rows are indexed (so no row falls between), then the rows in slices of 20,000 with
`INSERT OR REPLACE` (indexing a row twice is harmless, and an interrupted run carries on from its saved place). Until it is
done a search scans and folds on the fly the rows that have no fold, so it is correct from the first call; the FTS only ever
narrows candidates, and the LIKE on `text_norm` still decides, so the index can change how fast a search is, never what it
finds. The first search after upgrading starts the build; `initDb` only adds the column (instant), so no other command pays. Measured on the copy: the first search folds 386,000 rows in about 22 s (one time, with a progress line in `msg search`), the next three take 3 to 5 s while the index is built in slices, and from the fifth a common keyword takes 0.25 s, two words 33 ms, a keyword nobody wrote 6 ms, an exact-accents search 0.8 s. Finishing the fold in the foreground is deliberate: when most rows have no fold, scanning them with the fold done on the fly costs as much (27 s), so a slice-sized budget would only add waiting. An MCP client sees the same 22 s once, on its first search of a cache that big.
A tombstone's text is `[deleted]`, which stays in the index and is never returned (deleted rows are filtered out).

**Not done, on purpose.** An extension filter for files (the groups are in the bundle's `fileExt`, not worth a table here).
`ensureSearchIndex` is not run by a daemon at start, because a slice per search needs no coordination; a daemon that
searches little would finish the build on its first dozen searches. The wiki pages (EN and VN) are updated with the
release, like the logout pages.

## zCloud: what the web client does with the queue, and what we do (v3.0, 2026-10-26)

**What Zalo Web does** (bundle modules `_EZi` for the walker, `bWos` for the keys, `MNOV` for the batch form, `tP1L` for
the transport): on each cmd 621 `mycloudMedia` push it walks the verify queue from its saved last noise id and applies
every page, newest reset first. An `add` entry is stored. A `remove` entry carries the messages it removes in
`msgInfo.extInfo.orgMsgs[{type, uidFrom, uidTo, clientDelMsgId}]`, and each becomes the key `cliMsgId_conversation_sender`
(a 0 standing for the account, a DM's conversation being the other side, a group's id carrying a `g` prefix in the web
only). A `del_thread` entry clears a conversation's items older than its client timestamp (the first `orgMsgs` entry's
`uidTo`, or the group for a `group.leave`). A `reset_cloud` entry empties the store except the self chat (`send2me_id`),
and drops the page's entries that are older than it. `temp` and `duplicate` do nothing. The id of the last page is
saved, and the push is acted on at most once in 30 minutes. The old `sync-cloud` recorded `add` entries and only counted
the rest, so a recall, a cleared chat or a reset left items in the index for good.

**What we do.** `applyQueuePage` in `src/core/sync-v2/zcloud.js` is that page logic; `syncCloudIndex` applies each page
as it arrives and calls `onPage` with the place to resume from, which `sync-cloud` saves after every page and keeps when
the walk is complete (the old code threw it away then, so every run started from the top). The keys are computed the same
way (`cloudKeyOf`, `removalKeysOf`, `threadClearOf`), in this database's own conversation spelling (a group's id without
the `g`). `cloud_items` gained `zKey`, `seenAt`, `keyVersion` and `algoVersion`; rows written before get their key
from `raw_data` at the start of a walk. `--full` walks from the top and, only when the server has said it is done and
nothing failed, deletes every row no page of that walk stamped: the mark-and-sweep for an index the incremental walks left
stale. It never deletes before the end, so an interrupted full walk loses nothing. The web client wipes the store first
("verify from nothing"); we do not, because a failed walk would then leave nothing.

**cmd 621 in the daemon** (`src/core/cloud-verify.js`, built identically in `listen` and `mcp start`). The live payload is
`{"mycloudMedia": {pageSize, lastNoiseId, forceVerify, onboardingCompleted, auditLocalCloudQueue, correctCloudKey}}`
as plain JSON in the frame's `data.data`. Rules: only after a person has run `sync-cloud` once (the first walk reads
the whole queue, megabytes for an old account); nothing when the push's `lastNoiseId` equals the saved place; at most
once in 30 minutes; never while another stage holds the lock (it takes the lock with `tryAcquire`, never waits); at most
20 pages, the next push continues; the four forcing fields are read and ignored (`sync-cloud --full` is the explicit
form); and **never an acknowledgment**: the onboarding ack the web client sends after its first verify, `submitMediaExtInfo`,
`reset`, the QoS and migration calls all change what Zalo does with the account's cloud, and none of them is ours to send.

**Transport rules** (`zcloudGet`). A refused viewer key (-1, -205) is dropped. The web client then fails that request; we
fetch a new key once and repeat the GET, which is one extra request, so a stale key from the login does not fail the first
call of a run. After a refusal the login's key is never used again (it is known stale), which a first version got wrong:
the dropped key fell back to the login's. Server code 112, a dropped connection, an unreadable reply and an HTTP 4xx/5xx
are retried after 0, 5, 5 and 10 s; a 4xx/5xx moves to the next zCloud domain of the service map; every other code,
-201 included, fails at once. An error reply's own payload is decrypted and kept on the error (`error.payload`). Download
URLs are asked for through a 500 ms window (ended early by 50 waiting callers or 100 waiting ids), 100 to a request, and
reused for 60 s. The web client also keeps them 24 h; we do not, because a signed URL is not something to write down.
`usage-mycloud`, `family-usage` and the family viewer key are read-only reads (`getMyCloudUsage`, `getFamilyUsage`,
`getFamilyViewerKey`); nothing calls them yet, and which key the family reads want is not measured.

**Item shape.** The blob's key and versions are the item's top-level `encryptInfo {encryptKey, keyVersion, algoVersion,
cloudUrl}`. `mediaInfo.mediaExtInfo {data, encryptInfo {encryptKey, encryptVer}}` is the file-name and thumbnail
metadata under a different key; it stays in `raw_data` and is never taken for the blob's key. Nothing is decrypted.

**The key is out of scope (decision D8), and this is why it is a decision.** Reading names, thumbnails or blobs needs the
account's RSA private key, which the web client gets from the phone: `GET req_cloud_key` opens a pending transfer, the phone
user approves, and the key arrives on the chat socket as a `personal_cloud` control, wrapped in a Signal-style message
addressed to the account's own E2EE session. Taking part needs a registered E2EE device identity, a state-changing step on
the account whose effect on other devices is unknown, plus secure storage, key-version and `correct_cloud_key` handling and
free-plan removal. None of it is built, and no live request for it was made.

## Reads: the web client's read-only endpoints (v3.0, 2026-10-26)

**What it is.** `src/zalo/reads.js` is a table of 42 reads (40 at first; the closing sweep added `blocksharing-list` and the local `voice-transcript`): for each, the service-map host, the path, the web client's
command id and the body it encrypts into `params`, taken from the web API module (`fBUP`, 2026-10-23 bundle) method of
the same purpose. They all use the session cipher (a GET with `params` in the query, or a POST with `params` in the form
body); the two login-host reads (`check-update`, `server-settings`) have plain replies, with `data` unencrypted.
`callRead` sends one; `buildRead` shows the request without sending it. Surfaces: `read list` and `read run`
(`src/commands/read.js`) and the MCP tool `zalo_read` (`src/mcp/mcp-tools.js`). A test keeps the table to reads: no path
of it names an update, removal, send, seen mark or the like.

**Live check.** They were run on the test account, with shapes printed and values not. 35 answered at first; `pin-list` (added
by P7a) and `offline-check` (answered `{}`, `0`, `0` with a list of ids and `evict`) made 37. The other three, the `todo-*`
reads, answer `-69` ("stop retry"), which the zCloud report reads as a server refusal, so the account probably has no todos
feature (their request shape is untested). Nine more were in the first table and are **not offered** because Zalo
answers them with 404 or an error on this build: `cm/getpath`, `cm/mget`, `cm/rgetv2`, `group/analyse`,
`message/get_backupmsginfo`, the sticker `category/list` and `recommended`, and the GIF by-category and by-dictionary
reads. The web client's code still has methods for them, so a method in the bundle is not evidence that an endpoint is alive.
The group-history reads we use (`getrecentv2`, `getoldv2`) are the ones the client's real traffic shows.

**What the live check corrected.** `check-update` answers 1001 ("Item not found") to this client's version, which is an
answer (no update information), not a failure. `server-settings` replies with plain JSON, not the session envelope, which
`resolve` cannot read, hence the `reply: "plain"` flag. `friend-verify` takes an array of `userId_version` strings, not a
map. A group's `message-status` needs `{tId, ids}`, with the message ids. `important-messages` pages back from a `lastId`;
a `newestId` of 0 is refused, so the newest page is a `lastId` past every id. `last-messages` accepted both shapes of its
argument; its answer is queue-shaped, with message arrays, so it is a read of what Zalo holds, never printed in tests.

**Not done, on purpose.** The state-changing endpoints (plan 6.2) are not in the table and are added one at a time with the
owner's approval. AI translate (`translate/v1/setting` and the rest) is dropped for now (D5): its GET goes through a transport
this pass did not trace. The emoji-status pair carries `{imei}` as its body, which the live account accepted; the bundle's own
call site was not read.

## Writes: the web client's state-changing endpoints (v3.0, 2026-10-26)

**What it is.** `src/zalo/writes.js` is a table of 33 writes (24 after P7a; the closing sweep added nine) on the same request path as the reads (`src/zalo/web-call.js`, which `reads.js` and `writes.js` share), each with the host, path, command id and body taken from the web API module's method of the same purpose. Surfaces: `write list` and `write run` (`src/commands/write.js`) and the MCP tool `zalo_write`. The owner approved building all four groups of plan 6.2; the first version was written and tested offline, and P7a (2026-10-27) then ran them on a disposable group ("Việc riêng - AI test", whose members are the owner's accounts) and on the owner's Arden Companion account. **14 of the 24 were seen to work; 10 were not, for reasons recorded in each entry's `note`.** Two more (`profile/mode`, `closefr/update`) answered 404 and were removed. Guards: each entry has a `risk` (`private`, `visible`, `destructive`); `callWrite` takes `dryRun` and then sends nothing and returns the request with its body decrypted; `write run` refuses without `--yes` (or `--dry-run`) and `zalo_write` without `confirm: true` (or `dryRun: true`); tests keep the `verified` set exact and keep the table's endpoints and names disjoint from the reads, which a test holds to reads only.

**Built, with what the body is.** The multi-recall (`multi_undo`, `multi_undomsg`) sends, per message, a fresh client id,
the original's client id (`cliMsgIdUndo`) and its global id. The group note and reminder writes (`topic/createv2`,
`updatev2`) are the revamp builder's v2 branch: `pinAct` instead of `needPin`, `repeatRule` and `onlyMe` when given, `params`
as a JSON string, or `{}` (not an empty string) when absent. Pins use `pinv2` and `unpinv2` (GET), `pin/update` (POST) and
`multi_unpin` (GET). The todos are `board/personal/todo/*` and `board/personal/delete`; several of them are GETs that change
state, which is why the table carries the method per entry and `risk` does not follow it. `group/kickout/multi` removes ONE
account from several groups (`grids`, `member`), not several members from one.

**Left out, and what would be needed.** (1) The sending flows that upload or re-send content: `photo_url` is a re-send path
whose request goes through a helper (`transformParams`, then `_postSendMsg`) that adds fields; `sendpt`, `sharefile`,
`sendmp3`/`voicemp3`, the GIF and video chunk uploads and `upthumb` are multi-step uploads; zca-js already sends images,
files and videos. A local mp3 as a voice message can be had by uploading the file the way `msg send-file` does and sending
the URL with `msg send-voice`. Building them needs a capture of the web client sending each. (2) `convlabel/manage/*` and
`blocksharing/*`: only their paths and command ids are in the bundle files read; the callers are in lazily loaded modules,
and block sharing is a zBusiness feature (error 829 when not allowed). `label update` still takes a raw label payload.
(3) `voice2text`: the build has no method for it. (4) The receipts: the legacy `seen`/`delivered` forms and `subtab/seen`
change what other people see, and the v2 forms are already sent.

**The numbers, traced (P7a, 2026-10-27).** They are enums of the web client's constant modules: a board item's type is
`text 0, link 1, message 2, poll 3, reminder 4` (a reminder the web client creates is a `text` topic with a start time and
an emoji; `reminder 4` is the board's own label for it), an RSVP answer is `none 0, accept 1, reject 2`, a todo's status is
`waiting -1, inProcess 0, done 1`, the account's presence mode (the `user_mode` of its profile, 0 on the test account) is
`available 0, away 1, busy 2, invisible 3`, and the source of a multi-group removal is `unknown -1, profile 0,
mediaStore 1, contextMenu 2, operate 3, reviewRetry 4, suggestion 5`. A repeat rule is the RFC 5545 string the web client
builds, `RRULE:FREQ=<DAILY|WEEKLY|MONTHLY|YEARLY>;INTERVAL=1;[BYDAY=MO,TU,..;]`, sent as a JSON array of one string in
`repeatRule`, with the legacy `repeat` code beside it (daily 1, weekly 2, monthly 3, yearly 4) and `onlyMe` as 0 or 1 (also
inside the topic's `params`); both fields go together or not at all. **Not traceable:** the close-friend action (the web
client's toggle is an empty function in this build, and `closefr/update` answers 404), a suggestion's `src` and `type`.

**What the live runs corrected.** `unpinv2`, `pin/update` and `multi_unpin` name a pinned item as `{topicId, topicType}`,
not as a bare id (a bare id answers 114), and need the pin board's version from `board/pin/list` (the new `pin-list` read).
`recentsearch/update` takes `{id, type[, last_update_time]}`, not the shape `recentsearch/list` returns. A reminder is not in
`board/list` (it is in `board/listReminder`), so a cleanup that lists the board misses it. The `multi_undo` family
returns `{data: {<new client id>: <value>}, status: 0}`. `kickout/multi` really removes the member from each listed group
(checked on the disposable group; the member was added back). `topic-create` with `onlyMe` is honored (`onlyMe: 1` comes
back). `sync_action/media` accepts an empty list. The todos answer `-69` (feature off for the account). `profile/mode` and
`closefr/update` answer 404. What a send returns: `message.msgId` and `message.cliMsgId`; the recall needs both.

## P7: the live verification sweep and the hardening (v3.0, 2026-10-27)

**P7a, what was run live** (test account, a disposable group "Việc riêng - AI test" whose other members are the owner's own
accounts, and the owner's Arden Companion account as the target of anything that touches a friend; ids are never written
down). Reads and writes are in the sections above; the rest:

- **Board and message writes** all worked as recorded in the Writes section, after three corrections the live run forced
  (the pin refs, the search-history items, the repeat-rule serialization). Everything created was removed again, and the
  Companion account was removed from the group and added back.
- **`sync-cloud`**: a first walk to completion (two runs, resumed from the saved place), then `--full` over all 102 pages
  (35,994 items kept after 466 `remove` entries were applied; nothing to sweep). The queue's removals are real and numerous,
  which is what Z1 was for. Resuming from a page-100 cursor gave exactly the last two pages.
- **cmd 621**, in a real `mcp start` and a real `listen`: with the saved place behind the server's, the daemon walked two pages
  and recorded 560 items; with it level, it did nothing and said so (that line, `notice (cmd 621)`, was added by this pass:
  before it, "nothing to do" was silent and indistinguishable from "never arrived").
- **A real MCP session** (the SDK client over stdio): 27 tools, `zalo_read` listing and running, a missing argument refused,
  `zalo_write` refused without `confirm`, a dry run, and a real write.
- **Soak**: `listen` stayed up 30 minutes on the test account with no drop, no kick and no retry; self-heal recovered the
  messages missed while it was down, and the delivered receipts went out. `unknown-acts.json` was not written, which means no
  action it does not know arrived in that time.

**Not run, and why.** (1) The consuming pulls `515`, `517`, `518`, `603`: they may remove what they return from the server's
queue, and the account is the owner's real one. (2) The listener on a real network cut: it needs someone to switch the
network off and on. (3) A restore without the four-session cap: not needed, see the sync section. (4) A non-empty
`sync_action/media` list, a real `oa-block`, a real suggestion for `recommend-remove`: nothing disposable to aim them at.
(5) The three todo writes and reads: the account answers `-69`.

**P7b.** X10: `src/core/unknown-acts.js`, attached identically by `listen` and `mcp start` (a test reads both files' syntax
trees): an action the server pushes (`602`, or an unhandled `601` control) that nobody handles is named once in
`unknown-acts.json` of the account folder, with its first and last time, its count, the command that carried it and the key
NAMES of its data (never the values). Bounded (200 names), counts written back at most once a minute, never throws into
the socket. L16: decided against, see below. L17: comments and notes made true (the 532 ack shape, the pulls' answers, the
four-session cap's reason, the cookie note).

**L16 (optional boot reads), decided against.** The reads exist on demand (`read run server-settings`, `blocklist`, the zCloud
usage reads); nothing of ours consumes them at boot, and a boot that makes calls nobody needs is traffic that is not free for
the account. They can be added where a feature needs one.

**Error 71, from the web client's own code (corrected in the closing sweep).** The maintenance check (`maint.chat.zalo.me/api/chk`,
sent with the stored `bkt` and `spt_mtn`) answers `{error_code, data: {startTime, endTime}}`, the times in milliseconds. The
client's maintenance module does this with the answer: 0 ends the check (the servers are fine); 70 while the app is running
reloads it into the maintenance screen, and 70 while it is starting keeps re-checking; 71, running or starting, means "continue
checking": the app stays up and the check goes on. Between checks it waits by one rule, `s(window, now)`: inside the announced
window an hour, from the window's end (or with none announced) a minute, and before the window a flat 0 ms (which asks in a
loop; this client waits a minute there instead). That rule applies in the 70 loop too, so during an announced window even a
live maintenance is asked about hourly, not every minute.

What is built (`src/zalo/maintenance.js`, `socket.js`, `core/socket-host.js`): `checkMaintenance` returns the window;
`pollDelayMs` is the rule above; `waitOutMaintenance` waits by it; and after a 71 the supervisor (or the host, when the 71 came
while logging in) starts `watchMaintenance`, which keeps asking by the same rule while the socket carries on: a 0 ends the
watch, a 70 sends the socket back into the maintenance wait (the equivalent of the web client's reload). The question goes out
through the account's own fetch, so a proxied account's question leaves by its proxy. The earlier text of this note said the
poller asked hourly after a 71; it did not (a 71 only let the login proceed, and the unused hourly constant was removed).

What 71 means on Zalo's side (a notice before a window, or a degraded service) has never been observed, because Zalo was not
in maintenance in any capture; what is copied is what the client does with it, not why. That cannot be closed by a test and is
recorded here as such.

## The closing sweep before P8 (v3.0, 2026-10-27)

The owner asked for every open item of P0 to P7 to be closed or answered before the docs and release phase. This is what
was found and done; each item says whether it was closed by code, by a live run, by evidence from the web client, or
by a decision, and the few that need the owner's hands are listed at the end.

**Two defects found by looking, both older than 3.0 (the second is also in 2.5).**

- *Every proxied account failed to log in.* `createProxyFetch` handed an `undici` 8 `ProxyAgent` to Node's global
  `fetch`, which has its own undici (7.30 in Node 24.22): the pair fails every request with "invalid onRequestStart
  method", reported as "fetch failed". No offline test had ever sent a request through a proxy. It now uses the
  package's own `fetch`; `tests/unit/proxy-fetch.test.js` sends through a local proxy and goes red on the old pairing.
  The maintenance question and the supervisor now go out through the account's own fetch too, so a proxied account's
  question leaves by its proxy.
- *A restore wrote a row it could not write into an empty `catch`.* A full disk or a locked file left a hole, the
  conversation was marked restored and the run said "complete". The failure is now counted (`rowErrors`,
  `firstRowError`), the partition is settled as `failed` (`write-error`) so the next run asks again, the run is
  `partial`, and `sync` says how many rows and why. This is also what the client-side `MSG_IMPORT_FAILED` of the web
  worker amounted to (Y2b).

**Error 71 and the maintenance gate (L3).** Corrected: the web client does not "ask hourly after a 71". Its rule is
`s(window, now)`: an hour inside the announced window, a minute from its end or with none, and (before the window) 0 ms,
which asks in a loop and which this client does not copy (a minute). 71 is "continue checking": the app stays up and the
check goes on, and a later 70 reloads it into the maintenance screen. Built: `pollDelayMs`, the window read from the answer,
and `watchMaintenance`, which the supervisor (after a 71 in the maintenance wait) or the host (a 71 while logging in)
starts, and which hands a 70 back to the supervisor as a new maintenance wait. What 71 means on Zalo's side was never
observed; that cannot be closed by a test.

**The saved login never renews (cookie rotation, L8).** In eight real Zalo Web captures (a few minutes to a long session,
2,189 requests in the biggest) the chat session cookie `zpw_sek` (90 days) is set exactly once, by `jr.chat.zalo.me/jr/pushsession`
at login, and cleared at logout; `zpsid` (a year) likewise; no API answer re-issues either. The web client's own renewal call
(`exta/rnw`, `renewSession`) is defined and has no caller in any bundle. So nothing extends a login, and the useful thing
to build was the date: `src/core/session-expiry.js` reads `creation + max-age` from the saved jar, `whoami` prints it
(`sessionExpiry` in `--json`), the daemons log it at start, and the health snapshot warns from 14 days before
(`session`, `zalo_session_days_left`). Never a cookie value.

**Login host rotation (L2d).** The web client has one `authDomain` for `getServerInfo` and `getLoginInfo`; there is no
rotation to follow. Closed by evidence.

**Ctrl+C on a restore routed through a daemon (Y6b).** The channel now has `POST /sync/cancel`: it aborts the running
stage's signal, which `traceRunners` forwards (that wrapper dropped a third argument; a test caught it) to `restore()`;
`restoreViaDaemon` in the CLI sends it on the first Ctrl+C, and a second quits at once. Walking away without asking still
does not stop a stage.

**A real network cut (the plan's open live test).** A local CONNECT proxy that can be cut and restored, with
`ZALO_NET_PROBE` pointed at it, carried a real `listen`: (1) connections reset for 25 s and for 120 s: the socket closed 1006,
one retry (`interval_check`, 1.1 s) came about 2 s (25 s case) and 6 s (120 s case) after the network returned, self-heal closed each gap, no
relogin; (2) a black hole for 60 s (sockets open, no bytes): the socket stayed up through it (no ping was due, and a network that is
down is not a reason to close a socket); the bytes the test proxy had dropped then broke the stream at its release, which
is an artifact of the test, and the reconnect and the gap recovery worked; (3) a black hole of 215 s across a ping: the echo did not come, the socket closed under 5011, then 5012
(establish timeout) every ~18 s with the endpoint rotated after the table's five, and the unanswered queue ack was dropped after
three tries; after the network came back it reconnected and recovered. The hammering the old ladder would have done did not
happen. Not tested: a cut that leaves some hosts reachable (a captive portal).

**What the live login settings say (L11, the retry table).** The server's own table for this account has the same shape as
the defaults in `src/zalo/retry.js` (5012 and 5011 `max` 5, 4001 `max` 8 with `[2000, 3000, 5000, 8000]`, `5008` with five longer
steps, `rotate_error_codes` `[5011, 5012, 4001, 5008]`, `ping_interval` 180000, `reset_endpoint` 600000); the server's values
win over the defaults whenever the login carries them, which it does. It also carries `chat_label.api.update_label_version: 2`
and `v2t.transcribe.enabled: true`, and no `task_setting` at all.

**The ping echo (L10).** A real ping is `2/1 {eventId: <number>}` and its echo is `2/1 {eventId: <number>}`, the id at the top of
the frame body: the supervisor's first reading. Closed.

**zCloud reads (Z6).** `getMyCloudUsage`, `getCloudUsage`, `getFamilyUsage` and both viewer keys were run live: all answer;
the family key is a separate pair of the same sizes; the family usage list is empty (no family plan). Closed.

**Todos.** The six todo writes and three reads answer `-69` because the web client's todo screens need
`settings.features.task_setting.enable`, and this account's login settings carry no `task_setting`. The request shapes are
from the web client and stay unverified here; another account may have the flag.

**New surface found by tracing the bundles (D5: build all but AI translate).**

| Endpoint | Result |
|---|---|
| `convlabel/manage/{add,update,delete,reorder}` | built (`label-add`, `label-update`, `label-delete`, `label-reorder`) and all four seen working live on a throwaway label; the account's settings say the web client uses exactly these (`update_label_version` 2) |
| `message/gif`, `group/gif` | built (`gif-send`, `gif-send-group`), seen working in the disposable group and in the Companion DM; the arguments are what the GIF picker's result carries |
| `friendboard/reorder` | built (`pin-reorder-1on1`), seen working on the Companion DM (two pins reordered, then removed) |
| `aifeatures/voice2text` | built (`voice-to-text`): the answer is only a request id; the text arrives as a `601` control `voice2text/convert_finish {req_id, err, text, url, has_more}` (the first real unknown action `unknown-acts.json` ever caught). `src/core/voice-text.js` keeps it in `voice-text.json` (both daemons, identically), and the local read `voice-transcript` returns it. Seen end to end |
| `conv/blocksharing/{getConvers,updateConvers}` | the list read answers; the write answers 829 "zBusiness accounts only" on this account |
| `recommendsv2/remove`, `read-requests` | alive, need a real suggestion or request (the `src` and `type` of a suggestion are the server's own `recommSrc` and `recommType` of the list item; `type` 1 is a suggestion, 2 an incoming request) |
| `oa/block`, `oa/unblock` | answered error 0 for a real Official Account (block, then unblock, on one the owner named); no profile, block-list or mini-profile read showed the flip, polled for three minutes (a friend block shows at once in the same read), so the effect could not be seen from the CLI. Tried on Skyline VMAC and Zalo Video (error 0, no flip) and on the system Zalo OA (error 112); only the account's own user id is accepted as `oaid` (the global id and username answer 114). The request is the web client's own; the account ended as it began. Zalo for Developers was tried again after the owner marked it "Quan tam" (interest) on the phone: the profile still showed `isFr` 0 and the block still changed nothing, so the profile reads do not carry the follow state, or it had not reached them. **Settled in Zalo Web the same day:** the web UI's own block on Zalo for Developers persists (after a reload the chat bar reads "unblock to send messages to this OA"); the CLI's `oa-block` does the same (Zalo Web, logged in afterwards, showed that bar and the line "cannot send, you blocked this OA" for a message sent after it), and the CLI's `oa-unblock` lifted a block made in the web (the next message went through). The request is byte-for-byte the web's shape (`{"oaid":"<19-digit user id>"}`, params only). The profile read is blind to it, and the send call still answers success, so only Zalo Web shows the state. The OA was left unblocked |
| `sync_action/media` | each list item is `{fromUid, destId, isGroup, cmi}`, sent when a photo or video is opened or a file downloaded; its effect is unobserved |
| `closefr/update`, `profile/mode` | no replacement exists; the web client's toggle is an empty function and the feature flag is off |

Closed as covered, dead code, or not worth a command: `sendpt`, `sharefile`, `sendmp3`, `voicemp3`, `upthumb`, the local GIF
chunk send (zca-js makes the same request), `photo_url` (a forward's shortcut), the video chunk uploads (the web composer
sends a local video as a file), `mediastore/remove`, `sticker/personalized/update`, the v1 variants, `action/query`, and the
legacy and reaction receipts and `subtab/seen` (the owner did not pick the receipts; the v2 forms are sent). Credential and
account flows, calls, E2EE, LAN friends, zBusiness and eKYC, and the zCloud calls that cost money or acknowledge onboarding are
out on purpose (S10, Z3).

**Closed by reading the web worker.** `promoteOrphanConversationRanges` is a state change of the web client's own range table
(ranges of the conversation list that await a message sync become message ranges); this client's ranges exist only once a
conversation list has named the partition, so there is nothing to promote (Y5d). The two `532` acks that got no answer in
the first live runs match the black-hole run: an ack sent while the network is gone gets no answer, is dropped after three
tries, and the server delivers the item again (Y10).

**What the sweep could not close alone.** The wiring of the connect-time pulls (515, 517, 518, 603 and the 564/577/537 requests) is a design choice with a risk to the account's queues, and four checks need the owner's phone or a second account (a login with auto sync and the kick-reason line that follows it, a full restore past the old session cap, the todo and friend-request writes, and a real Official Account for the block calls). They are named in the sweep's report to the owner.

## Connect-time pulls: what the Web client does, and what this client now does (v3.0, 2026-10-27)

The owner asked for the connect-time pulls (X4 to X6) to be wired. A trace of the Web client's code (modules named in the
local report) showed what they are, and the answer is not the same for all of them.

**What each one is.**

- **603** (the control queue, `603_0` and `603_1`): the controls the server held while the client was away: group and friend
  events, unread marks set on another device, a transcribed voice message, sync statuses. The Web client runs a pulled page
  through the same handler as a live `601` push, persists the cursor first, and acknowledges nothing. A read does not consume
  it: the server repeats from the cursor the client sends.
- **515, 517, 518**: the end-to-end encryption (Signal) queues. 515 carries 1-1 messages encrypted for the Web device (the
  twin of 510), 517 Signal session-control items, 518 delivery records about encrypted messages this device sent. Which
  queues a client pulls is decided by the server's handshake (`qCmds`, `ctrl_qCmds`, `bk_cmds`), not by constants. 515 and
  517 cannot be used without libsignal, and a client that pulls them and advances its cursor without decrypting loses the
  items; 518 is the only cursor-less queue and is deleted by an acknowledgement (`557` for 1-1, `558` for groups), so an
  unacknowledged page comes back on the next connect, and an acknowledged one is gone.
- **564**: the Signal key id. **577**: a request for the last-read position of conversations the local store shows as unread
  and for which the offline pull produced no `clearUnreads`; its reply only clears unread badges. **537**: the list of
  media already downloaded on another device, which the Web client uses to prefetch the same media.

**What was done.** A daemon pulls `603` on every connect, after the message queues, from the cursors it keeps
(`src/core/control-replay.js`, called by `src/core/self-heal.js`, so `listen` and `mcp start` do it identically and
`--no-self-heal` turns it off). Each page is handed to the listener as a `601` push: the frame's command is rewritten and
the bytes are emitted on the socket as a binary message (`ws` gives its `onmessage` consumers text unless told the frame
is binary, and zca-js ignores a non-Buffer; a test on the real zca-js listener caught that). zca-js then emits the same
`group_event` and `friend_event` it emits for a live push, and everything that reads `601` here (unread marks, transcripts,
the unknown-action collector, the cursor keeper) sees it. It never asks without a saved cursor (a first pull would replay
everything the server still holds), never acknowledges, and says when the server reports it dropped entries. The control
queue is given three times the message queues' wait: one cold answer was slower than ten seconds, live. Seen live on the test
account: eight real controls that arrived while the daemon was off (a group join, friend requests and their rejection, a
contact-tab mark, an emoji status) were replayed from the saved cursor and the cursor moved.

**What was not done, and why.** 515, 517, 518 and 564: they belong to the Signal stack, which is out of scope on purpose
(plan S10: no E2EE message endpoints), and pulling them without it can only lose data. 577: this client keeps a read
watermark per conversation, moved by the `clearUnreads` rows of the offline pages and by `sync`, not an unread count, so
there is no list to send. 537: a prefetch hint; media is fetched by the shared downloader. The builders stay in
`src/zalo/pulls.js` for a client that has the Signal stack. The builder for 537 now reads the cursor from `id` (the Web
client's field; it read `actionId`) and asks for 50 items, as the Web client does.

**The pin control, found by the replay.** The first real replay named an unhandled control, `pinned_convers/update` with data
`{tab, action, pinIds, ts}`. It is the live signal that a conversation was pinned or unpinned on another device. The Web client
reads `pinIds` as its own conversation ids (`g` + group id, or one letter + user id) and `action` 1 as a pin. It is now handled
with the unread marks (`src/core/read-state.js`, `pinMarksFrom`): `conv_state.pinned` follows it, and `listen` prints a `pin`
event. Before this a pin changed on the phone reached the cache only through `sync`.
