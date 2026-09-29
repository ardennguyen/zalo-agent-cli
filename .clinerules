# AGENTS.md — zalo-agent-cli Project Rules

Rules for any AI coding agent working in this repository (Claude Code/Cowork, Antigravity, Cursor, Cline, Codex, …).

**This file is the instructor: it states rules, not reasons.** Every rule that has a story behind it — the incident that produced it, how to recover, the measured numbers, the lookup tables — lives in **[`docs/agent-notes.md`](docs/agent-notes.md)**, which is committed, has **no size limit**, and is read on demand. Read it when a rule here surprises you, when you are about to work around one, or when you need the detail a rule points at. It is not optional background; it is where this file's evidence went.

**`AGENTS.md`, `CLAUDE.md`, `.clinerules` and `.cursor/rules/project.mdc` are byte-identical copies of this text.** Each tool reads only its own filename. Edit `AGENTS.md`, copy it over the other three in the same commit, never hand-edit a copy.

**Keep this file under 24,000 bytes.** Google Antigravity silently truncates a longer rule file — no warning, no marker, the tail never reaches the model. Adding a rule that would exceed the budget means moving explanation to `docs/agent-notes.md` first, not shaving words.

```bash
for f in CLAUDE.md .clinerules .cursor/rules/project.mdc; do cp AGENTS.md "$f"; done
wc -c AGENTS.md   # must be < 24000
sha256sum AGENTS.md CLAUDE.md .clinerules .cursor/rules/project.mdc   # four identical hashes
```

---

## 0. Non-negotiables

If you read nothing else, read these.

1. **Run the full pre-commit gate before every commit** — `npm run format && npm run lint && npm run format:check && npm test`, all four green. → §6
2. **Every commit is immediately followed by a push.** → §7
3. **Never run `npm publish` by hand.** → §8
4. **Never ask the user to run something you can run yourself**, except a Zalo network flow your sandbox cannot reach — then hand back one copy-pasteable command. → §5
5. **Back up gitignored files before any `git reset --hard` / `git checkout` / `git clean -fd`.** They do not survive. → §7
6. **Never commit a real person's or account's identifiers** — Zalo ids (plain or noised), names, phone numbers, credentials — in code, comments, tests, fixtures or docs. `npm test` fails on a real-looking id. → §12
7. **In MCP mode stdout is the JSON-RPC transport.** Every diagnostic uses `console.error()`. → §4
8. **Re-read a file after writing it.** Concurrent agents work in this tree. → §5, §7
9. **`skill/references/command-reference.md` wins** when docs disagree. → §10
10. **Bilingual docs come in pairs.** Update both sides in the same change. → §3, §10
11. **Three writers to `zalo.db`: the listener, sync, and `msg history`'s fetch.** Nothing else writes rows. → §13

### First commands in a new session

```bash
git branch --show-current      # v2.0-dev is the active major-version branch
git status --short             # another agent may have left uncommitted work
npm test                       # offline suite, no Zalo session needed
```

Uncommitted work in the tree — including the sibling `zalo-agent-cli-wiki` checkout — is normal and is probably another session's. Read it before overwriting it.

---

## 1. What this project is

`@ardennguyen/zalo-agent-cli` — a Node.js CLI that automates Zalo, plus an MCP server so AI agents can read and send Zalo messages.

Two separate API surfaces live in one binary, and **must never be conflated**:

