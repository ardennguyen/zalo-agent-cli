# Changelog

All notable changes to `@ardennguyen/zalo-agent-cli`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm versions and git tags.

A release's section is added under `[Unreleased]` as the work lands and renamed in the version-bump
commit; the GitHub Release body is a copy of that section (see `docs/RELEASE.md`). Entries before
2.0.0 were never written down and are not reconstructed here — `git log v1.6.2` is the record.

## [Unreleased]

## [3.0.0] — unreleased

### What's changed since v2.5.9

**3.0 replaces zca-js with our own Zalo engine.** Logins, every request, uploads and the live socket now run on code built from the current Zalo Web protocol (API version 695) and kept in step with it, so the CLI keeps working with the latest Zalo version without waiting for a third-party library to catch up. With it, the CLI behaves toward Zalo the way Zalo Web does: it logs in, keeps its socket by Zalo's rules, signs out and restores history by the same steps, and it reports what it did and what it could not do.

More headline changes:

- **Everything saved is encrypted at rest.** The saved login and the other secret files are sealed, the message database and the webhook outbox are SQLCipher databases, downloaded media is encrypted, and every cached message carries a tamper-evident row MAC. A new `db` command group (`query`, `backup`, `export`, `verify`, `usage`, `purge`) replaces opening `zalo.db` with `sqlite3`.
- **On-demand presence.** `mcp start --http` and `listen --daemon` hold Zalo's socket only while something needs it and catch up from Zalo's offline queue when they wake; `presence.mode: "always-on"` keeps it open for real-time webhooks.
- **Confirmation before destructive actions.** A destructive CLI command acts only with `--yes`; without it, it sends nothing and exits 2, and `--dry-run` shows what it would do. The matching MCP actions take `confirm` and `dryRun`, and each deployment chooses who confirms with `confirmMode` (`agent`, `human` or `off`), through approval links when a person must approve.
- **The whole personal CLI over MCP.** 36 tools, nine of them new: every personal CLI command has an MCP action, apart from a short CLI-only list (logging in, the account registry, the daemon and fleet commands, `cloud get`).
- **Running it for others.** A runtime policy changed while the server runs, an admin API with its own credential, storage quotas and retention, a data export for a CRM, the fleet controller (`fleet serve`) with QR add, and a complete config set per deployment in `docs/config-samples/use-cases/`.

The MCP tools also speak one vocabulary now, and every id a program reads is a string; those are the breaking changes for programs (see the usage notices).

#### Breaking changes at a glance

Each one is described in its section below.

- **The saved files, `zalo.db`, the webhook outbox and downloaded media are encrypted the first time 3.0 touches them, and there is no way back.** A 2.x CLI cannot read them afterwards. A Linux server without a desktop keyring needs a key provider set before the first 3.0 command. Programs that opened `zalo.db` directly must move to `db query`, the `--json` output or the MCP tools.
- **`mcp start --http` and `listen --daemon` run on-demand by default.** Events that arrive while the socket is parked reach webhooks and waits on the next connect, flagged `catchUp: true`. Set `presence.mode: "always-on"` for real time. `--no-self-heal` is refused with on-demand.
- **A kicked on-demand daemon no longer exits: it yields** and refuses every request with `YIELDED` until `zalo-agent presence resume --yes` (or the admin, fleet or MCP equivalent). Always-on keeps exit 3.
- **A login Zalo keeps refusing no longer exits with code 4: the daemon stays up `signed_out`** and refuses requests with `SIGNED_OUT` until the account is added again by QR. `ZALO_EXIT_ON_SIGNED_OUT=1` keeps the old exit 4.
- **Leaving a group (or being removed, blocked or the group disbanded) deletes its local history** by default. `groups.onLeave: "keep"` keeps it.
- **Destructive commands need `--yes`**, `account export`, `db export --plaintext`, `db purge`, `fleet purge`, `cloud apply` and `presence resume` included; without it they exit 2 and send or write nothing.
- **A failing command exits 1** (most exited 0), and `--json` always prints one JSON object or array.
- **MCP clients and webhook receivers:** one name per id (`msgId`, `userId`, `senderId`), `threadType` is `"dm"` or `"group"`, every id is a string, `zalo_view_media` delivers the media instead of a path, `localPath` is gone, and `senderName` is now alias first (the name a message carried is `senderZaloName`).
- **Hidden chats are left out everywhere** (lists, searches, history, `listen`, webhooks, MCP, `db query`, `db export`) unless unlocked with the PIN.
- **`ZALO_QR_FLOW=legacy` is removed.** Every proxy sample and the generated Caddyfile answer 404 for `/zalo/admin/*`.

#### Upgrading from 2.5.9

1. **Stop every 2.x process that uses the home** (`~/.zalo-agent-cli`, or the `--config-dir` you use): a `zalo-mcp` deployment, `listen` / `mcp start` daemons, scheduled `sync-media`, bots that read `zalo.db`.
2. **Back up the whole plaintext home before you run any 3.0 command.** The first 3.0 command seals the saved files and encrypts each account's `zalo.db`, the webhook outbox and, in the background, the downloaded media. Sealing is one-way: 2.5.9 cannot read the result, and that backup is the only way back.
3. **On a Linux server without a desktop keyring, choose a key provider first** (`storage.json` or `ZALO_STORAGE_PROVIDER`: `passphrase`, `systemd-creds`, `kms` or `env`; docs/security.md). Keep each account's `keyring.json` in the same backup as its credentials from now on.
4. **Never run two copies of one login at once**: not 2.x beside 3.0, not two machines with the same copied home, not the old server beside a new one while you move. Zalo allows one web session per login; the second takes the socket and the first is kicked or yields. Move an account with the steps in docs/deployment.md §4.9 (`docs/config-samples/use-cases/c-vps-few-accounts/MIGRATE.md` for a Windows home moving to a VPS).
5. **Zalo keeps one web login per account.** A QR login into Zalo Web elsewhere signs the server out (it then stays up `signed_out`). Use the phone or Zalo PC beside the server, never Zalo Web. Each QR login adds an entry to the phone's device list and logs the older ones out; the offline queue survives a re-login because the device id is kept.
6. **Decide on presence and group exits.** A webhook that must fire in real time needs `presence.mode: "always-on"`; a deployment that must keep the history of groups the account leaves needs `groups.onLeave: "keep"`.
7. **Scripts:** add `--yes` to destructive commands and test the exit code (1 on failure). **MCP clients and webhook receivers:** read the usage notices at the end of this section.

#### Our own protocol engine

