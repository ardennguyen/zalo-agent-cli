# Changelog

All notable changes to `@ardennguyen/zalo-agent-cli`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm versions and git tags.

A release's section is added under `[Unreleased]` as the work lands and renamed in the version-bump
commit; the GitHub Release body is a copy of that section (see `docs/RELEASE.md`). Entries before
2.0.0 were never written down and are not reconstructed here — `git log v1.6.2` is the record.

## [Unreleased]

## [3.0.0] — 2026-11-06

### What's changed since v2.5.9

3.0 makes the CLI behave toward Zalo the way Zalo Web does: it logs in, stays connected, signs out and restores history by the same steps, and it reports what it did and what it could not do. The MCP tools speak one vocabulary, which is the one breaking change for programs (see the usage notices).

#### MCP contract (breaking)

- feat!: **one name for each id, in every MCP input and reply.** A message's id is `msgId` and a user's is `userId` (a message's author is `senderId`); `threadType` is the word `"dm"` or `"group"`, in inputs and in replies. The old names are gone: a live message has no `id` (nor do the webhook and `/events/wait` payloads), a send reply has no `messageId`, a group member has no `uid`, and `zalo_list_conversations` has no separate `type`. `zalo_view_media` takes `msgId` and `zalo_delete_message` takes `senderId`. Models copy a name from one reply into the next call, and the old mix made them call tools with the wrong field names — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b), [`530060c`](https://github.com/ardennguyen/zalo-agent-cli/commit/530060c)
- feat: **clearer tool descriptions and server instructions.** Every tool and parameter says what it does, when to use it, where each id comes from and what it returns, and the server sends its instructions when a client connects — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b)

#### MCP messages

