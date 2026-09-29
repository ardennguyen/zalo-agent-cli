# AGENTS.md — zalo-agent-cli Project Rules

Rules and context for any AI coding agent working in this repository (Claude Code/Cowork, Antigravity, Cursor, Codex, OpenClaw, …). This file is committed and is the **canonical** ruleset; `.agents/AGENTS.md` is gitignored and holds only machine-local overrides.

**`AGENTS.md`, `CLAUDE.md`, `.clinerules` and `.cursor/rules/project.mdc` are byte-identical copies of this text.** Each tool looks for its own filename and none of them reads the others, so the same rules have to exist under four names. Edit `AGENTS.md`, then copy it over the other three in the same commit — a pointer file was tried first and rejected, because a rule an agent has to follow a link to read is a rule it will skip. Verify with `sha256sum AGENTS.md CLAUDE.md .clinerules .cursor/rules/project.mdc`: four identical hashes, or the copies have drifted.

---

## 0. Non-negotiables

If you read nothing else, read these. Each is expanded in the section named.

1. **Run the full pre-commit gate before every commit** — `npm run format && npm run lint && npm run format:check && npm test`, all four green. → §6
2. **Every commit is immediately followed by a push.** → §7
3. **Never run `npm publish` by hand**; releases go through a GitHub Release + the publish workflow. → §8
4. **Never ask the user to run something you can run yourself.** The exception is a real Zalo network flow your sandbox can't reach (a QR scan on a phone) — then hand back one copy-pasteable command. → §5
5. **Back up gitignored files before any `git reset --hard` / `git checkout` / `git clean -fd`.** They do not survive. → §7
6. **Never put real credentials, user IDs, or phone numbers in tests or docs.** Offline tests import `tests/helpers/sandbox.js` first and assert `assertSandboxed(CONFIG_DIR)`. → §12
7. **In MCP mode stdout is the JSON-RPC transport.** Every diagnostic uses `console.error()`. → §4
8. **Re-read a file after writing it.** Concurrent agents work in this tree. → §5, §13
9. **`skill/references/command-reference.md` wins** when docs disagree; it is generated from `src/`. → §10
10. **Bilingual docs come in pairs.** Update both sides in the same change. → §3, §10

### Orientation — first commands in a new session

```bash
git branch --show-current      # v2.0-dev is the active major-version branch
git status --short             # another agent may have left uncommitted work
npm test                       # 988 offline tests, no Zalo session needed
```

Uncommitted work in the tree — including in the sibling `zalo-agent-cli-wiki` checkout — is normal and is probably a previous session's. Read it before overwriting it.

---

## 1. What this project is

`@ardennguyen/zalo-agent-cli` — a Node.js CLI that automates Zalo, plus an MCP (Model Context Protocol) server so AI agents can read and send Zalo messages.

Two completely separate API surfaces live in one binary:

