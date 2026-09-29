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
├── accounts.json                 # Registry (0600)
├── credentials/cred_<ownId>.json # Session credentials (0600)
├── mcp-config.json               # Optional MCP config
├── accounts/<ownId>/
│   ├── zalo.db                   # SQLite cache (messages, threads, contacts, sync_state, sync_gaps)
│   ├── media/                    # Auto-downloaded attachments
│   ├── sync/                     # RSA sync keys
│   ├── daemon.lock               # Held by a running `listen` daemon or `mcp start`
│   └── daemon-channel.json       # Loopback port + token of that daemon's upload channel (0600)
└── qr.png
```

---

## Numbers repeated across docs — sources and check commands (§10)

| Invariant | Current | Source of truth | How to check |
|---|---|---|---|
| CLI commands | **184** invokable leaves (152 personal + 32 OA) | the live commander tree | walk it (see below) — counting strings in `tests/cli/surface.test.js` gives the wrong answer |
| Command groups | **16** | `src/index.js` | the `register*Commands` calls |
| MCP tools | **7** | `src/mcp/mcp-tools.js` | `grep -c 'server.registerTool' src/mcp/mcp-tools.js` |
| OA commands | **32** | `src/commands/oa.js` | `OA_SUBGROUPS` in the surface test |
| Offline tests | **1388** as of 2026-09-29 (1384 pass, 4 skipped, 0 fail) | `npm test` | the run's own summary line |

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
guessing those names silently drops OA's 32 commands and MCP's 1. Load each into
a fresh `Command`, walk it, count nodes with no children, and add the inline
top-level commands found by scanning `src/index.js` for `.command("...")`.

Measured at `a719c99` (2026-09-29): **184 leaves, 21 containers, 205 nodes**.
By group: group 33, oa 32, friend 22, msg 18, conv 16, top-level 12, profile 11,
catalog 9, account 7, poll 7, reminder 6, auto-reply 4, quick-msg 4, label 2,
mcp 1. A separate audit confirmed zero drift between that live tree and the
manifest in `tests/cli/surface.test.js`, in both directions, so the manifest is
trustworthy as the *contract* even though counting its string literals is not
how you get the number.

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
`@ardennguyen/zalo-agent-cli` with `--provenance`. `NPM_TOKEN` is a repository secret. Never run
`npm publish` manually.

---

## Why the patched zca-js is bundled, not patched on install (§13)

We patch zca-js to add `logoutV2`, `pullMobileMsg`, `getCrossDB` and `deleteSnapshotMobileMsg`, and
to modify `loginQR` and `sendMessage`. Without them `logout` and `account remove` die on
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
  node_modules/zca-js` — but the install still exits 0, so the patch silently did nothing and the
  four methods were simply absent at runtime.

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
`pullMobileMsg`, `getCrossDB`, `deleteSnapshotMobileMsg`, every client-id stamp, and the
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
- `.github/workflows/publish.yml` is `npm ci` then `npm publish --access public --provenance` —
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
daemon must never start a stage on its own — the same rule as the "Why the daemon does not
self-heal" note in `src/commands/listen.js`.

### One media downloader

There used to be three folder layouts for the same conversation, depending on which command
fetched it. `src/core/media-downloader.js` and `src/mcp/media-downloader.js` are both deleted;
`src/core/sync-v2/media.js` is the only downloader left, and everything routes through it —
`listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile --transfer`, and the MCP tools.

Destination is `<accountDir>/media/<threadId>/` with filenames
`<YYYY-MM-DD-HH-mm>_<msgIdTail>[_n]_<name>.<ext>` (`destPath()` in that module).
`mcp-config.json`'s `media.downloadDir` is passed as `mediaRoot` and overrides the root for the MCP
server only; when it is null, `mcp-tools.js` passes `undefined` and the module falls through to
`resolve(accountDir, "media")` — the same per-account path as everything else. The
`// default: ~/.zalo-agent-cli/media/` comment in `mcp-config.js` is stale and describes the old
account-agnostic MCP downloader that no longer exists.

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

### `zalo-mcp`: partial pass-through, drifting pin

`zalo-mcp/mcp-server.js` forwards only `--http` and `--auth`. `--host` and `--config` are not
forwarded, so a wrapper user cannot bind `0.0.0.0` or point at a custom config through it; they must
invoke `zalo-agent mcp start` directly. The tool surface is identical; the flag surface is not.

Its `package.json` pins `@ardennguyen/zalo-agent-cli` as a real npm dependency — currently `1.0.8`,
while this repo is at `2.0.0`. Whatever the pin says is what a deployed wrapper actually serves, so
an MCP tool added here is not reachable through `zalo-mcp` until that pin is bumped and released.
When the MCP tool list changes here, `zalo-mcp`'s pin and README must be updated too.


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
