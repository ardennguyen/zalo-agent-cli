# AGENTS.md — zalo-agent-cli Project Rules

Rules for any AI coding agent working in this repository (Claude Code/Cowork, Antigravity, Cursor, Cline, Codex, …). This file is committed and **canonical**; `.agents/` is gitignored and holds only machine-local overrides, which must not follow the repo to another machine.

**`AGENTS.md`, `CLAUDE.md`, `.clinerules` and `.cursor/rules/project.mdc` are byte-identical copies of this text.** Each tool reads only its own filename, so the rules must exist under four names. Edit `AGENTS.md`, copy it over the other three in the same commit, and never hand-edit a copy — that change is invisible to every other tool and the next sync overwrites it.

**Hard size budget: keep this file under 24,000 bytes.** Google Antigravity silently truncates any single rule file past that — no warning, no marker; the tail never reaches the model. At 36,358 bytes (2026-09-29) it was cutting §11–§13 off every Antigravity session. So this file carries **rules**; background, incident diagnoses and lookup tables go to [`docs/agent-notes.md`](docs/agent-notes.md), which has no limit.

```bash
for f in CLAUDE.md .clinerules .cursor/rules/project.mdc; do cp AGENTS.md "$f"; done
wc -c AGENTS.md   # must be < 24000
sha256sum AGENTS.md CLAUDE.md .clinerules .cursor/rules/project.mdc   # four identical hashes
```

---

## 0. Non-negotiables

If you read nothing else, read these. Each is expanded in the section named.

1. **Run the full pre-commit gate before every commit** — `npm run format && npm run lint && npm run format:check && npm test`, all four green. → §6
2. **Every commit is immediately followed by a push.** → §7
3. **Never run `npm publish` by hand**; releases go through a GitHub Release + the publish workflow. → §8
4. **Never ask the user to run something you can run yourself**, except a Zalo network flow your sandbox can't reach — then hand back one copy-pasteable command. → §5
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
npm test                       # offline suite, no Zalo session needed
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

Never conflate the two: different storage directories, different auth flows, and the unofficial-API disclaimer is deliberately suppressed for `oa` commands.

Three repos sit side by side under one parent folder (locally `F:/Coding/zalo-mcp/`): **`zalo-agent-cli`** (this repo — the engine), **`zalo-mcp`** (a thin wrapper with no engine code that spawns `zalo-agent mcp start`; it pins a *published* version of this package, so it serves that pin, not this branch — §13), and **`zalo-agent-cli-wiki`** (the public wiki, EN + VN page pairs).

---

## 2. Repository layout

Annotated `src/` tree and the per-account runtime storage layout: [`docs/agent-notes.md`](docs/agent-notes.md). The parts you cannot guess from a directory listing:

- `src/index.js` — Commander entry point; every command group file exports one `register<X>Commands(program)` and is wired here.
- `src/core/sync-v2/` — transfer-sync-v2, the **real** phone-backed history restore (socket cmd 590/591). `src/core/sync.js` is the *older* SyncManager (socket backfill, gap tracking, freshness debounce) — not the same thing. `sync-v2/media.js` is the **only** media downloader (§13).
- `src/core/daemon-channel.js` — loopback transport to a running daemon; `daemon-sync.js` holds the stage bodies it injects (§13). `lock.js` is `daemon.lock`, one listen/db writer per account. `src/mcp/mcp-tools.js` is the **source of truth** for the MCP tool list.
- `tests/unit/` and `tests/cli/` are offline; `tests/e2e/` is live and tiered 1–5 by blast radius behind `ZALO_TEST_LIVE=1`; `targets.json` is gitignored. See `tests/README.md`.
- Runtime state: `~/.zalo-agent-cli/` (registry + credentials at 0600), per account `accounts/<ownId>/` (`zalo.db`, `media/`, `sync/`, `daemon.lock`, `daemon-channel.json`).

---

## 3. Language

- All **English text** uses **American English (US)** spelling ("color" not "colour", "organize" not "organise") — docs, READMEs, commit messages, code comments, and agent responses.
- Vietnamese content in bilingual artifacts is correct as written — do **not** remove or "fix" it unless explicitly asked.
- Bilingual docs come in pairs (README VN/EN sections; wiki `Messages.md` ⇄ `Tin-Nhắn.md`). Update both sides in the same change.

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

