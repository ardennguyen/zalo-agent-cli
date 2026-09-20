# Tests

Everything about testing `zalo-agent-cli` lives in this folder. There are two
separate suites with very different risk profiles:

| Suite                            | Needs a Zalo session? | Touches real conversations?  | Command            |
| -------------------------------- | :-------------------: | :--------------------------: | ------------------ |
| **Offline** — unit + CLI surface |          no           |              no              | `npm test`         |
| **Live E2E** — tiered, gated     |          yes          | yes, disposable targets only | `npm run test:e2e` |

`npm test` is what CI runs and what the pre-commit gate requires. It never
opens a socket and never reads your real `~/.zalo-agent-cli/`.

```bash
npm test                      # 636 offline tests — no Zalo session needed
npm run test:unit             # just tests/unit/
npm run test:cli              # just tests/cli/
npm run lint                  # ESLint over src/ and tests/
npm run format                # Prettier auto-fix
npm run format:check          # Prettier verify (what CI runs)
```

> This file is how to run and write the tests.

### Pre-commit gate

Before every commit, all four must pass (see [AGENTS.md](../AGENTS.md) §6):

```bash
npm run format && npm run lint && npm run format:check && npm test
```

---

## Layout

```
tests/
├── README.md                    # this file — how to run and write the tests
├── targets.example.json         # live-target template (committed)
├── targets.json                 # your real targets (GITIGNORED)
├── run-e2e.js                   # live orchestrator — enforces tier order
├── fixtures/                    # committed sample media (see fixtures/README.md)
│   ├── image-64x48.{png,jpg,gif}  image-200x120.jpg  image-1x1.webp
│   ├── notes.txt  data.csv  document.pdf  archive.zip
│   ├── index.js                 # paths, expected dimensions, SHA-256 integrity check
│   └── checksums.js             # regenerate the checksum table
├── helpers/
│   ├── sandbox.js               # throwaway HOME for offline tests
│   ├── cli.js                   # subprocess harness (runCli / runJson)
│   ├── targets.js               # disposable-target registry + blast-radius guard
│   └── live.js                  # session probe, tier gates, write helpers
├── unit/                        # offline, pure logic + filesystem
│   ├── accounts.test.js         credentials.test.js   lock.test.js
│   ├── db.test.js               mcp-config.test.js    oa-client.test.js
│   └── pure-helpers.test.js
├── cli/                         # offline, drives the real binary
│   ├── surface.test.js          # every command/subcommand/flag is registered
│   └── validation.test.js       # every guard that fires before a network call
└── e2e/                         # live, tiered — see below
    ├── tier1-readonly.test.js         tier2-create.test.js
    ├── tier3-mutate-restore.test.js   tier4-cleanup.test.js
    └── tier5-destructive.test.js
```

Unit tests for modules under `src/` that predate this folder still sit
**next to their module** (`src/utils/bank-helpers.test.js`, `src/mcp/*.test.js`)
per [AGENTS.md](../AGENTS.md) §12, and `npm test` picks up both locations.
New tests go in `tests/`.

---

## Offline suite

### Sandboxing — how tests avoid your real credentials

`src/core/credentials.js` computes `CONFIG_DIR` **once**, at module-evaluation
time, from `os.homedir()`. `os.homedir()` reads `USERPROFILE` (Windows) /
`HOME` (POSIX) on every call, so redirecting those before the module is first
imported points the whole config tree at a temp directory.

`tests/helpers/sandbox.js` does that redirect at import time. ESM evaluates
dependencies in the order their `import` declarations appear, so **the sandbox
import must come first** in any test file that touches config state:

```js
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { CONFIG_DIR, saveCredentials } from "../../src/core/credentials.js"; // ← after

it("operates inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
```

That `assertSandboxed()` call is not ceremony: it makes a future reordering
fail loudly instead of silently writing to the developer's real
`~/.zalo-agent-cli/`. Every suite that touches the filesystem has one.

`node --test` forks a process per file, so each test file gets its own
isolated home for free.

### Two CLI behaviors every assertion has to account for

**1. API failures exit 0.** Nearly every action handler is
`try { … } catch (e) { error(e.message) }`, and `error()` writes `  ✗ <msg>`
to _stdout_. "Did it work?" is a question about output text, not `$?`. Only
commander parse errors and `msg history` / `conv recent` set a non-zero code.

**2. `--json` mode is not reliably JSON.** Success paths emit JSON, but the
`✗` line prints to the same stream, and `msg send --react` appends a human
`✓ Auto-reacted…` line _after_ the JSON. `runJson()` handles both: it reports
a `✗` line as `{ok: false, error}`, and extracts the first complete JSON value
while exposing any leftover as `trailing`.

