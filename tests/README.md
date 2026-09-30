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
npm test                      # 1897 offline tests — no Zalo session needed
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
├── unit/                        # offline, pure logic + filesystem (42 files)
│   ├── accounts.test.js              credentials.test.js           daemon-channel.test.js
│   ├── db.test.js                    image-metadata.test.js        listener-lifecycle-rules.test.js
│   ├── live-store.test.js            lock.test.js                  mcp-config.test.js
│   ├── mcp-normalize.test.js         mcp-tools.test.js             mentions.test.js
│   ├── msg-forward.test.js           oa-client.test.js             output-latch.test.js
│   ├── packaging.test.js             parse-options.test.js         pure-helpers.test.js
│   ├── qr-display.test.js            quote-sender.test.js          security-surfaces.test.js
│   ├── send-client-id.test.js        sync-backfill.test.js         sync-freshness.test.js
│   ├── sync-gap-advice.test.js       sync-live-parity.test.js      sync-poll-status.test.js
│   ├── sync-socket-rules.test.js     sync-v2-board.test.js         sync-v2-conv-state.test.js
│   ├── sync-v2-decode.test.js        sync-v2-keepalive.test.js     sync-v2-media.test.js
│   ├── sync-v2-message-types.test.js  sync-v2-plan.test.js          sync-v2-reactions.test.js
│   ├── sync-v2-restore-success.test.js  sync-v2-resume.test.js        sync-v2-window.test.js
│   └── sync-v2-zcloud.test.js        thread-type.test.js           zca-api-surface.test.js
├── cli/                         # offline, drives the real binary
│   ├── surface.test.js          # every command/subcommand/flag is registered
│   ├── validation.test.js       # every guard that fires before a network call
│   └── sandbox-discipline.test.js  # no offline test may touch the real ~/.zalo-agent-cli/
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

### Spawn timeouts are a load symptom, not a regression

`src/cli.test.js` boots a real `node` process per assertion. When something
else is competing for the machine — parallel agent sessions, a running
`listen` daemon, a full rebuild — a cold start can outlast the per-spawn
limit, and `npm test` then reports a handful of `--help` tests as failed. The
tell is that a **different** subset fails on each run and each one dies at
almost exactly the limit.

Check that before chasing a regression:

```bash
node --test src/cli.test.js        # passes alone => the suite is fine
```

The limit defaults to 30s. Override it when the default is wrong for the
machine, in either direction:

```bash
ZALO_TEST_CLI_TIMEOUT_MS=60000 npm test   # slow or heavily loaded box
ZALO_TEST_CLI_TIMEOUT_MS=2000 npm test    # tighten, to surface a real hang
```

A spawn that does time out now says so in those terms rather than surfacing a
bare `ETIMEDOUT`, and keeps the original error as its `cause`.

### What the offline suite covers