- JSDoc every exported function.
- All output goes through `src/utils/output.js` (`success`/`error`/`warning`/`info`) so `--json` stays clean.
- **In MCP mode stdout is the JSON-RPC transport.** Every diagnostic must use `console.error()`. `src/commands/mcp.js` reassigns `console.log` to `console.error` as a safety net — do not undo it.
- Never log proxy passwords, cookies, IMEI, or tokens. `maskProxy()` exists for this.

---

## 5. Development environment

This project is developed through AI coding agents — the user does not write code by hand.

- The agent does **all** development operations it can perform directly: `npm run format`, `npm run lint`, `npm test`, installing dependencies, debugging, editing files, and (with shell access) `git add`/`commit`/`push`. **Never ask the user to run a command the agent can run itself.** The one exception is a real Zalo network flow the agent's environment cannot reach (e.g. `*.zalo.me` egress blocked, or a QR scan): say so explicitly and hand back a **single copy-pasteable command**, not a multi-step procedure.
- Multiple agent tools work on this repo across sessions. Re-check file state (`git status`, a fresh read) before trusting in-memory assumptions about what's on disk, and re-read a file after writing it.

### Windows shell traps that fail silently

Each reports success, or reports an error naming the wrong cause.

- **Git Bash `kill` does not work on native Windows PIDs** — `kill -TERM` and `kill -0` both report success while the process runs on. Use `Stop-Process -Id <pid> -Force`; a `daemon.lock` PID is a number in a file, not proof of life, so verify with `Get-Process`.
- **MSYS rewrites any argument starting with `/`** — the reaction code `/-strong` arrived as `C:/Program Files/Git/-strong` (error 114). Every reaction code starts with `/`, so set `MSYS2_ARG_CONV_EXCL="*"` for `msg react` and `msg send --react`.
- **Backslashes do not survive being written into a file through the shell** — `F:\\Coding\\…` collapsed to `F:Codingzalo-mcp`, and a regex passed through `node -e` silently lost its `\d`. Use forward slashes, and write scripts to a file rather than `node -e` when they contain escapes.
- **PowerShell `Start-Process` does not inherit `$env:X` set in an earlier command**, and its child may die when the session tears down. For a long-running daemon, `nohup … &` from Bash survived where `Start-Process` did not.
- **git reads `.gitattributes` from the working tree, not the checked-out commit** (§13).

---

## 6. Pre-commit checklist (MANDATORY)

Before **every** commit, run and ensure all pass:

```bash
npm run format        # auto-fix prettier issues first
npm run lint          # must exit 0
npm run format:check  # must exit 0
npm test              # must exit 0
```

Do **not** commit if any fail. CI (`.github/workflows/ci.yml`) runs exactly these on Node 22 plus `node src/index.js --version` and `--help`. While iterating, narrow the loop (`npm run test:unit`, `npm run test:cli`, `node --test <file>`, `--test-name-pattern=`) — but run the full gate before the commit. `npm test` never opens a socket and never reads the real `~/.zalo-agent-cli/`; the live suite (`npm run test:e2e`) is separate and gated.

---

## 7. Git workflow

- **Always commit to `main` first**, then update the target branch to match:
  ```bash
  git checkout main && git commit ... && git push origin main
  git checkout <branch> && git reset --hard origin/main
  git push origin refs/heads/<branch> --force
  ```
- **Exceptions:** commit only to a beta/feature branch when the user explicitly says so; and **long-lived version branches** (e.g. `v2.0-dev`) do take substantial work committed directly across sessions — that is fine for an in-progress major version, but **confirm with the user before merging `v2.0-dev` into `main`**, which is a release decision, not a routine commit.
- Never leave `main` behind a feature branch once that branch is meant to ship.
- **Every `git commit` MUST be immediately followed by `git push`.**
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `style:`, `docs:`, `build:`. Different agent tools may write different (or no) co-author trailers — expected, not something to "fix" in history.