Both are pinned down by **characterization tests** in
`tests/cli/validation.test.js`, labeled `CHARACTERIZATION:`. They assert
current, arguably-wrong behavior on purpose, so that changing it is a
deliberate test update rather than a silent break for anyone piping to `jq`.

### What the offline suite covers

| File                          | Covers                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/credentials.test.js`    | save/load/delete, 0600 perms, corrupt-file tolerance, per-account isolation                                                                                             |
| `unit/accounts.test.js`       | registry CRUD, the "newest login wins" active-flag rule, `wipeAccountDir`, `removeAccount`, lock refusal, **no credential residue after purge**                         |
| `unit/lock.test.js`           | `daemon.lock` in every state: absent, live, stale, corrupt, foreign-owned                                                                                               |
| `unit/db.test.js`             | schema + WAL, the "not initialized" guard on all 11 exports, upsert/COALESCE semantics, ordering, paging, `sync_state`, `sync_gaps`                                     |
| `unit/mcp-config.test.js`     | defaults, the nested deep-merge for `notify`/`limits`/`media`, `parseDuration` (never returns NaN)                                                                      |
| `unit/oa-client.test.js`      | OA storage is a _separate_ directory from personal creds, multi-OA namespacing, OAuth URL building, message-type path-injection guard                                   |
| `unit/image-metadata.test.js` | `readImageMetadata()` across PNG/JPEG/GIF/WebP/BMP/TIFF, all 8 EXIF orientations, descriptive-throw contract, plus fixture SHA-256 integrity                            |
| `unit/pure-helpers.test.js`   | every bank alias round-trips, `maskProxy` never leaks, `extractMessageText` priority + circular safety, fingerprint internal consistency, `isNewerVersion` semver edges |
| `cli/surface.test.js`         | **the full command manifest** — every group, subcommand and behavior-changing flag                                                                                      |
| `cli/validation.test.js`      | every guard that fires before a network call                                                                                                                            |

`cli/surface.test.js` is the machine-checkable twin of
`skill/references/command-reference.md`. When a subcommand is added, renamed
or removed, it fails until the manifest is updated — which is the cue to
update the docs in [AGENTS.md](../AGENTS.md) §10 too.

---

## Live E2E suite

### Safety model

Three independent mechanisms, because the destructive tiers really are
destructive:

**1. An allowlist, not a denylist, decides what may be written to.**
`tests/targets.json` names exactly one disposable group and one disposable DM.
Every write helper in `helpers/live.js` calls `assertDisposable(threadId)`
first, which throws _before_ the network call if the id isn't blessed.

**2. A denylist for near-miss ids.** The account under test has a real group
whose name differs from the disposable one by a four-character suffix
("Việc riêng" vs "Việc riêng - AI test"). Name-based resolution is exactly the
sort of thing that quietly picks the wrong one, so the precious id is named
outright and checked first. An id appearing in both lists fails the whole run.

**3. Additive env gates.** A bare `npm test` cannot reach a network call; a
bare `npm run test:e2e` cannot end your session.

| Gate                        | Unlocks                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `ZALO_TEST_LIVE=1`          | tiers 1–4                                                              |
| `+ ZALO_TEST_DESTRUCTIVE=1` | tier 5a–5c (group disperse + recreate, history wipe, reversible purge) |
| `+ ZALO_TEST_END_SESSION=1` | tier 5d (real logout / purge — **requires a QR re-scan**)              |

`run-e2e.js` sets these for you based on its flags; you rarely set them by hand.

`ZALO_TEST_SYNC_MOBILE` is the exception — `run-e2e.js` never sets it. It gates
`sync-mobile --legacy`, the retired phone-transfer path, which is the only part
of the command that still reaches a real device. Set it by hand, once, when the
phone's owner is expecting it:

```bash
ZALO_TEST_LIVE=1 ZALO_TEST_SYNC_MOBILE=1 node --test tests/e2e/tier3-mutate-restore.test.js
```

`sync-mobile`'s default path needs no phone at all, and runs in tier 3 under
plain `ZALO_TEST_LIVE=1`. Flag parsing and the no-account guard are covered
offline in `tests/cli/validation.test.js`, and the backfill logic itself against
a fake listener in `tests/unit/sync-backfill.test.js`.

### Setup

```bash
cp tests/targets.example.json tests/targets.json
# then edit tests/targets.json
```

`targets.json` is gitignored. It must name:

- `accountOwnId` — the account the suite expects to be logged in as. A
  mismatch aborts tier 1 before anything is written.
- `disposable.group` — `threadId`, `name`, and `memberIds`. The name is
  asserted in tier 1 (drift means the file is stale, so stop), and both name
  and members are used to **recreate** the group after the tier-5 disperse.
- `disposable.dm` — a real friend thread. Note that self-chat does _not_
  work: Zalo rejects `msg send <ownId>` with `Tham số không hợp lệ`, so the
  DM target has to be someone else.
- `denylist` — ids that must never be written to, whatever else happens.

### Running

```bash
npm run test:e2e                          # tiers 1–4 (default)
node tests/run-e2e.js --tier 1            # a single tier
node tests/run-e2e.js --through 3         # tiers 1–3
node tests/run-e2e.js --destructive       # tiers 1–5c
node tests/run-e2e.js --end-session       # tiers 1–5d  ⚠ QR re-scan needed
node tests/run-e2e.js --keep-going        # don't stop at the first failing tier
```

`run-e2e.js` runs each tier file in **its own process, sequentially**. That is
not a style choice:

- The tiers are strictly ordered — tier 4 deletes what tier 2 created.
- **Zalo permits one WebSocket per account.** Two concurrent `msg history`
  calls would knock each other off with close code 3000. `node --test` runs
  files in parallel by default, which would break both invariants.

A failing tier stops the run before the next one can destroy anything, unless
you pass `--keep-going`.

### Tier order, and why it is what it is

The ordering is the whole safety design. Each tier can only damage what the
tiers before it already proved healthy.

**Tier 1 — read-only.** Nothing mutates. Runs first so a dead credential, the
wrong account, or a drifted target id fails the run before anything has been
created or destroyed. It asserts the group's _name_ matches `targets.json`,
which is the tripwire for a stale config pointing at someone else's group.

**Tier 2 — send & create.** Adds only: messages, polls, reminders, a group
note, a quick message, an auto-reply rule, a catalog. Every created id is
recorded in `tests/.artifacts.json` for tier 4 to clean up. Running tier 2
without tier 4 deliberately leaves visible artifacts — a half-run should be
obvious, not silent.

Tier 2 also **sweeps leftovers before it creates**: quick-message keywords
must be unique per account and catalogs count against a cap, so an aborted
run would otherwise poison the next one. Keywords are per-run unique
(`e2e<base36 timestamp>`).

DM volume is kept deliberately low — the DM target is a real person, so only
the messages needed to exercise the 1:1 path are sent, and tier 4 recalls all
of them.

**Tier 3 — mutate & restore.** Each test changes state and puts it back, with
the restore in that test's own `after()` rather than at the end of the file,
so aborting mid-tier leaves the least possible drift. Per-conversation toggles
come before group-level settings, so a failure in a toggle cannot leave the
group in a state that blocks its own cleanup.

**Tier 4 — delete & wipe.** Ordered internally:

1. message deletes (`delete`, `undo`) — need the messages to still exist
2. account-artifact deletes — independent of messages
3. local cache — independent of the server
4. **`conv delete` last** — it wipes the very history steps 1–2 operate on, so
   anything after it would have nothing left to act against

**Tier 5 — irreversible.** Split by how hard each step is to come back from:

- **5a** `group disperse` → **immediately recreate** with the same name and
  members, then write the new id back into `targets.json`. The old group id
  dies forever; the group itself is restored. If disperse succeeds but
  recreation fails, the tier prints a loud `MANUAL ACTION REQUIRED` notice.
- **5b** `logout --delete-history` — wipes `zalo.db` and `media/`; credentials
  survive and the cache rebuilds.
- **5c** `logout --no-remote --purge` — exercises the **entire** purge
  filesystem path (credential deletion, account-dir wipe, registry drop) while
  leaving the _server_ session valid, because `--no-remote` skips `logoutV2()`.
  The suite backs the credential up first and restores it after, then asserts
  the session is actually back. This proves the purge code works **without
  costing a QR re-scan** — which is why it is separate from 5d.
- **5d** real `logout` then `logout --purge` — calls `logoutV2()`, which
  genuinely invalidates the session at Zalo's servers. **Nothing restores
  this**; you must scan a QR code on your phone. Behind its own gate, last.

Note that `logout` _without_ `--no-remote` is as destructive as `--purge` for
practical purposes — it kills the server session, so the stored cookie is dead
even though the file is still on disk. `logout --no-remote` is the genuinely
safe one, and because each CLI invocation is its own process it is nearly a
no-op; tier 4 asserts exactly that.

### Transient failures

Zalo's unofficial endpoints intermittently answer 404/5xx or drop a
connection. Tier 1 routes its reads through `retryRead()`, which retries up to
3 times on a transient-looking error only. A genuinely retired endpoint fails
every attempt, so real breakage is never masked. **Writes are never retried** —
a retried send delivers the message twice.

### Response shapes vary — clean up by name, not just by id

Create endpoints do not agree on where they put the new id. `catalog create`
answers `{item: {id, …}}`, not a bare `{id}`; polls use `poll_id`; reminders
vary. A tier-2 test that reads only `r.data.id` records nothing, silently
orphaning the artifact.

That is not hypothetical: an untracked catalog survived a run, and because
catalogs count against a Zalo-side cap, the leftover made the **next** run's
`catalog create` fail with `Lỗi không xác định`. Two defenses, both worth
keeping when you add a new artifact type:

- tier 2 **sweeps stale `[e2e]`-named artifacts before it creates**, so an
  aborted run cannot poison the next one;
- tier 4 **sweeps by name as a backstop**, so cleanup does not depend on
  having parsed any particular response shape correctly.

Anything unique-per-account — quick-message keywords especially — gets a
per-run unique value (`e2e<base36 timestamp>`) rather than a fixed string.

---

## Writing tests — contributor guide

### Framework

Node's built-in runner (`node:test` + `node:assert/strict`). No external
framework.

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
```

