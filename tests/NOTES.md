# Test notes — findings, defects, and design decisions

Background material for [README.md](README.md), which is the test suite's
how-to. Nothing here is required reading to run the tests; it exists so that
a defect, a workaround, or a rejected design does not have to be rediscovered.

**Contents**

- [Known issues](#known-issues) — open, upstream, and environment
- [Fixed while building this suite](#fixed-while-building-this-suite)
- [Image metadata: why `image-size`](#image-metadata-why-image-size)
- [Ordering: conversations, history, friends and groups](#ordering-conversations-history-friends-and-groups)

---

## Known issues

Everything found while building this suite. Items that were **fixed** moved to
the section below; what remains here is either deliberate, upstream, or
account state.

Each open item is pinned by a `CHARACTERIZATION:` test asserting what the code
does today, so a change to that behavior fails a test rather than slipping
through.

### Open — in this codebase

| #   | Issue                                                                                                                                                                                                      | Where                  | Notes                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | **API failures exit 0.** Almost every action handler catches and calls `error()`, so `$?` is 0 even when the command did nothing. Only commander parse errors, `msg history` and `conv recent` set a code. | all of `src/commands/` | Same reasoning as above: a shell script checking `$?` today would start failing. Scripts must grep the output instead.                                          |
| 3   | **`db.js` exports no `closeDb()`**, so nothing can release the SQLite handle. On Windows an open handle makes `rmSync` fail with `EPERM`.                                                                  | `src/core/db.js`       | `unit/db.test.js` closes the handles `initDb()` returns to clean up its own temp dir. Worth keeping in mind for `logout --delete-history` and `account remove`. |

### Open — upstream (zca-js / Zalo)

| #   | Issue                                                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **`friend online` returns HTTP 404**                                                                                                                                                    | zca-js is calling a route Zalo has retired. The CLI surface is fine; the API is gone.                                                                                                                                                                                                                                                                                                                               |
| 6   | **`friend close` returns HTTP 404**                                                                                                                                                     | Same.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | **Self-chat is not a valid thread**                                                                                                                                                     | `msg send <ownId>` is rejected with `Tham số không hợp lệ` on both implicit and explicit `-t 0`. Worth knowing: "message myself" is a common automation idiom and it does not work here.                                                                                                                                                                                                                            |
| 9   | **No API creates a reminder from an existing message**                                                                                                                                  | `createReminder(options, threadId, type)` takes only `{title, emoji, startTime, repeat}` and posts to `board/topic/createv2`; `createNote` takes `{title, pinAct}`. Neither accepts a `msgId`, and no other zca-js API references one. The closest approximation is to read the message text (`msg history`) and pass it as the reminder title — which creates an unlinked reminder that merely quotes the message. |
| 10  | **Zalo caps auto-reply rules.** Creating one is refused while more than one already exists ("Bạn chỉ có thể chỉnh sửa khi tổng số tin trả lời tự động đang tồn tại không nhiều hơn 1"). | Account state, not a defect. The test account carries two rules from 2022, so `auto-reply create` legitimately refuses there. The tests accept either creation or this specific refusal.                                                                                                                                                                                                                            |
| 11  | **The upload-complete frame is occasionally dropped.** The non-image upload path waits on a WebSocket event that sometimes never arrives; the same send succeeds on retry.              | Bounded by `--upload-timeout` (default 120s) so it fails cleanly instead of hanging. The live tests pass a shorter budget so a transient stays legible.                                                                                                                                                                                                                                                             |

### Environment gotcha — logging in from an elevated shell

**Confirmed cause**, not speculation: running `zalo-agent login` from an
**elevated** PowerShell makes the credential file owned by
`BUILTIN\Administrators` instead of the user. It never receives the
`CREATOR OWNER` ACE a normally-created file inherits, so an unelevated session
is left with only `BUILTIN\Users: Write, ReadAndExecute, Synchronize` — write
but **no delete**.

Everything keeps working: login, auto-login, sending, even rewriting the
credential. The _only_ thing that breaks is deletion, so it surfaces solely as
`logout --purge` / `account remove` failing with:

```
✗ Purge failed while removing account data/credentials: EPERM: operation not permitted, unlink '…'
⚠ State may be partially removed — check with: zalo-agent account list
```

The CLI handles this correctly — it catches the error and warns rather than
dying with a stack trace. Diagnose with:

```powershell
Get-Acl "<config>\credentials\cred_<ownId>.json" | Format-List Owner, AccessToString
```

`Owner : BUILTIN\Administrators` confirms it. Fix by taking ownership:

```powershell
takeown /F "<config dir>" /R /D Y
icacls "<config dir>" /grant "%USERNAME%:(OI)(CI)F" /T
```

…or delete the credential as an administrator and run `zalo-agent login` again
from a **non-elevated** shell. **Prefer the latter, and prefer not logging in
elevated in the first place** — there is no reason this tool needs elevation.

Tier 5c's first assertion probes deletability of the real credential file (a
throwaway probe file is useless — a new file inherits `CREATOR OWNER` and
deletes fine regardless) and fails with this diagnosis, so it never again reads
as a product bug.

> **Related:** [AGENTS.md](../AGENTS.md) §13 records a 2026-09-18 "file-content
> anomaly" whose cause was left unidentified. A mundane explanation of this
> kind — an elevated shell, an editor, or an external handler re-saving a file
> — is worth ruling out before reaching for anything stranger. (A second
> instance during this work: `tests/fixtures/document.pdf` was rewritten in
> place by a PDF handler, which is why the fixtures now carry checksums.)

### Fixed while building this suite

**`--json` was not machine-readable on failure.** `error()` wrote `  ✗ <msg>`
to stdout regardless of mode, and commands calling `success()` after
`output()` — `msg send --react` — appended a human line AFTER the JSON. So
`| jq` broke on any failure and on one success path. Fixed in
`src/utils/output.js`: in machine mode stdout carries exactly one JSON value,
a failure is `{"error": "..."}`, and `success`/`info`/`warning` go to stderr.
`sync.js` progress ticks were routed the same way. Human mode is unchanged.
Exit codes remain an open issue — a `--json` consumer detects failure via the
`.error` key.

**`conv recent --groups-only` / `--friends-only` under-returned from cache.**
`getRecentThreads(limit)` took the newest N threads of ANY type and only then
filtered by type in JS, so asking for 5 groups returned the groups that
happened to fall within the newest 5 threads — usually fewer, often zero. `-n`
is documented as "max results per type" and the live path honored that; the
cache path did not. Fixed by filtering in SQL (`getRecentThreads(limit, type)`)
and fetching `limit` per type when neither flag is given. Six tests in
`unit/db.test.js`, one of which demonstrates the old behavior returning zero
groups.

**`msg send-file` hung forever.** zca-js's `uploadAttachment()` resolves its
internal promise synchronously for images, but for `video`/`others` it
registers a callback in `ctx.uploadCallbacks` and awaits a promise that **only**
`apis/listen.js:222` can settle, when the upload-complete frame arrives over
the WebSocket. `send-file` never started a listener, so the await never
settled — no output, no error, no timeout, killed at 120s. (`send-image` was
unaffected, which is why the bug hid.)

Fixed in `src/commands/msg.js` by bringing the listener up around the send,
adding `--upload-timeout` so a missed frame fails loudly, and exiting
explicitly because `listener.stop()` does not release every handle. `.txt` and
`.pdf` now both complete in ~3s. Guarded by three tests in
`e2e/tier2-create.test.js`, all capped at 45s so a regression fails rather
than stalls.

**`msg send-image` hung on any non-inline format.** Same root cause as send-file: zca-js routes by extension, so a `.bmp`/`.tiff`/`.heic` takes the "others" upload path and waits on a WebSocket frame — but `send-image` never started a listener. `send-image photo.bmp` hung with no output (killed at 91s); the identical file via `send-file` took 3s. Fixed by extracting a shared `sendAttachments()` that decides on the listener from the actual file paths rather than the command name, and warns when a format will arrive as a file rather than inline. Now ~3s. Guarded in `e2e/tier2-create.test.js`.

**`msg send-image` could not send WebP.** zca-js 2.0.0 dropped its `sharp`
dependency and now requires callers to supply their own `imageMetadataGetter`.
This project does supply one — `readImageMetadata()` in
`src/core/zalo-client.js`, wired in at the single `new Zalo()` site — but it
only recognized PNG, GIF and JPEG.

That matters because zca-js routes `.webp` through the **same** image upload
path as png/jpeg (`uploadAttachment.js`: `case "jpg": case "jpeg": case "png":
case "webp"`), and `getImageMetaData()` throws
`ZaloApiError("Failed to get image metadata")` on a `null` return. So
`msg send-image photo.webp` failed with that opaque message, while `sharp` —
the reference getter zca-js's own docs suggest — handles WebP fine.

Fixed by adding a RIFF/WebP branch covering all three container variants:
lossy `VP8 ` (14-bit fields behind a sync code, with scale bits masked off),
lossless `VP8L` (packed 14-bit pair after the `0x2f` signature), and extended
`VP8X` (24-bit canvas dimensions, so it handles images past 65535px). Verified
against a real 400×280 VP8X file and confirmed end to end with a live send.

Worth knowing about the neighboring paths, since they all funnel into the same
getter:

- **GIF does not use the image path.** `sendMessage.js` filters GIFs out into
  their own branch and calls `getGifMetaData()` — a different function that
  nonetheless calls the same `imageMetadataGetter`. So a getter that skips GIF
  breaks GIF sends even though GIF never reaches `uploadAttachment`'s image
  `case`.
- **Returning `null` is safe, not fatal.** zca-js converts it into a clean
  `ZaloApiError`. The getter should return `null` for anything it cannot
  parse rather than guessing dimensions.
- **The expected shape is `{width, height, size}`.** zca-js re-maps `size` to
  `totalSize` itself; returning `totalSize` directly would silently produce
  `undefined`.

**`group rename` always failed** with `Tham số không hợp lệ`. `group.js` called
`changeGroupName(groupId, name)` but zca-js declares
`changeGroupName(name, groupId)` — the arguments were swapped, so Zalo received
the group id as the new name. (`changeGroupAvatar(source, groupId)` on the next
command was always in declared order; rename was the outlier.) Fixed by
swapping them. Guarded by the rename test in `e2e/tier3-mutate-restore.test.js`,
which renames, verifies via `group info`, restores, and verifies again.

**`poll create --expire` always failed** with `Tham số không hợp lệ`.
`expiredTime` was computed as a _duration_ (`opts.expire * 60 * 1000`), but
Zalo wants an absolute epoch deadline — so 60 minutes read as Jan 1 1970.
Bisected at the time: `--expire` was the only one of the five poll flags that
failed. Fixed to `Date.now() + opts.expire * 60 * 1000`, with a test asserting
the echoed deadline is in the future.

**`auto-reply create` always failed on its defaults.** `--start`/`--end`
defaulted to `0`, which Zalo rejects, so the command could not succeed unless
the user guessed that two undocumented epoch values were mandatory. Fixed: an
unset start means "now", an unset end means one year out. Note the separate
account-state ceiling in **Known issues** #10 — Zalo refuses creation when more
than one rule already exists, which is not a defect.

**`msg history` printed a raw stack trace when logged out.** `const api =
getApi()` sat _above_ the `getActive()` / "No active account" guard, on a line
outside any try/catch, so the friendly message was unreachable and the
rejection went unhandled. Fixed by putting the guard first and wrapping the
`getApi()` call — matching how `conv recent` already did it.

---

## Image metadata: why `image-size`

zca-js 2.0.0 dropped `sharp` and now requires callers to supply
`imageMetadataGetter`. This project first hand-rolled one — four formats of
header parsing, returning `null` for anything else. That was the wrong call,
for two reasons that are worth recording so it does not get reverted:

**Zalo uses a denylist, not an allowlist.** `restricted_ext_file` is
`exe, cmd, bat, com, lnk, vbs, msi, vb, ws, wsf, scf, scr, pif, chm` — only
executables. Every image format is permitted, so a user can legitimately pass
`.bmp`, `.tiff`, `.heic` or `.avif`. Recognizing four formats and failing the
rest is backwards relative to what the server actually accepts.

**`null` is a bad return value.** zca-js turns a falsy result into a generic
`ZaloApiError("Failed to get image metadata")` that names neither the file nor
the reason. The getter now throws with both.

`image-size` (MIT, **zero dependencies**, pure JS) handles ~20 formats and has
a `imageSizeFromFile` entry point that reads incrementally rather than slurping
the file — which matters, because Zalo permits attachments up to 1 GB. `sharp`
was rejected as disproportionate: a ~30 MB native dependency with per-platform
prebuilt binaries, for a CLI that only needs four integers and never resizes
anything.

### The library is not enough on its own

`image-size` **reports** EXIF `orientation` but does not apply it. Orientations
5–8 are the 90° rotations, where stored and displayed dimensions are
transposed — the everyday case being a phone photo. Sending stored dimensions
there gives the recipient a sideways layout box.

So `readImageMetadata()` is a thin wrapper: image-size for parsing, plus the
orientation transpose, plus the real byte size, plus a descriptive throw. All
eight orientation values are covered in `unit/image-metadata.test.js`, against
JPEGs built with a real EXIF APP1 block.

> Building that test block is itself a trap worth noting: an IFD entry is
> tag(2) + type(2) + count(4) + value(4), so the value starts at offset **18**,
> not 16. Writing it at 16 corrupts the count field, and parsers then silently
> ignore the tag — which looked exactly like "image-size doesn't support
> orientation" until the block was fixed.

### What the getter does and does not cover

| Format                        |                      Reaches the getter?                      |      Renders inline in Zalo?       |
| ----------------------------- | :-----------------------------------------------------------: | :--------------------------------: |
| jpg, jpeg, png, webp          |                  yes — `getImageMetaData()`                   |                yes                 |
| gif                           | yes — `getGifMetaData()`, a separate path in `sendMessage.js` |                yes                 |
| bmp, tiff, heic, avif, svg, … |                            **no**                             | no — uploaded as a file attachment |
| mp4                           |                no — uses `getFileSize()` only                 |             as a video             |
| pdf, zip, txt, …              |                              no                               |        no — file attachment        |

The third row is the one that surprises people. zca-js routes on **extension**,
not on which command was called, so `send-image photo.bmp` takes the same
`"others"` upload path as `send-file doc.pdf` — the metadata getter is never
consulted. The image still uploads; it just arrives as a file. `send-image`
warns when that is about to happen rather than letting the command name
mislead.

**A metadata library therefore cannot make bmp/heic render inline.** Only
_transcoding_ to png/jpeg before upload would do that, and that needs a
converter — sharp — not a dimension reader. Not done; the warning is the
honest alternative. (HEIC would be awkward even with sharp: its prebuilt
binaries often ship without libheif.)

### Video needs no metadata at all

zca-js's `.mp4` branch calls `getFileSize()` only. `msg send-video` takes a
_URL_ plus an explicit `--thumb` URL and optional `--duration/--width/--height`,
so it never touches a local file. A local video can still be sent with
`msg send-file`, which takes the `"video"` upload path — verified with a 593 KB
`.mp4` in ~4s. A video probe (ffprobe, mp4box) would only be needed if
`send-video` grew the ability to take a local path and derive duration and
dimensions itself.

---

---

## Ordering: conversations, history, friends and groups

Zalo Web shows conversations newest-first by **last message in that chat**, and
orders search results by activity within the chat. This CLI does not match that,
and the reason is structural rather than a single bug.

### The root constraint

**zca-js exposes no conversation-list API.** There is no inbox, recent-chats or
thread-list endpoint — `getArchivedChatList`, `getPinConversations` and
`getHiddenConversations` are all filtered subsets, not the main list. Zalo Web
clearly has such an endpoint (it renders a sorted sidebar), but it is not
wrapped.

So nothing server-side tells this tool "here are your chats, most recent first".
Every ordering below is therefore reconstructed locally, and each
reconstruction is wrong in a different way.

### What each surface currently does

| Surface                            | Orders by                 | Verdict                                                       |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `conv recent` — cache path         | `threads.lastUpdate DESC` | **Correct**… but the table is almost always empty (see below) |
| `conv recent` — live path, friends | `lastActionTime DESC`     | **Meaningless** — see below                                   |
| `conv recent` — live path, groups  | `Object.keys(gridVerMap)` | **Unordered** — insertion order from Zalo                     |
| `friend list`                      | `lastActionTime DESC`     | **Meaningless**, same signal                                  |
| `friend search`                    | filter order              | **Unordered**                                                 |
| `group list` / `group list -q`     | `Object.keys(gridVerMap)` | **Unordered**                                                 |
| `msg history`                      | `timestamp DESC`          | **Correct** — newest first, both cache and live               |

### `lastActionTime` is not what the code assumes

Measured live against this account (1,714 friends):

```
friends with lastActionTime > 0 : 1714 of 1714
largest value                   : 1789817375625  (13 digits)
spread across the top 50        : 10 seconds
```

Two conclusions:

1. **It is epoch milliseconds, not seconds.** Both `conv.js` and `friend.js`
   render it as `new Date(t * 1000)`, which prints **year 58687**. That is the
   `lastActive: "8/8/58686"` you see in `conv recent` output today.

2. **It is not conversation activity, and not even per-friend presence.** Every
   single friend has a non-zero value and the top fifty are within ten seconds
   of each other — they are all stamped at roughly the moment `getAllFriends()`
   runs. It behaves like a phonebook-sync timestamp. Sorting by it produces an
   essentially arbitrary order that merely _looks_ like recency.

So `conv recent`'s live path is not "recent" in any sense, and `friend list`'s
"Last Activity" column is both wrongly dated and semantically empty.

### Why the correct path is almost never taken

`conv recent` reads `threads` from SQLite first and only falls back to the live
path when that table is empty. `threads` is populated by `upsertThread()` —
called from exactly two places, `listen.js` and `sync.js`.

`msg history` calls `insertMessage()` but **never** `upsertThread()`. Observed
on this account after several history fetches:

```
threads rows : 0
messages rows: 10
```

So unless the `listen` daemon has been running (or a mobile sync landed), the
good path has no data and every `conv recent` silently degrades to the
meaningless one.

### Suggestions, cheapest first

1. **Fix the ×1000 display bug.** `new Date(t)` not `new Date(t * 1000)` in
   `conv.js` and `friend.js`. One character each; removes an obviously absurd
   year from user-facing output.

2. **Have `msg history` upsert the thread it just fetched.** It already has the
   thread id, a name, and the newest timestamp. This alone makes `conv recent`'s
   correct path reachable through ordinary use rather than only via the daemon.

3. **Stop advertising an order that does not exist.** When `conv recent` falls
   back to the live path, either label the output (`ordered: "none"` in JSON, a
   warning line in human mode) or decline and point at `listen` / `sync-mobile`.
   Silently returning an arbitrary list under the name "recent" is the part that
   actively misleads.

4. **Sort `friend search` and `group list` deterministically.** Even
   alphabetical beats hash order, and when a cached `lastUpdate` exists for a
   thread, prefer it. Cheap, and makes output stable between runs.

5. **Seed the cache opportunistically.** For the top _N_ threads, a single
   `getGroupChatHistory` / history fetch per thread yields a real last-message
   timestamp. Expensive for 1,700 friends, reasonable for the 20–50 a user
   actually looks at.

6. **The real fix: wrap Zalo Web's conversation-list endpoint.** This belongs
   upstream in zca-js. It would give true server-side ordering, unread counts
   and last-message previews in one call, and would make items 2–5 unnecessary.
   Worth capturing the request against zca-js rather than accumulating more
   local approximations.

Items 1 and 2 are small and self-contained. Item 3 is a judgement call about
honesty versus convenience. Item 6 is the only one that actually matches Zalo
Web's behavior.

### How Zalo Web actually does it — measured, 2026-09-20

Logged into `chat.zalo.me` in a browser and inspected it directly. The
earlier suggestion in this section — "wrap Zalo Web's conversation-list
endpoint" — **was wrong. There is no such endpoint.**

A full page load of a logged-in session makes **zero REST API calls**. Every
request is a static asset or a worker script (`soc-worker`, `dal-worker`,
`opfs-worker`, `zd-worker`). Conversation data arrives over the WebSocket and
lands in IndexedDB.

The client keeps a database `zdb_<ownId>` whose relevant stores are:

| Store             | Key                                       | Carries                                                                               |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `conversation`    | `userId` (thread id, groups prefixed `g`) | `isGroup`, `pinned`, `topOut`, `label`, `numMsg`, `lastSmsLocalId` — **no timestamp** |
| `preview_message` | `convId`                                  | `messageTime` (epoch ms), `msgId`, `cliMsgId`, `fromUid`, `dName`                     |

`conversation` has **no indexes at all**, so nothing is sorted in the store.
The sidebar order is computed in memory by joining `conversation` →
`preview_message` and sorting on **`preview_message.messageTime` descending**,
with `pinned` lifted to the top.

Measured on this account: 191 `conversation` rows, 99 `preview_message` rows
(only conversations with real message activity get a preview), spanning 13
days from newest to oldest — a clean monotonic ordering, exactly the
newest-first list the user sees.

There is also `sync_<ownId>.missing_message_range`, the table AGENTS.md
already mentions, confirming the gap-tracking model `src/core/sync.js` mirrors.

**What this means for the CLI.** The local-cache-first design is not a
workaround — it is the same architecture Zalo Web uses. `threads.lastUpdate`
is this project's `preview_message.messageTime`. The design was right; only
the plumbing is incomplete:

- nothing outside `listen`/`sync` calls `upsertThread()`, so the table stays
  empty and the ordering never gets a chance to be correct;
- the live fallback then sorts by `lastActionTime`, which measurement showed
  is a phonebook-sync stamp, not conversation activity.

Revised recommendation: **drop the idea of finding a server-side ordered
list — it does not exist for any client.** Invest instead in populating
`threads` reliably (see the listener section below), which is what Zalo Web
does with its always-on socket.

---

---

## One web session per account — measured, 2026-09-20

This is a hard product constraint, not a socket-management detail, and it
changes what "auto-start the listener" can possibly mean.

**This CLI authenticates as a web client.** It uses the web QR login flow, web
cookies (`zpw_sek`, `zpsid`, …) and a browser fingerprint. Zalo Web is the
same device class. Zalo permits **one** such session per account, and the
newer login silently revokes the older — with no socket open on either side.

### The experiment

Credentials were purged, then a fresh QR login was performed on the CLI, with
**no listener started at any point**.

| Step                                                                                           | Result                                                                                                   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A. CLI QR login                                                                                | Succeeded. imei `eceb43d4…`, 10 cookies incl. `zpw_sek`                                                  |
| A. 10 REST-only probes (`whoami`, `friend list`, `group list`, `profile me`, `conv pinned`, …) | **10/10 pass**                                                                                           |
| A. Side effect on the browser                                                                  | Zalo Web, logged in minutes earlier, was **silently signed out** — next page load bounced to a QR screen |
| B. User signs back into Zalo Web                                                               | Succeeds; 99 `preview_message` rows, syncing normally                                                    |
| B. Same 10 probes re-run immediately                                                           | **9/10 fail** — `AutoLogin failed: Đăng nhập thất bại`                                                   |

The one probe that still "passed" is `status`, which reads `accounts.json` and
an in-process flag without calling Zalo at all — worth knowing, because it
means `status` reporting `loggedIn: true` does **not** prove the session is
alive.

### What was revoked, and where

The credential file was **byte-identical** afterwards — same imei, same ten
cookies, same mtime as the moment of login. Nothing local changed. Zalo
rejected the session **server-side**. So this is not corruption, expiry, or a
storage bug; it is revocation.

Revocation is **mutual**: CLI login kills Zalo Web, Zalo Web login kills the
CLI. The phone app is a different device class and survived both.

### Consequences

1. **Zalo Web and this CLI cannot be used at the same time, at all.** Not
   "not while `listen` runs" — ever, including for pure REST commands. Anyone
   running the CLI against an account they also browse with will see it break
   every time they open Zalo Web.
2. **`status` is not a liveness check.** Use `whoami` (or any real API call)
   when you need to know the session actually works.
3. **The error was misleading.** `autoLogin()` printed the raw upstream
   `Đăng nhập thất bại` and every command then advised
   `Run: zalo-agent login` — advice that works but signs the user's browser
   out again, so they loop. It now explains the cause and the trade-off.

### This supersedes part of the listener plan

The section below proposes lock discipline before any auto-start. That is
still correct for coordinating `listen` / `mcp start` / transient openers
**within** the CLI. But it does not address this: no amount of socket
coordination lets the CLI coexist with Zalo Web, because the collision happens
at login, before any socket exists.

So "enforce starting the listener automatically so all functions work
correctly" cannot be delivered as stated for a user who also uses Zalo Web.
The realistic options are:

- **Document the exclusivity prominently** (README, not just here) and treat
  the CLI as owning the account's web slot.
- **Detect revocation and say so clearly** — done, see above.
- **Then** do the internal lock work, which is what makes auto-start safe for
  users who have accepted the exclusivity.

## The listener: where it runs, and why "just auto-start it" is not safe yet

Zalo permits **one WebSocket per account**. Zalo Web holds that socket open
permanently, which is how its local DB — and therefore its ordering — stays
current. The CLI's equivalent is `listen`. Everything that is wrong about
ordering traces back to that socket usually not being open.

### Every place the socket is opened today

| Site                                                              | Mode                             | Holds `daemon.lock`?                 |
| ----------------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| `commands/listen.js`                                              | persistent, `retryOnClose: true` | **yes** — acquires, releases on exit |
| `commands/mcp.js`                                                 | persistent, `retryOnClose: true` | **no**                               |
| `commands/msg.js` — `msg history` WS path                         | transient: start → scan → stop   | no                                   |
| `commands/msg.js` — `send-file` / `send-image` non-inline uploads | transient: start → upload → stop | no                                   |

### The problem with auto-starting

`daemon.lock` exists precisely to enforce the one-socket rule, and **only
`listen` respects it**. `mcp start` opens a second persistent socket without
checking, and the transient openers in `msg.js` do not check either. Today
that mostly goes unnoticed because the transient ones are short-lived, but it
means:

- `mcp start` alongside a running `listen` is already an unguarded conflict;
- `msg send-file` while `listen` runs opens a second socket — Zalo closes one
  with code 3000, which AGENTS.md documents as fatal by design.

So auto-starting a listener from arbitrary commands would take a latent
conflict and make it constant. **The lock discipline has to come first.**

### Suggested order of work

1. **Make `checkLock()` mandatory before any `listener.start()`.** A tiny
   helper — "is a daemon already holding this account?" — used by all four
   sites. Cheap, and it turns an invisible conflict into a clear message.
2. **Have `mcp start` acquire the lock** like `listen` does, or explicitly
   document that it is a second daemon and must not coexist.
3. **Make the transient openers lock-aware.** If a daemon holds the lock, do
   not open a socket: the daemon is already receiving everything, so the
   upload-complete frame and history both come through its cache. If no
   daemon holds it, open transiently as now.
4. **Then, and only then, consider auto-start.** The realistic shape is not
   "every command starts a listener" but "commands that need fresh data
   refuse politely and point at `listen`", plus a documented supervisor
   (systemd / Task Scheduler / pm2) for the daemon — which is what an
   always-on client like Zalo Web effectively is.
5. **Populate `threads` from more sources.** `msg history` already fetches
   messages and knows the thread; having it call `upsertThread()` makes the
   ordering path work for people who never run the daemon. This is the
   single highest-value item and does not depend on 1–4.

Item 5 is independent and small. Items 1–3 are the prerequisite for any
auto-start being safe; item 4 is a product decision, not a patch.

---

## Mobile sync: the endpoint is retired — measured, 2026-09-20

`sync-mobile` never worked, and the reason was not a bug in this repo. It was
built on a Zalo API that no longer does anything.

### How this was measured

Credentials were purged, then Zalo Web was opened in an instrumented browser
and driven by hand. Three things were inspected: the full JS bundle, the live
WebSocket frames, and IndexedDB.

### 1. Zalo Web does not call `pull_mobile_msg` or `get_crossdb`

Both endpoints are still **defined** in Zalo Web's bundle (`lazy/1.*.js`),
with a command-id map that matches what zca-js sends:

| Command id | Path                                      |
| ---------- | ----------------------------------------- |
| 12000      | `/api/message/pull_mobile_msg`            |
| 12412      | `/api/message/get_crossdb`                |
| 12003      | `/api/message/delete_snapshot_mobile_msg` |
| 12700      | `/api/message/cancel_pull_mobile_msg`     |

But searching the **live module registry** — all 4,642 loaded modules, read
out of webpack's own cache — finds **zero call sites**. The definitions are
dead code. That is why `pullMobileMsg` returns an empty string rather than an
error: the endpoint answers, it just has nothing to give.

A second, smaller defect turned up in the same comparison: Zalo Web's legacy
`pullMobileMsg` sent `imei`, and **zca-js does not**. Worth knowing, but it
does not resurrect a retired endpoint.

### 2. What the client actually does: transfer-sync-v2, over the socket

Captured live by hooking the page's `WebSocket` before the app opened it, then
clicking **Settings → Dữ liệu → Đồng bộ tin nhắn**:

```
out cmd 590 subCmd 0   {"data":{"syncId":"qgc2GyPbMFVOuTDxA4eHiUi1BYmqinC4",
                        "syncType":0,"ek":"BWZE1TnKbYhX5HqLYcE/uC0ulAEzPa73…",
                        "ik":"BWcjl04aFG140ayIY9Ruz4z6E9EMeYifpiB9ahZ1yE1S",
                        "toDevice":0,"tempKey":"","deviceName":"Unknown Browser - Windows",
                        "req":{"type":"conversation","priority":0,"queries":[…]}}}
in  cmd 590            (ack)
in  cmd 601 × N        (the actual payload, 500–925 bytes each)
out cmd 591 subCmd 0   {"data":{"syncId":"…","toDevice":0,"reason":1}}
```

Then a second round with `"req":{"type":"message","priority":2,…}`.

The command map (module `Qtro`):

| Cmd | Name                                   |
| --- | -------------------------------------- |
| 590 | `SYNC_MESSAGE.REQUEST`                 |
| 591 | `SYNC_MESSAGE.ACK_DELETE_SYNC_SESSION` |
| 592 | `SYNC_MESSAGE.REQUEST_MOBILE_WAKE_UP`  |
| 534 | `PUSH_MISS_MSG`                        |

`ek`/`ik` are Curve25519 public keys (33 bytes, `0x05` prefix) — this is
libsignal, which is why `libs/libsignal-protocol.static.js` is loaded. The
phone encrypts, the PC decrypts; the client's own telemetry enumerates
`MOBILE_ENCRYPTION_FAILED`, `PC_DECRYPTION_FAILED`, `MOBILE_PARTITION_NOT_FOUND`.

**Implementing transfer-sync-v2 is a project, not a patch.** It needs a
libsignal identity keypair registered with Zalo, a session with the phone, and
the `req.queries` partition descriptors (whose internals were truncated in
capture and are still unknown). Recorded here so nobody has to re-derive it.

### 3. Clicking "Sync" when there is no gap does nothing at all

With `sync_<ownId>.missing_message_range` empty, clicking **Đồng bộ tin nhắn**
produced **zero frames** beyond a routine `PING_ACTIVE`. The real client
short-circuits on its own gap state and never disturbs the phone.

This vindicates the debounce in `SyncManager.pollSync()` — it mirrors the real
client — and condemns the old retry loop, which pinged the phone ~24 times
over two minutes precisely when there was nothing to fetch.

### 4. Old-message pulls do not fill the gap either — measured twice

Zalo Web's own IndexedDB (`zdb_<ownId>`, `msginfo_<ownId>`, `sync_<ownId>`)
was deleted and the page reloaded, reproducing a first-login restore. On
reconnect the client fires a burst of **old-message pulls**:

```
out cmd 510 subCmd 1   {"first":true,"lastId":"8285042762011","preIds":[]}   ← DMs
out cmd 511 subCmd 1   {"first":true,"lastId":"8284972075537","preIds":[]}   ← groups
out cmd 515 / 517 / 518 / 610 / 611 / 603                                     ← other stores
```

**The 510/511 responses came back essentially empty** — 381 bytes each, versus
the 500–4,000-byte `cmd 601` frames that carried the real payload later. The
web UI at that point showed two conversations and a banner pointing at Zalo PC
for anything older. Only when **transfer-sync-v2** ran (cmd 590 → 601 ×N → 591)
did the history appear.

This was then confirmed directly against the CLI, twice:

| Attempt                                                                 | Result          |
| ----------------------------------------------------------------------- | --------------- |
| `sync-mobile` (zca-js default, `lastId: null`)                          | 0 DMs, 0 groups |
| Probe with Zalo Web's exact anchors (`8285042762011` / `8284972075537`) | 0 DMs, 0 groups |

So **`requestOldMessages` is not a working backfill** for this account, and the
`lastId` is not the missing ingredient.

**What `sync-mobile` therefore does now.** It issues the 510/511 pulls — they
are free, they touch no phone, and they occasionally may return something —
and persists anything that arrives via the same `insertMessage()`/
`upsertThread()` the listener uses. When the answer is empty it **says so
plainly** rather than reporting success, and points at `listen` for capturing
messages going forward.

This is a deliberate downgrade in promise from what the command used to claim.
The old behavior was not a working sync either; it was a retired endpoint plus
a two-minute retry loop that notified the owner's phone roughly 24 times per
run. Replacing a harmful no-op with an honest no-op is the actual improvement
here. **A real full-history sync requires implementing transfer-sync-v2.**

### 5. The CLI CAN drive the real sync — VERIFIED live, 2026-09-21

This is the important result, and it overturns the conclusion in § 4.

**Sending socket cmd 590 from the CLI makes the phone display Zalo's real sync
prompt.** The account owner's phone showed:

> Đồng bộ tin nhắn lên máy tính **zalo-agent-cli probe**?
> [ ĐỒNG BỘ NGAY ] [ KHÔNG ĐỒNG BỘ VỚI THIẾT BỊ NÀY ]

— with `deviceName` rendered verbatim from the payload the CLI sent. No browser
involved. zca-js needs no patch for this: `listener.sendWs()` already frames
arbitrary commands.

#### The exchange, as measured

```
out cmd 592  {"data":{"syncId","toDevice":0},"reqId":"req_wake"}
in  cmd 592  {"error_code":0,"data":{"reqId":"req_wake","err":0,"ts":…}}
out cmd 590  {"data":{syncId,syncType:0,ek,ik,toDevice:0,tempKey:"",
                      deviceName,req:{type,priority,batchSize,queries}},"reqId":…}
in  cmd 590  {"error_code":0,"data":{"reqId":"req_sync","err":0,"ts":…}}
in  cmd 601  control act_type="transfer_sync2" act="transfer_status"
             data={"syncId":…,"fromDevice":0,"status":3}   ← WaitingConfirm
in  cmd 601  … "status":4                                    ← Confirmed (user tapped)
out cmd 591  {"data":{syncId,toDevice:0,reason:1},"reqId":…}  ← dispose
```

`ek`/`ik` are freshly generated X25519 public keys in libsignal DJB wire format
(`0x05` || 32 raw bytes, base64). Nothing pre-registered was needed.

#### The status enum (from the bundle)

| Value | Name                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| 1     | `Active`                                                                        |
| 2     | `Idle`                                                                          |
| 3     | `WaitingConfirm`                                                                |
| 4     | `Confirmed`                                                                     |
| 6     | `UserReject`                                                                    |
| 8     | `MasterDeviceBusy`                                                              |
|       | `BypassConfirmed`, `UserCancel`, `MasterDeviceLowStorage`, `MasterDeviceLogout` |

Event acts (`act_type: "transfer_sync2"`): `transfer_after_login`,
`transfer_status`, **`upload_batch`** (the actual data), `transfer_error`.

#### Why zca-js sees none of it

These arrive inside **cmd 601**, which zca-js's listener _does_ decode — but it
only dispatches `act_type` of `file_done`, `group` and `fr`. `transfer_sync2`
falls through and is silently dropped. Surfacing it needs either a
`patch-package` patch or a raw `listener.ws` tap like the probe uses.

#### The one remaining unknown: `req.queries`

Every probe sent `queries: []`. The phone reached `Confirmed` and then sent
**no `upload_batch` frames** — unsurprising, since an empty query list asks for
nothing. Zalo Web sends two rounds, `{type:"conversation",priority:0}` then
`{type:"message",priority:2}`, each with a populated `queries` array whose
contents were truncated in capture (the frame tap kept only the first 300
bytes). The builder is not in any downloaded chunk, and the published
`sourceMappingURL` 404s.

**So the blocker is no longer "can we talk to the phone" — it is one payload
field.** Recovering it needs a re-capture from Zalo Web with a wider frame tap.

#### Operational warning learned the hard way

Do **not** send cmd 591 while a transfer is in flight. The first probe disposed
after 30s, before the owner tapped confirm, which cancelled the session
server-side — and left the phone showing "Đang đồng bộ tin nhắn…" indefinitely.
Dispose only after `upload_batch` completes, or not at all.

**`sync-mobile` deliberately does NOT ship this handshake yet.** Initiating it
puts a confirmation prompt on a real person's phone; doing that while we cannot
consume the result would interrupt them for nothing.

### Consequences for the rest of the project

- `listen`'s auto-backfill on reconnect calls `pollSync()`, which now returns
  `legacy-retired` instead of pretending a retry might help. Pointing it at
  `backfillOverSocket()` would be nearly free (the listener already holds a
  socket) but, on this evidence, would recover nothing — so it is not worth
  doing until transfer-sync-v2 exists.
- **`PUSH_MISS_MSG` (cmd 534) is unhandled by zca-js.** Its listener ignores
  every command it does not recognize, with no catch-all event, so the CLI
  cannot see missed-message pushes at all. Exposing it needs a
  `patch-package` patch against zca-js. Not attempted here: the command was
  never observed carrying data during this session, and shipping an unverified
  decoder is how the original `sync-mobile` got into this state.