| Surface | API | Credentials | Risk |
|---|---|---|---|
| Personal (`msg`, `friend`, `group`, `listen`, `mcp`, …) | **Unofficial** ([zca-js](https://github.com/RFS-ADRENO/zca-js)), QR login | `~/.zalo-agent-cli/` | Account can be banned |
| Official Account (`oa …`) | **Official** Zalo OA REST v3.0, OAuth 2.0 | `~/.zalo-agent/` (no `-cli`) | None — sanctioned |

The unofficial-API disclaimer is deliberately suppressed for `oa` commands.

Three sibling repos under one parent (locally `F:/Coding/zalo-mcp/`): **`zalo-agent-cli`** (this repo, the engine), **`zalo-mcp`** (thin wrapper, no engine code, pins a *published* version — §13), **`zalo-agent-cli-wiki`** (public wiki, EN + VN pairs).

---

## 2. Repository layout

Annotated `src/` tree and runtime storage layout: [`docs/agent-notes.md`](docs/agent-notes.md). What you cannot guess from a directory listing:

- `src/index.js` — Commander entry point; each command group exports one `register<X>Commands(program)`.
- `src/core/sync-v2/` — transfer-sync-v2, the **real** phone-backed restore (cmd 590/591). `src/core/sync.js` is the *older* SyncManager — not the same thing. `sync-v2/media.js` is the **only** media downloader.
- `src/core/daemon-channel.js` — loopback transport to a running daemon; `daemon-sync.js` holds the stage bodies. `lock.js` is `daemon.lock`. `src/mcp/mcp-tools.js` is the **source of truth** for the MCP tool list.
- `tests/unit/` and `tests/cli/` are offline; `tests/e2e/` is live, tiered 1–5 by blast radius, behind `ZALO_TEST_LIVE=1`.
- Runtime state: `~/.zalo-agent-cli/` (registry + credentials at 0600), per account `accounts/<ownId>/`.

---

## 3. Language

- All **English text** uses **American English (US)** spelling — docs, READMEs, commit messages, code comments, agent responses.
- Vietnamese content in bilingual artifacts is correct as written. Do **not** remove or "fix" it unless asked.
- Bilingual docs come in pairs (README VN/EN; wiki `Messages.md` ⇄ `Tin-Nhắn.md`). Update both sides in the same change.

---

## 4. Code style

Enforced by Prettier + ESLint — do not hand-format.

**`npm run format` covers `src/` and `tests/` only.** Never run prettier by hand on `skill/`, `docs/` or the wiki: those have never been prettier-formatted, so it reformats the whole file instead of your hunk and lands on whatever someone else has uncommitted. Edit them by hand.

| Setting | Value |
|---|---|
| Module system | ESM (`"type": "module"`), `.js` extensions required in imports |
| Node | `>=22` (`engines`) |
| Indent / width | 4 spaces / 120 columns |
| Quotes / semicolons | Double quotes, semicolons on, trailing commas everywhere |
| Lint | `no-var`, `no-debugger`, `no-duplicate-imports` = error; `prefer-const`, `eqeqeq`, `no-unused-vars` (ignore `^_`) = warn |

- **A lint warning fails the gate like an error** (`--max-warnings 0`). Fix it; never raise the limit.
- JSDoc every exported function.
- All output goes through `src/utils/output.js` so `--json` stays clean.
- **In MCP mode stdout is the JSON-RPC transport.** Every diagnostic uses `console.error()`. `src/commands/mcp.js` reassigns `console.log` to `console.error` as a safety net — do not undo it.
- Never log proxy passwords, cookies, IMEI, or tokens. `maskProxy()` exists for this.

---

## 5. Development environment

This project is developed through AI coding agents — the user does not write code by hand.

- The agent does **all** operations it can perform directly: format, lint, test, install, debug, edit, and with shell access `git add`/`commit`/`push`. **Never ask the user to run a command you can run yourself.** The one exception is a real Zalo network flow your environment cannot reach (blocked egress, a QR scan): say so explicitly and hand back a **single copy-pasteable command**.
- Multiple agent tools work here across sessions. Re-check file state before trusting in-memory assumptions, and re-read a file after writing it.

### Windows traps that fail silently

Each reports success, or names the wrong cause. Detail and measurements: [`docs/agent-notes.md`](docs/agent-notes.md).

- **Git Bash `kill` does not work on native Windows PIDs** — both `kill -TERM` and `kill -0` report success while the process runs on. Use `Stop-Process -Id <pid> -Force` and verify with `Get-Process`. A `daemon.lock` PID is a number in a file, not proof of life.
- **MSYS rewrites any argument starting with `/`.** Every Zalo reaction code starts with `/`, so set `MSYS2_ARG_CONV_EXCL="*"` for `msg react` and `msg send --react`.
- **Backslashes do not survive being written through the shell.** Use forward slashes; write scripts to a file rather than `node -e` when they contain escapes.
- **PowerShell `Start-Process` does not inherit `$env:X` set earlier**, and its child may die with the session. For a daemon, use `nohup … &` from Bash.
- **git reads `.gitattributes` from the working tree, not your checked-out commit** (§13).

---

## 6. Pre-commit checklist (MANDATORY)

Before **every** commit, all four must pass:

```bash
npm run format        # auto-fix first
npm run lint          # must exit 0
npm run format:check  # must exit 0
npm test              # must exit 0
```

Do **not** commit if any fail. CI runs exactly these on Node 22 plus `--version` and `--help`.

While iterating, narrow the loop (`npm run test:unit`, `npm run test:cli`, `node --test <file>`, `--test-name-pattern=`) — but run the full gate before the commit.

**If another session holds files under `src/` or `tests/`, do not run `npm run format`** — it rewrites their in-flight work. Run the three read-only steps and say so in the commit message.

`npm test` never opens a socket and never reads the real `~/.zalo-agent-cli/`. The live suite (`npm run test:e2e`) is separate and gated.

---

## 7. Git workflow

- **Always commit to `main` first**, then update the target branch:
  ```bash
  git checkout main && git commit ... && git push origin main
  git checkout <branch> && git reset --hard origin/main
  git push origin refs/heads/<branch> --force
  ```
- **Exceptions:** commit only to a feature branch when the user says so; long-lived version branches (`v2.0-dev`) take work directly. **Confirm with the user before merging `v2.0-dev` into `main`** — that is a release decision.
- Never leave `main` behind a feature branch meant to ship.
- **Every `git commit` MUST be immediately followed by `git push`.**
- Conventional messages: `feat:`, `fix:`, `chore:`, `style:`, `docs:`, `build:`. Differing or absent co-author trailers are expected, not something to "fix".

### More than one session in this checkout

Learned the expensive way; the incidents are in [`docs/agent-notes.md`](docs/agent-notes.md).

- **Give a new session its own git worktree.**
- **Stage by explicit path. Never `git add -A` or `git add .`** — a shared file holds several sessions' hunks, and staging broadly commits someone's half-finished work under your message.
- **Never `git stash`** (nor `git rebase --autostash`) — the stash stack is shared across worktrees.
- **`git checkout -- .` and `git reset --hard` destroy other sessions' work.** Path-scope them or do not run them.
- **Before committing someone else's orphaned work**, verify it stands alone, attribute it to them, and snapshot first to `agent/work/`. **Never commit for a session that is still active** — ask first.
- **Before rebasing, check for a stale `.git/worktrees/<name>/rebase-merge/`** — it makes every later attempt fail with a misleading error. `git rebase --abort` clears it.
- **`git diff --name-only` disagreeing with `git status --porcelain` is a signal.** Go looking.

### Before any destructive git operation

Before ANY of `git reset --hard`, `git checkout <branch>`, `git clean -fd`: read and save every local-only (gitignored) file — `.agents/`, `.env*`, anything under `agent/` — proceed only once that is backed up, and restore it immediately afterward. **Never assume gitignored files survive.**

---

## 8. Release & publish

- All work is committed to `main` first.
- Release branches (`v1.x.x`) and tags are always **reset to `main`'s HEAD** — never cherry-pick. Tag, branch and `main` end at the same commit; the reset-and-retag sequence is in [`docs/agent-notes.md`](docs/agent-notes.md).
- A GitHub Release from the tag triggers `.github/workflows/publish.yml`, which publishes with `--provenance`. `NPM_TOKEN` is a repository secret.
- **Never run `npm publish` manually.**

---

## 9. Deployment (`V:/zalo_mcp` and other `zalo-mcp` installs)

- **Never** run `npm install` in a deployed `zalo-mcp` folder — only `zalo-mcp.ps1 update` (Windows) or `bash zalo-mcp.sh update` (Linux/macOS).
- Pull from **`ardennguyen/zalo-mcp`** — *not* the original PhucMPham repo, *not* npm. The scripts install from `github:ardennguyen/zalo-agent-cli`.

---

## 10. Documentation map — keep in sync with code changes

`skill/references/command-reference.md` is the **authoritative, exhaustive** CLI reference. When any other doc disagrees with it, that doc is wrong.

| File | Update when |
|---|---|
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
| `CLAUDE.md`, `.clinerules`, `.cursor/rules/project.mdc` | **Anything in this file changes** — copy over all three in the same commit |

### Numbers quoted across many docs

CLI commands (**190**), command groups (**21** containers), MCP tools (**7**), OA commands (**32**), offline tests (**1720** as of 2026-09-30). Changing the code behind one means changing every doc that quotes it. **Re-measure; never trust the number written down** — counting method and sources are in [`docs/agent-notes.md`](docs/agent-notes.md), including why the two obvious ways to count commands both give wrong answers.

**The MCP tool list in every doc must match `src/mcp/mcp-tools.js`**: `zalo_get_messages`, `zalo_send_message`, `zalo_list_threads`, `zalo_search_threads`, `zalo_mark_read`, `zalo_get_history`, `zalo_view_media`.

`tests/cli/surface.test.js` is the **machine-checkable twin** of `command-reference.md`. For the wiki, the authoritative EN⇄VN pairing is `_Sidebar.md` in that checkout.

### Leak check before every wiki push (MANDATORY)

**A wiki push publishes instantly — there is no review gate in front of it.** Run the check from the wiki checkout before every `git push`, and do not push on a non-zero exit:

```bash
bash ../zalo-agent-cli/.agents/check-wiki-leaks.sh
```

It fails the push on any of:

1. **Zalo ids** — any digit run of 12 or more. A real 19-digit thread id reached `command-reference.md` once and had to be scrubbed (`b0f267c`).
2. **Phone shapes** that are not the known dummies (`0123456789`, `0901234567`).
3. **Confidential terms** — company/product names and the personal names scrubbed in `b0f267c`.

The term list is `.agents/confidential-terms.txt` and is **gitignored on purpose**. This file is committed to a *public* repo, so the denylist cannot live in it: writing those names here is precisely the disclosure the check exists to prevent. If the list is missing the script exits 2 rather than passing — recreate it, never skip it.

The same rule applies to anything else that gets published: npm READMEs, GitHub releases, issue comments. The wiki is just the surface with the shortest path from edit to public.

**The check guards the working tree, which is why it runs *before* the push.** Once a term is pushed, deleting it in a later commit does not remove it — it stays in the public history and in every clone. Remediation at that point is history rewriting plus rotating whatever leaked, not a follow-up commit. Audit with `git log --all -S'<term>'`: **0 on every remote ref of both repos as of 2026-09-30.** A local feature branch cut before a scrub can still carry the scrubbed value in its tree — rebase it onto the scrubbed history with the value replaced before it is ever pushed, never push or merge it as-is (see [`docs/agent-notes.md`](docs/agent-notes.md)).

> Keep the script honest: after changing it, plant one sample per category in a scratch directory, confirm it exits 1, and delete them. Why that matters: [`docs/agent-notes.md`](docs/agent-notes.md).

---

## 11. Agent artifacts

- Long-form docs, plans and artifacts go in the project, **not** an agent's default `brain` directory: markdown → `agent/docs/`; generated code, scripts, media → `agent/work/`; temporary scratch → the session scratch directory only.
- `agent/` is gitignored. Anything that must reach another clone belongs in `docs/`.
- A document covering **both** repos goes into `agent/docs/` in both, named so the copies do not collide.

---

## 12. Research, planning & testing workflow

- **Research first.** Verify logic against the real API with a sub-agent or scratch scripts in `agent/work/` before writing complex features or integrating new endpoints.
- **Test before commit.** Write the test scripts before declaring a phase complete.
- **Approval checkpoints.** For large architectural changes, produce an `implementation_plan.md` flagging breaking changes and wait for user approval before modifying source.

### Testing rules

- Node built-in runner (`node:test` + `node:assert/strict`) — no external framework.
- **New tests go under `tests/`**: `unit/` pure logic and filesystem, `cli/` drives the binary, `e2e/` needs a live session. Pre-existing suites next to their module stay there; `npm test` globs both, so a count from one glob is wrong.
- **Never** use real credentials, user IDs, or phone numbers. Offline tests import `tests/helpers/sandbox.js` **first** and assert `assertSandboxed(CONFIG_DIR)`. Real thread ids live only in gitignored `tests/targets.json`.
- **Identity protection is enforced, not trusted.** `tests/unit/no-real-ids.test.js` fails `npm test` on any 15+-digit run, or 32-character noised id not spelling `NOISED`, in a tracked or unignored file, zip entry or path that is not a fake by its convention. Never copy a value from a live capture, log, `zalo.db` or `targets.json` into a commit; choose a fake that keeps what the test needs (length, past `MAX_SAFE_INTEGER`, a colliding twin, a fixture's byte size). Names have no automatic check — review them.
- The live suite writes only to ids blessed disposable in `targets.json`; every write helper calls `assertDisposable()`. Gated behind `ZALO_TEST_LIVE=1`, unreachable from `npm test`, destructive tiers behind additive env gates.
- **An assertion that only checks "did not crash" is not a test.** This CLI reports API failures as a printed `✗` and exits 0, so crash-only assertions cannot tell a working command from one that fails on every invocation. Assert the success the command claims.
- **Before trusting a new assertion, say what would have to change for it to go red — and check that is the thing you care about.** **An assertion that matches a string the fix itself introduces** proves the fix is present, not that it works. If an assertion greps for its own patch, it is testing the wrong thing. Worked example: [`docs/agent-notes.md`](docs/agent-notes.md).

---

## 13. Known risks

Every entry here has its diagnosis, measurements and recovery steps in [`docs/agent-notes.md`](docs/agent-notes.md). Read it before working around any of them.

- **Verify a write actually stuck** (re-read the file) after any edit in this tree. When a file looks wrong, rule out the mundane causes — ownership/ACLs, an external handler, an elevated shell — and ask, before recording anything as "cause unidentified".
- **Never run `zalo-agent login` from an elevated shell.** It leaves credentials owned by `BUILTIN\Administrators`, after which `logout --purge` and `account remove` fail with `EPERM` while everything else looks fine.
- **Line endings are pinned by `.gitattributes` — never work around it.** `tests/fixtures/** -text`, everything else LF. **Never "fix" a mangled fixture with `git add --renormalize .` or a broad `git add`** — that stages the corruption and breaks CI.
- **One WebSocket per account — including uploads, `sync` and history scans.** `listen`, `mcp start` and a browser Zalo Web session cannot coexist; a duplicate closes with code 3000. A running daemon publishes `daemon-channel.json` and serves uploads, sync stages and history on its own socket. **Never add a code path that opens a second listener without checking that file first** — `tests/unit/sync-socket-rules.test.js` and `listener-lifecycle-rules.test.js` enforce parts of this.
  - **Keep `src/core/daemon-channel.js` a transport** — stage bodies belong in `daemon-sync.js`, or the whole SyncV2 stack loads on every `msg` invocation.
  - **A daemon-routed sync still taps the phone.** Routing removes the second WebSocket, not the confirmation. The daemon must never start a stage on its own.
- **`listen` and `mcp start` are two entry points to the same socket. Any asymmetry between them is a defect.** Both track coverage gaps through `src/core/listener-lifecycle.js`; down-ness is observed, never inferred from a counter, and a deliberate stop is not a drop.
- **One db writer per account**, enforced by `daemon.lock`. With a `listen`/`mcp` daemon up, `msg history`'s fetch and write run in the daemon (its `history` stage, `src/core/history-fetch.js`); the CLI only displays, and exits 1 rather than fetching beside a daemon that cannot answer.
- **Message rows have exactly three writers: the listener, sync, and `msg history`'s fetch** (insert-if-absent — it never modifies or removes a row already cached). Nothing else writes to `zalo.db`; `msg send` stores nothing, not even a looked-up name. A message you just sent is therefore not quotable, forwardable or recallable until the listener observes its echo or a later `msg history` fetch returns it; say that plainly rather than pointing users at a command that cannot seed it.
- **Unofficial API.** `patches/` holds patch-package patches against zca-js, applied by `prepare` and shipped **inside the tarball** via `bundleDependencies` — never a consumer `postinstall`, which cannot reach a hoisted `zca-js`. Bumping `zca-js` means regenerating the patch *and* re-pinning the exact version; `tests/unit/packaging.test.js` enforces both.
- **One media downloader, one layout.** `src/core/sync-v2/media.js` is the only one; everything writes to `accounts/<ownId>/media/<threadId>/`. **Folders are thread IDs, never names** — a name can carry a path separator and changes on rename. `media/_conversations.json` maps ID to name. `mcp-config.json`'s `media.downloadDir` overrides the root for the MCP server only.
  - **A custom `media.downloadDir` survives a purge** — `wipeAccountDir()` removes only `CONFIG_DIR/accounts/<ownId>`. Warned about in `Security.md` / `Bảo-Mật.md` and `INSTALLATION.md`; not fixed in code.
- **`zalo-mcp` is a partial pass-through.** It forwards only `--http` and `--auth`; `--host` and `--config` are **not** forwarded. The *tool surface* is identical; the *flag surface* is not. Never say "it's a pass-through" without that qualifier.
- **`zalo-mcp`'s dependency pin drifts.** It pins a published version, so a tool added here is unreachable through the wrapper until that pin is bumped and released. Check the pin before claiming a new tool is available to wrapper users.