### More than one agent session in this checkout

Learned the expensive way on 2026-09-28/29, when six sessions shared one working tree. Details in [`docs/agent-notes.md`](docs/agent-notes.md).

- **Give a new session its own git worktree.** Merging afterwards costs minutes; recovering work from a shared tree costs hours and depends on someone noticing.
- **Stage by explicit path. Never `git add -A` or `git add .`** — a shared file holds several sessions' hunks, and staging broadly commits someone's half-finished work under your message. This has happened.
- **Never `git stash`** (nor `git rebase --autostash`) — the stash stack is shared across worktrees and another session may pop yours. Use a temporary WIP commit.
- **`git checkout -- .` and `git reset --hard` destroy other sessions' work**, not just yours. Path-scope them or don't run them.
- **A session that finishes cannot always commit.** If you inherit orphaned green work, verify it stands alone (`node -c`, its own suite) and commit it attributed to whoever wrote it — snapshotting first to `agent/work/`.
- **Before rebasing, check for a stale `.git/worktrees/<name>/rebase-merge/`** — one interrupted rebase makes every later attempt fail on leftover state, and the error describes *that*, not what first went wrong. `git rebase --abort` clears it.
- **`git diff --name-only` disagreeing with `git status --porcelain` is a signal**, not noise. Go looking.

### Before any destructive git operation

Before ANY of `git reset --hard`, `git checkout <branch>`, `git clean -fd`: read and save the content of all local-only (gitignored) files first — `.agents/`, `.env*`, anything under `agent/` — proceed only once that is backed up or in context, and restore it immediately afterward. **Never assume gitignored files survive a `git reset --hard`.**

---

## 8. Release & publish

- All work is committed to `main` first.
- Release branches (`v1.x.x`) and tags are always **reset to `main`'s HEAD** — never cherry-pick from main to a release branch. Tag, branch and `main` must end up at the same commit; the exact reset-and-retag sequence is in [`docs/agent-notes.md`](docs/agent-notes.md).
- A GitHub Release created from the tag triggers `.github/workflows/publish.yml`, which publishes with `--provenance`. `NPM_TOKEN` is a **repository secret**.
- **Never run `npm publish` manually.**

---

## 9. Deployment (`V:/zalo_mcp` and other `zalo-mcp` installs)

- **Never** run `npm install` directly in a deployed `zalo-mcp` folder — only `zalo-mcp.ps1 update` (Windows) or `bash zalo-mcp.sh update` (Linux/macOS).
- Before using the setup scripts, pull the latest from **`ardennguyen/zalo-mcp`** on GitHub — *not* the original PhucMPham repo, *not* npm. The scripts install `zalo-agent-cli` from `github:ardennguyen/zalo-agent-cli`.

---

## 10. Documentation map — keep in sync with code changes

`skill/references/command-reference.md` is the **authoritative, exhaustive** CLI reference, generated by reading `src/` directly. When any other doc disagrees with it, that doc is wrong.

| File | Update when |
|------|-------------|
| `skill/references/command-reference.md` | Any command, subcommand, flag or default (**source of truth**) |
| `skill/SKILL.md` | Any user-visible command surface change |
| `skill/references/mcp-guide.md` (VN), `login-flow.md`, `listen-mode-guide.md`, `skill/evals/eval-scenarios.md` | The matching MCP / login / listener / skill behavior changes |
| `skill/references/oa-command-reference.md` (EN), `docs/official-account.md` (VN) | Any `oa …` change |
| `README.md` (VN/EN) | A command group is added/removed, or a headline feature ships |
| `INSTALLATION.md` | Install/update flow, MCP transport flags, or config keys |
| `tests/README.md` | A suite moves, a gate or the test count changes, a manual check is added |
| `docs/agent-notes.md` | The background behind a rule here changes, or a new incident is worth recording |
| `agent/work/transfer-sync-v2/{NOTES,HANDOFF,FINDINGS}.md` | New measured behavior or protocol detail (gitignored — does not travel) |
| `zalo-agent-cli-wiki/*.md` | A command's behavior changes — **update the EN + VN pair together** |
| `CLAUDE.md`, `.clinerules`, `.cursor/rules/project.mdc` | **Anything in this file changes** — copy it over all three in the same commit |

