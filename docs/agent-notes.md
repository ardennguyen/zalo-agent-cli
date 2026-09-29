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
| Offline tests | **1371** as of 2026-09-29 (1367 pass, 4 skipped, 0 fail) | `npm test` | the run's own summary line |

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
