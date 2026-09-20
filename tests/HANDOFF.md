# Session handoff — 2026-09-19 → 2026-09-20

Written to survive context truncation. If you are picking this up cold, read
this file, then [NOTES.md](NOTES.md) for the measured findings and
[README.md](README.md) for how to run the tests.

---

## What this work was

Build a full test suite for `zalo-agent-cli` under `tests/`, then fix what it
found. Live tests run against a real Zalo account with disposable targets.

**Test counts:** 649 offline tests, 0 failures, 0 todos. Live tiers 1–4 all
passed as of the last full run. Gates (`format`, `lint`, `format:check`,
`test`) all green.

---

## Current state — READ THIS FIRST

| Thing                | State                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CLI session          | Logged in (QR scanned 2026-09-20 ~15:07). May be revoked if Zalo Web was opened since.                                         |
| Zalo Web             | Signed out by the CLI login. The two cannot coexist — see NOTES.md.                                                            |
| `tests/targets.json` | Group `4546985820537230880`, DM `4025260187856951526` (Tiểu Hồ). Gitignored.                                                   |
| Uncommitted work     | **Everything.** Nothing has been committed yet. Two commits were requested: test-suite changes and source changes, separately. |
| `sync-mobile`        | **BROKEN and UNVERIFIED** — see below. Do not run it casually; every attempt notifies the user's phone.                        |

### Hard rules learned the hard way

1. **Never run `sync-mobile` without explicit, immediate permission.** Each
   attempt pushes a notification to the owner's phone. This was violated three
   times in one session. The live test for it is gated behind
   `ZALO_TEST_SYNC_MOBILE=1` and must stay that way.
2. **Zalo allows one web session per account.** `zalo-agent login` signs Zalo
   Web out and vice versa — instantly, server-side, with no socket involved.
   Measured. See NOTES.md § One web session per account.
3. **`status` is not a liveness check** — it reads local files only. Use
   `whoami`.
4. **Never run `zalo-agent login` from an elevated shell.** It makes the
   credential file owned by Administrators and undeletable by the normal user,
   which breaks `logout --purge` with EPERM.

---

## Open work, in priority order

### 1. `parseInt` as a commander coercion — CODEBASE-WIDE BUG, partially fixed

```js
.option("-c, --count <n>", "Page size", parseInt, 100)
```

Commander calls the coercion as `fn(value, previousValue)`. JS
`parseInt(str, radix)` treats that second argument as a **radix**, so the
option's default becomes the radix:

| Invocation                 | Actually evaluates     | Result                  |
| -------------------------- | ---------------------- | ----------------------- |
| `friend alias-list -c 100` | `parseInt("100", 100)` | `NaN`                   |
| `profile avatars -c 50`    | `parseInt("50", 50)`   | `NaN`                   |
| `catalog list -l 20`       | `parseInt("20", 20)`   | **40** — silently wrong |

**This invalidates an earlier claim in NOTES.md** that
`friend alias-list -c/-p` failing with `Tham số không hợp lệ` was an upstream
Zalo defect. It was ours — we sent `NaN`. That NOTES.md row must be corrected.

Every `.option(..., parseInt, <default>)` call site needs a safe integer
coercion instead. Grep: `grep -rn "parseInt," src/commands/`.

### 2. `sync-mobile` does not work

Even after the user completed the phone-side sync (Settings → Sync Messages →
Sync Now), every `pullMobileMsg` returned `No session token returned`. Cause
unknown. Suspect: the RSA sync keys under `accounts/<ownId>/sync/` were wiped
by `logout --purge` and the new keypair is not registered with Zalo, so the
phone has nothing to encrypt to.

Two bugs already fixed in `src/commands/sync.js`:

- **Overlapping polls.** It used `setInterval(async …, 5000)`, which does not
  await its callback; `pollSync()` takes longer than 5s, so attempts stacked
  and the phone got several _simultaneous_ pushes per tick. Now a sequential
  `for` loop.
- **No user control.** Added `--wait <seconds>` and `--interval <seconds>`
  (default 10s, raised from 5s). NOTE: these are themselves affected by bug #1
  above — `--wait 90` was silently ignored and ran the 120s default.

### 3. Listener / cache coherence (the original ask)

See NOTES.md § The listener. Summary:

- Four sites open the socket; **only `listen` takes `daemon.lock`**.
  `mcp start` opens a second persistent socket without checking.
- `msg history` calls `insertMessage()` but never `upsertThread()`, so the
  `threads` table stays empty and `conv recent` falls through to a meaningless
  live ordering. **This is the single highest-value fix and is independent of
  everything else.**
- Auto-start cannot be delivered as originally asked, because the CLI cannot
  coexist with Zalo Web at all — the collision precedes any socket.

### 4. Test-coverage audit

Requested but not done: a careful pass over every command's option
combinations and cross-paths. Bug #1 above is exactly the class of thing that
audit would catch, so do it after fixing the coercion.

---

## Fixes already made (all uncommitted)

**Source (`src/`):**

| File                              | Fix                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands/group.js`               | `changeGroupName(name, groupId)` — arguments were swapped, so rename ALWAYS failed                                                                  |
| `commands/poll.js`                | `--expire` sent a duration where Zalo wants an absolute epoch                                                                                       |
| `commands/auto-reply.js`          | `--start`/`--end` defaulted to `0`, which Zalo rejects; now now / +1 year                                                                           |
| `commands/msg.js`                 | `msg history` called `getApi()` above its own no-account guard → raw stack trace                                                                    |
| `commands/msg.js`                 | `send-file`/`send-image` hung forever on non-inline formats (no WebSocket listener); extracted shared `sendAttachments()`, added `--upload-timeout` |
| `commands/conv.js`                | `conv delete` called non-existent `deleteConversation`; real API is `deleteChat(lastMessage, threadId, type)`                                       |
| `commands/conv.js` + `friend.js`  | `new Date(t * 1000)` on an epoch-ms field printed **year 58687**                                                                                    |
| `commands/conv.js` + `core/db.js` | `--groups-only`/`--friends-only` applied the limit before the type filter, so asking for 5 groups often returned 0                                  |
| `core/zalo-client.js`             | Replaced hand-rolled image header parsing with `image-size`; added EXIF orientation transpose; throws instead of returning null                     |
| `utils/output.js`                 | `--json` now emits `{"error": …}` on stdout and sends human chatter to stderr                                                                       |
| `utils/qr-http-server.js`         | `server.unref()` (orphan held port 18927 for hours); binds **127.0.0.1** unless `--qr-url` — it was publishing the login QR to the whole LAN        |
| `commands/sync.js`                | Sequential polling; `--wait`/`--interval`                                                                                                           |

**New dependency:** `image-size@2.0.4` (MIT, zero transitive deps).

**Tests (`tests/`):** helpers, fixtures (real media + SHA-256 integrity),
`unit/`, `cli/`, tiered `e2e/`, `run-e2e.js` orchestrator. See README.md.

---

## How to run things

```bash
npm test                              # 649 offline tests, no session needed
npm run test:e2e                      # live tiers 1–4
node tests/run-e2e.js --destructive   # + tier 5a–5c
```

Live tiers need `tests/targets.json` and a working session. Tier 5d ends the
session. `ZALO_TEST_SYNC_MOBILE=1` is required for the sync test and pings a
real phone.
