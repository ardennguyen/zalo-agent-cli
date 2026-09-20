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
| `sync-mobile`        | **Rewritten 2026-09-20.** Default path backfills over the WebSocket and never touches the phone; only `--legacy` does.         |

### Hard rules learned the hard way

1. **Never run `sync-mobile --legacy` without explicit, immediate permission.**
   That path pushes a notification to the owner's phone. It was violated three
   times in one session, back when it was the default and looped for two
   minutes. It is now opt-in, runs once, and its live test stays gated behind
   `ZALO_TEST_SYNC_MOBILE=1`. The default `sync-mobile` is phone-free.
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

### 2. `sync-mobile` — HARM FIXED, SYNC STILL IMPOSSIBLE (2026-09-20)

The endpoint it was built on is retired. Measured directly against the live
Zalo Web client: `/api/message/pull_mobile_msg` and `/api/message/get_crossdb`
still exist in Zalo Web's bundle but have **zero call sites** across all 4,642
loaded modules. The empty return was the endpoint being dead, not the phone
being slow — so the two-minute retry loop could never have worked, and every
retry notified a real person.

Current Zalo syncs over the WebSocket instead (`transfer-sync-v2`: cmd 590
request / 591 dispose / 592 mobile wake-up, libsignal-encrypted).

**Read this before trusting the new command.** The first version of this fix
assumed a freshly-wiped Zalo Web client restores itself with plain old-message
pulls (cmd 510/511), which zca-js already supports. **That was a misreading of
the trace, and the live test caught it.** Measured twice — once via the CLI and
once with a probe using Zalo Web's exact `lastId` anchors — 510/511 return
**0 messages**. Zalo Web gets the same empty answer and falls back to
transfer-sync-v2.

So `sync-mobile` now: issues the free 510/511 probe, persists anything that
arrives, and **says plainly when the answer is empty**. The retired REST path
survives as `--legacy`, one attempt only. Full evidence, frame captures and
command map in [NOTES.md](NOTES.md) § Mobile sync.

**Do not read "it never touches the phone" as a feature.** The owner confirmed
that a real Zalo Web sync makes their phone show a request notification — the
phone is the data source, cmd 590 wakes it, and it encrypts the payload that
returns as cmd 601. A run that leaves the phone silent has not synced anything.
An earlier draft of this work got that backwards; NOTES.md § 5 has the detail.

**There is no working full-history sync in this tool today**, and there will
not be one until transfer-sync-v2 is implemented. What was fixed is the harm
(phone spam) and the dishonesty (reporting a dead path as a pending retry).

Still open, in order of value:

- **transfer-sync-v2** — the only path observed carrying any data, and so the
  only way to make this command genuinely sync. A project, not a patch:
  libsignal identity keypair, a session with the phone, and the `req.queries`
  partition descriptors, which were truncated in capture. See NOTES.md for the
  captured frames and the command map. Rewiring `listen`'s reconnect backfill
  is NOT worth doing before this exists — every available path returns empty.
- **`PUSH_MISS_MSG` (cmd 534) is invisible to zca-js** — its listener silently
  ignores unrecognized commands with no catch-all event. Exposing it needs a
  `patch-package` patch. Not done: the command was never observed carrying data,
  and shipping an unverified decoder is how this command broke originally.

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