### Where a new test goes

| Kind                                                      | Location                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Pure logic / filesystem, no session                       | `tests/unit/<module>.test.js`                                 |
| Drives the binary, no session                             | `tests/cli/`                                                  |
| Needs a live Zalo session                                 | `tests/e2e/tier<N>-*.test.js` — pick the tier by blast radius |
| New module under `src/` following the existing convention | next to the module (`src/foo/bar.test.js`)                    |

### Picking a tier

Ask what a failure mid-test would leave behind:

- nothing → tier 1
- an artifact someone would notice → tier 2
- a changed setting → tier 3, and write the restore in that test's `after()`
- something deleted → tier 4
- something unrecoverable → tier 5, behind the right gate

### Test-ordering rules

- **Never** wrap a write in `retryRead()` — it would send twice.
- Put restores in the individual test's `after()`, not the file's.
- Anything that wipes history goes last within its tier.
- If a test creates something, record it in the `artifacts` ledger so tier 4
  can clean it up.

### Marking a defect rather than a failure

When live behavior is wrong but the cause is upstream or out of scope, use a
`todo` plus a characterization test:

```js
it("does the right thing", { todo: "one-line reason" }, async () => {
    /* the assertion you WANT to pass */
});

it("CHARACTERIZATION: currently does the wrong thing", async () => {
    /* assert what actually happens today */
});
```