### Numbers that appear across many docs — verify before you change one

Counts of CLI commands (**184**), command groups (**16**), MCP tools (**7**), OA commands (**32**) and offline tests (**1366** as of 2026-09-29) are quoted in README, SKILL.md, the wiki and INSTALLATION.md. Changing the code behind one means changing every doc that quotes it. **Re-measure; never trust the number written down** — the table of sources and check commands is in [`docs/agent-notes.md`](docs/agent-notes.md).

**The MCP tool list in every doc must match `src/mcp/mcp-tools.js`.** This has drifted before (docs claimed 4 when the code registered 7). The 7: `zalo_get_messages`, `zalo_send_message`, `zalo_list_threads`, `zalo_search_threads`, `zalo_mark_read`, `zalo_get_history`, `zalo_view_media`.

`tests/cli/surface.test.js` is the **machine-checkable twin** of `command-reference.md`: a new subcommand fails that suite until the manifest is updated, which is the cue to walk this map. For the wiki, the authoritative EN⇄VN pairing is `_Sidebar.md` in that checkout — read it rather than guessing, and add a row there when a page is added.

---

## 11. Agent artifacts

- Save long-form documentation and artifacts to the project directory, **not** an agent's default `brain` directory: markdown (reports, plans, guides, release notes, walkthroughs) → `agent/docs/`; generated code, scripts, media, images → `agent/work/`; temporary scratch scripts → the session scratch directory only.
- `agent/` is gitignored and created on demand. Anything that must reach another clone belongs in `docs/` instead.
- A document covering **both** `zalo-agent-cli` and `zalo-mcp` goes into `agent/docs/` in both folders, named so the copies don't collide (`walkthrough_deployment.md`, not `walkthrough.md`).

---

## 12. Research, planning & testing workflow

- **Research first.** Before writing complex features or integrating new Zalo endpoints, verify the logic against the real API with a research sub-agent or scratch scripts in `agent/work/`. Test edge cases spanning large volumes of code (cross-device sync gaps, reconnect behavior) in isolation and feed the results back.
- **Test before commit.** Write test scripts (SQLite locking, duplicate handling, sort order) before declaring a phase complete.
- **Approval checkpoints.** For large architectural changes, produce an `implementation_plan.md` flagging breaking changes, and wait for user approval before modifying source.

### Testing rules

- Framework is the Node built-in runner (`node:test` + `node:assert/strict`) — no external framework.
- **New tests go under `tests/`**: `unit/` for pure logic and filesystem work, `cli/` for tests that drive the binary, `e2e/` for anything needing a live session. Pre-existing suites next to their module (`src/utils/bank-helpers.test.js`, `src/mcp/*.test.js`) stay there; `npm test` globs both locations — so a count taken from one glob only is wrong.
- **Never** use real credentials, user IDs, or phone numbers in tests. Offline tests import `tests/helpers/sandbox.js` **first** (it redirects `USERPROFILE`/`HOME` before `credentials.js` freezes `CONFIG_DIR`) and assert `assertSandboxed(CONFIG_DIR)`. Real thread ids live only in gitignored `tests/targets.json`.
- The live suite may only write to ids blessed as disposable in `tests/targets.json`; every write helper calls `assertDisposable()` first. It is gated behind `ZALO_TEST_LIVE=1`, never reachable from `npm test`, and its destructive tiers sit behind additive env gates — see `tests/README.md`, which also holds the manual checklist.

---

## 13. Known risks

Background and diagnoses for all of these: [`docs/agent-notes.md`](docs/agent-notes.md).