| Surface | API | Auth | Credentials | Risk |
|---------|-----|------|-------------|------|
| Personal account (`msg`, `friend`, `group`, `listen`, `mcp`, …) | **Unofficial** ([zca-js](https://github.com/RFS-ADRENO/zca-js)) | QR login | `~/.zalo-agent-cli/` | Account can be banned |
| Official Account (`oa …`) | **Official** Zalo OA REST API v3.0 | OAuth 2.0 | `~/.zalo-agent/` (no `-cli` suffix) | None — sanctioned API |

Never conflate the two. They have different storage directories, different auth flows, and the unofficial-API disclaimer is deliberately suppressed for `oa` commands.

### Sibling repositories

Three repos live side by side under one parent folder (locally `F:\Coding\zalo-mcp\`):

- **`zalo-agent-cli`** (this repo) — the engine. All API logic, auth, CLI commands, and the MCP server source (`src/mcp/`).
- **`zalo-mcp`** ([github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)) — a thin deployment wrapper with **no engine code**. `mcp-server.js` just spawns `zalo-agent mcp start` and pipes stdio through, forwarding `--http`/`--auth` **only** (`--host` and `--config` are not forwarded — see §13). Its `package.json` pins `@ardennguyen/zalo-agent-cli` as a real npm dependency (currently `1.0.8`, while this repo is `2.0.0`), so the MCP tool surface it exposes is always exactly whatever `src/mcp/mcp-tools.js` registers **in the pinned version** — not what's on this branch. When the MCP tool list changes here, `zalo-mcp`'s pin and README must be updated too.
- **`zalo-agent-cli-wiki`** — the public GitHub wiki, cloned as a sibling folder. EN + VN page pairs.

---

## 2. Repository layout

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
│   │   └── gid.js        # opaque convId → real threadId mapping for non-friend DMs
│   ├── lock.js           # daemon.lock — one listen/db writer per account
│   └── live-store.js       # live socket events → rows (shared by listen, mcp, sync)
├── mcp/                  # MCP server
│   ├── mcp-tools.js      # SOURCE OF TRUTH for the MCP tool list
│   ├── mcp-server.js     # stdio transport
│   ├── mcp-http-transport.js  # Express + StreamableHTTP + bearer auth + /health
│   ├── mcp-config.js     # ~/.zalo-agent-cli/mcp-config.json defaults & merge
│   ├── message-buffer.js thread-filter.js thread-name-cache.js notifier.js
│   └── message-buffer.js thread-filter.js thread-name-cache.js notifier.js
└── utils/                # Pure helpers (bank BINs, proxy masking, QR, output, …)
skill/                    # Agent-facing skill (SKILL.md + references/ + evals/)
docs/official-account.md  # Full OA reference (Vietnamese)
patches/                  # patch-package patches against zca-js
tests/                    # Test suite — see tests/README.md
├── helpers/              # sandbox (temp HOME), CLI harness, target guard, live gates
├── unit/                 # Offline: accounts, credentials, lock, db, mcp-config, oa-client, pure helpers
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

## 3. Language

- All **English text** must use **American English (US)** spelling and conventions ("color" not "colour", "organize" not "organise"). Applies to docs, READMEs, commit messages, code comments, and agent responses.
- Vietnamese content in bilingual artifacts is preserved and correct — do **not** remove or "fix" it unless explicitly asked.
- Bilingual docs come in pairs (README VN/EN sections; wiki `Messages.md` ⇄ `Tin-Nhắn.md`). Update both sides of a pair in the same change.

---

## 4. Code style

Enforced by Prettier + ESLint — do not hand-format.

| Setting | Value |
|---------|-------|
| Module system | ESM (`"type": "module"`), `.js` extensions required in imports |
| Node | `>=22` (`engines`) |
| Indent / width | 4 spaces / 120 columns |
| Quotes / semicolons | Double quotes, semicolons on, trailing commas everywhere |
| Lint rules | `no-var`, `no-debugger`, `no-duplicate-imports` = error; `prefer-const`, `eqeqeq`, `no-unused-vars` (ignore `^_`) = warn |

Conventions to follow when adding code:

- Every command group file exports a single `register<Group>Commands(program)` and is wired in `src/index.js`.
- JSDoc every exported function.
- All output goes through `src/utils/output.js` (`success`/`error`/`warning`/`info`) so `--json` mode stays clean.
- **In MCP mode, stdout is the JSON-RPC transport.** Every diagnostic must use `console.error()`. `src/commands/mcp.js` reassigns `console.log` to `console.error` as a safety net — do not undo it.
- Never log proxy passwords, cookies, IMEI, or tokens. `maskProxy()` exists for this.

---

## 5. Development environment

This project is developed through AI coding agents — the user does not write code by hand.

- The agent is responsible for **all** development operations it can perform directly: `npm run format`, `npm run lint`, `npm test`, installing dependencies, debugging, editing files, and (with shell access) `git add`/`commit`/`push`.
- **Never ask the user to run a command the agent can run itself.**
- Exception: real Zalo network flows the agent's environment cannot reach (e.g. a sandboxed session with `*.zalo.me` egress blocked) may require the human to run one command or scan a QR on their phone. When that happens, say so explicitly and hand back a **single copy-pasteable command**, not a multi-step manual procedure.
- Multiple agent tools may work on this repo across sessions. Don't assume you're the only writer: re-check file state (`git status`, a fresh read) before trusting in-memory assumptions about what's on disk, especially after any step that took more than a few seconds. Re-read a file after writing it to confirm the write stuck.

### Windows shell traps that fail silently

Each of these reports success, or reports an error that names the wrong cause.
All were hit on 2026-09-28; none announce themselves.

- **Git Bash `kill` does not work on native Windows PIDs.** `kill -TERM` and
  `kill -0` both report success while the process keeps running. Use PowerShell
  `Stop-Process -Id <pid> -Force`. A `daemon.lock` PID is a number in a file, not
  proof of life — verify with `Get-Process`.
- **MSYS rewrites any argument starting with `/`.** A Zalo reaction code
  `/-strong` reached the API as `C:/Program Files/Git/-strong` and came back as
  error 114. Every reaction code starts with `/`, so set
  `MSYS2_ARG_CONV_EXCL="*"` for `msg react` and `msg send --react`.
- **Backslashes do not survive being written into a file through the shell.**
  `"F:\\Coding\\…"` landed as `"F:\Coding\…"`, which JS then read as escapes and
  stripped to `F:Codingzalo-mcp`. Use forward slashes; Windows accepts them. Same
  class: a regex written through `node -e` lost its backslash and `/^\d+$/`
  silently became `/^d+$/`. Write scripts to a file rather than `node -e` when
  they contain escapes.
- **PowerShell `Start-Process` does not inherit `$env:X` set in an earlier
  command**, and a process it starts may die when the session tears down. For a
  long-running daemon, `nohup … &` from Bash survived where `Start-Process` did
  not.
- **git reads `.gitattributes` from the working tree, not the checked-out
  commit.** An untracked copy on disk changes how files round-trip even on a
  branch whose commit does not contain it.

---

## 6. Pre-commit checklist (MANDATORY)

Before **every** commit, run and ensure all pass:

```bash
npm run format        # auto-fix prettier issues first
npm run lint          # must exit 0
npm run format:check  # must exit 0
npm test              # must exit 0
```

Do **not** commit if any of these fail. CI (`.github/workflows/ci.yml`) runs exactly these on Node 22 plus `node src/index.js --version` and `--help`.

While iterating, narrow the loop — but run the full gate before the commit:

```bash
npm run test:unit                        # tests/unit/ only
npm run test:cli                         # tests/cli/ only (drives the real binary)
node --test tests/unit/db.test.js        # one file
node --test --test-name-pattern="lock" tests/unit/lock.test.js   # one test
```

`npm test` never opens a socket and never reads the real `~/.zalo-agent-cli/`. The live suite (`npm run test:e2e`) is a separate, gated thing — see `tests/README.md`.

---

## 7. Git workflow

- **Always commit to `main` first**, then update the target branch to match:
  ```bash
  git checkout main
  git commit ...
  git push origin main
  git checkout <branch> && git reset --hard origin/main
  git push origin refs/heads/<branch> --force
  ```
- **Exception:** if the user explicitly says to commit to a beta/feature branch only, commit only to that branch.
- **Long-lived version branches** (e.g. `v2.0-dev`) are also an exception in practice: substantial work is committed directly to `v2.0-dev` across sessions without daily main-syncing. That is acceptable for an in-progress major version, but **confirm with the user before merging `v2.0-dev` into `main`** — that's a release decision, not a routine commit.
- Never leave `main` behind a feature branch once that branch is meant to ship.
- **Commits always come with pushes**: every `git commit` MUST be immediately followed by `git push`.
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `style:`, `docs:`, `build:`.
- Commits made by different AI agent tools may carry different (or no) co-author trailers — expected, not something to "fix" in history.

### More than one agent session in this checkout

Learned the expensive way on 2026-09-28/29, when six sessions shared this one
working tree with no isolation.

- **Give a new session its own git worktree.** Merging afterwards costs minutes;
  recovering work from a shared tree costs hours and depends on someone noticing.
- **Stage by explicit path. Never `git add -A` or `git add .`.** A shared file
  holds several sessions' hunks, and staging broadly commits someone's
  half-finished work under your message. This happened: a commit went out
  carrying 37 lines another session was still writing, and was only caught
  because that session spoke up.
- **Never `git stash`** — the stash stack is shared across worktrees and another
  session may pop yours. Use a temporary WIP commit instead.
- **`git checkout -- .` and `git reset --hard` destroy other sessions' work**, not
  just yours. Path-scope them or don't run them.
- **A session that finishes cannot always commit.** Three sessions in 24 hours
  completed green work and exited without committing, because the file they
  touched also held another session's unfinished change. If you inherit that:
  verify it stands alone (`node -c`, its own suite) and commit it with
  attribution to whoever wrote it. Snapshot first — `git diff` to a patch plus
  copies of untracked files, under `agent/work/`.
- **Before rebasing, check for a stale `.git/worktrees/<name>/rebase-merge/`.** One
  interrupted rebase makes every later attempt fail on the leftover state, and
  the error describes *that*, not what first went wrong.
- **`git diff --name-only` disagreeing with `git status --porcelain` is a signal**,
  not noise: something stateful is in play. Go looking.

### This file is now actually committed

It did not used to be. Until 2026-09-29 `.gitignore` listed `AGENTS.md`,
`CLAUDE.md` and `.agents/`, so the opening line's claim — "This file is
committed and is the **canonical** ruleset" — was false: every rule an agent
followed here, and every correction written into it, lived on one machine and
reached no clone, no CI and no reviewer. Two sessions updated the test-count
invariant in this file that same day and both edits were local-only.

`AGENTS.md` and `CLAUDE.md` are tracked from now on, so edits here are review-
able and travel with the repo. Write them as if a stranger will read them,
because now one can.

`.agents/` is still ignored, deliberately: it holds machine-local overrides and
absolute paths, which must not follow the repo to another machine.

### Before any destructive git operation

Before running ANY of `git reset --hard`, `git checkout <branch>`, `git clean -fd`:

1. **Read and save** the content of all local-only (gitignored) files first — `.agents/AGENTS.md`, `.env*`, anything under `agent/`.
2. Only proceed once that content is backed up or in context.
3. Restore them immediately afterward if they were deleted.

**Never assume gitignored files survive a `git reset --hard`.**

---

## 8. Release & publish

- All work is committed to `main` first.
- Release branches (`v1.x.x`) and tags are always **reset to `main`'s HEAD** — never cherry-pick from main to a release branch. Tag, branch, and `main` must point at the same commit:
  ```bash
  git checkout v1.x.x && git reset --hard origin/main
  git push origin refs/heads/v1.x.x --force
  git tag -d v1.x.x && git push origin :refs/tags/v1.x.x
  git tag v1.x.x && git push origin refs/tags/v1.x.x
  git checkout main
  ```
- A GitHub Release created from the tag triggers `.github/workflows/publish.yml`, which publishes `@ardennguyen/zalo-agent-cli` with `--provenance`. `NPM_TOKEN` is a **repository secret**.
- **Never run `npm publish` manually.**

---

## 9. Deployment (`V:\zalo_mcp` and other `zalo-mcp` installs)

- **Never** run `npm install` directly in a deployed `zalo-mcp` folder.
- Only use `.\zalo-mcp.ps1 update` (Windows) or `bash zalo-mcp.sh update` (Linux/macOS).
- Before using the setup scripts, pull the latest from **`ardennguyen/zalo-mcp`** on GitHub — *not* the original PhucMPham repo, *not* npm.
- The scripts install `zalo-agent-cli` from `github:ardennguyen/zalo-agent-cli`.

---

## 10. Documentation map — keep in sync with code changes

`skill/references/command-reference.md` is the **authoritative, exhaustive** CLI reference, generated by reading `src/` directly. When any other doc disagrees with it, that doc is wrong.

| File | Purpose | Update when |
|------|---------|-------------|
| `README.md` (bilingual VN/EN) | Top-level pitch, quick start, command-group table | A command group is added/removed, or a headline feature ships |
| `INSTALLATION.md` | End-user deployment: the `zalo-mcp` wrapper install/update flow, MCP client config, OA setup | Install/update flow, MCP transport flags, or config keys change |
| `tests/README.md` | How to run and write the tests: offline suite, tiered live E2E, manual checklist | A suite is added/moved, a gate changes, the test count changes, or a new manual check is needed |
| `agent/work/transfer-sync-v2/NOTES.md` | Measured findings: known defects, upstream issues, environment gotchas | New command, new module, or new manually-verifiable behavior |
| `agent/work/transfer-sync-v2/HANDOFF.md` | Current state of the mobile-sync investigation — what works, what's open | The sync picture changes (referenced from `CLAUDE.md`) |
| `agent/work/transfer-sync-v2/FINDINGS.md` | The measured transfer-sync-v2 protocol (frames, rounds, decrypt chain) | A protocol detail is newly measured or corrected |
| `docs/official-account.md` (VN) | Full OA command reference | Any `oa …` command or flag changes |
| `skill/SKILL.md` | Agent-facing quick reference + constraints + security model | Any user-visible command surface change |
| `skill/references/command-reference.md` | Exhaustive CLI reference (**source of truth**) | Any command, subcommand, flag, or default changes |
| `skill/references/mcp-guide.md` (VN) | MCP tools, config, architecture | `src/mcp/mcp-tools.js` or `mcp-config.js` changes |
| `skill/references/oa-command-reference.md` (EN) | OA quick reference for agents | Any `oa …` change |
| `skill/references/login-flow.md`, `listen-mode-guide.md` | Login methods; listener/webhook operation | Login or listener behavior changes |
| `skill/evals/eval-scenarios.md` | Skill eval scenarios | The skill's expected behavior changes |
| `zalo-agent-cli-wiki/*.md` | Public GitHub wiki, EN + VN page pairs | A command's behavior changes — **update the matching pair together** |
| `CLAUDE.md`, `.clinerules`, `.cursor/rules/project.mdc` | Per-tool entry points — **byte-identical copies of `AGENTS.md`** | **Anything in this file changes** — copy it over all three in the same commit |

Those three are not summaries and not pointers: they are this file, under the
names Claude Code, Cline and Cursor each look for. Edit `AGENTS.md` and copy:

```bash
for f in CLAUDE.md .clinerules .cursor/rules/project.mdc; do cp AGENTS.md "$f"; done
sha256sum AGENTS.md CLAUDE.md .clinerules .cursor/rules/project.mdc
```

Four identical hashes or they have drifted. Do not hand-edit the copies — a
change made in one of them is invisible to every other tool and will be
overwritten by the next sync.

### Numbers that appear across many docs — verify before you change one

These are repeated in README, SKILL.md, the wiki, and INSTALLATION.md. Changing the code behind any of them means changing every doc that quotes it. Verify, don't assume:

| Invariant | Current | Source of truth | How to check |
|---|---|---|---|
| CLI commands | **178** | `src/commands/` | `tests/cli/surface.test.js` `COMMAND_SURFACE` + `OA_SUBGROUPS` + `TOP_LEVEL` |
| Command groups | **16** | `src/index.js` | the `register*Commands` calls |
| MCP tools | **7** | `src/mcp/mcp-tools.js` | `grep -c 'server.registerTool' src/mcp/mcp-tools.js` |
| OA commands | **32** | `src/commands/oa.js` | `OA_SUBGROUPS` in the surface test |
| Offline tests | **1305** as of 2026-09-29 (1301 pass, 4 skipped, 0 fail) | `npm test` | the run's own summary line — this is a snapshot, not a contract; re-measure rather than trusting it |

**The MCP tool list in every doc must match `src/mcp/mcp-tools.js`.** This has drifted before (docs claimed 4 tools when the code registered 7). The 7 are: `zalo_get_messages`, `zalo_send_message`, `zalo_list_threads`, `zalo_search_threads`, `zalo_mark_read`, `zalo_get_history`, `zalo_view_media`.

`tests/cli/surface.test.js` is the **machine-checkable twin** of `skill/references/command-reference.md`. A new subcommand fails that suite until the manifest is updated — which is the cue to walk this table.

### Wiki page pairs

Every wiki page has an EN and a VN twin. Update both in the same change:

| EN | VN |
|----|----|
| `Home.md` | `Tiếng-Việt.md` (+ `Home.md` carries both) |
| `Login-&-Logout.md` | `Đăng-Nhập-&-Đăng-Xuất.md` |
| `Messages.md` | `Tin-Nhắn.md` |
| `Friends.md` | `Bạn-Bè.md` |
| `Groups.md` | `Nhóm.md` |
| `Conversations.md` | `Hội-Thoại.md` |
| `Accounts.md` | `Tài-Khoản.md` |
| `Profile.md` | `Hồ-Sơ.md` |
| `Polls.md` | `Khảo-Sát.md` |
| `Reminders.md` | `Nhắc-Nhở.md` |
| `Auto-Reply.md` | `Trả-Lời-Tự-Động.md` |
| `Quick-Messages.md` | `Tin-Nhắn-Nhanh.md` |
| `Labels.md` | `Nhãn.md` |
| `Catalog.md` | `zBusiness.md` |
| `Listener.md` | `Lắng-Nghe.md` |
| `Local-Cache-&-Sync.md` | `Bộ-Nhớ-Đệm-&-Đồng-Bộ.md` |
| `MCP-Server.md` | `MCP-Server-(VN).md` |
| `Official-Account.md` | `Official-Account-(VN).md` |
| `Multi-Account-&-Proxy.md` | `Đa-Tài-Khoản-&-Proxy.md` |
| `Bank-Card-&-QR-Payments.md` | `Thẻ-Chuyển-Khoản-&-QR.md` |
| `VPS-Setup.md` | `Cài-Đặt-VPS.md` |
| `Security.md` | `Bảo-Mật.md` |

`_Sidebar.md` lists both languages and must gain a row when a page is added.

When you ship a feature (new command, changed behavior, new MCP tool), check whether it needs a line in each of the above. Most defects in this doc set have been small drifts — a stale tool count, a renamed field, a missing subcommand — not wholesale rewrites.

---

## 11. Agent artifacts

- Save long-form project documentation, implementation plans, and important artifacts to the project directory, **not** an agent's default `brain` directory.
  - **Markdown** (reports, plans, guides, release notes, walkthroughs) → `agent/docs/`
  - **Generated code, scripts, media, QR codes, images** → `agent/work/`
  - **Temporary scratch scripts** → the session scratch directory only
- `agent/` and its subfolders are gitignored and created on demand — create them if they don't exist.
- When a document covers **both** `zalo-agent-cli` and `zalo-mcp`, copy it into `agent/docs/` in both project folders.
- Use descriptive filenames when copying docs that would otherwise collide (`walkthrough_deployment.md`, not `walkthrough.md`).

---

## 12. Research, planning & testing workflow

- **Research first.** Before writing complex features or integrating new Zalo endpoints, use a research sub-agent or scratch scripts in `agent/work/` to verify the logic against the real API.
- **Test before commit.** Write comprehensive test scripts (SQLite locking, duplicate handling, sort order) before declaring a phase complete.
- **Approval checkpoints.** For large architectural changes, produce an `implementation_plan.md` using GitHub alerts to highlight breaking changes, and wait for user approval before modifying source.
- **Break down tasks.** For edge cases spanning large volumes of code (cross-device sync gaps, reconnect behavior), test them in isolation via sub-agents and feed results back.

### Testing rules

- Test framework is the Node built-in runner (`node:test` + `node:assert/strict`) — no external framework.
- **New tests go under `tests/`**: `tests/unit/` for pure logic and filesystem work, `tests/cli/` for tests that drive the binary, `tests/e2e/` for anything needing a live session. Pre-existing suites still sit next to their module (`src/utils/bank-helpers.test.js`, `src/mcp/*.test.js`) and stay there; `npm test` globs both locations.
- **Never** use real credentials, user IDs, or phone numbers in tests. Offline tests import `tests/helpers/sandbox.js` **first** (it redirects `USERPROFILE`/`HOME` before `credentials.js` freezes `CONFIG_DIR`) and assert `assertSandboxed(CONFIG_DIR)`. Real thread ids for the live suite live only in gitignored `tests/targets.json`.
- The live suite may only write to ids blessed as disposable in `tests/targets.json`; every write helper calls `assertDisposable()` first. Destructive tiers are behind additive env gates — see `tests/README.md`.
- Anything needing a live Zalo session belongs in the tiered live suite under `tests/e2e/` (gated behind `ZALO_TEST_LIVE=1`, never reachable from `npm test`), or in the manual checklist in `tests/README.md`.

---

## 13. Known risks

- **Shared parent folder.** `zalo-agent-cli`, `zalo-mcp`, and `zalo-agent-cli-wiki` are siblings under one parent, and `zalo-mcp` depends on the published CLI. A file-content anomaly was observed once (2026-09-18) where `zalo-agent-cli/package.json` briefly reverted to a state matching the older pinned version; git history was confirmed clean, so it wasn't a checkout/reset. Cause unidentified — **verify a write actually stuck (re-read the file) after any edit in this folder tree**, especially when another agent or process may be running concurrently.
  - **Rule out the mundane causes first, and ask the user rather than guessing.** Two concrete instances were traced during the 2026-09-19 test-suite work, and neither was mysterious: (a) `tests/fixtures/document.pdf` was rewritten in place by an installed PDF handler, turning a hand-written 453-byte PDF 1.4 into a 4674-byte linearized PDF 1.6; (b) credential files under the test home were owned by `BUILTIN\Administrators` and undeletable, because `zalo-agent login` had been run from an **elevated** PowerShell — confirmed by the user, after the agent had initially attributed it to something vaguer. Before recording an anomaly as "cause unidentified", check file ownership/ACLs (`Get-Acl`), whether an external handler or editor touched the file, and whether the command was run elevated — then ask.
- **Never run `zalo-agent login` from an elevated shell.** Nothing in this tool needs elevation, and doing so leaves credential files owned by `BUILTIN\Administrators`. An unelevated session can then read and rewrite them but not delete them, so `logout --purge` and `account remove` fail with `EPERM` while everything else appears fine. See the environment-gotcha section in [agent/work/transfer-sync-v2/NOTES.md](agent/work/transfer-sync-v2/NOTES.md) for diagnosis and recovery.
- **Line endings are pinned by `.gitattributes` — never work around it.** Git's system config on this machine sets `core.autocrlf=true`. `.gitattributes` (added 2026-09-28, `69b2793`) marks `tests/fixtures/** -text` because those files are compared byte-for-byte against the SHA-256 table in `tests/fixtures/index.js`, and normalizes everything else to LF so `npm run format` stops reporting ~115 files as modified with no content change. Two non-obvious consequences:
  - **Never "fix" a mangled fixture with `git add --renormalize .` or a broad `git add`.** Under `-text` that *stages the corruption* — `notes.txt` at 367 bytes instead of 358, `data.csv` at 152 instead of 149 — and breaks CI for everyone, since CI runs on Linux where the bytes were always correct. Restore instead with `rm tests/fixtures/notes.txt tests/fixtures/data.csv && git checkout -- tests/fixtures/`, then confirm with `node --test tests/unit/image-metadata.test.js`. There is no renormalization sweep owed: every tracked text blob is already stored LF, so `--renormalize` on a correct tree stages nothing.
  - **Git reads `.gitattributes` from the working tree, not from the commit you have checked out.** A stray untracked copy on a branch cut before `69b2793` puts `-text` in force *there*, so CRLF fixture copies become a real difference against the LF blobs and `git rebase` aborts with "cannot rebase: You have unstaged changes" naming only those two files. Rebasing onto `69b2793` is otherwise fine — do not adopt a "merge, never rebase" rule. Pre-flight such a branch with: `git status --porcelain` empty, no untracked `.gitattributes` in the worktree, and `git rebase --abort` first if an earlier attempt died (a leftover `rebase-merge/` directory masks the original error with a stale one). Avoid `--autostash`: the stash stack is shared across worktrees and other sessions.
- **One WebSocket per account.** `listen`, `mcp start`, `sync-mobile`, and a browser Zalo Web session cannot coexist on the same account. A duplicate session closes the connection with code 3000 and is fatal by design.
- **One db writer per account.** `daemon.lock` enforces this. `account remove` and `logout --purge` refuse while a `listen` daemon holds the lock.
- **One WebSocket per account, including for uploads and for `sync`.** A non-inline attachment can only be sent over a socket, so `msg send-file`/`send-image` used to open their own — and Zalo evicted the running daemon (cmd 3000), losing every message that arrived during its ~6s reconnect. The `sync` socket stages had the same collision and a worse workaround: they were skipped outright while a daemon ran, so closing a coverage gap meant stop → sync → restart, and the stop/restart opened a fresh ~70s hole with no repair path. A daemon now publishes `daemon-channel.json` and does both jobs on its own socket: `POST /send-attachments` for uploads, and `POST /sync/messages` / `POST /sync/reactions`, which stream NDJSON progress back so the CLI prints the run as it happens. Callers fall back to their own socket only when **no** daemon is up. Never add a code path that opens a second listener without checking that file — `tests/unit/sync-socket-rules.test.js` fails the build when a `run*` command in `sync.js` calls `connectListener` without first calling `getDaemonChannel`.
  - **Keep `src/core/daemon-channel.js` a transport.** The stage bodies live in `src/core/daemon-sync.js` and are injected as `runners`, because `src/commands/msg.js` imports the channel at the top level for `sendViaDaemon` — importing SyncV2 there would put the libzproto decrypt stack, the CDN asset fetcher and the sqlite writes into every `msg` invocation. `tests/unit/daemon-channel.test.js` enforces that the channel imports nothing but node builtins.
  - **A daemon-routed sync still taps the phone.** Routing removes the second WebSocket, not the confirmation, and the daemon must never start a stage on its own — same rule as the "Why the daemon does not self-heal" note in `src/commands/listen.js`.
- **Unofficial API.** zca-js tracks a moving target. `patches/` contains patch-package patches against it; regenerate them when bumping `zca-js`.
- **Two different media directories — do not "unify" them in docs.** There are two downloaders and they write to different places:

  | Module | Used by | Destination | Filename |
  |---|---|---|---|
  | `src/core/sync-v2/media.js` | `listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile --transfer` | `~/.zalo-agent-cli/accounts/<ownId>/media/<conversation>/` | `<date>-<HH-mm>_<msgIdTail>_<kind>.<ext>` |

  One downloader, one layout. The two earlier ones (`src/core/media-downloader.js`,
  `src/mcp/media-downloader.js`) filed the same conversation under three
  different folder names depending on which command fetched it, and both are
  now deleted. `mcp-config.json`'s `media.downloadDir` still overrides the
  root for the MCP server only.
  | `src/core/sync-v2/media.js` | `sync-media` | `~/.zalo-agent-cli/accounts/<ownId>/media/<threadName>/` | `<date>_<time>_<msgId>_<name>.<ext>` |

  The MCP path is **account-agnostic** (`CONFIG_DIR/media`, not under `accounts/<ownId>/`), which is why `mcp-config.json`'s `media.downloadDir` default is `~/.zalo-agent-cli/media/`. Docs have repeatedly flattened these into one per-account path; that is wrong for MCP.
- **MCP-downloaded media survives a purge — an open privacy gap.** `wipeAccountDir()` (`src/core/accounts.js`) removes only `CONFIG_DIR/accounts/<ownId>`, so `logout --purge`, `logout --delete-history`, and `account remove` all leave `CONFIG_DIR/media/` — real message attachments — on disk. Documented as a warning in `Security.md` / `Bảo-Mật.md` and `INSTALLATION.md`; **not** fixed in code. If you touch the purge path, this is the thing to fix.
- **`zalo-mcp` is a partial pass-through, not a total one.** Its `mcp-server.js` forwards only `--http` and `--auth`. `--host` and `--config` are **not** forwarded, so a wrapper user cannot bind `0.0.0.0` or point at a custom config through it — they must invoke `zalo-agent mcp start` directly. The *tool surface* is identical; the *flag surface* is not. Say "the tool list is identical", never "it's a pass-through", without that qualifier.
- **`zalo-mcp`'s dependency pin drifts.** It currently pins `@ardennguyen/zalo-agent-cli@1.0.8` while this repo is at `2.0.0`. Whatever the pin says is what a deployed wrapper actually serves, so an MCP tool added here is not reachable through `zalo-mcp` until that pin is bumped and released. Check the pin before claiming a new tool is available to wrapper users.