`todo` reports without failing CI. The characterization test fails the moment
the behavior changes, which is the prompt to promote the todo. Add a row to
**Known issues** above.

### Security rules for tests

- **Never** put real credentials, user ids, or phone numbers in committed
  test code. Real ids live only in gitignored `tests/targets.json`.
- **Always** import `helpers/sandbox.js` first in offline tests that touch
  config state, and assert `assertSandboxed(CONFIG_DIR)`.
- **Never** commit `tests/targets.json`, `tests/.artifacts.json`, or
  `tests/.credential-backup/` — all three are gitignored.

---

## Manual checklist

What the automated suites genuinely cannot cover: anything needing a phone, a
second machine, a proxy, or an OA app.

### Login and QR

- [ ] `zalo-agent login` — QR renders as terminal ASCII, scan works, credentials saved
- [ ] `zalo-agent login --proxy http://user:pass@host:port` — login via proxy
- [ ] `zalo-agent login --qr-url` — QR viewable at the localhost URL
- [ ] `zalo-agent login --qr-port 9999` — honors the custom port
- [ ] `zalo-agent login --credentials ./creds.json` — skips QR
- [ ] Scan then **decline** on the phone — reports "Login declined" within one long-poll round trip, not after the ~60s QR timeout
- [ ] Scan without confirming — shows the scanning account's name/avatar first
- [ ] Let the QR expire — reports expiry rather than hanging
- [ ] The phone's "Thiết bị" label matches the generated fingerprint (Chrome + the right OS)

### Session exclusivity (needs two clients)

Zalo allows one web session per account and this CLI occupies it. Verified
2026-09-20. Cannot be automated — it needs a second real client and a QR scan.