| File                                                                                                                                                  | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/credentials.test.js`                                                                                                                            | save/load/delete, 0600 perms, corrupt-file tolerance, per-account isolation                                                                                                                                                                                                                                                                                                                                                                        |
| `unit/accounts.test.js`                                                                                                                               | registry CRUD, the "newest login wins" active-flag rule, `wipeAccountDir`, `removeAccount`, lock refusal, **no credential residue after purge**                                                                                                                                                                                                                                                                                                    |
| `unit/daemon-channel.test.js`                                                                                                                         | The loopback channel a daemon serves: descriptor lifecycle, token rejection, stale-pid cleanup, dead-port fallback, and that the daemon's _current_ api is used after a reconnect. Plus the `sync` stage routes — progress streaming while the stage is still running, the one-sync-at-a-time guard, uploads still served during a sync, NDJSON reassembly across a split write, and the rule that only a truly absent daemon reads as "no daemon" |
| `unit/sync-v2-plan.test.js`                                                                                                                           | What one `zalo-agent sync` run does: at most one phone prompt across every stage combination, one socket window, a running daemon never evicted — and, when that daemon lends its socket, that the run never both hands off _and_ opens one of its own                                                                                                                                                                                             |
| `unit/sync-v2-conv-state.test.js`                                                                                                                     | Pinned/unread state with the live-measured shapes: `g`/`u`-prefixed pin ids, unread ids rounded past 2^53 and matched only when unique                                                                                                                                                                                                                                                                                                             |
| `unit/sync-v2-restore-success.test.js`                                                                                                                | A confirmed restore records success and resolves only the gaps its window covered, so the debounce stops re-pinging the phone                                                                                                                                                                                                                                                                                                                      |
| `unit/sync-socket-rules.test.js`                                                                                                                      | Static: `sync.js` starts a listener only in `connectListener`, the unified run never calls an exiting `run*` body, and no `run*` command opens a socket without first asking whether a daemon already holds one                                                                                                                                                                                                                                    |
| `unit/packaging.test.js`                                                                                                                              | The published tarball must carry a _patched_ zca-js on every install path: zca-js pinned to the exact version its patch file names, that patch bundled via `bundleDependencies`, applied by `prepare`, and no install script that would need a devDependency in a consumer's tree                                                                                                                                                                  |
| `unit/zca-api-surface.test.js`                                                                                                                        | Every `getApi().<method>()` in `src/` names a method zca-js actually exposes (parsed from `dist/apis.js`) — catches typo'd or renamed calls the offline suite otherwise cannot reach                                                                                                                                                                                                                                                               |
| `unit/thread-type.test.js`                                                                                                                            | Filling `--type` from the cache: promotion, explicit-flag precedence, threadId found by argument name                                                                                                                                                                                                                                                                                                                                              |
| `unit/lock.test.js`                                                                                                                                   | `daemon.lock` in every state: absent, live, stale, corrupt, foreign-owned                                                                                                                                                                                                                                                                                                                                                                          |
| `unit/db.test.js`                                                                                                                                     | schema + WAL, the "not initialized" guard on all 11 exports, upsert/COALESCE semantics, ordering, paging, `sync_state`, `sync_gaps`                                                                                                                                                                                                                                                                                                                |
| `unit/mcp-config.test.js`                                                                                                                             | defaults, the nested deep-merge for `notify`/`limits`/`media`, `parseDuration` (never returns NaN)                                                                                                                                                                                                                                                                                                                                                 |
| `unit/oa-client.test.js`                                                                                                                              | OA storage is a _separate_ directory from personal creds, multi-OA namespacing, OAuth URL building, message-type path-injection guard                                                                                                                                                                                                                                                                                                              |
| `unit/image-metadata.test.js`                                                                                                                         | `readImageMetadata()` across PNG/JPEG/GIF/WebP/BMP/TIFF, all 8 EXIF orientations, descriptive-throw contract, plus fixture SHA-256 integrity                                                                                                                                                                                                                                                                                                       |
| `unit/pure-helpers.test.js`                                                                                                                           | every bank alias round-trips, `maskProxy` never leaks, `extractMessageText` priority + circular safety, fingerprint internal consistency, `isNewerVersion` semver edges                                                                                                                                                                                                                                                                            |
| `unit/sync-backfill.test.js`                                                                                                                          | `backfillOverSocket()` against a fake listener: batch accumulation, per-thread-type routing, timeout/`request-failed` exits, gap resolution                                                                                                                                                                                                                                                                                                        |
| `unit/sync-freshness.test.js`                                                                                                                         | `checkSyncFreshness()` — the one-hour debounce, the `--force` override, and the pending-gap escape hatch that defeats the debounce                                                                                                                                                                                                                                                                                                                 |
| `unit/sync-v2-decode.test.js`                                                                                                                         | transfer-sync-v2 pure decode path: `splitChunks()` length-framing (including a declared length that overruns the buffer), `decodeFrame()` across `encrypt` 0/1/2/3                                                                                                                                                                                                                                                                                 |
| `unit/mentions.test.js`                                                                                                                               | `@[uid]` expansion — UTF-16 (not byte) offsets on accented Vietnamese and emoji, `@[-1]` → `@All`, style shifting across an expansion — and the `--quote` payload rebuild, including the refusals for a photo/sticker/file and a cross-thread msgId                                                                                                                                                                                                |
| `cli/surface.test.js`                                                                                                                                 | **the full command manifest** — every group, subcommand and behavior-changing flag                                                                                                                                                                                                                                                                                                                                                                 |
| `cli/validation.test.js`                                                                                                                              | every guard that fires before a network call                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/parse-options.test.js`                                                                                                                          | `parseIntOption` — Commander passes an option's DEFAULT as `parseInt`'s radix, so `-l 20` silently paged by 40 and `-c 100` came back `NaN`. Nine command files import this to avoid that; it had no test at all                                                                                                                                                                                                                                   |
| `unit/mcp-tools.test.js`                                                                                                                              | the MCP tool registration contract — exactly the 12 documented names and no others, each schema's defaults and bounds, and the handlers against fakes. The machine-checkable twin of the tool list, which has drifted before                                                                                                                                                                                                                       |
| `unit/mcp-message-actions.test.js`                                                                                                                    | `zalo_react` / `zalo_undo` refuse, reaching no api at all, when the cliMsgId is neither passed nor cached, and otherwise hand zca-js `{msgId, cliMsgId}` from the cache; `zalo_send_message`'s `urgency` maps as `msg send --urgency` does and `me` resolves to My Documents' `send2me_id` as a 1-1                                                                                                                                                |
| `unit/mcp-lookup-tools.test.js`                                                                                                                       | `zalo_get_group_members` (cache names first, one batched Zalo lookup of 50 per request for the rest, a missing group is an error), `zalo_list_conversations` (newest first, `limit` per type) and `zalo_coverage` (pending gaps from a real `sync_gaps`, the resolved count, and a `sync --from` dated from the oldest gap's day)                                                                                                                  |
| `unit/conv-recent-group-members.test.js`                                                                                                              | `conv recent`'s cache path and `group members` pinned as they print, through the offline session — their logic is shared with `zalo_list_conversations` and `zalo_get_group_members`, and neither command had a test that read its output                                                                                                                                                                                                          |
| `unit/read-state.test.js`                                                                                                                             | read state other devices report (M4): which `clearUnreads` rows are conversation reads, the 601 `mark_unread` control, a watermark that only moves forward and compares ids as integers, all driven through the real socket tap; `listen` and `mcp start` both build it                                                                                                                                                                            |
| `unit/mcp-read-state.test.js`                                                                                                                         | the account's own read state on Zalo in the MCP: `readOnZalo` on `zalo_get_messages`, `readState` on `zalo_list_threads` and `zalo_list_conversations`                                                                                                                                                                                                                                                                                             |
| `unit/live-api.test.js`                                                                                                                               | the MCP tools and the notifier call the current session after a re-login, not the start-up one (`liveApi`), and `mcp start` hands them that                                                                                                                                                                                                                                                                                                        |
| `unit/qr-display.test.js`                                                                                                                             | JSON-mode QR output. **Lived in `src/utils/` with no sandbox**, where it created and unlinked `qr.png` inside the developer's REAL `~/.zalo-agent-cli/` on every `npm test`                                                                                                                                                                                                                                                                        |
| `unit/output-latch.test.js`                                                                                                                           | the once-only JSON error latch — first `error()` is the payload on stdout, every later one goes to stderr so `\| jq` keeps working. Only reachable in-process, which is why the `_resetErrorLatch` seam existed for a test nobody had written                                                                                                                                                                                                      |
| `unit/security-surfaces.test.js`                                                                                                                      | the three surfaces that sat at 0% function coverage: `openFile()` refusing a shell metacharacter (the path is built from a Zalo-supplied filename and the Windows branch uses a shell), the QR server's `0.0.0.0` bind guard, and MCP bearer auth incl. `--auth ""` starting an UNAUTHENTICATED server                                                                                                                                             |
| `cli/sandbox-discipline.test.js`                                                                                                                      | static guard: no offline test may reach `credentials.js` without importing `helpers/sandbox.js` **first**. `CONFIG_DIR` is frozen at module-eval from `os.homedir()`, so a later import is too late and fails silently                                                                                                                                                                                                                             |
| `unit/sync-*.test.js`, `unit/live-store`, `unit/daemon-channel`, `unit/msg-forward`, `unit/send-client-id`, `unit/quote-sender`, `unit/mcp-normalize` | the sync-v2 / daemon / live-capture suites, added alongside that surface. Sixteen files not individually described here — read the docblock at the top of each; they are written to be read in that order                                                                                                                                                                                                                                          |

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

**4. The session is confirmed before any tier writes.** `assertDisposable()`
guards thread ids and is blind to _identity_, and tiers 5c–5e are not
thread-scoped at all — so `gate()`, which only reads env flags and the shape
of `targets.json`, was the only thing between `--tier 5 --destructive` and a
`group disperse` on an account nobody had checked. Tiers 2–5 now call
`assertSession()` first (memoised, one round trip per run).

**3. Additive env gates.** A bare `npm test` cannot reach a network call; a
bare `npm run test:e2e` cannot end your session.

`run-e2e.js` **strips all three gate variables from the environment** it
passes down and then sets them from its own flags. It used to spread
`process.env` and only ever add, so an ambient `ZALO_TEST_END_SESSION=1`
left over in a shell passed straight through to the real-logout tier — and
the banner keys off the flag variable rather than the environment, so
nothing warned. An inherited value is now discarded and named on stderr.

| Gate                        | Unlocks                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `ZALO_TEST_LIVE=1`          | tiers 1–4                                                                                 |
| `+ ZALO_TEST_DESTRUCTIVE=1` | tier 5a–5d (conversation wipe, group disperse + recreate, history wipe, reversible purge) |
| `+ ZALO_TEST_END_SESSION=1` | tier 5e (real logout / purge — **requires a QR re-scan**)                                 |

`run-e2e.js` sets these for you based on its flags; you rarely set them by hand.

`ZALO_TEST_SYNC_MOBILE` is the exception — `run-e2e.js` never sets it. It gates
`sync-mobile --legacy`, the old phone-transfer path. Set it by hand, once,
when the phone's owner is expecting it:

```bash
ZALO_TEST_LIVE=1 ZALO_TEST_SYNC_MOBILE=1 node --test tests/e2e/tier3-mutate-restore.test.js
```

`sync-mobile --socket` needs no phone at all, and runs in tier 3 under plain
`ZALO_TEST_LIVE=1`. It must keep the flag: the phone-backed restore is now
`sync-mobile`'s default, so a bare invocation in that tier would wake the
owner's phone and wait for a human to tap.

**`sync-mobile --transfer` has no automated coverage at any tier**, and that is
deliberate. It is the one command whose whole purpose is to wake the owner's
phone and wait for a human to tap "ĐỒNG BỘ NGAY" — there is nothing a test
harness can assert without a person holding the device, and an unattended run
just leaves an unanswered prompt. It lives in the [manual
checklist](#sync) instead. What _is_ automated:

| Layer                               | Covers                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tests/cli/surface.test.js`         | that `--transfer` is registered at all (`FLAG_CONTRACT["sync-mobile"]`)                                 |
| `tests/unit/sync-v2-decode.test.js` | the pure decode chain — `splitChunks()` length-framing, `decodeFrame()` across all four `encrypt` modes |
| `tests/unit/sync-freshness.test.js` | the debounce that stops `--transfer` re-pinging the phone                                               |

The socket backfill logic itself is covered against a fake listener in
`tests/unit/sync-backfill.test.js`.

> **Known gap.** `tests/cli/validation.test.js` has offline guards for `--force`
> and `--legacy` (boolean-flag parsing, unknown-flag rejection, the no-account
> exit) but **none for `--transfer`**. Nothing offline asserts that
> `sync-mobile --transfer` stops at the account guard before opening a socket,
> or that `--transfer --force` parses as two flags rather than `--transfer`
> swallowing the next argument. Those are cheap to add and belong next to the
> existing `--legacy` cases.

### Setup

```bash
cp tests/targets.example.json tests/targets.json
# then edit tests/targets.json
```

`targets.json` is gitignored. It must name:

- `home` — the throwaway config directory the live suite is allowed to drive
  (this is what `USERPROFILE`/`HOME` are set to for every CLI subprocess).
  **Required, and validated**: a missing key, a path that does not exist, or
  your real home directory all refuse the run outright. It used to be
  unvalidated and fell back to `process.env.USERPROFILE`, so anyone who
  copied `targets.example.json` on another machine and deleted the
  machine-specific line rather than editing it silently pointed the
  destructive tiers at their own account.
- `accountOwnId` — the account the suite expects to be logged in as. A
  mismatch aborts before anything is written: tier 1 probes it, and tiers
  2–5 each call `assertSession()` in a `before()` hook, so a `--tier 5` run
  cannot disperse a group without first confirming whose account it is on.
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
node tests/run-e2e.js --destructive       # tiers 1–5d
node tests/run-e2e.js --end-session       # tiers 1–5e  ⚠ QR re-scan needed
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
note, a quick message, an auto-reply rule, a catalog. Nearly every created
id is recorded in `tests/.artifacts.json` for tier 4 to clean up — the
exceptions are **polls and the pinned group note, which no command in the
product can delete**. zca-js exposes `createPoll` / `lockPoll` / `vote` /
`unvote` / `share` / `addOptions` / `getPollDetail` and no delete, and
`group` has `note-create` / `note-edit` and no delete. Tier 4 therefore
_locks_ the polls it finds (the same end state tier 3 settles for) and the
only thing that truly removes them is tier 5b's disperse-and-recreate.
Running tier 2
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

The two message deletes are **different operations** and both are asserted:
`msg delete` removes a message from your own view only
(`deleteMessage(dest, onlyMe=true)`), while `msg undo` recalls it for everyone
(what the phone app calls "Thu hồi"). Both need the message's `cliMsgId`,
which is client-generated and cannot be derived from the `msgId` — but only
`msg undo` needs it supplied: both commands fall back to
`cachedMessageById()` when `-c` is omitted, which is how an ATTACHMENT gets
recalled at all. zca-js never stamps a `cliMsgId` onto an attachment
response, so tier 2 records those on `msgId` alone and forces a history
fetch so the row reaches `zalo.db`.

Step 2 also **locks** every poll the ledger holds. Locking is not deletion;
it is the only closure the product has (see the cleanup note above), so a
tier-4 run leaves polls closed but present.

`conv delete` **used to be step 4 here** and has moved to tier 5a. Execution
order was never the problem — blast radius was. Wiping a conversation
destroys history with no undo, and tier 4 runs on a bare
`npm run test:e2e`, which put permanent history loss behind `ZALO_TEST_LIVE=1`
— the same gate that unlocks read-only tier 1.

**Tier 5 — irreversible.** Split by how hard each step is to come back from:

- **5a** `conv delete` — permanently wipes a thread's history, for the group
  and the DM. First within tier 5 because it costs messages, not the group.
  The tier then asserts the thread survived: same name, same members, still
  writable, and a second delete is idempotent.
- **5b** `group disperse` → **immediately recreate** with the same name and
  members, then write the new id back into `targets.json`. The old group id
  dies forever; the group itself is restored. If disperse succeeds but
  recreation fails, the tier prints a loud `MANUAL ACTION REQUIRED` notice.
- **5c** `logout --no-remote --delete-history` — wipes `zalo.db`, `media/`
  **and the saved credentials**, then asserts nothing auto-logs-in. Backed up
  and restored like 5d, so no QR re-scan.
- **5d** `logout --no-remote --purge` — exercises the **entire** purge
  filesystem path (credential deletion, account-dir wipe, registry drop) while
  leaving the _server_ session valid, because `--no-remote` skips the server
  call. The suite backs the credential up first and restores it after, then
  asserts the session is actually back. This proves the purge code works
  **without costing a QR re-scan** — which is why it is separate from 5e.
- **5e** real `logout` then `logout --purge` — runs the server logout and
  deletes the credentials. **Nothing restores this**; you must scan a QR code
  on your phone. Behind its own gate, last.

Every `logout` deletes the saved credentials since 2026-09-30, so none of them
is safe outside tier 5's backup. What they do at Zalo was measured that day:
the logout calls end only this device's session _key_ — with the credentials
kept, the next command logged straight back in, and the phone kept listing the
web session as signed in. The login ends at Zalo only when the web session is
removed from the phone's device list. Tier 4 used to run `logout --no-remote`
as a harmless no-op; that no-op was the bug, and tier 4 no longer logs out.

### Transient failures

Zalo's unofficial endpoints intermittently answer 404/5xx or drop a
connection. Tier 1 routes its reads through `retryRead()`, which retries up to
3 times on a transient-looking error only. A genuinely retired endpoint fails
every attempt, so real breakage is never masked. **Writes are never retried** —
a retried send delivers the message twice.

### Known issues

Live behaviour that is wrong or unavailable for reasons outside this code.
Each is a `todo` plus a characterization test, per **Marking a defect rather
than a failure** below. Confirmed against the live account on 2026-09-29.

| What            | Symptom                           | Why it is not a failure here                                                                                 |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `friend online` | HTTP 404                          | zca-js calls a route Zalo retired. CLI surface is fine.                                                      |
| `friend close`  | HTTP 404                          | Same.                                                                                                        |
| `group history` | HTTP 404 on `getGroupChatHistory` | Same. `msg history` falls back to the socket.                                                                |
| `sync-cloud`    | `Invalid CloudViewerKey`          | zCloud appears not to be enabled on this account. The CLI reports it cleanly and names both possible causes. |
| `msg send-bank` | send returns an empty body        | Zalo answers with no payload, so there is no msgId or cliMsgId to record — see the bank-card section above.  |

Promote an entry the moment its characterization test fails: that is the
signal the behaviour changed.

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

### Recalling anything you sent needs a patched zca-js

`msg undo` and `msg delete` both refuse to run without a `cliMsgId`, and
`cliMsgId` is client-generated — nothing derives it from a `msgId`. For a
plain text send the CLI reports it; for an **attachment** it did not, so tier 4
once finished a run with 24 images and files it had sent itself and could not
clean up.

Two things fixed that, and both have to hold:

- `patches/zca-js+2.2.0.patch` stamps every attachment response, not just
  `responses.message`. Upstream stamps only the latter, and for a single
  jpg/jpeg/png/webp the caption folds into the attachment so `responses.message`
  is `null` — leaving the send with no id anywhere.
- `msg send-image` / `msg send-file --json` surface them as `sent: [{msgId,
cliMsgId}]`, which is what `rememberSent()` in tier 2 writes to the ledger.

A fresh `npm i` whose `prepare` script did not run gets an unpatched zca-js and
silently loses this. `tests/unit/send-client-id.test.js` fails in that state
rather than letting the next live run discover it.

### Cleanup has exactly one chance

Zalo's recall window closes. Four `[e2e]` artifacts left in the DM target on
2026-09-21 — two PDFs, a photo and a reminder card — could not be recalled on
2026-09-29: every one answered `Lỗi không xác định`, while a message sent
minutes earlier in the same thread recalled cleanly. Their `cliMsgId` was
present in the cache the whole time, so this is a server-side time limit, not
a missing id.

The consequence is that **tier 4 cannot be deferred**. A run that sends to the
DM and does not reach tier 4 leaves debris in a real person's chat
permanently; `msg delete` would only hide it from our side, which is worse.
`tests/run-e2e.js` prints `MANUAL CLEANUP REQUIRED` when the ledger survives a
run that skipped tier 4 — treat it as urgent, not advisory.

### One send type still cannot be tracked: bank cards

`msg send-bank` is the exception. Zalo answers the bank-card endpoint with an
empty body, so `utils.resolve()` yields `""` — there is no object to stamp and
no `msgId` to record either. The patch is in `sendBankCard.js` anyway, for the
day that changes, but today a bank card is invisible to the ledger and tier 4
cannot recall it.

Verified 2026-09-29: the message really is delivered, and a running `listen`
DOES see it (`chat.webcontent`, with both ids), so the ids exist — they just
never come back on the send. Recall works fine once you have them.

This is contained on purpose: tier 2 sends bank cards to the **group only**
(`-t 1`, `T.group.threadId`), never to the DM, so the one artifact type that
cannot be cleaned up can never land in a real person's chat. Tier 5a disperses
and recreates the group, which is what actually clears them. **Keep it that
way** — a bank-card test pointed at the DM would leave permanent debris.

### What a passing `undo` does and does not prove

Zalo's **group** recall endpoint keys on `msgId`: a wrong-but-plausible
`cliMsgIdUndo` still recalls the message, and still answers `{"status": 0}`.
An id shaped like a `msgId` rather than a timestamp is rejected outright. So
`status: 0` alone is not evidence that the right message went away — it was
returned for a deliberately wrong id in testing.

Ground truth is the server's own push: with `listen` running, a real recall
emits `{"event":"undo", "msgId": …, "applied":true}`, and a one-sided delete
emits `deleted_for_me`. Prefer that over the REST history, which lagged by a
full day when this was measured and did not show messages sent minutes
earlier.

The DM recall endpoint is a different URL (`/api/message/undo`) and may well
validate the id. It is deliberately **untested** — the only DM target is a real
person's chat, and attachments are never sent there.

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
- **Restore to state you CAPTURED, never to an assumed default**, and assert
  the restore landed. `runCli()` never rejects, so a discarded restore result
  is a restore you are not doing.

### Write an assertion that can FAIL

The most expensive class of bug in this suite is not a missing test — it is
a test that passes no matter what the command does. Two CLI behaviors make
it easy to write one by accident:

- **API failures are caught and printed, not thrown.** Every handler is
  `try { … } catch (e) { error(e.message) }`, and `error()` writes
  `  ✗ <msg>`. So `assert.doesNotMatch(r.all, /at Command\.|Unhandled/)`
  — "it didn't crash" — is true for a command that fails on every single
  invocation. `msg delete` and `msg forward` were each broken for their
  entire lives behind exactly that assertion.
- **stdout is never empty.** The unofficial-API disclaimer goes to stdout in
  human mode, so `r.stdout.trim().length > 0` is a constant. A tier-3 helper
  combined both of these and silently covered 19 call sites with nothing.

So: assert `errorLineOf(r.stdout) === null` **and** `hasSuccess(r.stdout)`,
or use `runJson()` and assert `r.ok`. When a refusal is legitimate (`conv
hide` with no PIN set), allow _that specific message_ explicitly rather than
widening the success condition. And prefer asserting an observable
consequence — the option appears in `poll info`, the id lands in the ledger —
over asserting that the command merely ran.

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
- [ ] `listen --events read`, then open a disposable thread on the phone — a `read` event names that thread, and `conv_state.lastReadMsgId` moves; mark it unread on the phone — an `unread_mark` event (the triage's probe 3; not yet measured)
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
- [ ] `sync-mobile --transfer` — one phone confirm, then restores history into zalo.db with real thread names
- [ ] `sync-mobile` while `listen` is running — refuses, naming the lock
- [ ] `sync-mobile` while Zalo Web is open — reports the one-web-session rule
- [ ] `sync-mobile --legacy` — one attempt, then reports it returned nothing
- [ ] `sync-mobile --legacy --force` — skips the debounce
- [ ] Kill `listen`, wait >30s, send a message to a disposable thread, restart — the gap is recorded,
      and the self-heal brings the message back (`[catch-up]`) and resolves it; with `--no-self-heal`
      it stays pending, and the printed `sync --from <date>` is what closes it

### MCP server

- [ ] `mcp start` — stdio transport; logs on stderr only, stdout carries only JSON-RPC
- [ ] `zalo_get_messages` — `since` excludes already-seen messages
- [ ] `zalo_send_message` — returns `{success, messageId}` and actually delivers
- [ ] `zalo_list_threads` — unread counts match `zalo_get_messages`
- [ ] `zalo_search_threads` — finds a Vietnamese name with accents stripped
- [ ] `zalo_mark_read` — the cursor is global, not thread-scoped
- [ ] `zalo_get_history` — paginates via `lastMsgId`
- [ ] `zalo_view_media` — opens a cached attachment, and downloads an uncached one
- [ ] `zalo_send_message` with `urgency: "urgent"` shows the Urgent badge in the app; `threadId: "me"` lands in My Documents
- [ ] `zalo_react` — the reaction appears on the message for the other side (Zalo answers success for a reaction it never shows, so look at the app)
- [ ] `zalo_undo` — your message is recalled for the other side too
- [ ] `zalo_get_group_members` — names match the app's member list, including members who never posted
- [ ] `zalo_list_conversations` — the order matches the app's recent list
- [ ] `zalo_coverage` — stop `mcp start` for a minute and restart it with `--no-self-heal`: the gap is listed; once the printed `sync --from` run completes, it counts as resolved
- [x] ~~`mcp start --http <port> --auth <token>` — requests without the bearer token are rejected~~
      — now automated in `tests/unit/security-surfaces.test.js`, along with a
      wrong token, a prefix of the right one, and the empty-string case where
      `--auth ""` starts an **unauthenticated** server while logging success
- [x] ~~`GET /health` — responds **without** a token~~ — automated there too
- [ ] `mcp start --http <port>` binds `127.0.0.1` only; `--host 0.0.0.0` makes it reachable
      (the _default_ is asserted offline; that a LAN bind is genuinely
      reachable from another host still needs a second machine)
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