- fix: **a long-poller no longer loses messages when the daemon restarts.** The buffer's cursor started again from 1 after a restart, so a client that came back with its saved `since` silently skipped every message that arrived before the new counter passed it. Cursors now start at the clock when the daemon starts (an epoch-ms-sized number), above anything an earlier run handed out, and a `since` beyond the newest buffered message is read as stale: from the start of the buffer, which can repeat a message but never skips one. `zalo_mark_read` with such a cursor marks nothing. Applies to `zalo_get_messages`, `zalo_wait_for_message`, `GET /events/wait` and `mcp wait` — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: **a reply says what it replies to.** Every message from `zalo_get_messages`, `zalo_wait_for_message`, `zalo_get_history` (cache and server) and `zalo_search_messages`, and the webhook payload, carries `replyTo`: `{ msgId, cliMsgId, senderId, senderName, text, timestamp, hasAttachment }` of the quoted message, or `null`. It was always `null`, so an agent could not tell what "look at this" pointed at. `senderId` is `null` when Zalo gives only an encrypted author id (a message restored from the phone) — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- fix: **a recall reaches the agent.** `zalo_wait_for_message` wakes and `zalo_get_messages` lists an entry with `type` `"undo"` whose `msgId` is the recalled message (`null` when only its `cliMsgId` is known); the webhook carries it as `event: "undo"` — [`8ffb5b9`](https://github.com/ardennguyen/zalo-agent-cli/commit/8ffb5b9)
- feat: **`zalo_group` `rename`**, and **`zalo_friend` `alias` / `alias_list`** (an empty `alias` removes the nickname; `senderDisplayName` follows at once) — [`81e2747`](https://github.com/ardennguyen/zalo-agent-cli/commit/81e2747)
- feat: **`zalo_search_messages` searches the way `msg search` does**: accent-insensitive by default (`accents: "exact"` to match them), filters by sender, period and type, pages with a cursor, and returns a highlighted snippet, optional context messages and how far back the cache reaches — [`99e17aa`](https://github.com/ardennguyen/zalo-agent-cli/commit/99e17aa)
- feat: `zalo_send_message` warns when the text has a backslash and an `n` and no line break (Zalo shows them as typed); the text is still sent as written — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b)
- fix: **a long text goes out as several messages, in any script, instead of being refused** (over 3000 bytes: split at a line break, else a sentence end or a space, never inside a character, an emoji or an @-mention, 300 ms apart) — [`5736fb9`](https://github.com/ardennguyen/zalo-agent-cli/commit/5736fb9), [`2c0b3a1`](https://github.com/ardennguyen/zalo-agent-cli/commit/2c0b3a1)

#### Login and sessions

- feat: **the official QR login is the default.** It follows the sequence Zalo Web makes, including the second QR an account with a trusted device is asked for (the CLI then appears in the phone's linked-device list as one companion entry, and a later login links as the same entry). `ZALO_QR_FLOW=legacy` selects the previous flow — [`5063855`](https://github.com/ardennguyen/zalo-agent-cli/commit/5063855), [`1722efc`](https://github.com/ardennguyen/zalo-agent-cli/commit/1722efc)
- feat: **`login --sync [--sync-days <n>]`** starts a phone-backed restore right after the QR login, with no extra tap on the phone when the account allows it — [`b9a2890`](https://github.com/ardennguyen/zalo-agent-cli/commit/b9a2890)
- feat: **logout signs the device out**, by the six steps Zalo Web makes, and says so only after checking that the saved login is refused. `--keep-session` keeps the old behavior — [`9405743`](https://github.com/ardennguyen/zalo-agent-cli/commit/9405743)
- feat: saved-session logins are made by this CLI itself, as Zalo Web makes them (API version 694, the browser's headers, the account's own profile call, cookies written back), with no call to the npm registry — [`d3c8846`](https://github.com/ardennguyen/zalo-agent-cli/commit/d3c8846)
- feat: `listen` and `mcp start` keep their socket by Zalo's rules: reconnect after a pause by Zalo's own table, never retry a kick (**exit code 3**) or a login Zalo keeps refusing (**exit code 4**), wait out maintenance; the shipped systemd unit does not restart on either — [`57748d7`](https://github.com/ardennguyen/zalo-agent-cli/commit/57748d7), [`47e4360`](https://github.com/ardennguyen/zalo-agent-cli/commit/47e4360)
- fix: **a kick says why it happened.** The daemon asked Zalo for the reason but exited before the answer came, so the reason never showed. It now waits up to 5 s and logs `Zalo says why: …` before it exits — [`b9a2890`](https://github.com/ardennguyen/zalo-agent-cli/commit/b9a2890), [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: **`fleet status`, `--status` and the health endpoints say why a socket is not up**: `maintenance`, `relogin` or `kicked`. A daemon that has exited on a kick leaves `kicked.json` in the account folder (removed at its next connect), so `fleet status` shows the account as `kicked`, not `stopped` — [`47e4360`](https://github.com/ardennguyen/zalo-agent-cli/commit/47e4360), [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: the end date of a login is shown (`whoami`, `--status`, `zalo_session_days_left` in the metrics), with a warning from 14 days before: Zalo never renews a web login, so a new QR login is then due — [`e575e90`](https://github.com/ardennguyen/zalo-agent-cli/commit/e575e90)
- feat: `account devices` lists the linked devices readably and marks which one is this CLI; `account status` reports the zBusiness package and its limits and the zCloud plan, usage and expiry (`--json`; also `zalo_read` with `name: "account-status"`) — [`b523fbb`](https://github.com/ardennguyen/zalo-agent-cli/commit/b523fbb), [`b0f3648`](https://github.com/ardennguyen/zalo-agent-cli/commit/b0f3648)

#### Restoring history from the phone

- feat: **a restore runs the way Zalo Web and PC run it**: the whole history in one run, conversations asked in waves and released one at a time, a dropped connection resumed (up to three times), a conversation the phone cannot serve skipped alone, what an earlier run settled not asked again (`--full-resync` asks for everything), Ctrl+C that keeps what arrived. A restore that could not save everything ends as partial, never as success — [`096308b`](https://github.com/ardennguyen/zalo-agent-cli/commit/096308b), [`f663bdc`](https://github.com/ardennguyen/zalo-agent-cli/commit/f663bdc), [`7d9838c`](https://github.com/ardennguyen/zalo-agent-cli/commit/7d9838c)
- fix: **a "no" on the phone is a no**: a declined restore prompt fails the run and records nothing as restored — [`47e4360`](https://github.com/ardennguyen/zalo-agent-cli/commit/47e4360)
- fix: queue items are acknowledged only after they are written, and sessions a stopped run left open are released at the next start — [`6f2cb70`](https://github.com/ardennguyen/zalo-agent-cli/commit/6f2cb70), [`f184097`](https://github.com/ardennguyen/zalo-agent-cli/commit/f184097)
- feat: the daemon replays what happened while it was away (group and friend events, unread marks and pins set on another device) on every connect — [`114c9e7`](https://github.com/ardennguyen/zalo-agent-cli/commit/114c9e7), [`392ea32`](https://github.com/ardennguyen/zalo-agent-cli/commit/392ea32)
- feat: **`msg search`** searches the local cache the way Zalo does: accents and case ignored, indexed — [`99e17aa`](https://github.com/ardennguyen/zalo-agent-cli/commit/99e17aa)
- fix: restore and media downloads use the account's own proxy, User-Agent and the Web client's Referer, and a restore stops before asking the phone when the server has sync turned off for the account — [`238d6eb`](https://github.com/ardennguyen/zalo-agent-cli/commit/238d6eb)
- fix: **a proxied account can log in again**, and a restore no longer hides messages it could not save — [`e575e90`](https://github.com/ardennguyen/zalo-agent-cli/commit/e575e90)

#### Media

- feat: **attachments download two at a time** (was four), as Zalo Web fetches, because a burst is what the CDN answers with 403 and 429. **`sync` and `sync-media` take `--media-limit <n>`** to cap one run; what it leaves out stays pending and the run says how many — [`530060c`](https://github.com/ardennguyen/zalo-agent-cli/commit/530060c)
- fix: **a photo Zalo serves as JPEG XL is saved as a JPEG.** The download asks for the photo's JPEG twin, as Zalo Web does when it cannot decode JPEG XL, so `zalo_view_media` and the media folder hold a `.jpg` that viewers and models can open — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- fix: **a photo with only an HD or a thumbnail link is downloaded.** It counted as having an attachment but was never fetched, so it stayed without a local file through every sync — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)

#### zCloud

- feat: the zCloud index is **applied, not only read**: removals and cleared conversations are followed, a walk resumes from where it stopped, the server's "verify" notice is answered, and the web client's retry rules are used — [`2744631`](https://github.com/ardennguyen/zalo-agent-cli/commit/2744631)
- feat: `sync` reads the zCloud plan first; an account with no zCloud skips the cloud stage and says so; media that is gone from the CDN says whether the cloud lists it — [`bfc919f`](https://github.com/ardennguyen/zalo-agent-cli/commit/bfc919f)
- feat: **`cloud ls` and `cloud plan`** report what the index holds and what a cleanup would cover and free. They delete nothing — [`b0f3648`](https://github.com/ardennguyen/zalo-agent-cli/commit/b0f3648)

#### Everything else Zalo Web can do

- feat: **`read list|run`** (41 read-only calls) and **`write list|run`** (27 state-changing calls, behind a dry run and a confirmation), also as the MCP tools `zalo_read` and `zalo_write` — [`54b36c9`](https://github.com/ardennguyen/zalo-agent-cli/commit/54b36c9), [`9a98960`](https://github.com/ardennguyen/zalo-agent-cli/commit/9a98960), [`a4603c5`](https://github.com/ardennguyen/zalo-agent-cli/commit/a4603c5)
- Surface: 230 CLI commands in 27 command groups, 27 MCP tools.

### Usage notices

- **Breaking, MCP clients and webhook receivers:** read `msgId` (not `id` or `messageId`) and `userId` (not `uid`); send `threadType` as `"dm"` or `"group"` (a number is refused); call `zalo_view_media` with `msgId` and `zalo_delete_message` with `senderId`. The CLI is unchanged (`-t 0|1`).
- **MCP cursors are large numbers now** (they start at the clock). A client that stores a cursor needs no change; one that assumed a small counter from 1 should not.
- **Logging in** follows the official sequence by default; on an account with a trusted device you scan two QR codes in turn. The CLI shows in the phone's linked-device list. `logout` keeps this identity for the next login; `logout --purge` and `account remove` delete it, and Zalo keeps listing the entry until you remove it on the phone.
- **`logout`** signs the device out at Zalo. Use `--keep-session` for the old behavior.
- A kicked or refused daemon exits with code 3 or 4 and is not restarted by the shipped systemd unit: log in again (or close the other session) and start it yourself.
- `sync` and `sync-media` fetch two files at a time; pass `-c <n>` for more, or `--media-limit <n>` to stop a run early.
- `friend close` is retired by Zalo, and `friend online` is answered with a 404 on the current build; both say so.
- Wrapper: `@ardennguyen/zalo-mcp` users get 3.0 with wrapper 3.0.0 (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update`).

## [2.5.9] — 2026-10-29

### What's changed since v2.5.8

#### Fixes

- fix: **a long text is split correctly in every script, not only Chinese.** v2.5.8 started splitting a text Zalo would refuse as one message (over 3000 bytes) into several, at a line break, else a sentence end or a space. Two things in that were tuned to the scripts tried first. The sentence marks of other scripts were not break points, so a long Hindi, Arabic, Armenian, Ethiopic, Burmese or Khmer text without spaces was cut at an arbitrary place; they are now (`।` `॥` `۔` `؟` `،` `؛` `։` `።` `။` `។` and the other marks of those scripts, besides the ASCII and Chinese/Japanese ones). And a cut could still land inside a character: between a Thai or Devanagari letter and its vowel or tone marks, inside a flag or a skin-tone emoji, or inside an emoji joined from several (a family). A cut now always falls between whole characters. Applies to `msg send` and the MCP tool `zalo_send_message` — [`04ba225`](https://github.com/ardennguyen/zalo-agent-cli/commit/04ba225)

### Usage notices

- Nothing to change in how you send. Texts that fit in one message are sent exactly as written.
- Wrapper: this fix reaches `@ardennguyen/zalo-mcp` users after this version is published and the wrapper is updated (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.8] — 2026-10-29

### What's changed since v2.5.7

#### Fixes

- fix: **a long text goes out as several messages instead of being refused.** Zalo refuses one oversized message: a plain text past 3000 characters, or a formatted one (what Markdown becomes) whose text plus formatting passes about 3 KB. A Chinese character counts 3 bytes and every bullet or bold word adds formatting, so Chinese and long bulleted answers hit the limit early, and the sender only saw "Tham số không hợp lệ" or "Lỗi không xác định". Zalo Web never sends such a message; it cuts the text and sends the parts in order. `msg send` and the MCP tool `zalo_send_message` now do the same: the text is split at 3000 bytes, at a line break when there is one, else at a sentence end or a space (the Chinese `。！？，` count), never inside an emoji or an @-mention, and the parts go out 300 ms apart. `--urgency` and a quote belong to the first part. If Zalo refuses a part, the rest are not sent and the error says how many already went out. A text that fits is sent exactly as written. The reply then lists every part (`splitInto`, `parts`) — [`5f938d0`](https://github.com/ardennguyen/zalo-agent-cli/commit/5f938d0)

#### MCP

- feat: **one name for each id across the MCP tools.** A message's id is `msgId` in every input and every reply (live messages also keep `id`, and a send reply keeps `messageId`, with the same value); a user is `userId` (a message's author is `senderId`; group members have `userId`, and `uid` stays). Models copy a name from one reply into the next call, and the old mix (`id`, `msgId`, `messageId`, `uidFrom`) made them call tools with the wrong field names — [`4138a48`](https://github.com/ardennguyen/zalo-agent-cli/commit/4138a48)
- feat: **clearer tool descriptions and server instructions.** Every tool and every parameter now says what it does, when to use it, where each id comes from and what it returns, and the server sends a short set of instructions when a client connects (the ids, how to read and send, the rules for `zalo_sync` and `zalo_group`) — [`4138a48`](https://github.com/ardennguyen/zalo-agent-cli/commit/4138a48)
- feat: **`zalo_send_message` warns when the text has a backslash and an `n` and no line break.** Zalo shows those two characters as typed, so a reply written that way showed a literal backslash-n between paragraphs. The text is still sent exactly as written; the reply carries a warning naming the fix (real line breaks, and `zalo_undo` for the message just sent) — [`4138a48`](https://github.com/ardennguyen/zalo-agent-cli/commit/4138a48)

### Usage notices

- **Two MCP parameters were renamed** to match the other tools: `zalo_view_media` takes `msgId` (it was `messageId`) and `zalo_delete_message` takes `senderId` (it was `uidFrom`). A client that sends the old names gets a clear "required" error; update its calls. Replies keep the old field names beside the new ones.
- Put real line breaks in the text you send; do not type a backslash followed by `n`.
- Wrapper: these changes reach `@ardennguyen/zalo-mcp` users after this version is published and the wrapper is updated (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.7] — 2026-10-28

### What's changed since v2.5.6

#### Fixes

- fix: **a proxied account can log in again.** With a proxy set, every request failed with "fetch failed": the proxy support handed one library's connection handler to another library's `fetch`, and the two versions do not work together. Logins, reads, sends and the listener's HTTP calls of a proxied account now go through the proxy as intended — [`59e6f6a`](https://github.com/ardennguyen/zalo-agent-cli/commit/59e6f6a)
- fix: **a restore no longer hides messages it could not save.** If a message could not be written to the local cache (a full disk, a locked file), the restore skipped it without a word and still reported success. It now counts them, says how many and why, and reports the run as partial, so you know to run it again — [`59e6f6a`](https://github.com/ardennguyen/zalo-agent-cli/commit/59e6f6a)

### Usage notices

- A restore that could not save some messages now ends with "Partial restore" and a line naming the count and the first reason. Re-run `sync --force` once the cause is gone.
- Wrapper: these fixes reach `@ardennguyen/zalo-mcp` users after this version is published and the wrapper is updated (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.6] — 2026-10-21

### What's changed since v2.5.5

#### Features

- feat: **the webhook no longer loses events.** `-w <url>` now writes each event to disk first and delivers it from there, in order and at least once. A receiver that is down, slow or answering with an error costs a backlog, not messages: delivery is retried with growing waits and survives a restart or a crash. An event the receiver refuses as malformed, or one that stays undelivered for 24 hours, is set aside, never dropped. `ZALO_WEBHOOK_BATCH_SIZE` sends several events in one POST. New commands `mcp webhook status`, `list`, `retry` and `purge` show and manage the backlog — [`e35c093`](https://github.com/ardennguyen/zalo-agent-cli/commit/e35c093e2c6ab8f365a640bfe6e5a54ef68158ed)
- feat: **real health and metrics.** `/health` and `/ready` are open; `/ready` answers 200 only while the Zalo connection is up. `/status` and `/metrics` (Prometheus text) need the bearer token. They report the connection state and age, the last event and message, the webhook backlog, pending gaps, memory and more. `listen --status` and `mcp start --status` print the same from the command line — [`3ef2907`](https://github.com/ardennguyen/zalo-agent-cli/commit/3ef2907116cc0a32814f249f5840564f21398712)
- feat: **batch pull.** `zalo_wait_for_message`, `GET /events/wait` and `mcp wait` take `limit` (up to 100 messages per call) and `settleMs`, so a program that was away can read its backlog in a few calls instead of one message per call — [`356b3ac`](https://github.com/ardennguyen/zalo-agent-cli/commit/356b3ac812a82f2100afb00d45a470cdae68e4f2)
- feat: **log levels for `daemon.log`.** `--log-level error|warn|info|debug` (or `ZALO_LOG_LEVEL`), timestamps on every line or one JSON object per line (`ZALO_LOG_FORMAT=json`), and rotation at 50 MB keeping 3 files — [`3e0cd27`](https://github.com/ardennguyen/zalo-agent-cli/commit/3e0cd27819ba1f952d585c2dc041d03f7b70f2de)
- feat: **`fleet` commands for many accounts on one machine:** `fleet ports`, `status`, `start`, `stop`, `restart` and `generate`. `fleet status --check` exits 1 unless every account is serving, `fleet restart --unhealthy` restarts only daemons that are down, and `fleet generate` writes systemd units, env files with a token each, and a Caddyfile — [`780ab39`](https://github.com/ardennguyen/zalo-agent-cli/commit/780ab39566745ed7260254ca12de104b4dd5974c)
- feat: **start-up jitter and a login cap.** `ZALO_START_JITTER` waits a random number of seconds before logging in, and `ZALO_LOGIN_SLOTS` lets only that many daemons on the machine log in at once, so a fleet restarting together does not log in all at once — [`205dc43`](https://github.com/ardennguyen/zalo-agent-cli/commit/205dc4314b4c34ff58f0a4a32dd041cec907e3b4)
- feat: **Markdown replies show up as formatting in Zalo.** Zalo displayed `**bold**` and `- item` exactly as typed, because bold, bullets and headings are sent as separate style ranges. `zalo_send_message` now converts Markdown (bold, italic, strike, headings, bullet and numbered lists, quotes, code, links, colors) and keeps `@` mentions working. `msg send --markdown` does the same on the command line. `format: "plain"` or `ZALO_SEND_FORMAT=plain` sends text exactly as written — [`0e17e97`](https://github.com/ardennguyen/zalo-agent-cli/commit/0e17e97134a235d610862caa73d61dc49b771fa7)

#### Fixes

- fix: the account list, saved logins and `mcp-config.json` are written atomically, and changes to the account list run under a lock. Two commands changing accounts at the same time no longer lose each other's change, and a reader never sees a half-written file — [`84151b7`](https://github.com/ardennguyen/zalo-agent-cli/commit/84151b72749d7761a83c7513ec301d52d0052444)
- fix: updated the `hono` dependency to 4.13.13, which closes a moderate advisory (GHSA-5r4p-p66f-jhc7, `serveStatic` path decoding); `npm audit --omit=dev` reports 0 vulnerabilities — [`7410cbe`](https://github.com/ardennguyen/zalo-agent-cli/commit/7410cbe31ba5fdbe4bd0c2328e487812b13b79c2)

#### Documentation

- docs: the installation guides, `.env.example`, the listener and MCP guides, the README and the wiki describe all of the above, in English and Vietnamese

### Usage notices

- `daemon.log` now logs at `info` by default: the per-request and per-message lines are only written at `--log-level debug`, and every line starts with a timestamp.
- An account list that exists but cannot be read is now an error that changes nothing. Before, it was treated as "no accounts".
- A webhook receiver should answer 2xx quickly and ignore a message id it has already seen: delivery is at least once.
- `zalo_send_message` converts Markdown by default. Text that is not Markdown is sent as it was. Use `format: "plain"` to turn it off.
- Wrapper: new features reach `@ardennguyen/zalo-mcp` users after this version is published and the wrapper is updated (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.5] — 2026-10-21

### What's changed since v2.5.4

#### Documentation

- docs: a configuration cookbook for the MCP server, in English and Vietnamese ([`docs/configuration.md`](https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/configuration.md), [`docs/configuration.vi.md`](https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/configuration.vi.md)). It says where each `.env` and `mcp-config.json` lives, which one wins, and lists every environment variable and config key. It then walks through the recommended setup for each case: on one machine (stdio or loopback HTTP), on a LAN, on the internet behind a reverse proxy, as a backend for a CRM (webhook, pull, send, catch-up), and with many accounts — [`9d6d371`](https://github.com/ardennguyen/zalo-agent-cli/commit/9d6d37147b7fe5a0f412426e073d7b7a34fa3fdf)
- docs: ready-to-copy sample files in [`docs/config-samples/`](https://github.com/ardennguyen/zalo-agent-cli/tree/main/docs/config-samples): `mcp-config.json` and `.env` files per setup, a systemd unit per account, Caddy and nginx configs, a Claude Code client config, and CRM scripts that send a message and verify the webhook signature (Node, Python, shell). A test checks every sample against the code, so a sample cannot name a setting that does nothing — [`9d6d371`](https://github.com/ardennguyen/zalo-agent-cli/commit/9d6d37147b7fe5a0f412426e073d7b7a34fa3fdf)
- docs: the bearer token for `mcp start` can be set with `ZALO_MCP_AUTH_TOKEN` (or `ZALO_MCP_AUTH_TOKEN_<ownId>` for one account) instead of `--auth`, which keeps it out of `ps`. The deployment guide's systemd unit now does this — [`9d6d371`](https://github.com/ardennguyen/zalo-agent-cli/commit/9d6d37147b7fe5a0f412426e073d7b7a34fa3fdf)
- docs: `.env.example` lists the MCP server settings — [`9d6d371`](https://github.com/ardennguyen/zalo-agent-cli/commit/9d6d37147b7fe5a0f412426e073d7b7a34fa3fdf)
- docs: removed `ZALO_OA_WEBHOOK_PORT` from the install guides and skill reference. Nothing ever read it; `zalo-agent oa listen` takes its port from `--port` (default 3000) — [`5a42b65`](https://github.com/ardennguyen/zalo-agent-cli/commit/5a42b65e97be041337eb2433dd26ae71669d4986)

### Usage notices

- There are no code changes in this release. The engine behaves as 2.5.4.
- If you used `ZALO_OA_WEBHOOK_PORT`, it never had an effect. Pass `--port` to `zalo-agent oa listen`.
- `@ardennguyen/zalo-mcp` 2.0.7 is the matching wrapper (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.4] — 2026-10-21

### What's changed since v2.5.3

#### Features

- feat: `daemon.log` now says what a sync is doing. A daemon that runs a sync stage (`zalo-agent sync`, `msg history`, the `zalo_sync` tool) writes the stage's parameters, every phase with the time since it started, a `still running` line every minute, a summary of live messages stored meanwhile, and the result or the failure with its code and cause — the same progress a direct `zalo-agent sync` prints — [`73d3e14`](https://github.com/ardennguyen/zalo-agent-cli/commit/73d3e142fa3335450da8ecc8b16380308c5ab8e4)
- feat: event-loop stalls are logged (`event loop was blocked for 6.2s while the messages stage was running`), and every `Disconnected` / `Connection closed` line ends with how long the socket had been up and which stage was running — [`73d3e14`](https://github.com/ardennguyen/zalo-agent-cli/commit/73d3e142fa3335450da8ecc8b16380308c5ab8e4)
- feat: a restore that loses its socket inside a daemon (close code 1006 and others) no longer ends as partial. The stage waits up to 2 minutes for the daemon's own re-login, then continues over the new connection and re-requests the batches that never arrived, up to 3 times per restore — [`73d3e14`](https://github.com/ardennguyen/zalo-agent-cli/commit/73d3e142fa3335450da8ecc8b16380308c5ab8e4)
- feat: profile lookups (`getUserInfo`, `gid/decrypt`) are paced and retried with growing waits when Zalo answers with a limit, and stop when the limit persists instead of repeating the refusal for every batch. Zalo's own code and message are written to the log — [`73d3e14`](https://github.com/ardennguyen/zalo-agent-cli/commit/73d3e142fa3335450da8ecc8b16380308c5ab8e4)
- feat: a restore refreshes the names of at most 500 non-friend DM peers per run (`ZALO_SYNC_NAME_REFRESH_MAX` changes the cap), those without a cached name first — [`73d3e14`](https://github.com/ardennguyen/zalo-agent-cli/commit/73d3e142fa3335450da8ecc8b16380308c5ab8e4)

#### CI

- ci: the CI workflow runs on every branch and every pull request; publish and release workflows use npm `^12.2.0`; the release-preparation workflow authors its commit as whoever runs it — [`a66848b`](https://github.com/ardennguyen/zalo-agent-cli/commit/a66848b821b8ce5a95ad6ab53abdb5f6be1e2448)

### Usage notices

- A resumed restore may ask for one more confirmation on your phone; the restore says so when it does. If the daemon does not reconnect within 2 minutes the stage ends with what it already stored, and `zalo-agent sync --from <date>` does the rest.
- Names Zalo refuses to look up stay as ids until a later restore reaches them; the log line says how many and why.
- `daemon.log` is longer during a sync: expect a line per phase and a `still running` line every minute.
- `@ardennguyen/zalo-mcp` 2.0.6 and later is the matching wrapper (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.3] — 2026-10-20

### What's changed since v2.5.1

#### Features

- feat(mcp): `zalo_friend` tool — friend status, sent and received requests, send / accept / reject / cancel a request, list friends — [`be309e4`](https://github.com/ardennguyen/zalo-agent-cli/commit/be309e4dfd64cc671cad0713c874df61db579819)
- feat(mcp): `zalo_group` tool — `leave`, `info`, `create`, `add_members`, `remove_member`; complements `zalo_get_group_members`. With `zalo_friend` the server now has 25 MCP tools — [`81b9147`](https://github.com/ardennguyen/zalo-agent-cli/commit/81b9147156c13ccb7f3c856b0f8b634112a16cd5)
- feat(mcp): `zalo_group` asks for `confirm: true` before `leave` and `remove_member`; switch the check off with `"groupConfirm": false` in `mcp-config.json` or `ZALO_MCP_GROUP_CONFIRM=0` — [`0dfac5f`](https://github.com/ardennguyen/zalo-agent-cli/commit/0dfac5f88674c0d8450e1312cc47bafbfc472c86)
- feat: `group leave -s` / `--silent` (and `silent` on the tool) — [`81b9147`](https://github.com/ardennguyen/zalo-agent-cli/commit/81b9147156c13ccb7f3c856b0f8b634112a16cd5)
- feat: `--webhook-secret` for `listen` and `mcp start`; the flag wins over `ZALO_WEBHOOK_SECRET[_<ownId>]`, which wins over `webhookSecret` in `mcp-config.json`; an empty flag is refused — [`be309e4`](https://github.com/ardennguyen/zalo-agent-cli/commit/be309e4dfd64cc671cad0713c874df61db579819)
- feat: `friend search` also matches the alias you set for a friend — [`4e83794`](https://github.com/ardennguyen/zalo-agent-cli/commit/4e837948b97488e3e0082bacb94046c20754cb73)
- feat: 20 new commands covering the zca-js methods the CLI had not exposed, including a new `bank` group (see below) — [`86683a0`](https://github.com/ardennguyen/zalo-agent-cli/commit/86683a08d64f140cddf25753540f575813bd59a0)
- feat(mcp): `mcp wait` and `mcp mark-read` CLI subcommands over the daemon channel — [`e75ccbf`](https://github.com/ardennguyen/zalo-agent-cli/commit/e75ccbf3400733fea7ea31443adaf41f1791e3df)

#### Bug Fixes

- fix: `daemon.log` no longer prints the values of `--auth`, `--client-secret` and `--webhook-secret` (they show as `***`) — [`be309e4`](https://github.com/ardennguyen/zalo-agent-cli/commit/be309e4dfd64cc671cad0713c874df61db579819)
- fix(mcp): `zalo_group` `create` lists only the members you asked for as added; leaving a group you are not in, and removing someone who is not in the group, are explained — [`51b0676`](https://github.com/ardennguyen/zalo-agent-cli/commit/51b0676bc246a5dd19cc6530c9d59686739f87fd)
- fix(deps): repair the bundled zca-js patch so a clean `npm ci` installs — [`cb4813b`](https://github.com/ardennguyen/zalo-agent-cli/commit/cb4813b8733091b99e9296ae62137ed4d88e538f)
- fix(deps): update `@modelcontextprotocol/sdk` to 1.32.1 — [`f66e698`](https://github.com/ardennguyen/zalo-agent-cli/commit/f66e698e2e72c1b2ff21887d54642cb7e9870212)

#### Removed

- refactor: the legacy sync path is gone, including `sync-mobile -L` / `--legacy` (it called an endpoint Zalo Web no longer uses and always answered empty); use `sync-mobile` as before — [`1558119`](https://github.com/ardennguyen/zalo-agent-cli/commit/15581199c22fd3afd85cfa95ac184b2c66db4c4c)

#### Documentation

- docs: bilingual `INSTALLATION.vi.md`, `deployment.vi.md`, English `official-account.md`, refreshed `skill/` — [`6a965e4`](https://github.com/ardennguyen/zalo-agent-cli/commit/6a965e4ea12d9ba0686ed04cff33207574421668)
- docs: every new command, tool and flag is in the command reference and the wiki, English and Vietnamese, including a new Bank page

### New commands (`86683a0`)

| Group | Commands |
|---|---|
| `msg` | `typing`, `report`, `link-preview`, `scan-url` |
| `friend` | `qr`, `common-groups`, `biz`, `block-feed [--unblock]` |
| `group` | `link-preview <link>` (see a group from its invite link before joining), `invite-info <groupId>` (a pending invitation) |
| `conv` | `muted` |
| `profile` | `active on\|off`, `lang vi\|en`, `lost-focus` |
| `catalog` | `register on\|off` |
| `bank` (new) | `list`, `accounts`, `add`, `update`, `remove` — your saved bank accounts and the bank directory |
| `listen` | `--events typing,upload` — two opt-in event types: someone is typing, and Zalo finished processing a video or file you uploaded |

The CLI now has 212 commands.

### Usage notices

- `--webhook-secret` on a command line is visible in the process list; prefer the `ZALO_WEBHOOK_SECRET` environment variable on a shared machine.
- `zalo_group` `leave` and `remove_member` cannot be undone from the tool. A call without `confirm: true` is refused and the reply says how to repeat it; a backend that makes these calls on its own can set `groupConfirm` to `false` instead.
- A silent leave hides the "left the group" notice from ordinary members, not from the group's owner. An owner who leaves hands ownership over first, so the new owner sees it; transfer ownership (`group transfer-owner`) and leave as an ordinary member to keep it quiet.
- Zalo limits how many friend requests an account can send. Use `zalo_friend` `send` sparingly.
- `msg report` sends a real report to Zalo. `bank add`, `bank update` and `bank remove` change your saved bank accounts, and `catalog register`, `profile lang` and `profile active` change account settings: run them deliberately.
- `sync-mobile --legacy` no longer exists.
- The new tools and flags reach `zalo-mcp` users with `@ardennguyen/zalo-mcp` 2.0.5 or later (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update` for a 1-click folder).

## [2.5.1] — 2026-10-19

Adds native file and media attachment support (`filePath` and `files`) to the `zalo_send_message` MCP tool, bringing MCP message sending to full parity with `zalo-agent msg send --file`.

### What's New

#### File & Image Attachments in `zalo_send_message` (`b38ce59`)
- **New `filePath` and `files` Parameters on `zalo_send_message`**:
  - `filePath` (`string`, optional): Absolute local file path to attach (image, PDF, document, archive, video, or audio).
  - `files` (`string[]`, optional): Array of absolute local file paths to attach in a single call.
  - `message` (`string`, optional when `filePath` or `files` is provided): Optional text caption sent alongside the attachment(s), or standalone text message when no files are attached.
- **Pre-Flight File Validation**:
  - Verifies every path in `filePath` / `files` exists and is a regular file (`fs.statSync`) before invoking `api.sendMessage({ msg, attachments }, threadId, type)`, returning a clear `isError: true` response if a path is missing or is a directory.
- **No More CLI Fallback for Media**:
  - AI agents connected over stdio or remote Streamable HTTP (`/mcp`) can now send screenshots, generated images, PDFs, and documents directly through the `zalo_send_message` MCP tool without shelling out to `zalo-agent msg send -f` or opening a competing session.

## [2.5.0] — 2026-10-19

Major release bringing **OAuth 2.0 / 2.1 + PKCE Authorization Server**, **native HTTPS/TLS (`--cert`/`--key`) with automatic port 443 dual-binding**, **Google Gemini Connected Apps & Claude Custom Connectors compatibility**, **per-account OAuth & signed webhook configurations**, **headless background daemon management (`-d, --daemon`, `--stop`, `--status`)**, **two new MCP tools (`zalo_wait_for_message` and `zalo_label`)**, and **automatic name & message deduplication sync**.

### Highlights & New Features

#### 1. Built-In OAuth 2.0 / 2.1 Authorization Server for Cloud AI & CRM Connectors
- **Full MCP OAuth 2.1 Discovery & Endpoints**:
  - `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) — RFC 9728 Protected Resource Metadata with `resource_name: "Zalo Agent MCP"` and `WWW-Authenticate: Bearer resource_metadata=".../mcp"` on `401` responses.
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 Authorization Server Metadata (`authorization_code`, `refresh_token`, `S256` PKCE, `client_secret_post`, `client_secret_basic`, `none`).
  - `POST /register` — RFC 7591 Dynamic Client Registration (DCR) for zero-config clients.
  - `GET /authorize` & `POST /authorize` — Interactive dark-mode HTML consent page + auto-redirect for pre-registered clients (`client_id` + `client_secret`) and Google Account Linking (`GAL`).
  - `POST /token` — Authorization code exchange (`PKCE S256` + `client_secret` validation) and `refresh_token` rotation (`30-day` access tokens, `365-day` refresh tokens).
  - `POST /revoke` — RFC 7009 token revocation.
- **Google Gemini Connected Apps & Claude Custom Connectors Support**:
  - Supports `ACCESS_VIEW_MANAGE_MCP_CONTENT` scope alongside `mcp:tools` (`--oauth-scopes`).
  - Handles `HEAD`, `GET`, `POST`, and `DELETE` on `/mcp` for Streamable HTTP session management and connector health probes.
- **Multi-Client & Concurrent Consumer Support (`oauth.clients[]`)**:
  - Register multiple static OAuth clients (`id`, `secret`, `name`, `redirectUris`) in `mcp-config.json` alongside `--oauth-client-id` / `--oauth-client-secret` and `--auth <bearer-token>`, enabling Claude, Gemini, ChatGPT, Antigravity, and external CRM services to connect simultaneously to a single daemon.

#### 2. Native HTTPS / TLS Server (`--cert`, `--key`) & Dual-Port Binding
- **`zalo-agent mcp start --http <port> --cert <fullchain.pem> --key <privkey.pem>`**:
  - Serves MCP and OAuth endpoints directly over native Node.js `https` without requiring an external reverse proxy.
  - When TLS is enabled on a custom port (e.g., `--http 3100`), automatically attempts to bind port `443` in parallel so cloud connectors that enforce standard HTTPS port `443` and LAN clients using `:3100` work simultaneously.

#### 3. Per-Account OAuth, Auth, and HMAC-Signed Webhook Configuration
- **Per-Account Overrides in `mcp-config.json` and `.env`**:
  - Configure `accounts.<accountId>.authToken`, `accounts.<accountId>.oauth`, `accounts.<accountId>.webhook`, and `accounts.<accountId>.webhookSecret` in `mcp-config.json` so multiple `mcp start --account <id>` daemons share one config file with isolated credentials and ports.
  - Automatic `.env` loading (`~/.zalo-agent-cli/.env`, current directory `.env`, or `--env-file <path>`) with per-account suffix resolution (`ZALO_MCP_AUTH_TOKEN_<accountId>`, `ZALO_MCP_OAUTH_CLIENT_ID_<accountId>`, `ZALO_MCP_OAUTH_CLIENT_SECRET_<accountId>`, `ZALO_WEBHOOK_SECRET_<accountId>`).
- **HMAC-SHA256 Signed Webhooks (`--webhook-secret <secret>`)**:
  - Supported on both `zalo-agent listen` and `zalo-agent mcp start`.
  - Computes `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` and attaches `X-Zalo-Timestamp`, `X-Zalo-Signature: sha256=<hex>`, and `X-Zalo-Account-Id` headers on every webhook `POST`.

#### 4. Two New MCP Tools (23 Total)
- **`zalo_wait_for_message`**:
  - Zero-CPU long-poll MCP tool (`timeout` `1..120s`, optional `threadId`, `since` cursor) that blocks until the next watched Zalo message arrives or returns immediately if an unread message is already buffered after `since`.
- **`zalo_label`**:
  - Full conversation label management (`action: "list" | "add" | "remove"`, `labelId`, `labelTitle`, `threadId`) for CRM tagging and workflow automation directly from MCP.

#### 5. Headless Background Daemon Management (`-d, --daemon`, `--stop`, `--status`)
- **`zalo-agent listen` & `zalo-agent mcp start --http <port>`**:
  - `-d, --daemon`: Spawns a detached background daemon, waits for health verification (`daemon.lock` + `daemon-channel.json`), and prints PID and log file path (`~/.zalo-agent-cli/accounts/<ownId>/logs/daemon.log`).
  - `--status`: Reports live daemon state, PID, mode (`listen` / `mcp`), uptime, and loopback channel port.
  - `--stop`: Cleanly stops the running daemon for the target account.

### Bug Fixes & Improvements
- **Default `listen` Event Types (`1863178`)**: Expanded default `zalo-agent listen -e, --events` from `message` only to all 5 event types (`message,friend,group,reaction,read`).
- **Profile & Account Registry Name Sync (`7f3fbe9`)**: `profile update`, `profile me`, and `whoami` automatically update the cached display name in `accounts.json`.
- **Live & Sync Name Resolution + Duplicate Message Cleanup (`7a8c0cf`)**:
  - Automatically refreshes DM, group, and self display names in `zalo.db` during live WebSocket events and `sync`.
  - Deduplicates messages sharing the same `(account_id, thread_id, client_id)` when syncing across devices.

## [2.2.2] — 2026-10-16

Real-time event-driven push and zero-CPU long-polling for `zalo-agent mcp start`, eliminating the need for AI agents or external orchestrators to poll `zalo_get_messages` in a loop.

### What's New

#### Real-Time Webhook Push on MCP (`-w, --webhook <url>`)
- **`zalo-agent mcp start -w, --webhook <url>`** (or `"webhook"` in `~/.zalo-agent-cli/mcp-config.json`):
  - Immediately `POST`s each watched incoming message (live or recovered by `self-heal`) as JSON (`{"event":"message","accountId":"<ownId>",...normalized}`) to your webhook endpoint with a 5-second timeout (fire-and-forget, never blocking the listener).
  - Lets external orchestrators (n8n, Make, LangGraph, custom CRM backends) wake up and call the MCP server only when a real Zalo message arrives.

#### Built-In Zero-CPU Long-Polling (`GET /events/wait`) on MCP HTTP
- **`GET /events/wait?timeout=<1..300>&threadId=<id>&since=<cursor>`**:
  - Exposed on the MCP HTTP server (`--http <port>`) and protected by the same `--auth <token>` bearer authentication as `POST /mcp`.
  - If a buffered message after `since` is already present (e.g., arrived while the AI agent was replying to the previous message), returns `200 OK` immediately (`0 ms`).
  - Otherwise blocks at `0%` CPU until the next watched message arrives on the Zalo WebSocket (`{"status":"message","message":{...},"cursor":N}`), or returns `{"status":"timeout","message":null,"cursor":N}` when `timeout` expires.
  - Ideal for LAN/remote MCP servers and AI coding sessions (Antigravity, Claude Code) — requires zero inbound firewall ports on the client machine and zero wasted LLM polling turns.

## [2.2.1] — 2026-10-16

Expands the built-in MCP server from **14 to 21 tools**, adding local full-text message search across `zalo.db`, user lookup (phone, username, userId, and `self` profile), message forwarding and deletion, unified reminder management, group board notes & message pinning, and group poll workflows — plus rich link preview cards and contact cards on `zalo_send_message`.

**Requires Node.js 22 or newer** (22.19 or newer in practice).

#### Highlights

- **7 new MCP tools (21 total, all enabled by default):**
  - **`zalo_search_messages`** — Full-text substring search (`LIKE`, case-insensitive) across the local SQLite cache (`zalo.db`) with optional filters (`threadId`, `senderId`, `since`, `until`, `limit`). Zero network calls; attaches cached `threadName` to each matching message.
  - **`zalo_lookup_user`** — Look up or inspect Zalo users from one tool: own account profile (`self: true`, equivalent to `whoami`), phone number (`phone`, equivalent to `friend find`), username (`username`), or user ID (`userId`, equivalent to `friend info`).
  - **`zalo_forward_message`** — Forward any cached message (`msgId`) to another DM or group (`threadId`, `threadType` inferred from cache when omitted) with full `msg forward` parity: badged text forwards (`buildForwardReference` + `sendForward`) and re-sending contact cards, stickers, links, videos, voices, and locally downloaded attachments.
  - **`zalo_delete_message`** — Delete a message from own view (`everyone: false`, default) or for everyone in a group (`everyone: true`), automatically resolving `cliMsgId` and `uidFrom` from `zalo.db` when omitted.
  - **`zalo_reminder`** — Unified reminder tool across DMs and groups (`action`: `"create" | "list" | "info" | "responses" | "edit" | "remove"`).
  - **`zalo_note`** — Unified group board & message pin tool (`action`: `"create" | "edit" | "list" | "pin_message" | "unpin_message"`), including cached text message pin/unpin parity with `msg pin` / `msg unpin`.
  - **`zalo_poll`** — Unified group poll workflow (`action`: `"create" | "info" | "vote" | "unvote" | "add_options" | "lock" | "share"`).
- **Enhanced `zalo_send_message` with link previews & contact cards:**
  - Pass `link: "https://..."` (with optional accompanying `text`) to send a rich link preview card (`api.sendLink`).
  - Pass `cardUserId: "<uid>"` to send a Zalo contact card (`api.sendCard`).
- **Database & test coverage:**
  - Added `searchMessages({ query, threadId, senderId, since, until, limit })` to `src/core/db.js`.
  - Expanded offline test suite to **2,005 tests** (including contract and handler tests for all 21 MCP tools in `tests/unit/mcp-tools.test.js` and static `zca-js` call-shape verification).

#### Upgrade

```bash
npm install -g @ardennguyen/zalo-agent-cli@2.2.1
```

Or if using `zalo-mcp`:

```bash
npm update -g @ardennguyen/zalo-mcp      # Global npm install
.\zalo-mcp.ps1 update                    # Windows 1-click folder
bash zalo-mcp.sh update                  # Linux / macOS 1-click folder
```

#### Things to know

- **`zalo-mcp` pass-through:** `zalo-mcp` spawns `zalo-agent mcp start`, so updating `@ardennguyen/zalo-agent-cli` to `2.2.1` inside a `zalo-mcp` deployment (`zalo-mcp.ps1 update` / `./zalo-mcp.sh update`) immediately exposes all 21 MCP tools to connected AI clients without needing a new wrapper release.
- **`zalo.db` three-writer rule preserved:** None of the new MCP tools write directly to `zalo.db`; `zalo_forward_message`, `zalo_delete_message`, and `zalo_note` (`pin_message` / `unpin_message`) read required message metadata from the local cache populated by `listen` / `mcp start`, `sync`, or `msg history`.
- Full MCP reference: `skill/references/mcp-guide.md` and `skill/references/command-reference.md`.

## [2.2.0] — 2026-10-16

Global `--account <id>` (`ZALO_ACCOUNT`) support across **all** personal-account CLI commands for running multiple live Zalo accounts concurrently without mutating `accounts.json`, automatic per-account daemon-channel routing (`daemon-channel.json`), and a comprehensive multi-account documentation refresh.

**Requires Node.js 22 or newer** (22.19 or newer in practice).

#### Highlights

- **Global `--account <id>` (`ZALO_ACCOUNT`) across all personal-account CLI commands.** Previously, `--account <id>` was only available on `listen` and `mcp start`, while one-shot CLI commands (`msg`, `conv`, `friend`, `group`, `sync`, `status`, `whoami`, `logout`, `profile`, `todo`, `reminder`, `poll`, `note`, `catalog`, `label`, `ar`, `zcloud`, `call`, …) always used the shared `activeAccount` in `accounts.json` — requiring `account switch <id>` and risking race conditions when multiple accounts were used concurrently. Now any personal-account CLI command accepts `--account <id>` (before or after the subcommand) or `ZALO_ACCOUNT=<id>`:
  ```bash
  # Pin one-shot CLI commands to specific accounts without touching accounts.json
  zalo-agent --account 1000000000000000001 msg send <threadId> "Hello from account 1"
  zalo-agent msg history <threadId> --account 1000000000000000002 --json
  ZALO_ACCOUNT=1000000000000000001 zalo-agent conv recent --json
  ```
- **Automatic per-account daemon channel routing (`daemon-channel.json`).** When `--account <id>` or `ZALO_ACCOUNT` is set, socket-bound operations (`msg send` media uploads, `msg history` fetches, `sync` stages) and `status` automatically inspect and route through `<DATA_DIR>/<accountId>/daemon-channel.json` and `<DATA_DIR>/<accountId>/zalo.db`, ensuring each account reuses its own running `listen` or `mcp start` WebSocket without opening a duplicate connection (code 3000).
- **Fail-closed account validation.** Just like `listen` and `mcp start`, global `--account <id>` / `ZALO_ACCOUNT` requires an exact, full numeric registered account ID (no display names, partial IDs, or leading zeros) and fails immediately before authentication if the account is not registered or if the stored credential UID does not match.
- **Concurrent multi-account live deployments (MCP & headless services).** Run multiple live accounts simultaneously on a single machine by launching one `mcp start` or `listen` process per `--account <id>`:
  - **Stdio MCP:** Register multiple MCP server entries in your client config, each with `--account <ID>`.
  - **HTTP MCP:** Run one HTTP MCP server per account on its own port (`zalo-agent mcp start --account <ID_1> --http 3847 ...`, `zalo-agent mcp start --account <ID_2> --http 3848 ...`).
  - **Headless / CRM backend:** Spawn one `zalo-agent listen --account <ID> --json` worker per account (streaming NDJSON events from stdout or Forwarding via `--webhook <url>`) and execute outbound CLI actions with `zalo-agent --account <ID> ...`.
- **Comprehensive documentation refresh.** Updated `README.md` (VN/EN), `INSTALLATION.md`, `skill/SKILL.md`, `skill/references/{command-reference,mcp-guide,login-flow,listen-mode-guide}.md`, `skill/evals/eval-scenarios.md`, and `docs/account-pinning.{md,vi.md}` to document global `--account <id>`, multi-account live topologies, and full `zalo-mcp` v2.0+ flag/command forwarding.

#### Upgrade

```bash
npm install -g @ardennguyen/zalo-agent-cli@2.2.0
```

Or if using `zalo-mcp`:

```bash
npm update -g @ardennguyen/zalo-mcp      # Global npm install
.\zalo-mcp.ps1 update                    # Windows 1-click folder
bash zalo-mcp.sh update                  # Linux / macOS 1-click folder
```

#### Things to know

- **Omitting `--account` / `ZALO_ACCOUNT` preserves default behavior:** commands fall back to the `activeAccount` in `accounts.json`. Running `zalo-agent account switch <id>` changes that default for future unpinned commands, while already-running `listen` and `mcp start` daemons stay pinned to the account they started with.
- Commands, flags, and defaults: `skill/references/command-reference.md`. Account pinning guide: `docs/account-pinning.md` (EN) / `docs/account-pinning.vi.md` (VN).

## [2.1.1] — 2026-10-16

Production-ready storage volume separation (`--config-dir`, `--credentials-dir`, `--data-dir`, `--media-dir`, `--oa-dir` and `ZALO_*_DIR`), native `.env` file loading via Node 22 `util.parseEnv`, and removal of the deprecated `node-domexception@1.0.0` dependency warning by switching `zca-js` to native Node 22 `fetch`.

**Requires Node.js 22 or newer** (22.19 or newer in practice).

#### Highlights

- **Independent storage directories for production deployments.** Separate config, credentials, the SQLite database (`zalo.db` + daemon locks), downloaded media, and Official Account credentials onto distinct volumes, network shares, or encrypted mounts via global CLI flags or environment variables:
  | Tier | Default | CLI Flag | Environment Variable |
  | :--- | :--- | :--- | :--- |
  | Config & registry (`accounts.json`, `mcp-config.json`, `qr.png`) | `~/.zalo-agent-cli` | `--config-dir <dir>` | `ZALO_CONFIG_DIR` |
  | Personal credentials (`cred_<ownId>.json`, mode `0600`) | `<CONFIG_DIR>/credentials` | `--credentials-dir <dir>` | `ZALO_CREDENTIALS_DIR` |
  | Per-account DB & locks (`<ownId>/zalo.db`, `daemon.lock`, `daemon-channel.json`) | `<CONFIG_DIR>/accounts` | `--data-dir <dir>` | `ZALO_DATA_DIR` *(or `ZALO_DB_DIR`)* |
  | Downloaded media (`<threadId>/`, `_conversations.json`) | `<DATA_DIR>/<ownId>/media` | `--media-dir <dir>` | `ZALO_MEDIA_DIR` |
  | Official Account credentials (`oa-credentials.json`, mode `0600`) | `~/.zalo-agent` | `--oa-dir <dir>` | `ZALO_OA_DIR` |
  Precedence is **CLI flag > environment variable > default**. Every command (`listen`, `msg history`, `mcp start`, `sync-mobile`, `sync-media`, `oa`, and MCP tools) honors these paths consistently.
- **Native `.env` file loading (zero external dependencies).** `zalo-agent` now loads `.env` files at startup using Node 22's built-in `util.parseEnv` before resolving storage paths, without overwriting existing shell environment variables:
  1. `--env-file <path>` (or `ZALO_ENV_FILE`)
  2. `./.env` in the current working directory
  3. `<CONFIG_DIR>/.env` (default `~/.zalo-agent-cli/.env`)
  Includes a tracked `.env.example` template shipped with the package.
- **Recommended `.env` split with `zalo-mcp`.** When using the `zalo-mcp` wrapper alongside `zalo-agent-cli`, keep `zalo-mcp/.env` for **port configuration only** (`ZALO_MCP_HTTP_PORT`, `ZALO_OA_WEBHOOK_PORT`) and place all storage directory overrides (`ZALO_*_DIR`) and engine settings in `~/.zalo-agent-cli/.env` (`<CONFIG_DIR>/.env`) so both commands share a single source of truth from any working directory.
- **Eliminated `npm warn deprecated node-domexception@1.0.0`.** Replaced `node-fetch@3.3.2` with Node 22's native global `fetch` inside the bundled `zca-js@2.1.0` patch (`patches/zca-js+2.1.0.patch`), removing `node-fetch`, `fetch-blob`, and `node-domexception@1.0.0` from the dependency tree.

#### Upgrade

```bash
npm install -g @ardennguyen/zalo-agent-cli@2.1.1
```

Or if using `zalo-mcp`:

```bash
npm update -g @ardennguyen/zalo-mcp      # Global npm install
.\zalo-mcp.ps1 update                    # Windows 1-click folder
bash zalo-mcp.sh update                  # Linux / macOS 1-click folder
```

#### Things to know

- **External media mounts survive `--purge`.** `logout --purge` and `account remove` wipe `<DATA_DIR>/<ownId>/` and the account's credential file. If you configure a custom `--media-dir` / `ZALO_MEDIA_DIR` (or `media.downloadDir` in `mcp-config.json`) outside `<DATA_DIR>/<ownId>/`, delete that external media directory manually when removing an account for privacy reasons.
- **Official Account (`oa`) media remains stateless.** `ZALO_OA_DIR` (`--oa-dir`) stores `oa-credentials.json` only; OA webhook events and conversation history return attachment URLs in JSON without auto-downloading files to disk.
- Commands, flags, and defaults: `skill/references/command-reference.md`. Installation and environment variables: `INSTALLATION.md`.

## [2.0.0] — 2026-10-13

A release-quality pass: every command was checked against what Zalo actually does, the listener no longer loses messages silently, and the MCP server is built for AI agents in production, including several bots on one account. 168 commits since 1.0.7, the last published version. Live-tested against a real account on 2026-09-30; the phone was the judge wherever a command's own success message could not be trusted.

**Requires Node.js 22 or newer** (its dependency tree needs 22.19 or newer in practice).

#### Highlights

- **The listener heals itself.** After a dropped connection or a restart, `listen` and `mcp start` pull what they missed from Zalo's offline message queue on their own socket, as Zalo Web does. No tap on the phone. A gap is closed only for the window the pull actually covered; anything it cannot reach stays pending with the exact `zalo-agent sync --from <date>` that restores it. `--no-self-heal` turns it off. Measured: a 75-minute outage came back in full.
- **Read state across devices.** When you read a conversation on the phone or Zalo Web, or mark it unread, the listener now records it (zca-js drops both reports). `conv recent` has a READ column, the MCP reports `readState` per conversation and `readOnZalo` per message, and `listen --events read` prints it. A bot can tell that a person already handled a thread.
- **The MCP server grows from 7 to 12 tools**: `zalo_react`, `zalo_undo`, `zalo_get_group_members`, `zalo_list_conversations`, `zalo_coverage`, plus `urgency` and `threadId: "me"` (My Documents) on `zalo_send_message`.
- **Several bots can share one MCP server.** Every bot passes a `consumer` name and gets its own read cursor; `zalo_mark_read` no longer deletes anything for everyone else.
- **Delivered receipts** are sent for every received message, as Zalo Web does (`--no-delivered-receipts` opts out). `conv read` sends real seen receipts and clears the unread mark.
- **Conversation and message controls**: `conv pin/unpin`, `conv archive/unarchive`, `conv forget`; `msg send --urgency`, the `me` alias, quote-replies, safe @-mentions, message pin/unpin, and forwards of every kind the app can send.
- **Group history** from Zalo's cloud-message store, and `group settings` that changes only the flags you pass and reads the group back.
- **Official Account**: `oa listen` knows all 57 documented webhook events, answers within Zalo's 2 seconds and flags redeliveries; `oa whoami` shows the package tier.
- **Production deployment guide**: `docs/deployment.md`.

#### Breaking changes

- **`logout` deletes the saved credentials**; the next command needs a new QR login. Zalo's own logout ends only the session key, never the login, so a login really ends only when you sign the device out from the phone's device list. Stopping a daemon is not a logout.
- **MCP `zalo_mark_read`** returns `{success, marked, readCursor}` and deletes nothing (it returned `{success, discarded}` before).
- **Media folders are named by thread ID**, not conversation name. Folders from earlier versions are not migrated.
- **`sync-mobile` defaults to the phone-backed restore** (one confirmation on the phone). `--transfer` is accepted and ignored; `--socket` asks Zalo's servers instead and usually returns nothing.
- **`whoami` exits 1** when it cannot get a profile; **`group settings` exits 1** when a requested change did not stick.
- **`mcp start` now refuses to start** on an empty `--auth` token or an unreadable `--config` (both used to start silently with no authentication, or with defaults that watch every thread).

#### Fixes worth knowing

- MCP tools and the notifier kept the start-up session after a re-login, so sends went through the replaced one and `zalo_get_history` scanned a closed listener.
- Pinning a message in a DM turned the cached DM into a group, so default-typed commands on it misrouted.
- `group history` claimed more messages after empty pages, and `zalo_get_history` returned nothing for an uncached group.
- Five commands had never worked and printed a clean failure with exit 0: `msg delete`, `msg forward`, `conv mute`, `conv unmute`, `conv read`.
- `sync-cloud` crashed on a fresh login; the QR page did not follow a regenerated QR; `oa login` crashed on its timeout path; the account directory was not created before the cache opened.
- `msg history` runs inside a running daemon and caches insert-if-absent; a daemon that cannot answer makes it fail instead of opening a second socket.

#### Known limits

- **History reaches back only to this device's login.** Zalo serves older messages only through the phone-backed `zalo-agent sync`.
- **Not yet verified against a live account**: which socket command a read on the phone arrives on, and the five new MCP tools (offline tests only). The next live session covers both.
- **One Zalo Web session per account**: `listen`, `mcp start` and a browser session cannot run together.
- **Unofficial API.** This drives Zalo through reverse-engineered endpoints; the account can be banned.
- **The `zalo-mcp` wrapper**: `zalo-mcp` 1.0.16 and later pin engine 2.0.0 and expose the new tools; older wrapper releases pin an older engine and do not.
- Deferred to 2.1: delivery-confirmation resends, native voice and video upload, voice-to-text, repair after queue overflow, E2EE detection, a live zCloud index, and a graceful stop for a daemon on Windows.

#### Upgrade

```bash
npm install -g @ardennguyen/zalo-agent-cli@2.0.0
```

Commands, flags and defaults: `skill/references/command-reference.md`. Operating it on a server: `docs/deployment.md`.

[Unreleased]: https://github.com/ardennguyen/zalo-agent-cli/compare/v3.0.0...v3.0-dev
[3.0.0]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v3.0.0
[2.5.9]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.9
[2.5.8]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.8
[2.5.7]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.7
[2.5.6]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.6
[2.5.5]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.5
[2.5.4]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.4
[2.5.3]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.3
[2.5.1]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.1
[2.5.0]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.5.0
[2.2.2]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.2.2
[2.2.1]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.2.1
[2.2.0]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.2.0
[2.1.1]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.1.1
[2.0.0]: https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.0.0