- [ ] With the CLI logged in and NO listener running, sign into Zalo Web — the next CLI API call fails with `Đăng nhập thất bại`
- [ ] The failure message explains the cause and the trade-off, not just `Run: zalo-agent login`
- [ ] The credential file on disk is unchanged (same imei, same cookies) — revocation is server-side
- [ ] `zalo-agent login` afterwards restores the CLI **and** signs Zalo Web out
- [ ] The phone app keeps working throughout
- [ ] `status` still reports `loggedIn: true` against a revoked session — it is a local check, not a liveness probe; use `whoami`

### Multi-account and proxy

- [ ] `account login --proxy URL --name "Shop"` — adds a second account
- [ ] `account switch <ID>` — re-logs in with that account's proxy
- [ ] `account export -o ./creds.json` — file created with 0600 perms
- [ ] Import that file on another machine — session works there
- [ ] `account remove <ID>` while a `listen` daemon holds the lock — refused, PID reported, credentials untouched
- [ ] Proxy passwords never appear in any output (always `***`)

### Listener

- [ ] `listen` — messages stream live; reconnects after a network drop
- [ ] `listen --events message,friend,group,reaction` — group/reaction events appear
- [ ] `listen --webhook <url>` — one JSON POST per event; a dead webhook does not stall processing
- [ ] `listen --save ./logs` — one `<threadId>.jsonl` per thread
- [ ] A second `listen` for the same account is refused (`daemon.lock`)
- [ ] Kill `listen`, restart — the stale lock is reclaimed
- [ ] `--json listen` — one JSON object per line, pipes cleanly into `jq`
- [ ] Received media lands in `accounts/<ownId>/media/`, organized by thread

### Sync

- [ ] `sync-mobile` — backfills over the socket and reports a saved/total count
- [ ] `sync-mobile` twice in a row — the second run reports "Already synced … ago"
      and exits without opening a socket; `--force` overrides it
- [ ] `sync-mobile` while `listen` is running — refuses, naming the lock
- [ ] `sync-mobile` while Zalo Web is open — reports the one-web-session rule
- [ ] `sync-mobile --legacy` — one attempt, then reports the retired endpoint
- [ ] `sync-mobile --legacy --force` — skips the debounce
- [ ] Kill `listen`, wait >30s, restart — a backfill is attempted for the gap
      (currently the retired path, so it recovers nothing)

### MCP server

- [ ] `mcp start` — stdio transport; logs on stderr only, stdout carries only JSON-RPC
- [ ] `zalo_get_messages` — `since` excludes already-seen messages
- [ ] `zalo_send_message` — returns `{success, messageId}` and actually delivers
- [ ] `zalo_list_threads` — unread counts match `zalo_get_messages`
- [ ] `zalo_search_threads` — finds a Vietnamese name with accents stripped
- [ ] `zalo_mark_read` — the cursor is global, not thread-scoped
- [ ] `zalo_get_history` — paginates via `lastMsgId`
- [ ] `zalo_view_media` — opens a cached attachment, and downloads an uncached one
- [ ] `mcp start --http <port> --auth <token>` — requests without the bearer token are rejected
- [ ] `GET /health` — responds **without** a token
- [ ] `mcp start --http <port>` binds `127.0.0.1` only; `--host 0.0.0.0` makes it reachable
- [ ] `--config <path>` — custom `limits`/`watchThreads` take effect
- [ ] With `notify.enabled` and `notify.thread` set, messages arriving while no client is connected produce a batched summary respecting `notify.cooldown`

### Official Account

OA uses the official API — safe to test on a real OA.

- [ ] `oa init --app-id <ID> --secret <KEY> --skip-webhook` — non-interactive setup
- [ ] `oa init` — interactive wizard end to end
- [ ] `oa whoami` — name, id, follower count
- [ ] `oa msg text <uid> "test"` then `oa msg status <messageId>`
- [ ] `oa upload image ./photo.jpg` → `oa msg image <uid> --image-id <id>`
- [ ] `oa follower list --count 10` / `oa tag list` — paginated
- [ ] `oa listen -p 3000 -s <SECRET>` — answers `hub.challenge`; rejects a bad MAC
- [ ] `oa listen --path /zalo` — served at `/zalo`
- [ ] `oa refresh` — new access token after the old one expires (~25h)
- [ ] Multi-OA: `--oa-id shop1` / `shop2` stay separate
- [ ] An expired token surfaces `-216`; a tier-gated API surfaces `-224`

### Cross-platform

- [ ] QR ASCII renders correctly in the terminal
- [ ] `~/.zalo-agent-cli/` is created automatically
- [ ] Unix: credential files and `accounts.json` are `0600`
      (the offline suite skips these assertions on Windows, where POSIX mode bits
      are not meaningful — they must be checked by hand on Linux/macOS)