- feat!: **zca-js is removed; the engine is our own implementation of the protocol Zalo Web uses.** Logins, every request, uploads and the live socket now run on code written from what Zalo Web sends: its hosts, parameters, key order and timeouts. No third-party Zalo client is installed, patched or bundled any more, so installing the package runs no patch step. The protocol code lives in `src/zalo/`, a library with its own entry point and README that never imports the rest of the app. The engine change alone changes no command or flag; the changes you can see are listed below — [`c913adf`](https://github.com/ardennguyen/zalo-agent-cli/commit/c913adf), [`8fde64a`](https://github.com/ardennguyen/zalo-agent-cli/commit/8fde64a), [`30b7123`](https://github.com/ardennguyen/zalo-agent-cli/commit/30b7123)
- **Breaking:** `ZALO_QR_FLOW=legacy` is removed. It is refused before any request with a message that says so; leave `ZALO_QR_FLOW` unset or set it to `official` — [`7d7ed0b`](https://github.com/ardennguyen/zalo-agent-cli/commit/7d7ed0b)
- fix: **ids keep every digit.** Thread, message, reminder, poll and user ids past 2^53 are no longer rounded anywhere, and small ids arrive as strings too (a `reminderId` of 9 is `"9"`, and a reaction reply's `msgId`s are strings). Unread marks set on another device now name the exact conversation — [`8fde64a`](https://github.com/ardennguyen/zalo-agent-cli/commit/8fde64a), [`faf77d3`](https://github.com/ardennguyen/zalo-agent-cli/commit/faf77d3), [`0d38a35`](https://github.com/ardennguyen/zalo-agent-cli/commit/0d38a35)
- fix: **`listen` and `mcp start` report more of what Zalo sends**: messages carried inside group, page and catch-up lists, reactions carried inside other events or listed after a malformed one, and upload confirmations for photos and videos. A message Zalo pushes again is reported once, not twice. A recalled DM is reported with `threadType` `"dm"` (it said `"group"`). An end-to-end encrypted message this client cannot read is reported with `undecryptable: true` and empty content, and one log line says so the first time — [`8fde64a`](https://github.com/ardennguyen/zalo-agent-cli/commit/8fde64a), [`59dff1c`](https://github.com/ardennguyen/zalo-agent-cli/commit/59dff1c)
- fix: the socket reads the login's current cookies each time it starts, so a refreshed session is used without logging in again; a frame Zalo marks as an error is reported as an `error` event — [`8fde64a`](https://github.com/ardennguyen/zalo-agent-cli/commit/8fde64a)
- fix: **two sends in the same millisecond never share a `cliMsgId`** (split long texts, mixed sends), and `msg send-bank --json` prints the `cliMsgId` the card was sent with — [`88e07c1`](https://github.com/ardennguyen/zalo-agent-cli/commit/88e07c1)
- fix: **an upload cannot hang.** A file whose confirmation never comes fails with `UPLOAD_TIMEOUT` at most 60 s after the upload wait (180 s in all by default), and a chunk Zalo never answers fails the send after 60 s. `msg send-video` gives up after 8 s on a hosted URL whose host does not answer — [`c4ef074`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4ef074), [`88e07c1`](https://github.com/ardennguyen/zalo-agent-cli/commit/88e07c1), [`59dff1c`](https://github.com/ardennguyen/zalo-agent-cli/commit/59dff1c)
- fix: **a voice message is sent as Zalo Web sends it.** `msg send-voice`, `msg forward` and `zalo_forward_message` no longer contact the voice file's host to read its size before sending (so a slow or unreachable host no longer delays or fails the send), and a forwarded voice message uses Zalo's m4a link — [`1115f9f`](https://github.com/ardennguyen/zalo-agent-cli/commit/1115f9f)
- feat: `reminder list` takes `-p, --page <n>`, as `zalo_reminder` `list` already did; pages are read as Zalo Web reads them (see the reminder and board lists below) — [`5e0d09a`](https://github.com/ardennguyen/zalo-agent-cli/commit/5e0d09a)
- fix: links are sent with Zalo Web's parameters, so the preview card can look different; `msg link-preview` and `send-link` encode a link with spaces or accents first; `msg scan-url` gives up after 5 s, as Zalo Web does; `msg sticker-list` prints an empty list when Zalo suggests no sticker (it failed) — [`88e07c1`](https://github.com/ardennguyen/zalo-agent-cli/commit/88e07c1), [`59dff1c`](https://github.com/ardennguyen/zalo-agent-cli/commit/59dff1c)
- fix: **a group recall uses the group's own visibility**, as Zalo Web does (a CLI group recall looks the group up first); `msg undo` past the recall window says `The recall window for this message has passed` — [`faf77d3`](https://github.com/ardennguyen/zalo-agent-cli/commit/faf77d3), [`59dff1c`](https://github.com/ardennguyen/zalo-agent-cli/commit/59dff1c)
- fix: **a thread type other than 0 or 1 is refused before anything is sent** (`Thread type is invalid`) by `msg react`, `msg undo`, `msg delete`, the reminder commands and `conv mute`, `unmute`, `mark-unread`, `hide`, `unhide`, `auto-delete` and `delete`. `msg delete` in a DM on the other person's message sends it the way Zalo Web does — [`faf77d3`](https://github.com/ardennguyen/zalo-agent-cli/commit/faf77d3), [`0d38a35`](https://github.com/ardennguyen/zalo-agent-cli/commit/0d38a35)
- fix: **labels on groups show up on the group.** `zalo_label` `assign` / `unassign` store a group the way Zalo does (`g<groupId>`) and take a new optional `threadType` (`"dm"` or `"group"`) for every thread given; left out, each thread's stored type is used. Unassigning a group also removes the bare id earlier versions stored. On accounts Zalo has moved to its newer label service, label changes go through it, and a label list changed elsewhere since it was read is refused with a clear message instead of being overwritten — [`c28bea3`](https://github.com/ardennguyen/zalo-agent-cli/commit/c28bea3), [`faf77d3`](https://github.com/ardennguyen/zalo-agent-cli/commit/faf77d3)
- fix: `conv unread` marks the conversation at its newest cached message, as Zalo Web does; pins removed on another device are followed by `sync` instead of failing, and the pinned list's entry that is not a conversation is no longer counted as unresolved — [`c28bea3`](https://github.com/ardennguyen/zalo-agent-cli/commit/c28bea3), [`faf77d3`](https://github.com/ardennguyen/zalo-agent-cli/commit/faf77d3)
- fix: **`group create` and `group rename` refuse an empty name** (`A group name must not be empty`; the group used to be named after a timestamp), and `group create` leaves your own id out of the member list. Member and group lookups go in batches, so a long id list no longer risks an overlong request. An HTTP failure reads `HTTP <status>` — [`67a52ea`](https://github.com/ardennguyen/zalo-agent-cli/commit/67a52ea), [`d8bb449`](https://github.com/ardennguyen/zalo-agent-cli/commit/d8bb449)
- fix: avatars in friend and group replies come at 160 px, the size Zalo Web asks for, `profile avatar` and `group avatar` upload at that size, and `profile avatar-url` asks for it too (it asked for 240 px) — [`67a52ea`](https://github.com/ardennguyen/zalo-agent-cli/commit/67a52ea), [`d8bb449`](https://github.com/ardennguyen/zalo-agent-cli/commit/d8bb449), [`ab21e8f`](https://github.com/ardennguyen/zalo-agent-cli/commit/ab21e8f)
- fix: **`friend sent-requests`** says `No sent friend requests` when none are open (`{}` with `--json`, and in `zalo_friend` `sent_requests`); `friend find-username` prints the name (it printed `Name: ?`); `friend undo-request` explains Zalo's limit on taking requests back (try again in 24 hours); a phone search refused for the search limit says so; `friend find` turns a leading `0` into `84` whatever the session language; the nickname list is read to its real end — [`d8bb449`](https://github.com/ardennguyen/zalo-agent-cli/commit/d8bb449), [`cbbe376`](https://github.com/ardennguyen/zalo-agent-cli/commit/cbbe376)
- fix: unpinning a 1-1 message finds its topic when Zalo sends it as text — [`d8bb449`](https://github.com/ardennguyen/zalo-agent-cli/commit/d8bb449)
- fix: **`reminder edit` changes only what you pass.** An edit without `--time` moved the reminder to the moment of the edit, without `--repeat` reset it, and without `--emoji` blanked it; the reminder's own values are kept now. New reminders get Zalo Web's default color — [`0d38a35`](https://github.com/ardennguyen/zalo-agent-cli/commit/0d38a35), [`c553644`](https://github.com/ardennguyen/zalo-agent-cli/commit/c553644)
- fix: **`poll add-option` keeps your votes** (it could clear them); with `--vote` on a single-choice poll it replaces your earlier vote. `poll lock` no longer fails on an empty success reply — [`0d38a35`](https://github.com/ardennguyen/zalo-agent-cli/commit/0d38a35), [`c553644`](https://github.com/ardennguyen/zalo-agent-cli/commit/c553644)
- fix: reminder and board lists show the title Zalo sends as text (they showed `?`), list only reminders (no notes), end with an empty list instead of an error, and page with Zalo Web's cursor, so nothing added during a scan is skipped (`zalo_note list` and `zalo_reminder list` reach page 2 and later the same way; a short page no longer ends a list, and a group's reminder page 2 no longer repeats page 1). A DM sync also keeps DM reminders on the board as notes — [`0d38a35`](https://github.com/ardennguyen/zalo-agent-cli/commit/0d38a35), [`c553644`](https://github.com/ardennguyen/zalo-agent-cli/commit/c553644)
- fix: a catalog product with more than 5 photos is refused before any upload, and photo files given to the product calls are uploaded (they were ignored); `auto-reply` with `--scope 2` or `3` and no `--uids` sends an empty list — [`ab21e8f`](https://github.com/ardennguyen/zalo-agent-cli/commit/ab21e8f), [`c553644`](https://github.com/ardennguyen/zalo-agent-cli/commit/c553644)
- fix: `listen --json` prints only JSON event lines; the coverage-gap notice at startup goes to stderr
- fix: `logout` sends the logout form Zalo Web sends — [`570c5b7`](https://github.com/ardennguyen/zalo-agent-cli/commit/570c5b7), [`c553644`](https://github.com/ardennguyen/zalo-agent-cli/commit/c553644)

#### Confirmation before destructive actions

- **Breaking:** **destructive CLI commands act only with `-y, --yes`.** The actions Zalo Web asks about first (`msg undo`/`delete`, `group leave`/`remove-member`/`remove-admin`/`transfer-owner`/`block-member`/`disable-link`/`disperse`, `group settings --no-join-appr`, `friend remove`/`block`/`reject`/`undo-request`, `conv delete`/`hidden-pin-reset`/`unhide`/`forget`, `poll lock`, `reminder remove`, a `label update` that removes a label, `catalog delete`/`delete-product`, `bank remove`, `auto-reply delete`, `quick-msg remove`, `profile delete-avatar`, `logout`, `account remove`, `account export`, `mcp webhook purge`) send nothing without it and **exit 2**, saying what they would do; `--dry-run` shows that and exits 0. With `--json` the refusal is `{"error": "Not done: confirmation needed: …", "confirmationRequired": true, …}`. `write run` without `--yes` now exits 2 as well (it exited 1).
- feat: **`confirmMode` decides who confirms a guarded MCP action**: `agent` (default: the caller sends `confirm: true`), `human` (the server asks the user through MCP elicitation, and the caller cannot answer for them) or `off`. Set it in `mcp-config.json` or `ZALO_MCP_CONFIRM_MODE[_<ownId>]`. `zalo_undo`, `zalo_delete_message`, `zalo_group` `leave`/`remove_member`/`remove_admin`/`transfer_owner`/`block_member`/`disable_link`/`disperse` (and `settings` that turns join approval off), `zalo_friend` `reject`/`undo`/`remove`/`block`, `zalo_conversation` `delete`/`hidden_pin_reset`/`unhide`/`forget`, `zalo_reminder` `remove`, `zalo_poll` `lock`, a `zalo_label` `update` that removes a label, `zalo_catalog` `delete`/`delete_product`, `zalo_bank` `remove`, `zalo_auto_reply` `delete`, `zalo_quick_message` `remove`, `zalo_profile` `delete_avatar`, `zalo_cloud` `apply`, and `zalo_write` (guarded even when the mode is `off`) take `confirm` and `dryRun`. `groupConfirm: false` and `ZALO_MCP_GROUP_CONFIRM=0` still work and mean `off`.

#### MCP contract (breaking)

- feat!: **one name for each id, in every MCP input and reply.** A message's id is `msgId` and a user's is `userId` (a message's author is `senderId`); `threadType` is the word `"dm"` or `"group"`, in inputs and in replies. The old names are gone: a live message has no `id` (nor do the webhook and `/events/wait` payloads), a send reply has no `messageId`, a group member has no `uid`, and `zalo_list_conversations` has no separate `type`. `zalo_view_media` takes `msgId` and `zalo_delete_message` takes `senderId`. Models copy a name from one reply into the next call, and the old mix made them call tools with the wrong field names — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b), [`530060c`](https://github.com/ardennguyen/zalo-agent-cli/commit/530060c)
- feat: **clearer tool descriptions and server instructions.** Every tool and parameter says what it does, when to use it, where each id comes from and what it returns, and the server sends its instructions when a client connects — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b)

#### The personal CLI over MCP

- feat: **every personal CLI command has an MCP action**, making the same call, so an agent can do what the CLI can. Nine new tools: `zalo_conversation` (pin, archive, mute, hide, mark read or unread, auto-delete, delete or forget a conversation, the typing indicator, report a user or group), `zalo_profile` (avatar, bio, name, privacy settings, online status, language, linked devices), `zalo_auto_reply`, `zalo_quick_message`, `zalo_catalog`, `zalo_bank`, `zalo_cloud` (the zCloud summary, cleanup plan and the cleanup itself), `zalo_sticker` and `zalo_link` (preview, safety scan). `zalo_friend` gains `online`, `close`, `last_online`, `remove`, `block`, `unblock`, `block_feed`, `find_phones`, `qr`, `common_groups` and `biz`; `zalo_group` gains the rest of `group` (admins, owner, blocked members, settings, join requests, invite links and invitations, `disperse`, `avatar`, `members_info`). `zalo_send_message` also sends a `sticker`, a `voiceUrl`, a `video` from a URL or a local file, a `bankCard` and a `qrTransfer` image, and `zalo_sync` runs the `cloud`, `media` and `boards` stages. An action is named after its CLI subcommand, with `_` for `-`. What stays CLI-only (logging in, the account registry, the daemon and fleet commands, and `cloud get`, which takes the account's cloud key) is listed with the reason in the MCP guide, and a test fails when a new personal command has neither.
- **Breaking, MCP clients:** the new tools, `zalo_friend`, `zalo_group` and `zalo_send_message` refuse an input they do not take instead of ignoring it, and `dryRun` on an action that is not asked about first is refused instead of ignored (the action used to be done).
- fix: **`zalo_write` checks its arguments before it asks for confirmation**, so a missing argument is reported as one instead of as a confirmation refusal that could never succeed.
- fix: **`confirmMode: "human"` over the HTTP transport refuses at once and says why.** That transport is stateless (each request is a fresh server), so the question could never be answered: it said the client does not support elicitation, and a client that did would have waited five minutes. Use stdio for `human`, or `agent`.

#### MCP messages

- fix: **a long-poller no longer loses messages when the daemon restarts.** The buffer's cursor started again from 1 after a restart, so a client that came back with its saved `since` silently skipped every message that arrived before the new counter passed it. Cursors now start at the clock when the daemon starts (an epoch-ms-sized number), above anything an earlier run handed out, and a `since` beyond the newest buffered message is read as stale: from the start of the buffer, which can repeat a message but never skips one. `zalo_mark_read` with such a cursor marks nothing. Applies to `zalo_get_messages`, `zalo_wait_for_message`, `GET /events/wait` and `mcp wait` — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: **a reply says what it replies to.** Every message from `zalo_get_messages`, `zalo_wait_for_message`, `zalo_get_history` (cache and server) and `zalo_search_messages`, and the webhook payload, carries `replyTo`: `{ msgId, cliMsgId, senderId, senderName, text, timestamp, hasAttachment }` of the quoted message, or `null`. It was always `null`, so an agent could not tell what "look at this" pointed at. `senderId` is `null` when Zalo gives only an encrypted author id (a message restored from the phone) — [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- fix: **a reply sent from the phone names the message it quotes.** The phone quotes by the client id alone (`globalMsgId` 0), so `replyTo.msgId` was null; it is now looked up in the cache in the same conversation, and every message carries its own `cliMsgId` to match on when the quoted one is not cached — [`7c970cc`](https://github.com/ardennguyen/zalo-agent-cli/commit/7c970cc)
- fix: **a recall reaches the agent.** `zalo_wait_for_message` wakes and `zalo_get_messages` lists an entry with `type` `"undo"` whose `msgId` is the recalled message (`null` when only its `cliMsgId` is known); the webhook carries it as `event: "undo"` — [`8ffb5b9`](https://github.com/ardennguyen/zalo-agent-cli/commit/8ffb5b9)
- feat: **`zalo_group` `rename`**, and **`zalo_friend` `alias` / `alias_list`** (an empty `alias` removes the nickname; `senderDisplayName` follows at once) — [`81e2747`](https://github.com/ardennguyen/zalo-agent-cli/commit/81e2747)
- feat: **`zalo_search_messages` searches the way `msg search` does**: accent-insensitive by default (`accents: "exact"` to match them), filters by sender, period and type, pages with a cursor, and returns a highlighted snippet, optional context messages and how far back the cache reaches — [`99e17aa`](https://github.com/ardennguyen/zalo-agent-cli/commit/99e17aa)
- feat: **history by period.** `zalo_get_history` takes `since` / `until` (epoch ms) or `last` (`7d`, `2w`, …) and returns the cached messages of that period oldest first, up to 1000 per page, with `nextSince` for the rest; `msg history --since <date> --until <date>` (or `--last`) prints every cached message of the period at once. Reaching one day no longer means paging back 200 at a time — [`0094750`](https://github.com/ardennguyen/zalo-agent-cli/commit/0094750)
- feat: `zalo_send_message` warns when the text has a backslash and an `n` and no line break (Zalo shows them as typed); the text is still sent as written — [`c4e558b`](https://github.com/ardennguyen/zalo-agent-cli/commit/c4e558b)
- fix: **a long text goes out as several messages, in any script, instead of being refused** (over 3000 bytes: split at a line break, else a sentence end or a space, never inside a character, an emoji or an @-mention, 300 ms apart) — [`5736fb9`](https://github.com/ardennguyen/zalo-agent-cli/commit/5736fb9), [`2c0b3a1`](https://github.com/ardennguyen/zalo-agent-cli/commit/2c0b3a1)

#### Login and sessions

- feat: **the official QR login is the default.** It follows the sequence Zalo Web makes, including the second QR an account with a trusted device is asked for (the CLI then appears in the phone's linked-device list; each QR login adds an entry there and logs the older ones out). The previous flow is removed (see above) — [`5063855`](https://github.com/ardennguyen/zalo-agent-cli/commit/5063855), [`1722efc`](https://github.com/ardennguyen/zalo-agent-cli/commit/1722efc)
- fix: **the QR page says how the login ended, and an expired code waits to be asked for, as on Zalo Web.** The page shows "logged in" or "login failed" with the reason (it was closed before it could). At a terminal an expired code shows "QR code expired" with **Get a new code** (or press Enter), and the login ends after 5 minutes without one; with `--json` or no terminal, up to 5 codes are shown and then the login ends with `Login timed out`. `account login` no longer waits forever on an expired code — [`7c970cc`](https://github.com/ardennguyen/zalo-agent-cli/commit/7c970cc)
- fix: **the QR login offers only an address that works.** Without `--qr-url` the page listens on this machine alone, so it says so and gives the SSH tunnel to reach it from a VPS, instead of printing a public `http://<ip>:18927/qr` that could not answer; it no longer asks an outside service (ipify) for the public IP unless `--qr-url` is given. The `--json` `qr_server` event says `lan` and has `publicUrl` only then — [`4ebcd01`](https://github.com/ardennguyen/zalo-agent-cli/commit/4ebcd01)
- feat: **`login --sync [--sync-days <n>]`** starts a phone-backed restore right after the QR login, with no extra tap on the phone when the account allows it — [`b9a2890`](https://github.com/ardennguyen/zalo-agent-cli/commit/b9a2890)
- feat: **logout signs the device out**, by the six steps Zalo Web makes, and says so only after checking that the saved login is refused. `--keep-session` keeps the old behavior — [`9405743`](https://github.com/ardennguyen/zalo-agent-cli/commit/9405743)
- feat: saved-session logins are made by this CLI itself, as Zalo Web makes them (API version 695, the browser's headers, the account's own profile call, cookies written back), with no call to the npm registry — [`d3c8846`](https://github.com/ardennguyen/zalo-agent-cli/commit/d3c8846)
- feat: `listen` and `mcp start` keep their socket by Zalo's rules: reconnect after a pause by Zalo's own table, never retry a kick or a login Zalo keeps refusing, wait out maintenance. An always-on daemon exits on a kick (**exit code 3**); an on-demand one yields, and a refused login leaves either one up `signed_out` (exit code 4 only with `ZALO_EXIT_ON_SIGNED_OUT=1`; see On-demand presence below). The shipped systemd unit restarts on neither exit code — [`57748d7`](https://github.com/ardennguyen/zalo-agent-cli/commit/57748d7), [`47e4360`](https://github.com/ardennguyen/zalo-agent-cli/commit/47e4360)
- fix: **a kick says why it happened.** The daemon asked Zalo for the reason but exited before the answer came, so the reason never showed. It now waits up to 5 s and logs `Zalo says why: …` before it exits, without the misleading "Auto-retrying" line that followed the kick — [`b9a2890`](https://github.com/ardennguyen/zalo-agent-cli/commit/b9a2890), [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: **`fleet status`, `--status` and the health endpoints say why a socket is not up**: `maintenance`, `relogin` or `kicked`. A daemon that has exited on a kick leaves `kicked.json` in the account folder (removed at its next connect or login), so `fleet status` shows the account as `kicked`, not `stopped` — [`47e4360`](https://github.com/ardennguyen/zalo-agent-cli/commit/47e4360), [`ade58b8`](https://github.com/ardennguyen/zalo-agent-cli/commit/ade58b8)
- feat: the end date of a login is shown (`whoami`, `--status`, `zalo_session_days_left` in the metrics), with a warning from 14 days before: Zalo never renews a web login, so a new QR login is then due — [`e575e90`](https://github.com/ardennguyen/zalo-agent-cli/commit/e575e90)
- feat: `account devices` lists the linked devices readably and marks which one is this CLI; `account status` reports the zBusiness package and its limits and the zCloud plan, usage and expiry (`--json`; also `zalo_read` with `name: "account-status"`) — [`b523fbb`](https://github.com/ardennguyen/zalo-agent-cli/commit/b523fbb), [`b0f3648`](https://github.com/ardennguyen/zalo-agent-cli/commit/b0f3648)
- feat: **three more things changed on another device reach `listen` and `mcp start`**: a DM reminder deleted elsewhere is removed from the local cache (it stayed until the next `sync`), and a change to the account's device list is logged every time. `listen` prints them, with a product catalog change, only when asked: `--events catalog`, `reminder`, `devices` (opt-in; events `catalog_changed`, `reminder_removed`, `devices_changed`, each with the control's data as `control`, without the device list's signed identity material). They are no longer reported as controls this client has no handler for
- feat: **a DM reminder created or edited on another device reaches the cache at once** (it waited for the next `sync`): `listen` and `mcp start` write it as `sync-boards` would, and `listen --events reminder` prints `reminder_created` and `reminder_updated`. Unverified: only the names of these controls were seen live, so the fields read are Zalo Web's

#### On-demand presence (breaking)

- **Breaking: `mcp start --http` and `listen --daemon` run on-demand by default.** The socket is held only while something needs it (an MCP tool call, a `zalo_wait_for_message` / `GET /events/wait`, a CRM lease, a CLI request routed to the daemon: an upload, a `sync` stage, `mcp wait`; `presence wake`) and parks after `presence.idleTimeout` (5 min, never within `presence.minConnected` of a connect). What arrives while parked comes back from Zalo's offline queue on the next connect, so webhooks and waits get it then, flagged `catchUp: true`: **real time is `presence.mode: "always-on"`** (policy, `mcp-config.json`, or `ZALO_PRESENCE_MODE[_<ownId>]`). stdio MCP and a foreground `listen` printing to stdout stay always-on. The start-up catch-up (`connectOnStart`) runs once, then the socket parks. A policy change of `presence.*` applies at once. Both daemons go through one wiring (`src/core/daemon-presence.js`).
- **Breaking: `--no-self-heal` with on-demand is refused at start** (the catch-up is how a parked window comes back); with always-on it still works.
- **Breaking: MCP tools wait for a waking socket by class.** Sends and lookups run at once beside the wake; cache reads (`zalo_get_messages`, `zalo_get_history`, `zalo_search_messages`, `zalo_list_conversations`, `zalo_coverage`) wait up to `presence.warmWait` (10 s) for the connect and its catch-up and may answer with a `presence: {state, catchUp, coveredUntil}` block; socket tools (`zalo_sync`, `zalo_forward_message`, a send with a file) may fail with the retryable `WARMING` (`retryAfterSec`). CLI requests over the daemon channel behave as socket tools.
- **Breaking: a kick no longer ends an on-demand daemon; it yields, and only the user takes the account back.** Another session of the same login taking the socket (a second copy of these credentials, a second tab of one browser; close 3000) leaves the daemon up in **`yielded`**: an `account_state` `yielded` event (webhook, MCP buffer, `/status`, `presence status`) says so, and every tool call, lease, wait and CLI request is refused with **`YIELDED`** and what to do. Nothing takes the account back on its own: **`zalo-agent presence resume --yes`** (new; guarded: exit 2 without `--yes`, `--dry-run`), `POST /zalo/admin/presence/resume` (admin API), `POST /zalo/admin/accounts/<ownId>/presence/resume` (fleet controller) or MCP `zalo_profile` `presence_resume` (confirmMode applies). Always-on (and `presence.onKick: "exit"`) keeps exit 3.
- **Breaking: a login Zalo keeps refusing no longer ends the daemon (exit 4); it stays up `signed_out`.** Zalo keeps one web login per account, so a QR login into Zalo Web elsewhere revokes the server's; the daemon now lets the socket go, never retries, emits `account_state` `signed_out`, refuses every request with **`SIGNED_OUT`** ("add the account again by QR"), and keeps its API, status and the fleet controller's QR re-add working. **`ZALO_EXIT_ON_SIGNED_OUT=1`** keeps exit 4 (the systemd unit's `RestartPreventExitStatus=3 4` is unchanged). Both modes.
- feat: **`ZALO_CONNECT_SLOTS`** (default 0, no cap; fleet samples 16) caps how many daemons on the machine wake at once (a slot until the first catch-up, at most 60 s; `ZALO_CONNECT_SLOT_WAIT`, default 120 s). `/status` and `/metrics` carry the presence block (`lastWakeMs`, `lastCatchUpMs`, metered connected time; `zalo_presence_last_wake_seconds`, `zalo_presence_last_catch_up_seconds`, `zalo_presence_connected_seconds_total`, `zalo_presence_wakes_total`); `account_state` detail carries the mode. `/ready` is 503 while yielded or signed out.
- fix: the first alias snapshot logs `aliases: loaded N`, not `N changed`; one control replay that carries several device-list changes logs one line with a count.
- fix: **`listen --daemon` reads its presence settings from `mcp-config.json`, as `mcp start` does** — the `presence` block, `accounts.<ownId>.presence` and `<accountDir>/mcp-config.json`, under the environment and the policy. It read only the environment and the policy, so a webhook listener configured always-on in the file ran on-demand and delivered events late. A background `listen` refuses to start when that file cannot be read or is not valid JSON, as `mcp start` does.
- feat: **`ZALO_EXIT_ON_SIGNED_OUT_<ownId>`**, the per-account form of `ZALO_EXIT_ON_SIGNED_OUT`; it wins over the global one, like the other per-account variables.
- fix: **the admin API's `PUT`/`PATCH` reply carries `notes`** when a change switches `groups.onLeave`: the same text `policy set` / `policy unset` prints (purge→keep affects later exits only; keep→purge purges the kept groups on the next pass).
- The presence core (`src/core/presence.js`): holds (a tool call, a wait, a CRM lease, a CLI request, a stage, the start-up catch-up), the park/wake state machine, the idle timeout (`5m`, never before `minConnected` `60s`), hysteresis (over `12` wakes an hour the idle timeout doubles per wake, up to an hour), always-on as one permanent hold, the catch-up pulse (**off** by default) with a per-account offset, metered connected time and wait time.
- Park and wake in the socket host: a park closes the socket on purpose (a requested close: the supervisor retries nothing, no relogin) and keeps the session, lock, HTTP port and daemon channel; a wake starts a new supervisor on the same session (a dead one goes the existing relogin way). The parked window is a **planned** coverage gap (`idle`) that self-heal closes from Zalo's offline queue on the next handshake; what the queue no longer holds becomes a real gap, `idle-evicted`, with the `sync --from` advice. Health and `fleet status` do not warn about `idle` gaps, and a parked socket shows as `idle`, never `down`.
- CRM leases (`src/core/presence-leases.js`): `POST /zalo/presence/leases {holder, ttlSec?}` (201), `PUT .../<leaseId>` (renew; 404 once expired), `DELETE .../<leaseId>` (204), `GET /zalo/presence` (counts, never a holder), behind the agent's bearer token; TTL 90 s by default, 15–600 s, at most 64 per account (429), in memory only. A yielded or signed-out account refuses a lease (409 `YIELDED` / `SIGNED_OUT`).
- feat: **users** between a tenant and its accounts: `<configDir>/users/<userId>.json` (opaque CRM ids, sealed, revisioned) with the user's one `tenant`, the `accounts` it owns and its own policy; precedence inside the policy is tenant < user < account. Admin API `GET|PUT|PATCH /zalo/admin/policy/users/<userId>` (`{tenant?, accounts?, policy?}`) and `GET /zalo/admin/presence/always-on`; CLI `policy get|set|unset ... --user <id>` (`policy set tenant <id> --user <id>`, `policy set accounts <ownId,...> --user <id>`). Quotas sum over a tenant's users' accounts too.
- feat: **`presence.*` policy keys** (live) and the `mcp-config.json` `presence` block: `mode`, `idleTimeout`, `minConnected`, `maxWakesPerHour`, `warmWait`, `connectOnStart`, `catchUpEvery` (`off` by default), `maxLeases`, `leaseTtl`, `leaseTtlMax`, `waitHoldsSocket`, `onKick`; `ZALO_PRESENCE_MODE[_<ownId>]`, `ZALO_PRESENCE_IDLE_TIMEOUT[_<ownId>]`.
- feat: **the always-on cap**: `presence.alwaysOn.maxPerUser` (default 1, tenant or user policy) and `presence.alwaysOn.maxPerTenant` (tenant). A write that goes over a cap, or a lowered cap, sets the **oldest** always-on account to `on-demand` (an account-level write by `presence-cap`, listed in the reply's `demoted`), under a host lock.
- feat: **`account_state` events** from `listen` and `mcp start`: `{event: "account_state", accountId, state, previous, at, detail}` with `state` one of `idle`, `connecting`, `connected`, `kicked` (said just before exit 3), `yielded`, `login_needed` (while logging in again), `signed_out`, `maintenance`; to the webhook, the MCP buffer (a system event, as `storage_quota`), `listen`'s output and `/status` (`accountState`); Prometheus `zalo_presence_state{state,mode}`. Ids only, never a name.
- **Breaking:** `/ready` is 200 while the socket is parked (`idle`: the process serves and wakes on demand); `/status` `socket.state` and `fleet status` gain `idle` (never `down`; `--check` accepts it); the sample alert `ZaloSocketDown` skips idle accounts.
- feat: **`fleet serve`**, the fleet controller: one account-lifecycle admin API per host (`/zalo/admin/accounts`, start/stop/restart through systemd units or spawned daemons, presence wake/park relayed to the daemon, a **guarded** logout and removal with a single-use confirm token, `GET /events` SSE of `account_state`, the host-level policy routes), admin credential only, no account lock and no Zalo socket. `ZALO_FLEET_CONTROLLER_PORT`, `ZALO_FLEET_SUPERVISOR`, `ZALO_FLEET_WEBHOOK[_SECRET]`; samples `zalo-fleet-controller.service` and a polkit rule scoped to `zalo-mcp@*.service`.
- feat: **QR add from a CRM** on the fleet controller: `POST /zalo/admin/accounts/qr` (202 with a one-time `<publicUrl>/zalo/qr/<token>` page per flow), SSE events (`qr`, `scanned`, `expired`, `done`, `failed`), the current image, cancel; each flow a child `login` (no chat socket), at most `ZALO_FLEET_QR_FLOWS` (4); the finish assigns a port, writes the account's env file with a new token, adds it to the user, sets presence and starts it (a running daemon the new login kicked is restarted: `restarted: "relogin"`). The QR page's state is per page now, so two logins never share one.
- feat: **`presence status|wake|park|resume`**: the running daemon's socket under on-demand presence, through its channel (a daemon without presence says it stays connected).
- **Breaking:** an account under two users, or under two tenants, is refused on write with `409 MEMBERSHIP` (two tenants listing one account used to warn, the later winning). `quota.tenant.accounts` still counts but is superseded by user membership.

#### Offline queue: one device per login, overflow repair

- fix: **a re-login no longer makes the daemon claim it caught up on what it missed.** Zalo keeps the offline queue per device (imei), and every QR login used to make a new device id: after a re-login the old queue position was answered with nothing (`more: 0`, no `evict`), and self-heal closed the whole start-up gap ("closed 1 gap(s)", "covered since" a day earlier). Coverage now never starts before the time this device id came into use: the saved credentials carry `deviceSince` (stamped whenever the imei changes, by every login path; a login saved before this change uses its file's last write time, which is never earlier), and Zalo's own `first_time_login_device`, when the login settings carry it, counts too (the later of the two). The window before it stays a pending gap, `new-device`, with the `zalo-agent sync --from <date>` command, unless a phone-backed restore finished after the login and reached back past it.
- feat: **a QR re-login keeps the account's device id**, as Zalo Web keeps one per browser across logout and login: the active account's saved user agent is presented again, and an account that confirms the QR with a device id saved for it logs in with that imei, so Zalo's queue for it can survive the re-login. A first login, a login whose saved credentials are gone (`logout` deletes them) or unreadable, or another account gets a new device id. `login` and `account login` say which (`Device: the same device id ...` / `Device: a new device id ... (no saved login for this account here: ...)`; `--json`: `newDevice` and `device` in `login_success`).
- feat: **`login` always checks the phone's "sync messages to this device" box** after a QR login (the phone's `transfer_after_login` control, read once from the control queue) and says what it found. Ticked: the history is restored at once with the phone's key, no tap (the tick is the consent; this is what `login --sync` did, and `--sync` stays as the default's old spelling; `--sync-days <n>` limits it). Not ticked, ticked too long ago, or an offer for the PC app: nothing is started, and a new device is told which `zalo-agent sync --from <date>` restores what it does not have. **New `--no-sync`** only reports. With a `listen`/`mcp` daemon holding the account the offer is not read (it would need a second socket), and the command is printed instead. `--json`: a `login_auto_sync` event with `status` (`restored`, `declined`, `none`, `late`, `other-client`, `same-device`, `daemon-running`, `unknown`, `failed`).
- fix: **`login` finds the "sync messages" tick again after a re-login that kept the device id.** Keeping the device id keeps its control queue, and the phone's offer is at the end of it; `login` asked once, without a cursor, and got the oldest page, so a ticked box was reported as not ticked. Each control queue is now read as Zalo Web reads it: from the cursor `listen` saved, page by page while Zalo says there is more, then from the start. **New `login --verbose`** lists the queues read and every control seen (act type, act, `pc`, key or not, age; never the key; `--json`: `pulls` and `controls` in `login_auto_sync`).
- feat: **queue overflow is repaired for groups and announced.** When Zalo reports it dropped part of the group message queue (`evict`, or a queue reset), self-heal reads the cloud message store of the groups the account is in (most recently active first, at most 50 groups and 200 messages each; a group with nothing newer than the loss costs one request), stores what the cache lacks (insert-if-absent, `raw_data.src` `group-cloud`) and closes the group gap when every group was read back to it. A 1-1 overflow has no such path and stays pending. Either way a **`queue_overflow`** event goes out (`{event, accountId, fromTs, toTs, queues, direct, groups, pending, command}`, ids and counts only): `listen`'s output, JSONL and webhook, `mcp start`'s log, webhook and MCP buffer (a system event). A drain of 0 rows with no `evict` is a quiet queue, never an overflow.

#### Saved files and the message database are encrypted at rest (breaking)

- feat!: **the saved login and the other secret files are sealed.** `credentials/cred_<ownId>.json`, the trusted-device identity (`trusted-device.json`), the phone sessions of a history restore (`sync/open-sessions.json`) and the voice transcripts (`voice-text.json`) are encrypted with AES-256-GCM under a per-account key kept in `accounts/<ownId>/keyring.json`, and that key is itself encrypted by a key provider of the machine: Windows DPAPI by default on Windows, the login keychain on macOS, the desktop keyring on Linux. A copied file is useless on another machine or under another user. See [docs/security.md](docs/security.md).
- feat: **servers choose their provider** in `<config-dir>/storage.json` or `ZALO_STORAGE_PROVIDER`: `systemd-creds` (host key / TPM2), `kms` (AWS KMS, Google Cloud KMS, Azure Key Vault or HashiCorp Vault through the machine's identity; the cloud SDK is an optional peer dependency you install), `passphrase` (from a file or a prompt), or `env` (a key in an environment variable, warned about on every start). A Linux server without a desktop keyring and without a configured provider refuses with a message that names them: nothing is ever kept in plaintext as a fallback.
- feat: **optional dkey layer** (`"dkeyLayer": true` in storage.json, or `ZALO_STORAGE_DKEY_LAYER=1`): everything a login does not need (all but the saved login and the device identity) is also locked under a key derived from the account's data key that Zalo returns at each login, as Zalo PC does with its databases. A copied disk then reads nothing without a live login; the price is that local data opens only after a login.
- feat: **`account security status | migrate | rekey | provider`**: what is sealed and by which provider (never key material), seal what is left, make new keys, move the keys to another provider.
- **Breaking:** the first 3.0.0 command that reads a saved file seals it (sealed copy written, read back and checked, then renamed over the plaintext), and every login seals the rest of its account. There is no way back to plaintext; `account export` still writes the login out as before, on purpose. A 2.x CLI cannot read the sealed files.
- feat!: **the message database is encrypted.** `accounts/<ownId>/zalo.db` (messages, conversations, contacts, the search index) and its write-ahead log are SQLCipher v4 (AES-256 with an HMAC per page), keyed from the account's data key, with deleted rows overwritten (`secure_delete`). `sqlite3`, `better-sqlite3`, DB Browser for SQLite and any bot that opened the file directly now get `file is not a database`: read through the MCP tools (`zalo_get_history`, `zalo_search_messages`) or `msg history` / `msg search --json`, or `zalo-agent db query` (read-only SQL). A copied `zalo.db` opens only with its `keyring.json` and the same key provider, so copying files or `sqlite3 .backup` alone no longer makes a usable backup.
- **Breaking:** the first 3.0.0 command that opens the cache encrypts a 2.x plaintext `zalo.db` in place, once: a copy is encrypted and verified (integrity check, every table's row count), swapped in, and only then is the plaintext overwritten and removed. No plaintext copy is kept, and 2.x cannot read the result: the only way back is a backup taken before upgrading. A crash part way is finished or undone at the next open. It takes about 1 s per 20 MB, needs free disk of about 1.1× the database, and refuses while another process holds the account (`daemon.lock`) or, on Windows, has the file open. `account security status` and `migrate` list the database; `rekey` re-encrypts it in place under the new key and keeps the old key until that is done, so an interrupted rekey is finished by running it again (its `--json` reply lists `databases` and whether each is under the new key).
- feat: **tamper evidence for cached messages (row MAC).** Each message row carries an HMAC (16 bytes) of its id, conversation, sender, time, type, text, raw data and status, keyed with the account's `row-mac` key, which is never exported, and kept by SQL triggers for every writer. Someone holding the database key cannot add or change a message without it showing: a tool without the app's function cannot write a message, and a changed row fails its check. Quote, forward, delete, recall, react, pin and `msg media` / `zalo_view_media` refuse a row that fails ("failed its integrity check"); `rowMac.verifyOnRead: "off"` in `storage.json` turns that check off. Rows cached before are sealed once by the first command that opens the cache (about 50,000 rows a second); `rekey` carries the MACs to the new key. About 20 µs more per message written. Temporary tables, sorts and statement journals of the database now stay in memory, so no decrypted page reaches a temporary file.
- feat: **`db` command group** (CLI-only, local, no login): `db query <sql> [-n, --limit <n>]` runs one read-only statement on the encrypted cache (read-only connection with `query_only`; writes, `ATTACH`, all but a few schema pragmas, `PRAGMA key` and the functions that reach outside the database are refused before anything is prepared; 1000 rows by default, `truncated` says when there were more; hidden chats are left out unless the PIN is given, see below). `db backup --out <file>` writes an encrypted, verified copy (`VACUUM INTO`, a consistent snapshot beside a running daemon, never overwriting a file); it opens only with the account's keyring and provider. `db export --out <file>` writes the same copy, or with `--plaintext` a decrypted one, guarded like `account export` (`--yes`, `--dry-run`, exit 2 without either). `db verify [-T <thread>] [--since <date> | --last <period>]` checks every cached message's row MAC and exits 1 on any finding. These replace opening `zalo.db` with `sqlite3` / `better-sqlite3` and `sqlite3 .backup` (docs/deployment.md §1.5, §4.6).
- feat!: **the webhook outbox is encrypted** like the message database (`webhook-outbox.db`, SQLCipher v4, its own subkey of the data key): queued and dead-lettered events hold message content. The first 3.0.0 writer encrypts a 2.x outbox: one with nothing queued is removed and recreated, one with a backlog is copied, encrypted and verified, so no queued event is lost. `mcp webhook status` / `list` read it with the key and fail closed when it cannot be had; `account security status`, `migrate` and `rekey` include it.
- feat!: **downloaded media is encrypted.** Every file under the media root (`accounts/<ownId>/media/`, `--media-dir` / `ZALO_MEDIA_DIR`, `media.downloadDir`) is a chunked AES-256-GCM container under a random per-file key, wrapped under the account's media key; file names do not change, any byte range reads without decrypting the rest, and `_conversations.json` is sealed too. OS viewers, scripts and anything that opened these files directly can no longer read them: use `zalo_view_media`. A custom root becomes unreadable once its account is removed (crypto-shred).
- **Breaking:** media downloaded by 2.x is sealed in place, once per file (written beside, checked, swapped, the plaintext overwritten and removed): on its first read, by `account security migrate`, and by a running `listen` / `mcp start` in the background (50 files every 30 s). About 40 MB/s. In a media root shared by several accounts only the files this account's messages point at are sealed under its key. `account security status` counts media (`sealed`, `plaintext`, `unreadable`, `staleKey`); `rekey` re-wraps each file's key in its header (76 bytes, the old wrap kept valid until the new one is written) and never re-encrypts the media; its `--json` reply has `media`.
- **Breaking:** `zalo_view_media` delivers media instead of returning a path: inline as MCP image or audio content (photos, GIFs, doodles, stickers and voice up to 5 MB), as a 10-minute link (`url`, with `auth`), or as a private decrypted copy (`path` with `expiresAt`, deleted after 10 minutes, only for a client on the server's machine), by the server's `media.deliver` or the call's new `deliver` input; the reply is `{success, msgId, mediaType, delivery, mimeType, size, …}` with `notes` when the delivery differs from the one asked for. `open` only opens a tempfile on a stdio server, and `media.autoOpen` now defaults to off over HTTP. A sticker is fetched on demand and sent inline. A hidden chat's media is refused. `msg forward` / `zalo_forward_message` upload a decrypted copy that is removed as soon as the send returns, and take a video's size from the encrypted file's header. `cloud get` writes a cached copy out decrypted. `sync-media --prune` reports the plaintext size.
- **Breaking:** `localPath` is gone from `msg history --json`, `msg search --json`, `zalo_get_history`, `zalo_search_messages` and `zalo_get_messages`' attachments; a message with downloaded media says `mediaCached: true` instead, and the text output of `msg history` shows `[Media: zalo-agent msg media <msgId>]`. The files it pointed at are encrypted.
- feat: **`msg media <msgId>`** gets a cached photo, voice message, video or file decrypted: a private copy (default, 10 minutes), `--out <file>`, `--stdout`, `--deliver link` (a link the running `listen` / `mcp start` serves, asked over its loopback channel) or `--deliver inline` (base64 under `--json`); `--open` opens the copy. It reads the cache only (no login).
- feat: **media delivery is a policy.** New `mcp-config.json` keys under `media`: `deliver` (per kind: `inline`, `link` or `tempfile`; by default photos, GIFs, doodles, stickers and voice inline, video and files as a link), `inlineMaxBytes` (5 MB), `allowDeliver` (what a call may ask for; a CRM can forbid `tempfile`), `linkTtl` and `tempfileTtl` (10 minutes), `linkAuth` (`auto`, `bearer` or `capability`), `linkRateLimit` (60 a minute) and `capability.maxClients` / `capability.ttl` (3 client addresses for 15 minutes), each also under `accounts.<ownId>.media`; `ZALO_MCP_MEDIA_DELIVER[_<ownId>]` and `ZALO_MCP_MEDIA_LINK_AUTH[_<ownId>]`. A top-level `trustedProxies` (`ZALO_MCP_TRUSTED_PROXIES`) names the reverse proxies whose `X-Forwarded-For` is believed; none by default. `media.autoOpen` is unset by default: on for stdio, off over HTTP. Decrypted copies live in a private folder and are deleted after `tempfileTtl`, on exit, or by a sweep at the next start.
- feat: **media links**: `/zalo/media/<token>` on the MCP HTTP port (or a `127.0.0.1` listener under stdio) serves a cached file from its encrypted form, one byte range at a time (`206`, `416`; video seek works), with `no-store`, `nosniff`, `no-referrer` and a `default-src 'none'; sandbox` CSP; a type off the media allow-list is a download. `bearer` links also need the server's own `Authorization`; `capability` links off this machine serve at most 3 client addresses each for 15 minutes. 60 requests a minute and 10 unknown tokens a minute per client address, then `429`. Links end on logout or kick, when their chat is hidden, on a rekey and on restart (`410`). The access log masks the token and drops the query. The proxy samples no longer compress `/zalo/media/` and pass the client's address; set `trustedProxies` behind a proxy.
- fix: opening the cache no longer reads every message: the repairs it runs at each open use two new indexes (`type`; `senderId, threadId`). On an encrypted cache of 100,000 messages an open went from 3 s to 10 ms.
- build: **the SQLite driver is now `better-sqlite3-multiple-ciphers` 13.0.3** (an exact pin), a fork of `better-sqlite3` with the same API and the same SQLite build, plus SQLite3 Multiple Ciphers so the message database can be encrypted. It ships prebuilt binaries for Linux (glibc and musl), macOS and Windows on x64 and arm64 and runs no install script, so nothing is compiled on the host.

#### Hidden chats stay hidden in db query and db export

- feat: **`db query` and `db export` (with or without `--plaintext`) leave hidden chats out** unless `--include-hidden` and the hidden-chat PIN (a prompt that does not echo, or `--pin-stdin`; never an argument), checked as `conv hidden` checks it, with the same lockout. Without the PIN they work on a snapshot with every row of those conversations removed (messages, search entries, reactions, row MACs, conversation state, boards, reminders, cloud items), so no SQL reaches them, and an exported file holds no trace of them. When this machine does not know which chats are hidden yet and Zalo cannot be asked, they read nothing. `db backup` keeps them: it is the encrypted restore image, read only through these commands.

#### Export my data (CRM)

- feat: **`POST /zalo/admin/export/<ownId>`** on the admin API (its own credential, never the agent's): builds an export of the account's messages as a job (`GET .../export/<ownId>/<jobId>` for its state, `DELETE` to drop it) and hands it out as an **expiring download link** with the media-link rules (bearer or capability as `media.linkAuth` says, byte ranges, `no-store`, an attachment, `media.linkTtl`). The file is deleted once it has been downloaded whole, when the link expires or is revoked (logout, kick, rekey, a link-policy change, a chat hidden after the export was made), and with the server.
- **Encryption is chosen per export:** `encryption: "password"` (the user's password in the JSON body; scrypt and AES-256-GCM, the parameters in the file's header; never stored or logged) or `"plaintext"` with `confirm: true` (without it: `409`, `confirmationRequired`, as the CLI's `--yes`).
- **Hidden chats are left out** unless `includeHidden: true` with either a **single-use grant** (`POST .../export/<ownId>/hidden-access` returns a secure-page link for the owner and a grant; the owner types the PIN on the engine's page, so it never reaches the CRM; the grant works once, for an export, within 2 minutes) or the **PIN in the JSON body** over https or from this machine (refused over plain http from elsewhere, and in a URL), checked once with the hidden-chat lockout and dropped. Hidden chats in the file are marked in `export_hidden_threads`; the PIN and its hash never are.
- feat: **`db export --password`** (asked twice) / **`--password-stdin`**: the same password-encrypted file from the CLI. Every export (CLI or API) now carries `export_info` and `export_hidden_threads`; with `--include-hidden` the reply says `hiddenChats: "included"` (was `null`). The file format and how to read it are in docs/security.md §7; an import command is a follow-up.

#### Storage quotas and retention

- feat: **storage quotas, the zCloud way.** `quota.account.limit`, a tenant's `quota.tenant.limit` shared by its `quota.tenant.accounts`, `quota.graceDays` (45) and `quota.warnAt` (0.8), set in the runtime policy (or `storage.json`). Over a limit, **caching goes on**: the daemon sends `storage_quota` events (`warn`, `over`, `grace_ending` 7 days and 1 day before, `purged`, `ok`) to the webhook, and `listen` prints them. Only after the grace period does it purge, oldest media first, then the oldest messages with their search entries, reactions and row MACs (`secure_delete`, WAL checkpoint), until usage is at or under the limit. Back under the limit (a raise, a renewal) clears the clock. A tenant on several hosts: each host sums only the accounts it runs; the console reads `/zalo/admin/usage` and pushes per-account caps.
- feat: **retention rules**: `retention.messages` / `retention.media` = `keep` (default) or `<N>d`, `retention.outboxDead` (30d) for dead webhook deliveries, checked every `retention.purgeEvery` (6h); `ZALO_RETENTION_MESSAGES` / `ZALO_RETENTION_MEDIA` (per account too). A purge raises the database's retention floor, so a later `sync` or `msg history` fetch never restores a purged message.
- feat: **`db usage`** (storage, quota state, rules) and **`db purge [--dry-run] [--yes]`** (guarded: exit 2 without either; run by the daemon holding the account when one runs). `account status` (and `zalo_read` `account-status`) shows this machine's storage as `storage`.
- feat: **MCP clients see their storage too** (not every MCP client is an agent): `storage_quota` events reach `zalo_get_messages`, `zalo_wait_for_message` and `GET /events/wait` as system events (`system: true`, `type: "storage_quota"`, `level`, `usedBytes`, `limitBytes`, `purgeAt`, a readable `text`), and **`zalo_profile` `usage`** returns what `db usage` prints.
- A tenant member whose daemon is down is measured at each check the way a daemon measures it (its database read-only with its own keys, from a temporary copy, and its media folder) instead of the figure its daemon last left; when its database does not open, its file sizes. The log says which; nothing in its folder is written.
- The purge is a fourth writer to `zalo.db`, **delete-only**, run only by the process holding `daemon.lock`.

#### `fleet purge` for a timer

- feat: **`fleet purge [accounts...] [--dry-run|--yes]`**, for a systemd timer or cron: for each account on this machine with **no running daemon**, the same purge as `db purge`, under the account's `daemon.lock` (so a stopped account's grace period and age rules still run out); a **running daemon** is left alone while its last check is within `retention.purgeEvery` × 2, and asked over its channel to run it when it is behind. Guarded (exit 2 without `--yes`). `fleet generate` now also writes `zalo-mcp-purge.service` and `zalo-mcp-purge.timer` (hourly, random minute, `Persistent=true`); samples in `docs/config-samples/systemd/`. Each pass records `lastPass` in `quota-state.json`.

#### Runtime policy and the admin API

- feat: **change policy while the server runs.** `confirmMode`, `hiddenChats`, `allowPinArgument`, `approval.*`, media delivery and links (`media.*` but `downloadDir`), `webhook`, `webhookBatchSize`, `webhookMaxAge`, and the coming `quota.*` / `retention.*` can be set in a **runtime policy**: a sealed, revisioned file per account (`<accountDir>/policy.json`) and per tenant (`<configDir>/tenants/<tenantId>.json`, for the accounts it lists), above the files and the environment, read on every tool call. A change counts on the next call: a link-auth change revokes the outstanding media links, a webhook change moves the delivery. Keys read only at start (port, bind address, `publicUrl`, TLS, OAuth, the key provider) and secrets are refused as `restartRequired`. `.env` stays for start-up settings.
- feat: **the admin API** on the MCP HTTP server: `GET|PUT|PATCH /zalo/admin/policy[/<ownId>|/tenants/<id>]` and `GET /zalo/admin/usage`, with `If-Match: "<rev>"` (412 on a stale rev) and `ETag`. It takes **its own credential**: an admin token (`zalo-agent policy token --rotate`, only its hash kept, sealed; or `ZALO_MCP_ADMIN_TOKEN_FILE` / `admin.tokenFile`) or a client certificate (`ZALO_MCP_ADMIN_CLIENT_CA` / `admin.clientCa`, mTLS). The agent's bearer and OAuth tokens are refused there, so an agent can never change its own limits. With no admin credential the API does not exist.
- feat: **`zalo-agent policy get|set|unset [--tenant <id>] [--if-match <rev>]`** and **`policy token [--rotate]`**: through the running daemon (applied at once) or into the file. A config-management tool can also drop the file as plain JSON: the daemon checks and seals it, and keeps the last good policy when it does not validate (`policy.json.rejected`). Every change and refusal is in `<configDir>/policy-audit.log` (keys and revs, never a value or a credential). A daemon refuses to start on a policy file it cannot use.

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
- feat: **`msg send-video` takes a local file**: the video goes up in chunks (on the running daemon's socket when one is up), a local `--thumb` image goes up as a photo, and it arrives as a video, as Zalo Web sends one. Unverified live
- fix: **a GIF larger than 512 KB goes up in chunks** of 512000 bytes, as Zalo Web sends one; it was sent whole in one request. Unverified live for a GIF of more than one chunk

#### zCloud

- feat: the zCloud index is **applied, not only read**: removals and cleared conversations are followed, a walk resumes from where it stopped, the server's "verify" notice is answered, and the web client's retry rules are used — [`2744631`](https://github.com/ardennguyen/zalo-agent-cli/commit/2744631)
- feat: `sync` reads the zCloud plan first; an account with no zCloud skips the cloud stage and says so; media that is gone from the CDN says whether the cloud lists it — [`bfc919f`](https://github.com/ardennguyen/zalo-agent-cli/commit/bfc919f)
- feat: **`cloud ls` and `cloud plan`** report what the index holds and what a cleanup would cover and free. They delete nothing — [`b0f3648`](https://github.com/ardennguyen/zalo-agent-cli/commit/b0f3648)
- feat: **`cloud apply`** deletes what `cloud plan` lists, the way Zalo Web's cloud view deletes: the chat message behind each item, for this account on every device, with no undo. It asks first (`--yes`, `--dry-run`, exit 2 without either). Unverified: no such delete has been watched yet
- feat: **`cloud get <noiseId> -o <file>`** downloads one item as Zalo Web opens it (`?zcloudurl=true` and the viewer-key header; the bare address answered 404). An encrypted item opens with the account's cloud key, given at run time on standard input or a hidden prompt and never stored; neither Zalo client derives that key from a PIN. Unverified live
- feat: `sync --plan` shows the cloud stage running in the daemon when one that runs it is up (`rest→daemon`, `cloudViaDaemon` in `--json`)
- fix: **the cloud walk never runs beside the daemon's own.** With a `listen` or `mcp start` daemon up, `sync`'s cloud stage and `sync-cloud` walk the zCloud queue in the daemon, one at a time with the walk it makes when Zalo says the queue may be stale; beside a daemon that cannot (an older one, or another `sync` holding the account) the walk is skipped and says why, instead of two walkers writing the index at once
- feat: **a forced verify is answered as Zalo Web answers it.** When Zalo asks for one (`forceVerify` or `forceReset` in its cloud notice), the daemon walks the whole queue from the top and then removes what the queue no longer lists, at most once in 30 minutes and only after a first `sync-cloud`; a request to correct the cloud key or audit the local queue is logged and left

#### Everything else Zalo Web can do

- feat: **`read list|run`** (41 read-only calls) and **`write list|run`** (27 state-changing calls, behind a dry run and a confirmation), also as the MCP tools `zalo_read` and `zalo_write` — [`54b36c9`](https://github.com/ardennguyen/zalo-agent-cli/commit/54b36c9), [`9a98960`](https://github.com/ardennguyen/zalo-agent-cli/commit/9a98960), [`a4603c5`](https://github.com/ardennguyen/zalo-agent-cli/commit/a4603c5)
- feat: **`catalog product <productId>`** shows one product (`prodcatalog/product/view`). Unverified: needs a zBusiness catalog
- fix: `friend online` asks as Zalo Web's Friends tab does and, like it, moves on to the next profile host after an HTTP error, so the 404 is reported only when every host gives one. Unverified until a capture of the Web's Friends tab
- `write run blocksharing-update` is marked unverified (`write list`): it needs zBusiness Max, and a personal account gets 829
- feat: **`conv read` marks a conversation read as Zalo Web's "Mark as read" does**: a seen receipt for every cached incoming message after your read position (up to 50, oldest first; end-to-end encrypted ones left out), a reaction-seen receipt when a reaction is unread (unverified), and the manual unread mark removed only when it is set. The reply says what the sender sees (`senderReceipt` from your seen-status setting): they see "Seen" unless your seen status is hidden. `conv read --mark-only` removes only the unread mark (the real unread count stays). `zalo_conversation` `read` takes `markOnly` and answers the same JSON
- feat: **`msg seen <threadId> [msgIds...]`** and `zalo_conversation` `seen` mark chosen cached messages seen (or the newest incoming one), without touching the unread mark; Zalo also moves your own read position
- feat: **`friend last-online` follows Zalo Web**: when your own online status is hidden it asks nothing and answers `hiddenBy: "you"` (`--ask-anyway` asks regardless), `hiddenBy: "them"` when the user hides theirs, and an Official Account is asked as one (`--oa` skips the lookup). `--cached` answers from the presence pushes a running `listen` or `mcp start` keeps, without a request. `zalo_friend` `last_online` takes `askAnyway`, `cached`, `isOA` and answers the same JSON. Unverified live
- feat: **`profile set` covers `add-by-card` (found through a shared contact card) and `focused-tabs`** (the Focused and Other tabs, written the way Zalo Web writes it). `profile settings` also shows strangers' messages, two-factor and quick messages (read-only), and with `--json` every key Zalo sent that is not mapped, under `other`; `zalo_profile` `settings` answers the same JSON
- feat: **`quick-msg enable|disable`** and `zalo_quick_message` `enable` / `disable` turn quick messages on or off for the account, as Zalo Web's switch does. Unverified live
- feat: **`conv block-sharing <threadId> on|off`** and `zalo_conversation` `block_sharing`. Needs zBusiness Max; unverified
- feat: `listen --events online` prints a user's last-online time as Zalo pushes it (`online_status`), and `--events settings` prints your own settings changed on another device (`settings_changed`). `listen` and `mcp start` keep the last-online times for `friend last-online --cached` whatever `--events` says
- fix: **typing from your own other devices no longer shows as an event**, as in Zalo Web, and a peer sending a file shows as a `typing` event with `action: "fsending"`
- fix: **`msg typing` and `zalo_conversation` `typing` never tell a stranger you are typing**, as Zalo Web never does: a 1-1 conversation with someone who is not a friend is refused when the friend list is loaded (the MCP server loads it at start); a one-shot command sends and says it could not check
- docs: `profile active` is this session's presence (active or away), not the online-status privacy setting (`profile set online-status`); `friend online` is dead in practice: Zalo answers 404 and Zalo Web discards the answer too
- feat: **hidden chats stay hidden, as in Zalo Web.** A hidden conversation is left out of `conv recent`/`pinned`, `msg search`, `msg history`, `listen` output, webhooks and every MCP list, search, history, buffer and wait, unless it is unlocked. The MCP server follows the new `hiddenChats` policy (`exclude` by default; `contentless` passes an event on as `{event, hidden: true}` with no thread id or content; `include` shows everything). On the command line, `--include-hidden` asks for the PIN for that one command (`conv recent`, `msg history`, `listen`), and `listen --hidden-contentless` reports the bare event. The list is kept current from the `hidden_chat` pushes of other devices
- feat: **the hidden-chat PIN never reaches the agent or the logs.** The CLI asks for it at a prompt that does not echo (or reads `--pin-stdin`); the MCP server hands out a one-time **secure input page** (`/zalo/secure/<token>`, on the `--http` port or a local listener under stdio) where the owner types it, and the call is repeated with its `ticket`. A client that declares URL-mode elicitation is sent the page directly. The PIN is checked in memory against Zalo's hash, never stored, and 6 wrong PINs start a growing back-off. `conv hidden` and `zalo_conversation` `hidden` give only the count without the PIN; `unhide` needs the PIN; `hide` needs a PIN set; `hidden-pin` asks the current PIN and the new one twice. New `mcp-config.json` keys `hiddenChats`, `allowPinArgument` (default false: a PIN input lands in the client's logs) with `ZALO_MCP_HIDDEN_CHATS` and `ZALO_MCP_ALLOW_PIN_ARGUMENT` (each also `_<ownId>`); the page's links use `publicUrl` (below)
- feat: **one public address for the whole server, `publicUrl`.** `--public-url <url>` on `mcp start` (and on `login` and `account login`), `ZALO_MCP_PUBLIC_URL[_<ownId>]`, or `publicUrl` in `mcp-config.json` (top level or an account's block), highest first in that order, is what the MCP endpoint, the OAuth issuer metadata and every link the server hands out are built from: the one-time secure page `/zalo/secure/<token>` and the QR login page. It must be `https` (`http` only on `localhost`, `127.0.0.1` and `[::1]`), may carry a base path for a proxy that strips a prefix (`https://zalo.example.com/a/<ownId>`), and has no query or fragment; a value that breaks a rule stops `mcp start --http` (and `login`) with a message saying why. Links are never built from a request's `Host` header: without `publicUrl` they use the server's own address, and only the OAuth metadata still infers its origin from the request, as before. The secure page's form now posts to its own path relatively, so it works under a base path.
- feat: **the QR login page at a one-time link.** `login --public-url https://zalo.example.com` prints `https://zalo.example.com/zalo/qr/<token>` (the image at `.../qr.png`) instead of a localhost address, served on the QR port for a reverse proxy that routes `/zalo/qr/` there (the internet proxy samples do). The token is 128 random bits, lives while a code is on screen and ends with the login; every answer is `no-store` with a CSP that allows only the page's own image, style, script and polls, `X-Frame-Options: DENY`, no referrer and `nosniff`, and the token is masked in the MCP request log. The MCP HTTP server mounts the same route ahead of the bearer check. Without a public URL, `login` serves `http://localhost:18927/qr` exactly as before (now with the same headers).
- feat: **`confirmMode: "human"` works over the stateless HTTP transport** (the CRM / SaaS case): the question becomes a one-time approve page whose link is in the reply (`confirmationRequired`, `secureUrl`, `ticketExpiresAt`, `retryWith.ticket`); once approved, the repeated call with `ticket` goes ahead, once. Every guarded tool takes `ticket`. Under stdio a client with form elicitation is asked as before, and one with only URL elicitation is sent the page
- feat: **an approve page can ask for something only the person has**, so an agent that can open the link it relays cannot approve its own action: `approval.secret` (`ZALO_MCP_APPROVAL_SECRET[_<ownId>]`) is `pin` (the hidden-chat PIN, with its lockout), `password` (an approver password set with the new **`mcp approver set`**, typed at a hidden prompt or piped with `--stdin`, kept only as a salted scrypt hash; `mcp approver status`/`remove`), `none` (a click approves: weaker), or `auto` (default: the approver password when one is set and the link travels through the agent). The reply says `approverSecret: true|false`, and `mcp start` warns once when `confirmMode` is `human` and the link reaches the agent with no secret. Six wrong secrets start the PIN's back-off
- feat: **`approval.deliver` keeps the link away from the agent** (`ZALO_MCP_APPROVAL_DELIVER[_<ownId>]`): `result` (default: the link is in the tool result), `webhook` (the link is POSTed to the MCP webhook as `{event: "approval_requested", accountId, kind, action, wouldDo, target, secureUrl, expiresAt, approverSecret}`, queued and signed like every other webhook event, for a CRM's approval UI; the tool result carries only `confirmationRequired` or `pinRequired`, `approvalPending: true`, `ticket`, `ticketExpiresAt` and `deliveredTo: "webhook"`, and that ticket is a separate claim token from which the link cannot be rebuilt), or `both`. Approve and PIN pages both follow it. With URL-mode elicitation the link goes only through the client's own prompt, and the tool result never carries it, even when the page is left unanswered
- fix: **a wrong hidden-chat PIN is refused even when no conversation is hidden.** `conv hidden --pin-stdin` with a wrong PIN printed the empty list and exited 0; with a PIN set, the PIN is now checked whatever the list holds (exit 1, counted toward the lockout), and `zalo_conversation` `hidden` asks for it the same way
- feat: **`conv archived`, `conv muted` and `read run` leave hidden chats out** (`--include-hidden` with the PIN shows them; a `read run` naming a hidden chat exits 2), and so do `zalo_conversation` `archived`/`muted` under the `hiddenChats` policy, as `zalo_read` already did
- Surface: 259 CLI commands (227 personal, 32 Official Account) in 22 command groups, 36 MCP tools.

#### Names: the owner's alias first, everywhere

- feat: **every output names a person by the alias the account owner set for them**, as Zalo Web and PC do, then their Zalo name, then their display name, then the uid (Web's order). This covers `listen` lines, JSONL and webhooks, the MCP buffer, notifier, wait results and every `zalo_*` reply, `msg history`/`msg search`, `conv list`, `friend` and `group` commands, mentions, quoted messages (`replyTo`), reactions, typing and group events. The existing name field carries the value (`senderName`, `dName`, `displayName`, `dpn`, `inviterName`); **`senderAlias`/`alias`** and **`senderZaloName`/`zaloName`** are added beside it with the raw values. **Changed meaning:** `senderName` in replies used to be the name a message carried; that name is now `senderZaloName`, and `senderName` is alias first (`senderDisplayName`/`senderDisplayNameSource` are unchanged, plus the sources `phonebook` and `display`). Stored rows are not rewritten; a 1-1 is titled by the alias when shown, a group never is.
- feat: **alias changes reach a running daemon within seconds.** `listen` and `mcp start` read the alias list at start, again after Zalo's `alias` control (an alias set, changed or removed on any device; logged as `aliases: N changed`) and every 30 minutes; they keep the snapshot in `zalo.db` (`user_aliases`, carried by `db export`) for one-shot commands, and retitle the stored 1-1s whose alias changed. A `profile` control (`update`: the account's own name changed elsewhere) rereads the account's name. Both controls, and the 602 `profile/online_status` that `last-online` reads, are no longer noted in `unknown-acts.json`.
- fix: **a direct message no longer costs a full alias-list read.** The live identity refresh used to page the whole alias list for every incoming 1-1 message; it now uses the daemon's snapshot and asks nothing for an aliased peer.
- feat: `listen`'s human lines name the sender of an incoming message (`← [GR] [threadId] Arden AI: text`), the friend-request sender, the typer, the reactor (`by Name (uid)`) and a group event's members; `group members` prints the alias beside each uid and `group history` the sender's name.

#### Leaving a group deletes its local history, as Zalo Web and PC do (breaking)

- feat: **when the account leaves a group, is removed or blocked from it, or the group is disbanded, the group's local history is deleted at once** — messages (with their search entries and row MACs; `secure_delete` zeroes the pages), reactions, pins and notes, reminders, the cloud index, the conversation state and the downloaded media no other conversation points at; media and export links into it are revoked. The purge runs in bounded chunks that hand the event loop back. A delete marker stays, so a phone restore, `msg history`, the offline catch-up or a cloud pull never brings older messages back. **Breaking:** 2.x and earlier releases kept a left group's history and only flagged it.
- feat: **`groups.onLeave: "keep"`** keeps the history instead: the group stays readable and is listed flagged (`gone: true`, `leftAt`, `goneReason`: `leave`, `removed`, `blocked`, `disbanded`) in `conv recent`, `zalo_list_conversations`, `zalo_list_threads` and `zalo_search_threads`, and sends to it are refused with the reason. Set in `storage.json` (`groups.onLeave`, `accounts.<ownId>.groups.onLeave`), `ZALO_GROUPS_ON_LEAVE[_<ownId>]`, or the runtime policy (live, tenant < user < account; read at each exit). Switching keep -> purge purges the kept groups on the next quota/retention pass (or `fleet purge`); purge -> keep changes later exits only, and `policy set` / the admin API say so (`notes`). Default `purge`.
- feat: **`group leave` / `group disperse` (and `zalo_group` `leave` / `disperse`) act on the local copy on Zalo's success, with no listener running**, still behind `--yes` / `confirmMode`; their reply adds `localHistory`.
- feat: **a disbanded group is detected** from group info: listed in `removedsGroup`, or answered 161 / not-a-member when asked alone (`group info`, `group members`, `zalo_group` `info`, `zalo_get_group_members`, the MCP thread-name cache, `sync`'s group fetch).
- feat: each exit is a **`group_gone`** event (reason, `leftAt`, mode, purged counts) to `listen`'s output, JSONL and webhook and to the MCP webhook and live buffer. It replaces `thread_gone`.
- fix: while a group is gone, its later group events are ignored until a `join` naming the account (Zalo Web's rule): a late or replayed control no longer brings a left group back. The thread-name cache drops a purged group.
- fix: **a disband `mcp start` finds while it builds its thread-name cache at start-up now reaches the webhook and the live buffer.** The group was purged, but its `group_gone` event was dropped because the event route was not set up yet; exits found before the route is ready are now held (at most 200) and emitted, in order, once it is.

#### Deployment: the generated VPS fleet starts as written

- fix: **the files `fleet generate` writes now run on a stock Linux VPS.** `common.env` no longer sets `ZALO_DATA_DIR`/`ZALO_MEDIA_DIR`: they pointed outside the unit's `ReadWritePaths` (the daemon could not write its database), and a command run by hand never reads `common.env`, so it used another tree. Machine paths now go in the service user's `~/.zalo-agent-cli/.env` (the new `home.env`), which the units and every command read, and the units' `ReadWritePaths` hold the config dir plus the data or media dir that run of `generate` uses (the global `--data-dir`/`--media-dir`, or `ZALO_DATA_DIR`/`ZALO_MEDIA_DIR`). The default no longer names `/var/lib/zalo-media`, a folder that does not exist on a new host (the unit failed with 226/NAMESPACE).
- feat: **a key provider, wired:** `fleet generate --provider passphrase|systemd-creds|kms|none` (default `passphrase`) writes `storage.json` and, for the passphrase, `credentials.conf`: a drop-in with `LoadCredentialEncrypted=zalo-storage-passphrase:/etc/zalo-mcp/storage-passphrase.cred` for `zalo-mcp@.service`, the purge and the backup units. systemd decrypts it into `$CREDENTIALS_DIRECTORY`, where the provider reads it with no setting. This works for `User=zalo` on systemd 250 and later (Ubuntu 24.04 ships 255); the `systemd-creds` provider would need `"user": true` and systemd 256 (`storage/linux-server.json` now says so; new `storage/linux-vps-passphrase.json`).
- fix: **`fleet start|stop|restart` drive systemd** for an account its `zalo-mcp@<id>` unit runs (loaded and active, failed or enabled; `ZALO_FLEET_SUPERVISOR` decides for every account when set): `systemctl start|stop|restart`, instead of a daemon spawned beside the unit (it raced the unit for `daemon.lock` until the unit hit its start limit) or a stop that `Restart=always` undid 15 s later. `--json` gives each account's `supervisor`; a refused `systemctl` is a failure (exit 1) that prints the `sudo systemctl` line. `fleet status` with no registry on a fleet host says to run it as the service user.
- fix: **`fleet generate --domain`** writes each account's `ZALO_MCP_PUBLIC_URL=https://<domain>/a/<id>` (the one-time pages, media and approval links pointed at 127.0.0.1) and `ZALO_MCP_TRUSTED_PROXIES=127.0.0.1` in `common.env`, and its Caddyfile routes `/zalo/qr/*` to the login's QR port.
- feat: **an account added by QR through the fleet controller gets its public URL.** `fleet serve --domain <host>` (or **`ZALO_FLEET_DOMAIN`**, set in use case d's `common.env`) writes `ZALO_MCP_PUBLIC_URL=https://<host>/a/<id>` into the new account's env file, as `fleet generate --domain` does, and `ZALO_MCP_TRUSTED_PROXIES=127.0.0.1` too when the controller's environment and config trust no proxy (it warns at start); the `done` event carries `publicUrl`. Before, the URL had to be added by hand.
- fix: **a per-tenant KMS key now opens in every process, not only the account's daemon.** `ZALO_KMS_KEY` in an account env file reached the daemon only, so `za`, the purge and the backup units asked the machine's default key and could not open a keyring wrapped under a tenant's key. A keyring is now always unwrapped (and rekeyed) with the KMS key it records, whatever the default or `ZALO_KMS_KEY` says; and **`storage.json` takes a provider section per account** (`accounts.<ownId>.kms.key`), which beats the top level and the environment for that account and is read by every command. `account security provider kms <ownId> --key <id>` writes the key there and no longer changes the default. Use case e's samples put each tenant key in `storage.json` (its account env files are now as generated); its README's step said `--account <id>` without the argument, which moves every account.
- **Breaking (samples):** every proxy sample and the generated Caddyfile answer **404 for `/zalo/admin/*`**, with `/metrics` and `/status`: reach the admin API on loopback, over an SSH tunnel or a VPN, or through a separate admin host.
- feat: **`fleet generate [accounts...]`**, `--etc-dir`, `--backup-dir`, `--provider`, and the install steps printed with the paths it used (`--json`: `install`). It also writes `zalo-fleet-check.service`/`.timer` (`fleet status --check` every 5 minutes; add `OnFailure=` to be told), `zalo-backup.service`/`.timer` (nightly: `db backup` and `keyring.json` per account, then the config dir without databases, media and runtime files; 14 days kept), `za` (runs the CLI as the service user through `systemd-run`, with the units' home, `common.env` and credential), the polkit rule, and `zalo-policy-audit.logrotate` (`policy-audit.log` was never rotated). `common.env` sets `ZALO_FLEET_SUPERVISOR=systemd`, `ZALO_LOG_LEVEL=info` and `ZALO_START_JITTER=30`; the unit drops its `sleep $RANDOM` start-up delay (one jitter, in the daemon).
- docs: **a complete config set per use case** in `docs/config-samples/use-cases/`: `a-desktop-stdio`, `b-desktop-lan-http` (adds a WinSW service and a launchd agent), `c-vps-few-accounts` (one VPS, the passphrase provider, `za`, timers, Caddy, ufw, journald; with `MIGRATE.md` for moving accounts from a Windows 2.5.9 home), `d-crm-backend` (webhooks per account, approvals by webhook, the fleet controller, an admin host for the CRM's address only) and `e-saas-kms` (a KMS key per tenant, a tenant policy drop), each with a README in English and Vietnamese. Every shared file is byte-identical to its building block or to `fleet generate`'s output, and `config-samples.test.js` holds each folder to its full set, its env files to variables the engine reads, and the VPS sets to the rules above. New building blocks: `clients/claude-desktop.json`, `clients/claude-code-http-lan.json`, `clients/admin-policy.sh`, `env/loopback-server.env`; the Python CRM receiver binds `HOST` (default `127.0.0.1`) instead of every interface.
- docs: **the guides follow the use cases.** `docs/deployment.md` starts from the use-case table; §4.2 is the generated unit (one source, no hand-written `zalo-mcp.service`), the passphrase provider through `LoadCredentialEncrypted=` and why the `systemd-creds` provider does not fit `User=zalo` on systemd 255, `za`, and systemd-driven `fleet start|stop|restart`; §4.4 the three timers (the `sync-media --prune` timer is gone: `retention.media`); §4.6 the full backup tree; a new §4.9 on moving an account to another machine; §0 says Zalo keeps one web login per account (a QR login into Zalo Web signs the server out; the phone and Zalo PC coexist). `docs/deployment.vi.md` is brought to full parity with it. `security.md` recommends the passphrase provider for a VPS and covers moving an install; `configuration.md` §3.6 lists the new fleet files. Examples that put the token on a command line (`--auth <token>`) or bound every interface (README, INSTALLATION, SKILL.md, deployment §5.4) now use `ZALO_MCP_AUTH_TOKEN`, a LAN address or the VPS set; INSTALLATION no longer says `confirmMode: human` is stdio only.

#### Event loop

- fix: **`listen` and `mcp start` no longer stall their socket while sealing a 2.x account's media.** The background job that seals media downloaded before 3.0 ran each batch of 50 files in one go on the thread that serves the socket — about 3 s a batch, every 30 s, logged as `event loop was blocked for 3.1s`. It now hands the event loop back every few milliseconds (between files and between 64 KiB chunks of a file; a stop waits for the file in hand), and the rows that point at downloaded files come from a new index (`idx_messages_localpath`) instead of a walk of the whole encrypted table (1.8 s on 436,000 messages, now 25 ms; the retention purge's media query likewise). The index is built once, on the first open after the update (about 2 s on such a database).

#### Exit codes and `--json` output

- **Breaking:** **a command that fails now exits 1; before, most exited 0.** Exit codes: 0 done, 1 failed, 2 confirmation needed, 3 an always-on daemon was kicked, 4 Zalo keeps refusing the saved login (a daemon only with `ZALO_EXIT_ON_SIGNED_OUT=1`; it otherwise stays up `signed_out`). `logout` and `account remove` refused while a daemon holds the account now fail (they warned and exited 0).
- fix: **`--json` always prints one JSON object or array.** Zalo answers many calls with an empty body, and 132 commands printed it as it came: `""`, `null` or `undefined`. They now print `{"success": true, …the command's arguments}` (for example `{"success": true, "userId": "…"}` for `friend block`), and keep any other bare answer under `result`; an answer that is an object or array is printed unchanged, as before. `msg send` no longer fails on an empty answer to a send that went out.
- fix: **a list command answers an empty list, not `{"success": true}`**, when Zalo's answer is empty: `[]` for `friend list`, `friend close` and `msg sticker-list`, and the command's own object with empty lists for `friend online` (`{onlines: []}`), `friend alias-list`, `friend recommendations`, `friend find-phones`, `friend common-groups`, `group members-info`, `group pending`, `group blocked`, `group invite-boxes`, `conv archived` (`{items: []}`), `conv muted` (`{chatEntries: [], groupChatEntries: []}`), `profile avatars`, `reminder responses`, `auto-reply list`, `quick-msg list`, `label list`, `catalog list`, `catalog products` and `bank accounts`
- fix: **commands that printed nothing with `--json` print their result**: `logout` and `account remove` (what was ended and deleted), `account export` (`{exported, ownId, file}`, never the credentials), `conv forget` (the `zalo_conversation` `forget` reply, or the preview with `--dry-run`), `sync-media` (including `--prune` and `--prune-orphans`), `sync-boards`, `sync-reactions` and `sync-cloud` (their stats), and `group list` with no groups (`[]`). `account info` with no active account prints `{"active": null}` (it printed `null`).
- fix: **a partial failure leads with `error`.** `conv read` when the unread mark or the seen receipt fails, and `group settings` when Zalo did not apply a setting, print `{"error": …, …the result}` and exit 1 (with `--json`, `conv read` exited 0 when only the unread mark failed).

### Usage notices

- **Breaking, MCP clients and webhook receivers:** read `msgId` (not `id` or `messageId`) and `userId` (not `uid`); send `threadType` as `"dm"` or `"group"` (a number is refused); call `zalo_view_media` with `msgId` and `zalo_delete_message` with `senderId`. The CLI is unchanged (`-t 0|1`).
- **Breaking, programs reading ids:** every id in `--json` output, `listen` events and MCP replies is a string, small ones too (a `reminderId` of 9 is `"9"`). Compare and store ids as strings.
- **MCP cursors are large numbers now** (they start at the clock). A client that stores a cursor needs no change; one that assumed a small counter from 1 should not.
- **Breaking, scripts:** a failed command exits 1 (most exited 0), so a script that ran on after a failure now stops where `set -e` or `&&` is used. With `--json`, test the exit code or `.error`; stdout is always one object or array.
- **The engine is new.** Nothing to change in how you run the CLI, the MCP server or the wrapper. If something Zalo used to accept is now refused, report it with the command and the error.
- **`ZALO_QR_FLOW=legacy` is refused.** Remove it from your environment or `.env`; the official QR login is the only one.
- **MCP labels:** `zalo_label` `assign` / `unassign` take an optional `threadType`. A label an earlier version put on a group did not show in Zalo; assign it again to make it show.
- **Logging in** follows the official sequence; on an account with a trusted device you scan two QR codes in turn. The CLI shows in the phone's linked-device list, and each QR login adds an entry there and logs the older ones out; the offline queue survives a re-login because the device id is kept (a login after `logout`, which deletes the saved login, gets a new one). `logout` keeps the companion identity (`trusted-device.json`) for the next login; `logout --purge` and `account remove` delete it. **Zalo keeps one web login per account:** a QR login into Zalo Web elsewhere signs this one out, so use the phone or Zalo PC beside a server, not Zalo Web.
- **`logout`** signs the device out at Zalo. Use `--keep-session` for the old behavior.
- **Scripts that run destructive commands** (`msg undo`, `group leave`, `logout`, …) add `--yes`; without it they exit 2 and nothing is sent. **MCP agents** now get a refusal from `zalo_undo`, `zalo_delete_message`, `zalo_reminder` `remove` and the other guarded actions until they send `confirm: true`; a backend that confirms nothing itself can set `confirmMode` to `off`.
- **A kicked on-demand daemon yields** (`YIELDED`): close the other session, then `zalo-agent presence resume --yes`. An always-on daemon exits with code 3 and is not restarted by the shipped systemd unit. **A refused login leaves the daemon up `signed_out`** (`SIGNED_OUT`): add the account again by QR (`login`, or the fleet controller's QR add); `ZALO_EXIT_ON_SIGNED_OUT=1` restores exit 4. Zalo keeps one web login per account, so a QR login into Zalo Web elsewhere is the usual cause: use the phone or Zalo PC beside the server.
- `sync` and `sync-media` fetch two files at a time; pass `-c <n>` for more, or `--media-limit <n>` to stop a run early.
- `friend close` is retired by Zalo, and `friend online` is answered with a 404 on the current build; both say so.
- **Breaking, programs reading `conv read --json` or `zalo_conversation` `read`:** the reply is now `{success, threadId, threadType, markOnly, seen: {sent, msgIds, …}, reactions, unreadMark: {wasSet, removed}, senderReceipt, note}` on both surfaces (it was `seen.ok`/`seen.msgId` in the CLI and `seenMsgId`/`unreadMarkCleared` over MCP). `profile settings --json` is now `{settings, readOnly, other}` (it was Zalo's raw answer), and `friend last-online --json` and `zalo_friend` `last_online` are `{userId, lastOnline, hiddenBy, …}` (the raw answer is under `data`).
- **Reading without the sender seeing "Seen"**: there is no "red dot only" read. Turn your seen status off first (`profile set seen-status 0`); `conv read --mark-only` removes only the manual unread mark.
- **Breaking, hidden chats are excluded by default:** they no longer appear in any list, search, history, `listen` output, webhook or MCP tool. Set `hiddenChats` to `include` (or `contentless`) for an MCP server that must see them, or pass `--include-hidden` and the PIN on the command line.
- **Breaking, `conv hidden-pin` takes no PIN argument:** `conv hidden-pin 1234` is refused (exit 1) because the PIN would sit in the shell history; type it at the prompt or pipe it with `--pin-stdin`. `zalo_conversation` `hidden_pin` no longer takes the new PIN as `pin` (`pin`/`newPin` work only with `allowPinArgument: true`); without them it replies `pinRequired` with a page link.
- **Breaking, `conv hidden-pin-reset` deletes the hidden conversations:** removing the PIN now does what Zalo Web does on the device that asks: every hidden conversation's history is deleted for this account (each deletion is reported). It stays a guarded action (`--yes`, `confirm`).
- **Breaking, `confirmMode: "human"` over HTTP:** it no longer refuses with `statelessTransport`; it replies `confirmationRequired` with a one-time `secureUrl` and `retryWith.ticket`. A client without form elicitation under stdio gets the same link instead of the old `elicitationUnsupported` refusal.
- **Breaking, saved files are sealed:** nothing to do on a desktop. On a Linux server without a desktop keyring, set a provider before upgrading (`"provider": "systemd-creds"` in `~/.zalo-agent-cli/storage.json`, or `kms` / `passphrase`), or every command that needs the saved login stops with a message saying so. Keep `accounts/<ownId>/keyring.json` in the same backup as the credentials: without it they cannot be opened, and a new QR login is the only way back. A service running under DPAPI's CurrentUser scope must run as the user that sealed the files.
- **Before upgrading to 3.0.0, stop every 2.x process that uses the same home** (a `zalo-mcp` deployment, scheduled `sync-media`, bots that read `zalo.db`), and **back up `~/.zalo-agent-cli`**: the first 3.0.0 command encrypts each account's `zalo.db` and there is no downgrade. Do not run 2.x and 3.0 against one home, even read-only; give a test install its own `--config-dir`. A 2.x process restarted afterwards fails at login (sealed credentials) and at the database (`file is not a database`).
- **Breaking, programs that read `zalo.db`:** move them to the MCP tools or `--json` output; a server without a desktop keyring needs its key provider set first (above), or the database stays plaintext and every command that opens it stops with a message saying so.
- **The SQLite driver changed** to `better-sqlite3-multiple-ciphers`. `zalo-mcp update` installs it; an install policy that allowed `better-sqlite3`'s install script can drop that entry, as the new driver runs none.
- **Deprecated, `--issuer-url`, `ZALO_MCP_ISSUER_URL[_<ownId>]` and `oauth.issuerUrl`:** they are now names of `publicUrl` and keep working, read after every `publicUrl` source with a note once per process; move to `--public-url` / `ZALO_MCP_PUBLIC_URL` / `publicUrl`. They are now validated like `publicUrl`, so an `http://` issuer on a public host stops `mcp start --http`: use `https`. `login` does not read them (a proxy built for the OAuth issuer does not route the QR page).
- **Breaking, real-time webhooks:** `mcp start --http` and `listen --daemon` park their socket when idle, and what arrives meanwhile is delivered on the next connect (`catchUp: true`). A CRM that needs each message as it arrives sets `presence.mode: "always-on"` (or holds a lease, `POST /zalo/presence/leases`). Health checks: `/ready` is 200 while parked, and `fleet status` shows `idle`, not `down`.
- **Breaking, MCP clients:** a tool may answer `WARMING` (retry after `retryAfterSec`), `YIELDED` (another session took the account; a person must resume it) or `SIGNED_OUT` (add the account again by QR). Cache reads may carry a `presence` block; `account_state` and `storage_quota` events arrive as system events in `zalo_get_messages` and the waits.
- **Breaking, programs reading names:** `senderName` (and `dName`, `displayName`) is the owner's alias first; the name a message carried is `senderZaloName`, the alias alone `senderAlias`.
- **Breaking, group history:** leaving a group, being removed or blocked, or a disband deletes the group's local history at once; `thread_gone` is now `group_gone`. Set `groups.onLeave: "keep"` before upgrading if you must keep it.
- **Admin API:** the proxy samples and the generated Caddyfile answer 404 for `/zalo/admin/*`; reach it on loopback, an SSH tunnel, a VPN or a separate admin host.
- Wrapper: `@ardennguyen/zalo-mcp` users get 3.0 with wrapper 2.1.0, which requires engine 3.0.0 (`npm install -g @ardennguyen/zalo-mcp@latest`, or `zalo-mcp.ps1 update` / `zalo-mcp.sh update`).

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