- **Verify a write actually stuck (re-read the file) after any edit in this tree**, especially when another agent or process may be running. When a file looks wrong, **rule out the mundane causes and ask rather than guessing** — ownership/ACLs (`Get-Acl`), an external handler rewriting it, an elevated shell — before recording anything as "cause unidentified".
- **Never run `zalo-agent login` from an elevated shell.** Nothing here needs elevation, and it leaves credential files owned by `BUILTIN\Administrators`: an unelevated session can then read and rewrite them but not delete them, so `logout --purge` and `account remove` fail with `EPERM` while everything else looks fine.
- **Line endings are pinned by `.gitattributes` — never work around it.** It marks `tests/fixtures/** -text` (compared byte-for-byte against the SHA-256 table in `tests/fixtures/index.js`) and normalizes everything else to LF.
  - **Never "fix" a mangled fixture with `git add --renormalize .` or a broad `git add`** — under `-text` that *stages the corruption* and breaks CI for everyone. Restore with `rm tests/fixtures/notes.txt tests/fixtures/data.csv && git checkout -- tests/fixtures/`, confirm with `node --test tests/unit/image-metadata.test.js`.
  - **Git reads `.gitattributes` from the working tree, not the commit you have checked out**, so a stray untracked copy on an older branch aborts `git rebase` with "You have unstaged changes" naming only those two files. Rebasing is otherwise fine — do **not** generalize this into "merge, never rebase".
- **One WebSocket per account — including uploads and `sync`.** `listen`, `mcp start`, `sync-mobile` and a browser Zalo Web session cannot coexist on one account; a duplicate closes the connection with code 3000 and is fatal by design. A running daemon publishes `daemon-channel.json` and does both extra jobs on its own socket (`POST /send-attachments`, `POST /sync/messages`, `POST /sync/reactions`); callers open their own only when **no** daemon is up. **Never add a code path that opens a second listener without checking that file** — `tests/unit/sync-socket-rules.test.js` fails the build when a `run*` command in `sync.js` calls `connectListener` before `getDaemonChannel`.
  - **Keep `src/core/daemon-channel.js` a transport** — stage bodies belong in `src/core/daemon-sync.js`, injected as `runners`, because `src/commands/msg.js` imports the channel at the top level and importing SyncV2 there would pull the libzproto decrypt stack, the CDN fetcher and the sqlite writes into every `msg` invocation. `tests/unit/daemon-channel.test.js` enforces that the channel imports nothing but node builtins.
  - **A daemon-routed sync still taps the phone.** Routing removes the second WebSocket, not the confirmation, and the daemon must never start a stage on its own — same rule as the "Why the daemon does not self-heal" note in `src/commands/listen.js`.
- **One db writer per account.** `daemon.lock` enforces this; `account remove` and `logout --purge` refuse while a `listen` daemon holds it.
- **Unofficial API.** zca-js tracks a moving target. `patches/` holds patch-package patches against it; regenerate them when bumping `zca-js`.
- **One media downloader, one layout — do not invent a second path in docs.** `src/core/sync-v2/media.js` is the only one, and everything (`listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile --transfer`, the MCP tools) writes to `~/.zalo-agent-cli/accounts/<ownId>/media/<conversation>/` as `<YYYY-MM-DD-HH-mm>_<msgIdTail>[_n]_<name>.<ext>`. `mcp-config.json`'s `media.downloadDir` overrides the **root** for the MCP server only; unset, MCP uses that same per-account path.
  - **A custom `media.downloadDir` survives a purge**, because `wipeAccountDir()` removes `CONFIG_DIR/accounts/<ownId>` and nothing else. Warned about in `Security.md` / `Bảo-Mật.md` and `INSTALLATION.md`; **not** fixed in code. If you touch the purge path, this is the thing to fix.
- **`zalo-mcp` is a partial pass-through, not a total one.** Its `mcp-server.js` forwards only `--http` and `--auth`; `--host` and `--config` are **not** forwarded, so a wrapper user cannot bind `0.0.0.0` or point at a custom config through it. The *tool surface* is identical; the *flag surface* is not. Say "the tool list is identical", never "it's a pass-through", without that qualifier.
- **`zalo-mcp`'s dependency pin drifts.** It pins `@ardennguyen/zalo-agent-cli@1.0.8` while this repo is at `2.0.0`. Whatever the pin says is what a deployed wrapper serves, so an MCP tool added here is not reachable through `zalo-mcp` until that pin is bumped and released. Check the pin before claiming a new tool is available to wrapper users.
