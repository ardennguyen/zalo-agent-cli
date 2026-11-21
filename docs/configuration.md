# Configuration cookbook — `.env`, `mcp-config.json` and the setups worth running

> **Status:** verified against `zalo-agent-cli` `3.0.0`. Every file shown here exists, ready to copy, under [`docs/config-samples/`](config-samples/), and `tests/unit/config-samples.test.js` holds each one to the code: every `mcp-config.json` key is one the loader merges, every environment variable is one a source file reads, and the CRM receiver verifies a signature produced by the real webhook sender. Vietnamese: [`configuration.vi.md`](configuration.vi.md).

Two kinds of file configure a server, and they answer different questions:

| File | Holds | Format |
|---|---|---|
| `.env` | **Where and how this process runs**: storage directories, host, port, tokens, TLS, webhook URL and secret. Anything per machine or per account, and anything secret | `NAME=value` lines |
| `mcp-config.json` | **What the server watches and how it behaves**: which threads, buffer sizes, notifications, OAuth consumers, per-account overrides | JSON |

Secrets belong in `.env` (mode `0600`), not in `mcp-config.json`, and never on the command line: **a flag is visible to every user on the machine in `ps`**, an environment variable is not.

---

## 1. Where each file lives, and who reads it

| Location | Read by | Use it for |
|---|---|---|
| `<CONFIG_DIR>/.env` — default `~/.zalo-agent-cli/.env` | **every** `zalo-agent` / `zalo-mcp` command on the machine, from any directory | per-machine settings: data directories, `ZALO_AGENT_NO_UPDATE_CHECK`, defaults for all accounts. [`env/config-dir.env`](config-samples/env/config-dir.env) |
| `--env-file <path>` (or `ZALO_ENV_FILE`) | that one command | a service's own file: `/etc/zalo-mcp/<name>.env`, a container's `--env-file`. [`env/lan-server.env`](config-samples/env/lan-server.env), [`env/internet-server.env`](config-samples/env/internet-server.env), [`env/crm-backend.env`](config-samples/env/crm-backend.env) |
| `./.env` in the working directory | any `zalo-agent` started from that directory | avoid: it silently changes behavior depending on where you `cd`. Never put secrets here |
| `zalo-mcp/.env` in the wrapper's folder | the `zalo-mcp` launcher, before it starts the engine | **ports only**: [`env/wrapper-folder.env`](config-samples/env/wrapper-folder.env) |
| a systemd `EnvironmentFile=`, a shell `export`, a container's `-e` | the process as a real environment variable | the same names; these always win over every file above |
| `<CONFIG_DIR>/mcp-config.json` | `mcp start` (and `mcp wait` / the tools it serves) | the shared base for every account on the machine |
| `mcp start --config <path>` | that server | a second config for one service. It must exist and be valid JSON, or the server **refuses to start** (a missing file would otherwise mean "watch every thread"). It replaces the base file and the per-account file below |
| `accounts.<ownId>` block inside `mcp-config.json` | the server for that account | per-account overrides in one file: [`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json) |
| `<accountDir>/mcp-config.json` — `~/.zalo-agent-cli/accounts/<ownId>/` | the server for that account | a per-account file; refused at start if present but unreadable |
| `<CONFIG_DIR>/storage.json` | every command that reads or writes a saved login | the key provider and the dkey layer that protect the saved files (top level, or per account in `accounts.<ownId>`, e.g. a tenant KMS key in `accounts.<ownId>.kms.key`, which every command reads), and `rowMac.verifyOnRead` (`actions` (default) or `off`: whether an action checks the cached message it acts on against its row MAC) ([security.md](security.md)); the local cache's `retention.*` and `quota.*` (see [Storage quotas and retention](#storage-quotas-and-retention)) and `groups.onLeave` (see [Leaving a group](#leaving-a-group-groupsonleave)); no secret in it |

### Precedence

**Environment files** are merged without overwriting: the first source that defines a name wins, in this order: the real process environment, `--env-file`, `./.env`, `<CONFIG_DIR>/.env`. (`zalo-mcp/.env` is loaded by the launcher the same way: it fills names that are not already set.)

**A setting** is resolved per account, highest first:

1. the command-line flag (`--http`, `--host`, `--auth`, `--webhook`, …)
2. `NAME_<ownId>` in the environment, e.g. `ZALO_MCP_HTTP_PORT_1000000000000000001`
3. `NAME` in the environment
4. `mcp-config.json`, later layers over earlier: the base file, then its `accounts.<ownId>` block, then `<accountDir>/mcp-config.json`
5. the built-in default

[`env/multi-account.env`](config-samples/env/multi-account.env) shows rule 2 over 3 in one file.

### The runtime policy (changed live, no restart)

Above all of these sits the **runtime policy**: the settings a console or an operator changes while the server runs.
Files and the environment are read once at start; the policy is read again on every tool call.

| Layer (lowest first) | Where |
|---|---|
| built-in defaults | the code |
| files | `mcp-config.json`, `storage.json` |
| environment | `.env`, `--env-file`, a systemd `EnvironmentFile` (bootstrap only: port, bind address, `publicUrl`, the key provider, the admin credential's *reference*) |
| **policy** | per tenant `<CONFIG_DIR>/tenants/<tenantId>.json` (for its users' accounts and the accounts it lists in `quota.tenant.accounts`), then per user `<CONFIG_DIR>/users/<userId>.json` (for the accounts it owns), then per account `<accountDir>/policy.json` |

The policy takes `confirmMode`, `hiddenChats`, `allowPinArgument`, `ownMyDocuments`, `routing.*`, `approval.*`, `media.deliver`, `media.inlineMaxBytes`,
`media.allowDeliver`, `media.linkTtl`, `media.tempfileTtl`, `media.linkAuth`, `media.linkRateLimit`,
`media.capability.*`, `media.autoOpen`, `webhook`, `webhookBatchSize`, `webhookMaxAge`, `quota.*`, `retention.*`,
`groups.onLeave`, `presence.*`, `session.renew.*` and the `uploads.*` caps (not `uploads.localPaths`, `localPathRoots` or `allowPrivateUrls`) (`presence.alwaysOn.*` only in a tenant's or a user's policy; `quota.tenant.*` only
in a tenant's).
A key read only at start (`httpPort`, `host`, `publicUrl`, `tls`, `oauth`, `trustedProxies`, `admin`,
`media.downloadDir`, the key provider and its options, `accounts`) and every secret (`webhookSecret`) is refused with
`restartRequired`; any other key is refused as unknown.
The files are sealed under the account's boot key (the tenants' and users' under their folder's `keyring.json`) and
carry a revision (`rev`) that every change raises.

Three writers, all checked the same way:

1. **The admin API** on the MCP HTTP server: `GET|PUT|PATCH /zalo/admin/policy` (this account),
   `/zalo/admin/policy/<ownId>`, `/zalo/admin/policy/tenants/<tenantId>`, and `GET /zalo/admin/usage`. It takes **its own
   credential**, never the agent's: `Authorization: Bearer <admin token>` or a client certificate (`admin.clientCa`).
   The MCP bearer token, the OAuth secrets and the access tokens the server signs are refused (401), so an agent can
   never change its own limits. `PATCH` is a JSON merge patch (`null` removes a key); `PUT` replaces the policy.
   `If-Match: "<rev>"` makes a write conditional: another rev is `412` and nothing changes; the reply carries
   `ETag: "<rev>"` and the effective settings. `400` names each bad key; `422` lists `restartRequired`. With no admin
   credential set the API does not exist (`404`). The same credential starts a data export of this server's account
   (`POST /zalo/admin/export/<ownId>`, [deployment.md](deployment.md) "Export my data"); its download link follows the
   `media.*` link settings.
2. **`zalo-agent policy set|unset <key> [<value>] [--tenant <id>|--user <id>] [--if-match <rev>]`** (and `policy get
   [key] [--effective]`): through the account's running daemon (which applies the change at once), else into the file
   for the next start.
3. **A file drop** by a config-management tool: write the file as plain JSON (`{"policy": {...}}`), atomically. A
   running daemon picks it up within a second, checks it and seals it with the next rev. A file that does not validate
   is moved to `policy.json.rejected` and logged, and the last good policy stays. A daemon does not start on a policy
   file it cannot use.

Every change and every refusal is a line in `<CONFIG_DIR>/policy-audit.log`: when, who, which file, which keys, the old
and new rev. Never a value (a webhook URL can carry a token) and never a credential.

What a change does at once: `media.linkAuth` / `media.capability` revoke every outstanding media link; `hiddenChats`
revokes the links into newly hidden chats; `webhook*` moves the delivery to the new receiver or settings (queued events
stay queued); a lower `quota.*` is checked at once.

### Storage quotas and retention

The daemon holding an account (`listen` or `mcp start`) measures its storage (the message database's pages in use,
the media files, the webhook outbox) every `retention.purgeEvery` and applies these rules. Lowest first: the defaults,
`storage.json` (top level, then `accounts.<ownId>`), `ZALO_RETENTION_MESSAGES[_<ownId>]` /
`ZALO_RETENTION_MEDIA[_<ownId>]`, then the runtime policy.

| Key | Default | Meaning |
|---|---|---|
| `quota.account.limit` | `null` (no limit) | bytes, or `"2GB"` (1 GB = 1024³ bytes), or `"unlimited"` (beats a lower layer's limit) |
| `quota.tenant.limit`, `quota.tenant.accounts` | none | in a tenant's policy only: one limit shared by the listed accounts. On one host the engine sums only the accounts it runs. A member whose daemon is down is measured at each check as a daemon measures it (its database's pages in use, read with its own keys from a temporary copy, and its media folder), not taken from the figure its daemon last left; when its database does not open, its file sizes are used, and the daemon log says which. Nothing in that account's folder is written. For a tenant spread over several hosts the console is the source of truth (it reads `/zalo/admin/usage` and the events, and pushes per-account caps) |
| `quota.graceDays` | `45` | days kept after going over before the purge |
| `quota.warnAt` | `0.8` | the fraction of the limit that sends `warn` |
| `quota.purgeOrder` | `media-first` | the oldest media files first, then the oldest messages |
| `quota.minFree` | `2GB` | the free space kept on the disk that holds the account's data and media: bytes, or `"2GB"`, or `0` for none. `ZALO_STORAGE_MIN_FREE` wins over it, then the runtime policy, then `storage.json`. See [room before downloading](#room-before-downloading-quotaminfree) |
| `retention.messages` | `keep` | `keep`, or `<N>d`: messages N days old or older are deleted |
| `retention.media` | `keep` | `keep`, or `<N>d`: media files of messages N days old or older are deleted (the messages stay) |
| `retention.outboxDead` | `30d` | dead webhook deliveries are deleted after this |
| `retention.purgeEvery` | `6h` | how often the daemon checks (at least `1m`); `fleet purge` (a timer) asks a daemon that has not checked within twice this, and purges an account with no daemon itself |
| `quota.user.limit` | none | in a tenant's policy (the default per user) or a user's: the user's share, summed over the accounts it owns on this host; over it, each of its accounts gives up its share of the excess like a tenant's (events carry `scope: "user"`, `userId`) |
| `retention.mediaTempCap` | none | bytes, or `"1GB"`: the most the decrypted tempfile copies (`deliver: "tempfile"`) may hold; above it the oldest copies are removed first. The tempfile folder is the host's, so the cap counts every account's copies |

**Over a limit, caching goes on.** The daemon sends `storage_quota` events to the webhook (`listen` prints them, and
`mcp start` also hands them to its MCP clients as system events in `zalo_get_messages` / `zalo_wait_for_message`):
`{event: "storage_quota", accountId, scope: "account"|"tenant", tenantId?, level, usedBytes, limitBytes, overSince,
purgeAt}` with `level` `warn`, `over`, `grace_ending` (`daysLeft` 7 and 1), `purged` (`freedBytes`, `media`,
`messages`) and `ok` (back under: a raised limit or a renewal clears the grace clock). After `quota.graceDays` it
purges the oldest media, then the oldest messages (their search entries, reactions and row MACs with them; the pages
are zeroed by `secure_delete` and the WAL checkpointed) until usage is at or under the limit; a tenant's accounts each
give up their share of the excess. A purge raises the database's retention floor: no sync or history fetch stores a
message at or before it again. The database file keeps its size (SQLite reuses the freed pages); usage counts the
pages in use. `zalo-agent db usage` (and `zalo_profile` `usage` over MCP) shows all of it, `db purge --dry-run` counts what is due, and `db purge --yes` runs
it now (through the daemon when one runs).

#### Room before downloading (`quota.minFree`)

Before a media download (`sync-media`, the media stage of `sync`, the fetch after a restore, `zalo_view_media`) and
before each file it saves, the engine checks that there is room: the disk keeps `quota.minFree` free, and the account
stays under `quota.account.limit` when one is set. When either would be crossed, the download stops and says why; the
files not yet saved stay pending, and the same command continues once there is room (free some space, or raise the
limit). The restore offered after a QR login is skipped the same way when there is no room, and the login names the
`sync` command to run later. Set `quota.minFree` to `0` (or `ZALO_STORAGE_MIN_FREE=0`) to turn the disk check off.

The admin token: `zalo-agent policy token --rotate` makes one and shows it once; only its SHA-256 is kept, sealed in
`<CONFIG_DIR>/admin/admin-token.json`, and a rotation retires the old one at once. Or point
`ZALO_MCP_ADMIN_TOKEN_FILE` (`admin.tokenFile`) at a file your provider fills (a systemd credential, a KMS-decrypted
mount). `ZALO_MCP_ADMIN_TOKEN` is for development.

### Leaving a group (`groups.onLeave`)

When the account **leaves** a group, is **removed** or **blocked** from it, or the group is **disbanded**, Zalo's own
apps delete that group's local history at once. So does this engine by default:

| Value | What happens |
|---|---|
| `purge` (default) | At the exit: the group's messages (their row MACs and search entries with them; `secure_delete` zeroes the pages), reactions, board items (pins, notes, polls), reminders, cloud index and conversation state (pin, unread mark, read watermark) are deleted in bounded chunks that hand the event loop back, and the downloaded media no other conversation points at; media and export links into it are revoked. The group leaves `conv recent`, `zalo_list_conversations` and `zalo_search_threads`. |
| `keep` | Nothing is deleted. The group stays readable and is listed flagged: `gone: true`, `leftAt` (epoch ms), `goneReason` (`leave`, `removed`, `blocked`, `disbanded`) in `conv recent`, `zalo_list_conversations`, `zalo_list_threads` and `zalo_search_threads`; `db export` copies the same columns of `threads`. A send to it (`msg send` and the other `msg send-*`, `zalo_send_message`) is refused with the reason and the date. Kept groups follow the normal quota/retention order. |

Either way the group keeps a **delete marker** (`threads.deleteMarkerAt`, like Zalo's `deleteAllPrior` tombstone): no
writer -- the listener, a phone restore (`sync`), `msg history`, the offline catch-up or a cloud pull -- stores a
message of the group dated at or before it again. While a group is gone its later group events are ignored until a
`join` that names this account (Zalo's own rule); a chat message dated after the exit, or a restore's conversation
list that holds the group, also proves the account is back. A rejoin never brings back what was purged.

What is detected: our own `leave` / `remove_member` / `block_member` event (a running `listen` or `mcp start`); our
own `group leave` / `group disperse` (and `zalo_group` `leave` / `disperse`) on Zalo's success, **with no listener
running**, behind their usual confirmation (`--yes`; the MCP `confirmMode`); a disband from group info -- the group
listed in `removedsGroup`, or answered with error 161 (or not-a-member) when asked alone (`group info`, `group members`,
`zalo_group` `info`, `zalo_get_group_members`, the MCP thread-name cache at start, `sync`'s group fetch). Each exit is a
`group_gone` event: `{event: "group_gone", accountId, threadId, reason, leftAt, mode, source, purged: {messages,
reactions, boardItems, reminders, cloudItems, convState, files, filesShared, fileErrors, links}|null}` -- printed and
written to the JSONL and webhook by `listen`, and by `mcp start` to its webhook and live buffer (a system event in
`zalo_get_messages` / `zalo_wait_for_message`).

It is a **live** runtime policy key (tenant < user < account), read at the moment of each exit, no restart. Lowest
first: the default, `storage.json` `groups.onLeave` then `accounts.<ownId>.groups.onLeave`,
`ZALO_GROUPS_ON_LEAVE[_<ownId>]`, then the policy. **Switching `keep` -> `purge`** purges the groups kept so far on the
next quota/retention pass (`retention.purgeEvery`; `db purge`, or `fleet purge` for a stopped account). **Switching
`purge` -> `keep`** changes future exits only: **purged history never comes back.** `policy set` and the admin API say
so in their reply (`notes`).

### Users, the always-on cap and on-demand presence

A deployment is **tenant > users > accounts**, by opaque ids the CRM gives (letters, digits, `-`, `_`; never a name or
an email). A user lives in `<CONFIG_DIR>/users/<userId>.json` (sealed, revisioned, like a tenant's file): its tenant
(exactly one), the accounts it owns, and its own policy. **Each account has exactly one owning user**; others reach it
through the CRM. A write that puts an account under two users, or under two tenants (through a user, or through a
legacy `quota.tenant.accounts` list), is refused with `409 MEMBERSHIP` (two tenants used to only warn). A tenant's
accounts are its users' accounts plus its legacy list, so quotas count toward the owner. Precedence inside the policy:
tenant < user < account.

The `presence` keys (in `mcp-config.json` `presence`, `accounts.<ownId>.presence`, and the policy, live):

| Key | Default | Meaning |
|---|---|---|
| `presence.mode` | `on-demand` (`always-on` for stdio MCP and a foreground `listen` printing to stdout) | `on-demand`: hold the socket only while something needs it; `always-on`: real time |
| `presence.idleTimeout` | `5m` (at least `30s`) | no demand for this long and the socket parks |
| `presence.minConnected` | `60s` | never parks sooner after connecting |
| `presence.maxWakesPerHour` | `12` | over it, the idle timeout doubles per wake (up to an hour) |
| `presence.warmWait` | `10s` | how long a cache read waits for a waking socket |
| `presence.connectOnStart` | `true` | one catch-up at start, then park |
| `presence.catchUpEvery` | `off` | a periodic catch-up while parked (e.g. `6h`) |
| `presence.maxLeases`, `presence.leaseTtl`, `presence.leaseTtlMax` | `64`, `90s`, `600s` | CRM leases per account |
| `presence.waitHoldsSocket` | `true` | a pending `zalo_wait_for_message` / `/events/wait` holds the socket (a tier may turn it off; held time is metered) |
| `presence.onKick` | `yield` | on-demand only: when another session **of the same login** (a second copy of these credentials, a second tab of one browser) takes the socket, let it go and refuse every request until the user confirms `presence resume` (`yield`), or end the daemon with exit 3 (`exit`) |
| `presence.alwaysOn.maxPerUser` | `1` | tenant or user policy: always-on accounts per user |
| `presence.alwaysOn.maxPerTenant` | none | tenant policy: always-on accounts per tenant |
| `presence.alwaysOn.onCap` | `demote` | tenant or user policy: what a write that would go over a cap does. `demote`: the oldest always-on account goes to on-demand (below); `refuse`: the write is refused with `409 ALWAYS_ON_CAP` and nothing changes. A lowered cap still demotes in both modes |

`ZALO_PRESENCE_MODE[_<ownId>]` and `ZALO_PRESENCE_IDLE_TIMEOUT[_<ownId>]` sit between the files and the policy.

**The cap demotes the oldest.** When a write (an account, a user or a tenant) takes a user or a tenant over its cap,
or a cap is lowered, the account that became always-on first is set to `on-demand` (an account-level policy write by
`presence-cap`, a `capDemoted` audit line, and `demoted: [...]` in the admin API's reply). The check runs under a host
lock, so two concurrent writers cannot both pass it. Only the accounts on this host count.

Admin API (its own credential): `GET|PUT|PATCH /zalo/admin/policy/users/<userId>` with a body
`{tenant?, accounts?, policy?}`, and `GET /zalo/admin/presence/always-on` (always-on accounts per user and capped
tenant, against the caps). CLI: `zalo-agent policy get|set|unset ... --user <userId>`; the membership is set with
`policy set tenant <tenantId> --user <id>` and `policy set accounts <ownId,ownId> --user <id>`.

### Limits, access and secrets for a console

Generic limits a console (a control plane, a CRM) sets per tenant or user; the engine knows no plans or prices.

| Key | Where | Meaning |
|---|---|---|
| `limits.accountsPerUser` | tenant (default per user) or user | the most accounts a user may own: a write that adds one more is refused (`409 ACCOUNTS_PER_USER_LIMIT`), and so is a QR add before its login starts. A lowered limit removes nothing |
| `limits.usersPerTenant` | tenant | the most users a tenant may have: a new user or one moved in over it is refused (`409 USERS_PER_TENANT_LIMIT`) |
| `media.store` | any | `all` (default), `none` (text-only storage) or a list of kinds (`["photo", "voice"]`): the one media downloader fetches no other kind, whether for the listener, `sync-media`, a restore or `zalo_view_media` (which answers `MEDIA_NOT_STORED`); the message rows are stored as always |

Admin API routes (the same admin credential; every refusal carries a stable `code` beside `error`):

- `GET /zalo/admin/policy/users`, `GET /zalo/admin/policy/tenants`: every user (`userId`, `tenant`, `accounts`, `rev`)
  and every tenant (`tenantId`, `users`, `accounts`, `rev`, `file`). `DELETE /zalo/admin/policy/users/<userId>` and
  `DELETE /zalo/admin/policy/tenants/<tenantId>` delete the file, refused with `409 USER_HAS_ACCOUNTS` or
  `409 TENANT_HAS_MEMBERS` while it has members (`404 USER_NOT_FOUND` / `TENANT_NOT_FOUND`).
- `/zalo/admin/access/<ownId>`: the account's access and secrets, on the fleet controller and on the account's own
  server alike. A running daemon takes each change at its next request.
  - `GET` (all of the below at once, never a secret or a hash); `GET .../oauth/clients`, `GET .../oauth/grants`,
    `DELETE .../oauth/grants/<grantId>`, `POST .../oauth/revoke-all` `{clientId?}`, `DELETE .../oauth/clients/<clientId>`
    (a registered client and its grants; a configured one is `409 CLIENT_CONFIGURED`). The configured clients are the
    ones the account's daemon serves: its primary client from its own environment (`ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`,
    the fleet's `<env-dir>/<ownId>.env` included) or `mcp-config.json`, and `oauth.clients[]`. Each listed client has a
    `source`: `config`, `dynamic` (registered itself) or `account` (made here).
  - `GET|PUT .../oauth/settings` (`{mode}`: `off`, `automatic` or `specific`) -> `{mode, source, approverSet,
    publicUrl}`, how AI apps sign in to the account's MCP server, applied by the running daemon at its next request (no
    restart). `off`: every OAuth route answers 404 as on a bearer-only server; the grants already given are kept but
    refused while off, and API keys and the bearer token keep working. `automatic`: dynamic client registration
    (`/register`) is on and advertised. `specific`: only the configured clients and those made here are known;
    `/register` answers 404. Every connection is still approved with the approver password. `source` is `account` once a
    mode is saved (`oauth-settings.json` in the account folder, 0600), else `config`: `automatic` when
    `oauth.allowDynamicRegistration` / `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` is on, else `specific` when a client is
    configured, else `off`. Turning it on is `409 APPROVER_REQUIRED` with no approver password and `409
    PUBLIC_URL_REQUIRED` with no `publicUrl` (the issuer must be fixed); `400 INVALID_OAUTH_MODE` otherwise. The OAuth
    routes exist on any server with a `publicUrl`, so this works on a daemon started with OAuth off; a server with no
    `--auth` token and no client secret signs its tokens with a key of its own (`oauth-signing-key.json`, 0600). Once a
    mode is saved the bearer check stays on, even off.
  - `POST .../oauth/clients` (`{name, clientId?, redirectUris}`: a name of 1-60 characters, an optional id of 3-64
    characters `[A-Za-z0-9._-]`, else one is made, and 1-10 https callback URLs) -> `201 {clientId, clientSecret, name,
    redirectUris, createdAt}`: a confidential client (`client_secret_post` or `client_secret_basic` at `/token`) whose
    secret is shown this once; only its SHA-256 is kept. `409 CLIENT_EXISTS` for a taken id, `409 CLIENT_LIMIT` past 50.
    `DELETE .../oauth/clients/<clientId>` removes it and its grants.
  - `GET|POST .../api-keys` (`{label, expiresAt?}` -> `201 {keyId, label, createdAt, expiresAt, key}`: the key, shaped
    `zak_<keyId>_<secret>`, is shown once; only its SHA-256 is kept, sealed in `api-keys.json`), `DELETE
    .../api-keys/<keyId>`. A key is a bearer for the account's MCP server beside `ZALO_MCP_AUTH_TOKEN` (the legacy key,
    which keeps working); the first key turns the bearer check on for a server that had none.
  - `GET|PUT .../webhook` (`{url}` or `{url: null}`: the account's `webhook` policy key), `POST|DELETE
    .../webhook/secret` (rotate: the new secret is shown once and signs the next delivery, ahead of
    `ZALO_WEBHOOK_SECRET` and `webhookSecret`; clear: back to those), `POST .../webhook/test` (one signed
    `webhook_test` event: `{delivered, status, signed, ms}`; `409 WEBHOOK_NOT_SET`).
  - `GET|PUT|DELETE .../approver` (`{password}`, at least 8 characters, kept as a scrypt hash), `GET|DELETE
    .../cloud-key` (whether a zCloud key is stored; delete it).
  - Every change is an audit line with the account, an action code (`apiKey.create`, `oauth.grant.revoke`,
    `webhook.secret.rotate`, ...) and the id it touched, never a value.

The fleet controller adds `GET /zalo/admin/usage` (every account's storage, summed per user and per tenant against
their limits, and the disk) and `GET /zalo/admin/routes` (account id -> loopback port and `/a/<id>` path, the OAuth
discovery rewrites, the paths to block, and with `--domain` the Caddyfile `fleet generate --domain` writes) for a host
agent that keeps the reverse proxy; the controller itself changes no proxy configuration. A QR add
(`POST /zalo/admin/accounts/qr`) is refused before its login starts for an unknown user (`404 USER_NOT_FOUND`), a user
at `limits.accountsPerUser` (`409 ACCOUNTS_PER_USER_LIMIT`) or an always-on add over a cap that refuses
(`409 ALWAYS_ON_CAP`); `accountId` in its body names an account the user already owns (a login again), which passes.

**Who runs on-demand.** `mcp start --http` and `listen --daemon` follow `presence.mode` (on-demand by default);
stdio MCP and a foreground `listen` printing to stdout are always-on whatever it says. A parked socket wakes for an MCP
tool call, a `zalo_wait_for_message` / `GET /events/wait`, a CRM lease (`/zalo/presence/leases`), a CLI request routed to
the daemon (an upload, a `sync` stage, `mcp wait`) and `presence wake`; after `idleTimeout` with none of them it parks
again. What arrives while parked comes back from Zalo's offline queue on the next connect, flagged `catchUp: true`
(webhooks too): real time is the always-on tier. `--no-self-heal` with on-demand is refused at start (the catch-up is how
a parked window comes back). A policy change of a `presence.*` key applies at once.

**Tools while waking.** Each MCP tool has a class: `none` (sends, lookups) runs at once beside the wake; `fresh` (cache
reads: `zalo_get_messages`, `zalo_get_history`, `zalo_search_messages`, `zalo_list_conversations`, `zalo_coverage`)
waits up to `warmWait` for the connect and its catch-up, then answers with a `presence: {state, catchUp,
coveredUntil}` block; `socket` (`zalo_sync`, `zalo_forward_message`, a send with a file or a video) waits up to
`warmWait`, then fails with the retryable `WARMING` (`retryAfterSec`); `wait` (`zalo_wait_for_message`) holds the socket
while it waits (`waitHoldsSocket`). A CLI request routed to the daemon behaves as `socket`. The daemon never parks in the
middle of a running sync stage.

**Yielded and signed out.** Zalo keeps one web login per account: a QR login on any browser revokes the previous one,
while the phone and the Zalo desktop app coexist with the server. **Do not open the account in a browser while a server holds it**;
read and reply on the phone or in the desktop app beside it. There are two states nothing recovers from on its own, and in
both the daemon **stays up** (status, the admin API, a QR re-add keep working) and **refuses** every tool call, lease,
wait and CLI request:

| State (`account_state`) | When | Refusal | Ends with |
|---|---|---|---|
| `yielded` | on-demand, `onKick: "yield"`: another session of the same login took the socket (close 3000) | `YIELDED` | the user closes that session and confirms: `zalo-agent presence resume --yes`, `POST /zalo/admin/presence/resume`, the fleet controller's `POST /zalo/admin/accounts/<ownId>/presence/resume`, or MCP `zalo_profile` `presence_resume` (confirmMode applies) |
| `signed_out` (presence `signed-out`) | any mode: Zalo refuses the saved login three times (another browser QR-logged into Zalo) | `SIGNED_OUT` | adding the account again by QR (`zalo-agent login`, or the fleet controller's QR add, which restarts the daemon) |

Both go to the webhook, the MCP buffer, `/status` (`socket.state` `yielded` / `signed-out`, a warning), `/metrics` and
`presence status`. A signed-out daemon used to end with exit 4; `ZALO_EXIT_ON_SIGNED_OUT=1` keeps that ending (the
systemd unit's `RestartPreventExitStatus=3 4` still keeps such a unit down). Always-on keeps exit 3 on a kick.

**Many accounts waking at once.** `ZALO_CONNECT_SLOTS` (default `0`, no cap; fleet samples `16`) caps how many daemons
on the machine are waking at once: a wake takes a slot (`<CONFIG_DIR>/connect-slots/`) until its first catch-up ends,
at most 60 s; `ZALO_CONNECT_SLOT_WAIT` (seconds, default `120`) is how long a wake waits for one before going ahead.
Both take an `_<ownId>` form. `/status` and `/metrics` carry `lastWakeMs` / `lastCatchUpMs`
(`zalo_presence_last_wake_seconds`, `zalo_presence_last_catch_up_seconds`) and the metered connected time.

### Agents sharing one account (`routing`)

Several agents can use one account's MCP server at once (a hosted assistant, a Claude Code session, a Claude app
connector). The `routing` block names them, so the server knows which agent each call comes from, puts the agent's
**mark** in front of what it sends, and records which agent sent which message. This is the first part of the
Companion Router; nothing is routed or refused yet, and every caller still sees every message.

```json
"routing": {
  "marks": "shown",
  "presenceWindow": "90s",
  "agents": [
    {"slug": "dev", "name": "Dev", "credential": "apikey:0123456789ab"},
    {"slug": "ai", "name": "AI", "kind": "companion", "credential": "apikey:ba9876543210", "mark": "🤖 AI:"},
    {"slug": "claude", "name": "Claude", "credential": "oauth:claude-app", "markDisplay": "owner"}
  ]
}
```

- **`credential`** binds the agent to a credential the server already checks: `apikey:<keyId>` (a named API key,
  `access` API or `mcp agents` lists the ids), `oauth:<clientId>` or `oauth:<clientId>/<grantId>` (a connector, or one
  grant of it), `connector:<slug>` (the agent's own connector address, see below), `legacy` (the `--auth` deploy token),
  `open` (a server that asks for no token), `stdio` or `stdio:<name>` (a local stdio server started with
  `ZALO_MCP_AGENT=<name>`). The agent is never a name the caller types; a tool's `consumer` input is only a sub-name (a
  label, not a boundary).
- **One connector per agent.** `<publicUrl>/mcp/a/<slug>` is the same MCP server under an agent's own address. Added as
  a connector (a Claude app project's, say), it runs OAuth for the resource `<publicUrl>/mcp/a/<slug>`: the approve page
  tells the owner which agent he connects, and the grant's tokens carry that address as their audience. Such a token
  opens that address and `/mcp`, never another agent's address; it is the agent bound by `connector:<slug>`, or no
  agent at all when none is (it fails closed). Other credentials (API keys, the deploy token) work on the address as on
  `/mcp`.
- **`mark`** (default `🤖 <name>:`) goes in front of every text and caption the agent sends with `zalo_send_message`,
  unless the text already starts with it. **`marks`** (`shown`, the default, or `hidden`) is the account's setting;
  an agent's **`markDisplay`** overrides it: `inherit` (default), `everywhere`, `owner` (My Documents only) or `none`.
- **`delivery`**: `live` (default) or `onDemand` (default for OAuth connectors): an on-demand agent not seen lately
  shows `onDemand`, never offline. **`enabled`**: `false` shows the agent `disabled`.
- **`presenceWindow`** (default `90s`, at least `10s`): an agent seen this recently, or with a
  `zalo_wait_for_message` open, is `listening`; `zalo_inbox` `status` sets `away`.
- **Who sent what** is kept sealed in `accounts/<ownId>/sent-by.json` (ids and agent names, no text; 30 days, the
  newest 5,000 sends). `zalo_get_history` and `zalo_search_messages` return `sentBy: {agent, name, sub}` on the
  account's own messages. Presence is written to `accounts/<ownId>/agents-presence.json` (agent names and times).
- The live policy's `routing.agents`, `routing.marks` and `routing.presenceWindow` win over the file and change with no
  restart (`routing.agents` only in an account's own policy). See them with `zalo-agent mcp agents`, the admin API's
  `GET /access/<ownId>/agents`, or, as an agent, `zalo_inbox`.

**Routing (phases 3-6).** With `routing.enabled: true` every incoming message gets one handler, decided once by the
engine (src/core/message-router.js) and carried on the message as `route: {to, by, ruleId, observers, ownership}`
(also in the webhook). The order: the owner's **human pause** (his own send from his phone, PC or web pauses the agents
in that conversation for `humanPause`, 15 min by default), an explicit **trigger** (`@dev` or a route's word from the
owner, at the start; a `#hashtag` anywhere, from anyone when the route allows it; the trigger is removed from `text`
and kept in `rawText`), **sticky focus** (after a sticky trigger the owner's next messages stay with that agent until
`@end` or `stickyTtl`), **reply affinity** (a reply to an agent's message goes back to it, `affinityTtl`), an active
**claim**, then the **routes** table (first match: `threads`, `threadType`, `myDocuments`, `senders`, Zalo `labels`,
`kinds`, a time `window`, `mentionsAccount` for a group message that mentions the account or @All), then the **default**. Claims, the human pause and sticky focus survive a restart (sealed in `routing-state.json`). A live agent away for longer than `fallbackAfter` hands over to its
route's `fallback` chain (another agent, `human` with a notice in My Documents, or `{autoReply: text}`). Claims, human
pause, affinity, sticky focus and fallback need `routing.claims: true`.

```json
"routing": {
  "enabled": true, "claims": true, "isolation": false, "owners": ["<the owner's other Zalo user id>"],
  "routes": [
    {"id": "dev", "target": "dev", "match": {"trigger": {"word": "@dev", "sticky": true}}},
    {"id": "tickets", "target": "staff:lan", "match": {"trigger": {"word": "#ticket", "who": "anyone"}}},
    {"id": "dms", "target": "ai", "match": {"threadType": "dm"}, "fallback": ["dev", "human"]}
  ],
  "default": {"target": "human"},
  "staff": [{"id": "lan", "name": "Lan", "channels": ["zalo"], "zaloUserId": "<her Zalo user id>"}],
  "settings": {"humanPause": "20m"}
}
```

- Each agent reads its own messages: `zalo_get_messages` and `zalo_wait_for_message` take `view: "mine"` (default with
  routing on) or `"all"` (each marked `forMe`). A connection bound to no agent gets nothing new.
- **Send guard:** an agent's `zalo_send_message` or `zalo_forward_message` into a conversation the owner is answering is
  refused with `HUMAN_ACTIVE`; into one another agent holds (or quoting a message another agent owns) with `CLAIMED`.
- **Staff** targets: `staff:<id>` with `channels` `console` (answered in a console) and/or `zalo` (the message is
  forwarded to the staff member's own Zalo; his reply to it is relayed to the customer from this account with his mark).
- **`@agents`** typed by the owner in any chat is answered in his My Documents with the agents and their presence.
- **Per-agent privacy** (`routing.isolation: true`): an agent reads only conversations routed to it or claimed by it
  (`zalo_get_history`, `zalo_view_media`, `zalo_get_group_members`, `zalo_coverage` refuse with `NOT_ROUTED`; search and
  lists leave the others out) and cannot send elsewhere.
- `zalo_inbox` gains `claim`, `release`, `handoff`, `claims` and `route_test`; the admin API answers the same test at
  `POST /access/<ownId>/route-test` (with unsaved routes, for a console's test box).
- **A console's view of the running router** (`POST /access/<ownId>/routing`, `{action, ...}`, answered by the account's
  daemon; 409 `DAEMON_NOT_RUNNING` when none runs): `events` (routing decisions, claims, hand-offs, human pauses and
  refused sends, ids only, never a message's text; kept sealed in `routing-events.json` in the account folder
  for `routing.logDays` days, default 7, at least one, the newest 5,000 at most, across restarts), `claims`, `release`,
  `assign` (to an agent, a staff member or `human`), `human` / `endHuman` (start or end the owner's pause), and the staff
  inbox for a staff member who answers in a console: `inbox`, `thread` (the conversation's cached messages), `claim`,
  `unclaim`, `send` (sent from this account with the staff member's mark). A staff member reaches only conversations
  routed to him or held by him (`NOT_ROUTED`). The fleet controller publishes each new event on `GET /zalo/admin/events`
  as a `routing` event (not on the admin webhook).

### Renewing the saved login (`session.renew`)

A QR login lasts about 90 days and Zalo never renews it: only a new QR scan by the account's phone does. An
`mcp start --http` server with a public address (`publicUrl`, `--public-url`, `ZALO_MCP_PUBLIC_URL[_<ownId>]`) does
the asking itself. Within `daysBefore` days of the end it opens a **renewal link**, a one-time QR login page at
`<publicUrl>/zalo/qr/<token>` on its own HTTP port, and puts it in its `session_expiring` events as `renewUrl` (with
`renewExpiresAt`). A link lives `linkTtl`; when it runs out a new one is opened and one more `session_expiring` goes
out with it, every day by default, until the login is renewed. The 14-day threshold event still goes out without a link.

| Key (`session.renew.*`) | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` (or `ZALO_SESSION_RENEW[_<ownId>]=off`): no link is opened; the events stay as they were |
| `daysBefore` | `7` | open a link this many days before the end (1-14; `ZALO_SESSION_RENEW_DAYS[_<ownId>]`), and after it has ended |
| `linkTtl` | `"24h"` | how long one link lives (10m-7d) |

Layers: `mcp-config.json` `session.renew` < `accounts.<ownId>.session.renew` < the environment < the runtime policy
(`session.renew.*`, applied at once). `zalo-agent session renew [--account <id>] [--fresh]` opens a link by hand.
Without a public address no link can reach a phone: the events carry `renewHint` instead. `listen` serves no page,
so it opens no link.

The page asks Zalo for a fresh code when it is opened, shows which account it renews (its name and id), and needs
nothing but the scan and the confirmation on that account's phone. The login keeps the account's saved device id, so
Zalo's offline queue carries on. A scan by **another account** is refused before its session is opened, and the page
says so. On success the server saves the new login sealed under the account's keyring, switches to it **in place** (no
restart; a `signed_out` or `yielded` daemon comes back, a parked one keeps it for its next wake) and sends
`session_renewed` `{event, accountId, expiresAt, daysLeft, deviceKept, at}`; the link is then used up. The token is
128 random bits held in memory only (a restart opens a new link and the old one is dead) and never logged; the page is
`no-store`, `nosniff`, `no-referrer`, unframeable, with a nonce CSP, at most 120 requests a minute (then 429) and
12 QR logins an hour. `fleet status` shows `renewing` in LOGIN ENDS while a link is open.

---

## 2. Reference

### Environment variables

`_<ownId>` in the third column means the name also exists with the account's id appended (rule 2 above).

| Variable | `_<ownId>` | Meaning | Flag | `mcp-config.json` |
|---|:-:|---|---|---|
| `ZALO_CONFIG_DIR` |  | root: `accounts.json`, `mcp-config.json`, credentials. Default `~/.zalo-agent-cli` | `--config-dir` |  |
| `ZALO_CREDENTIALS_DIR` |  | credential files. Default `<CONFIG_DIR>/credentials` | `--credentials-dir` |  |
| `ZALO_DATA_DIR` (alias `ZALO_DB_DIR`) |  | per-account databases and runtime files. Default `<CONFIG_DIR>/accounts` | `--data-dir` |  |
| `ZALO_MEDIA_DIR` |  | downloaded media root | `--media-dir` | `media.downloadDir` (MCP server only) |
| `ZALO_OA_DIR` |  | the official APIs' credentials folder. Default `~/.zalo-agent` (no `-cli`): `oa-credentials.json` (the OA login, one record per `--oa-id`, also used by `zbs`) and `social-credentials.json` (the Social API login, one record per `--profile`), both mode `0600` | `--oa-dir` |  |
| `ZALO_OA_APP_SECRET`, `ZALO_SOCIAL_APP_SECRET` |  | the app secret for `oa login` / `oa init`, and for `social setup` / `social login`, when `--secret` is not given (a flag shows in the process list). Without either, a terminal is asked at a prompt that does not echo | `--secret` |  |
| `ZALO_ACCOUNT` |  | account for one-shot commands | `--account` |  |
| `ZALO_ENV_FILE` |  | an extra `.env` to load | `--env-file` |  |
| `ZALO_MCP_HTTP_PORT` | yes | serve HTTP/HTTPS on this port instead of stdio | `--http` | `httpPort` |
| `ZALO_MCP_HOST` | yes | bind address. Default `127.0.0.1` | `--host` | `host` |
| `ZALO_MCP_AUTH_TOKEN` | yes | bearer token for `/mcp` and `/events/wait` | `--auth` (visible in `ps`; prefer the variable) |  |
| `ZALO_MCP_TLS_CERT`, `ZALO_MCP_TLS_KEY` | yes | serve HTTPS; both or neither | `--cert`, `--key` | `tls.cert`, `tls.key` |
| `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET` | yes | the primary OAuth client (§3.4). Setting the secret turns OAuth on; it authenticates that client at `/token` only and is not a bearer token (since 3.0.1). `--auth` is never a client secret | `--client-id`, `--client-secret` | `oauth.clientId`, `oauth.clientSecret` |
| `ZALO_MCP_OAUTH_REDIRECT_URIS` | yes | the primary client's callback URLs, comma-separated (`https://claude.ai/api/mcp/auth_callback`). Matched exactly, except that an `http://127.0.0.1`, `[::1]` or `localhost` one matches any port; only `https`, or `http` on loopback | | `oauth.redirectUris` |
| `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` | yes | `true` opens `/register` (RFC 7591) and turns OAuth on: clients that register themselves (Claude Code, MCP Inspector). Default `false` | | `oauth.allowDynamicRegistration` |
| `ZALO_MCP_OAUTH_SECRETS_AS_BEARER` | yes | `true` keeps the 3.0.0 behavior where a configured client secret also works as a bearer token for `/mcp`. Default `false` | | `oauth.secretsAsBearer` |
| `ZALO_MCP_PUBLIC_URL` | yes | the one public address of the server behind a reverse proxy or TLS terminator (`https://zalo.example.com`, optionally with a base path such as `https://zalo.example.com/a/<ownId>`): the MCP endpoint, the OAuth issuer, and the links to the one-time secure page (`/zalo/secure/<token>`) and QR login page (`/zalo/qr/<token>`). Must be `https`, except `http` on `localhost`, `127.0.0.1` or `[::1]`; no query or fragment; a trailing slash is dropped. A value that breaks a rule stops the server from starting. Unset: links use the server's own address and only the OAuth metadata falls back to the request's `Host` | `--public-url` (`mcp start`, `login`, `account login`) | `publicUrl` |
| `ZALO_MCP_ISSUER_URL` | yes | deprecated name of `ZALO_MCP_PUBLIC_URL`, still read after every `publicUrl` source, with a note once per process | `--issuer-url` (deprecated) | `oauth.issuerUrl` (deprecated) |
| `ZALO_WEBHOOK_URL` | yes | POST each incoming message here | `-w`, `--webhook` | `webhook` |
| `ZALO_WEBHOOK_SECRET` | yes | sign the webhook (`Authorization: Bearer` + `X-Zalo-Signature: sha256=…`) | `--webhook-secret` (visible in `ps`) | `webhookSecret` |
| `ZALO_WEBHOOK_BATCH_SIZE` | yes | events per webhook POST, 1–100. The default, 1, sends each event alone | | `webhookBatchSize` |
| `ZALO_WEBHOOK_MAX_AGE` | yes | how long an undelivered event is retried before it is dead-lettered (`6h`, `24h`; at least `1m`). Default `24h` | | `webhookMaxAge` |
| `ZALO_MCP_CONFIRM_MODE` | yes | who confirms a destructive tool action (recall, delete, leave a group, …): `agent` (default; the caller sends `confirm: true`), `human` (the server asks the user: by MCP form elicitation under stdio, otherwise on a one-time approve page whose link is in the reply, which works over HTTP too) or `off` (no question; `zalo_write` still needs `confirm`) | | `confirmMode` |
| `ZALO_MCP_HIDDEN_CHATS` | yes | what the MCP server shows of the account's hidden chats: `exclude` (default: left out of every list, search, history and event), `contentless` (left out of lists; an event in one arrives as `{event, hidden: true}` with no thread id or content) or `include` (shown like any other: hands them to the agent) | | `hiddenChats` |
| `ZALO_MCP_OWN_MY_DOCUMENTS` | yes | `true` passes the account's own messages in its own My Documents (the self-chat, `me`) to the agents: `zalo_get_messages`, `zalo_wait_for_message`, the notifier and the webhook, each marked `isSelf: true`, so the owner can talk to an assistant there. Every other message the account sends itself stays out, and the agent's own `zalo_send_message` replies are not handed back to it. Default `false`: no self-sent message reaches the agents | | `ownMyDocuments` |
| `ZALO_MCP_AGENT` | no | The name of a local stdio server's caller: it is `stdio:<name>` for the `routing` block (lowercase letters, digits, `-`). Unset: `stdio` | | |
| `ZALO_MCP_ALLOW_PIN_ARGUMENT` | yes | `true` lets the hidden-chat tools take the PIN as a `pin` input. Default `false`: an input is written to the MCP client's logs and the model's context. Only for a non-AI client | | `allowPinArgument` |
| `ZALO_MCP_APPROVAL_SECRET` | yes | what an approve page (`confirmMode: "human"`) asks besides a click, so an agent that can open the link cannot approve its own action: `pin` (the hidden-chat PIN, with its lockout), `password` (the approver password set with `zalo-agent mcp approver set`, stored only as a salted scrypt hash), `none` (a click approves: weaker) or `auto` (default: the approver password when one is set and the link reaches the agent, else nothing, and the reply says `approverSecret: false`) | | `approval.secret` |
| `ZALO_MCP_APPROVAL_DELIVER` | yes | where the link of an approve or PIN page goes: `result` (default: in the tool result), `webhook` (only to the MCP webhook, as an `approval_requested` event; the tool result carries no link) or `both` | | `approval.deliver` |
| `ZALO_MCP_MEDIA_DELIVER` | yes | how `zalo_view_media` returns cached media, for every kind (`link`) or per kind (`photo=inline,video=link`): `inline` (MCP image/audio content), `link` (`<publicUrl>/zalo/media/<token>`) or `tempfile` (a private decrypted copy on this machine). Overrides `media.deliver` kind by kind; a call's own `deliver` beats it | | `media.deliver` |
| `ZALO_MCP_MEDIA_LINK_AUTH` | yes | who may fetch a media link: `bearer` (the request also carries this server's `Authorization`: `--auth`, `ZALO_MCP_AUTH_TOKEN` or an OAuth token), `capability` (the link alone, limited to `media.capability.maxClients` client addresses off this machine) or `auto` (default: `bearer` when `publicUrl` is another host, else `capability`) | | `media.linkAuth` |
| `ZALO_MCP_ADMIN_TOKEN_FILE` | yes | a file holding the admin API's token (at least 16 characters): a systemd credential, a KMS-decrypted mount. Read at start. The admin API also takes the token sealed by `zalo-agent policy token --rotate` | | `admin.tokenFile` |
| `ZALO_MCP_ADMIN_TOKEN` | yes | the admin API's token itself (development; prefer the file or the sealed token). The agent's token is always refused there, even if both are the same | | |
| `ZALO_MCP_ADMIN_CLIENT_CA` | yes | a CA certificate (PEM): a client certificate it signed admits to the admin API (mTLS). Needs `--cert`/`--key` | | `admin.clientCa` |
| `ZALO_MCP_TRUSTED_PROXIES` | yes | comma list of reverse-proxy addresses whose `X-Forwarded-For` is believed (`127.0.0.1`, or `loopback`). Default none: the client address is the connection's peer | | `trustedProxies` |
| `ZALO_MCP_GROUP_CONFIRM` |  | deprecated: `0` means confirm mode `off`, `1` means `agent`; an explicit confirm mode wins | | `groupConfirm` |
| `ZALO_SYNC_NAME_REFRESH_MAX` |  | opt-in cap on the non-friend DM names one sync restore looks up. Unset (default) = all of them, in requests of 500 as Zalo does; a 221 refusal stops the refresh for that run and parks the refused ids for an hour (or until the server's `nextTs`) | | |
| `ZALO_SEND_FORMAT` |  | `markdown` or `plain`: the default format of a text send. Unset: `msg send` sends plain (a person typed it), `zalo_send_message` converts Markdown (a model wrote it). An explicit `--md`/`--markdown` or the tool's `format` wins | | |
| `ZALO_START_JITTER` | yes | wait a random time up to this many seconds (0–600, default 0) before logging in, so a fleet restarting together does not log in together | | |
| `ZALO_LOGIN_SLOTS` | yes | at most this many daemons on the machine logging in and loading their lists at once (0–64; default 0, no cap); the rest wait for a slot. `ZALO_LOGIN_SLOT_WAIT` (seconds, default 900) is how long one waits before going ahead anyway | | |
| `ZALO_CONNECT_SLOTS` | yes | at most this many daemons on the machine waking their parked socket at once (on-demand presence; 0–64, default 0, no cap; fleet samples 16): a wake holds its slot until its first catch-up ends, at most 60 s. `ZALO_CONNECT_SLOT_WAIT` (seconds, default 120) is how long one waits before going ahead anyway | | |
| `ZALO_EXIT_ON_SIGNED_OUT` | yes | `1`: a login Zalo keeps refusing ends the daemon with exit 4, as before 3.0 (`ZALO_EXIT_ON_SIGNED_OUT_<ownId>` for one account). Default: the daemon stays up in `signed_out` and refuses requests until the account is added again by QR | | |
| `ZALO_SESSION_RENEW`, `ZALO_SESSION_RENEW_DAYS` | yes | `off` turns the renewal link off; the days before the login's end a link opens (1-14, default 7). Between the files and the runtime policy (see [renewing the saved login](#renewing-the-saved-login-sessionrenew)) | | `session.renew.enabled`, `session.renew.daysBefore` |
| `ZALO_PRESENCE_MODE`, `ZALO_PRESENCE_IDLE_TIMEOUT` | yes | `on-demand` or `always-on`; the idle time before the socket parks (`5m`, at least `30s`). Between the files and the runtime policy (see [on-demand presence](#users-the-always-on-cap-and-on-demand-presence)) | | `presence.mode`, `presence.idleTimeout` |
| `ZALO_FLEET_CONTROLLER_PORT` |  | the port `fleet serve` binds when `--http` is not given. Default `3899` | `fleet serve --http` | |
| `ZALO_FLEET_DOMAIN` |  | the proxy host of `fleet generate --domain`: an account added by QR through `fleet serve` gets `ZALO_MCP_PUBLIC_URL=https://<host>/a/<ownId>` in its env file | `fleet serve --domain` | |
| `ZALO_FLEET_QR_FLOWS` |  | QR logins the fleet controller runs at once (more is `429`). Default `4` | | |
| `ZALO_FLEET_JOBS` |  | Account jobs (sync, attachment download, purge) the fleet controller runs at once (more is `429 JOBS_BUSY`). Default `2` | | |
| `ZALO_FLEET_SUPERVISOR` |  | `systemd` or `spawn`: who starts, stops and restarts each account for `fleet start\|stop\|restart` and `fleet serve`. Unset: systemd for an account whose `zalo-mcp@<ownId>` unit is loaded and active, failed or enabled, else a spawned daemon. `fleet generate`'s `common.env` sets `systemd` | | |
| `ZALO_FLEET_WEBHOOK`, `ZALO_FLEET_WEBHOOK_SECRET` |  | the fleet controller's admin webhook: every `account_state` and QR-add event POSTed as JSON, signed like the daemons' webhooks (`Authorization: Bearer` + `X-Zalo-Signature`) when the secret is set | | |
| `ZALO_LOG_LEVEL` | yes | `error`, `warn`, `info` (default) or `debug` (adds a line per HTTP request and per message) | `--log-level` | |
| `ZALO_LOG_FORMAT` | yes | `text` (default, timestamped lines) or `json` (one object per line) | | |
| `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP` | yes | rotate `daemon.log` at this size (default `50m`, at least `4k`) and keep this many files (default 3) | | |
| `ZALO_AGENT_NO_UPDATE_CHECK` |  | any value: never run the `npm view` update check | | |
| `ZALO_API_VERSION` |  | protocol version announced to Zalo. Default 695 | | |
| `ZALO_QR_FLOW` |  | which QR login `login` uses: `official` (default: Zalo's own login sequence, no `verify-client`, `continue=https://chat.zalo.me/`, the redirects through `jr.zaloapp.com` and `jr.chat.zalo.me`, and the second QR an account with a trusted device is asked to scan, which makes this client a trusted companion device), the only QR login. `legacy` was removed in 3.0.0; it and any other value are refused before Zalo is contacted | | |
| `ZALO_NET_PROBE` |  | what a daemon asks to learn whether the network is up while its socket is down (every 10 s): a URL, default a global search engine's lightweight page, or `off` to assume the network is always up and contact nothing but Zalo | | |
| `ZALO_STORAGE_PROVIDER` |  | key provider that protects the saved files at rest: `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase`, `env`. Default by platform; a Linux server without a desktop keyring must set one. See [security.md](security.md) | | |
| `ZALO_RETENTION_MESSAGES`, `ZALO_RETENTION_MEDIA` | yes | `keep` or `<N>d`: the age rules of the local cache, over `storage.json`'s `retention.messages` / `retention.media` (see [Storage quotas and retention](#storage-quotas-and-retention)) | | |
| `ZALO_STORAGE_MIN_FREE` |  | the free space a download leaves on the disk (`2GB` by default, `0` for none), over the runtime policy's and `storage.json`'s `quota.minFree` (see [room before downloading](#room-before-downloading-quotaminfree)) | | |
| `ZALO_GROUPS_ON_LEAVE` | yes | `purge` (default) or `keep`: what a left, removed-from, blocked-from or disbanded group's local history becomes, over `storage.json`'s `groups.onLeave` (see [Leaving a group](#leaving-a-group-groupsonleave)) | | |
| `ZALO_STORAGE_DKEY_LAYER` |  | `1` / `0`: lock everything a login does not need under the account's login `dkey` as well. Default off | | |
| `ZALO_DPAPI_SCOPE`, `ZALO_SYSTEMD_CREDS_WITH_KEY`, `ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`, `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_STORAGE_KEY` |  | the chosen provider's options (`ZALO_STORAGE_KEY`: the `env` provider's key, weak by design). The `vault` KMS backend also reads `VAULT_ADDR`, `VAULT_TOKEN` and `VAULT_NAMESPACE` when `storage.json` does not name them | | |

### Official APIs (`oa`, `zbs`, `social`)

The official APIs take no `mcp-config.json` key; their only environment variables are `ZALO_OA_DIR`, the app secrets below and `ZALO_OA_SECRET`. Their other settings are flags, and their logins are files in the `ZALO_OA_DIR` folder (above, created `0700`), apart from the personal account's `~/.zalo-agent-cli/`.

- `oa login` / `oa init` save the OA's App ID, secret key and tokens in `oa-credentials.json` under `--oa-id` (default `default`); every OA and ZBS call then sends `appsecret_proof`, computed from that secret key, so after resetting the app's secret key log in again with the new one (`oa login` or `oa init`). The app secret comes from `--secret`, else the `ZALO_OA_APP_SECRET` environment variable, else a prompt that does not echo (on a terminal): the variable or the prompt keeps it out of the process list and the shell history.
- `oa login` and `social login` wait for the callback 5 minutes (`--timeout <seconds>`, 10 to 3600). Only the answer to this login ends it: a request with another `state`, or none where one is required, or with no code, gets `400` and the login keeps waiting. `social login` requires `state` on the callback; `oa login` also takes a callback without one, since the example in Zalo's OA docs has none. A token request gives up after 30 s.
- `social setup` and `social login` read the app secret from `--secret`, else `ZALO_SOCIAL_APP_SECRET`, else (`social setup` only) a prompt that does not echo; `social login` then falls back to the saved one.
- `social login` saves a Social API user login in `social-credentials.json` under `--profile` (default `default`); `--dpop` binds its tokens to a key pair (each proof carries a random `jti`).
- `oa listen` serves the OA and ZBS webhook: `--port` (default 3000; the engine does not read `ZALO_OA_WEBHOOK_PORT`), `--path` (default `/webhook`), `--secret <OA secret key>` or, better for a service, the `ZALO_OA_SECRET` environment variable (a flag is visible in the process list) for the `X-ZEvent-Signature` check (`--no-verify` skips it), `--app-id` for events whose body has no `app_id` (default: the saved App ID), and domain verification with `--verify-file <file.html>` (served as is at its name) or `--verify-meta '<meta …>'` (served in the home page's head). `oa init` run without flags asks for the keys interactively, which keeps them out of shell history.

### `mcp-config.json` keys

| Key | Default | Meaning |
|---|---|---|
| `watchThreads` | `["dm:*", "group:*"]` | which conversations are buffered: `dm:*`, `group:*`, `dm:<id>`, `group:<id>` |
| `triggerKeywords` | `["@bot"]` | words that mark a message as needing attention |
| `limits.autoDigestThreshold` | 50 | unread count above which tools return a digest |
| `limits.bufferMaxAge` | `"2h"` | how long a message stays in the live buffer |
| `limits.bufferMaxSize` | 500 | messages kept **per thread** in the live buffer |
| `media.downloadDir` | `null` | media root for this server (files there are sealed under the account's media key, like the default root) |
| `media.autoOpen` | unset (= `true` on stdio, `false` over HTTP) | `zalo_view_media` opens the file with this machine's viewer (through a tempfile). Over HTTP it never opens anything |
| `media.deliver` | photo, gif, doodle, sticker, voice, audio `inline`; video, file `link` | per kind: `inline`, `link` or `tempfile` (see `ZALO_MCP_MEDIA_DELIVER`). Inline over `inlineMaxBytes`, or of a type a client cannot render, goes as a link. The type is read from the file's own bytes, never from what Zalo's file server called it: pictures go inline as JPEG, PNG, GIF or WebP (a JPEG XL photo goes inline as the JPEG copy Zalo serves of it, or as a link when there is none; HEIC/HEIF and AVIF go as a link), sound as MP3, WAV, AAC, MP4, Ogg, WebM or FLAC (AMR goes as a link); a file whose bytes say nothing goes as a link; a tempfile for a client on another machine goes as a link |
| `media.inlineMaxBytes` | `5242880` | largest picture or voice message sent inline (5 MB is about 6.7 MB of base64 in the model's context) |
| `media.allowDeliver` | `["inline","link","tempfile"]` | the modes a call, or the defaults, may pick. A CRM server can leave out `tempfile` |
| `media.linkTtl` | `"10m"` | how long a media link works |
| `media.tempfileTtl` | `"10m"` | how long a decrypted copy stays before it is deleted |
| `media.linkAuth` | unset (= `auto`) | `auto`, `bearer` or `capability` (see `ZALO_MCP_MEDIA_LINK_AUTH`) |
| `media.linkRateLimit` | `60` | requests a minute one client address may make to media links (and 10 unknown tokens a minute), then `429` |
| `media.capability.maxClients`, `.ttl` | `3`, `"15m"` | a capability link that leaves this machine serves at most this many distinct client addresses, each for this long from its first request (load balancers, a reconnect on a new network, a video player's range requests). Raise per account in `accounts.<ownId>.media.capability` |
| `uploads.inlineMaxBytes` | `"10MB"` | the decoded bytes of every `{data}` file item of one MCP call together (at most `32MB`); the MCP request body limit follows it (base64 is 4/3 of the bytes, plus 1 MB) |
| `uploads.maxBytes` | `"100MB"` | one upload into the account's store (`POST /zalo/files`, a `zalo_file` upload link, `file put`) |
| `uploads.urlMaxBytes`, `uploads.urlTimeout` | `"100MB"`, `"60s"` | one `{url}` file item the server downloads |
| `uploads.quota` | `"500MB"` | what the account's upload store (`accounts/<ownId>/uploads/`) holds at once; an upload over it is refused with `507` |
| `uploads.ttl` | `"24h"` | how long an upload is kept |
| `uploads.uploadLinkTtl` | `"15m"` | how long a `zalo_file` `upload_begin` link waits for its file |
| `uploads.warnAt` | `0.8` | the share of `uploads.quota` where the store's `level` (usage reports) turns `warn` |
| `uploads.localPaths` | `"loopback"` | who may name a path on this machine in a tool input: `loopback` (a stdio client, an HTTP client on this machine), `any`, or `none`. File only, never a policy |
| `uploads.localPathRoots` | `[]` | folders whose paths any caller may name (a folder another container shares with this one). File only |
| `uploads.allowPrivateUrls` | `false` | a `{url}` item may reach a private, loopback or link-local address (a LAN that serves its own files). File only |
| `trustedProxies` | `null` (none) | reverse proxies whose `X-Forwarded-For` is believed (see `ZALO_MCP_TRUSTED_PROXIES`). List your proxy's address, or the per-client limits see one client |
| `notify.enabled`, `.thread`, `.on`, `.cooldown` | off | notify a Zalo group when the agent is away |
| `webhook`, `webhookSecret` | `null` | push each message to a URL, signed (prefer `ZALO_WEBHOOK_SECRET`) |
| `webhookBatchSize` | `1` | events per webhook POST (1–100) |
| `webhookMaxAge` | `"24h"` | an undelivered webhook event older than this is dead-lettered |
| `httpPort`, `host` | `null` | HTTP port and bind address |
| `tls.cert`, `tls.key` | `null` | HTTPS |
| `publicUrl` | `null` | the one public address of the server (see `ZALO_MCP_PUBLIC_URL`): MCP endpoint, OAuth issuer, secure and QR page links. Per account in `accounts.<ownId>.publicUrl` |
| `oauth.clientId`, `.clientSecret`, `.redirectUris` | `null`, `null`, `[]` | the primary OAuth client (§3.4 "OAuth for remote connectors"). A secret makes it confidential; with no secret and some `redirectUris` it is a public client (PKCE only). Either turns OAuth on |
| `oauth.clients[]` | `[]` | more OAuth clients: `{clientId, clientSecret?, redirectUris?}` each |
| `oauth.allowDynamicRegistration` | unset (= `false`) | see `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` |
| `oauth.secretsAsBearer` | unset (= `false`) | see `ZALO_MCP_OAUTH_SECRETS_AS_BEARER` |
| `oauth.accessTokenTtl`, `.refreshTokenTtl` | unset (= `1h`, `30d`) | OAuth token lifetimes; the refresh token's is sliding (every refresh starts it again). At least `1m` |
| `oauth.issuerUrl` | `null` | deprecated name of `publicUrl`, still read when no `publicUrl` source is set |
| `confirmMode` | unset (= `agent`) | `agent`, `human` or `off`: who confirms a destructive tool action. Set `agent` for an AI agent; `human` makes the server ask the user itself |
| `groupConfirm` | | deprecated: `false` means `confirmMode: "off"` when no confirm mode is set |
| `hiddenChats` | unset (= `exclude`) | `exclude`, `contentless` or `include`: what agents see of hidden chats (see the variable above) |
| `ownMyDocuments` | unset (= `false`) | `true` passes the owner's own My Documents messages to the agents, marked `isSelf: true` (see the variable above) |
| `routing` | unset (no agents, marks shown, `90s`) | `{agents, marks, presenceWindow}`: the agents sharing the account, bound to credentials, and their marks (§1 "Agents sharing one account") |
| `allowPinArgument` | unset (= `false`) | `true` lets the hidden-chat tools take the PIN as an input; it then sits in the client's logs |
| `approval.secret` | unset (= `auto`) | `auto`, `pin`, `password` or `none`: what an approve page asks besides a click (see the variable above) |
| `approval.deliver` | unset (= `result`) | `result`, `webhook` or `both`: where a one-time page's link goes |
| `admin.tokenFile` | `null` | see `ZALO_MCP_ADMIN_TOKEN_FILE` |
| `admin.clientCa` | `null` | see `ZALO_MCP_ADMIN_CLIENT_CA` |
| `presence.mode`, `.idleTimeout`, `.minConnected`, `.maxWakesPerHour`, `.warmWait`, `.connectOnStart`, `.catchUpEvery`, `.maxLeases`, `.leaseTtl`, `.leaseTtlMax`, `.waitHoldsSocket`, `.onKick` | see [Users, the always-on cap and on-demand presence](#users-the-always-on-cap-and-on-demand-presence) | on-demand presence of an `mcp start --http` / `listen --daemon`; per account in `accounts.<ownId>.presence`; the runtime policy beats it |
| `session.renew.enabled`, `.daysBefore`, `.linkTtl` | unset (= `true`, `7`, `"24h"`) | the renewal link an `mcp start --http` server with a `publicUrl` opens before the saved login ends (see [renewing the saved login](#renewing-the-saved-login-sessionrenew)) |
| `accounts.<ownId>` | | any of the above, for one account |

A key that is not in this table is ignored without a message. (The `mode` key in older files is accepted and never read.)

### `storage.json` keys

`<CONFIG_DIR>/storage.json` is read by **every** command, not only the MCP server: it chooses how the saved files, the message database and the media are sealed, and sets the local cache's quota, retention and group-exit rules. It holds no secret. Samples per platform: [`storage/`](config-samples/storage/).

| Key | Default | Meaning |
|---|---|---|
| `provider` | by platform: `dpapi` (Windows), `keychain` (macOS), `secret-service` (Linux desktop) | `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase` or `env` (`ZALO_STORAGE_PROVIDER` wins). A Linux server without a desktop keyring must set one; nothing falls back to plaintext. On a VPS: `passphrase`, handed over by systemd through `LoadCredentialEncrypted=` ([security.md](security.md)) |
| `dkeyLayer` | `false` | also lock everything a login does not need under the key Zalo returns at each login (`ZALO_STORAGE_DKEY_LAYER`); local data then opens only after a login |
| `dpapi.scope` | `CurrentUser` | or `LocalMachine` (a Windows service) (`ZALO_DPAPI_SCOPE`) |
| `systemdCreds.withKey`, `systemdCreds.user` | `auto` | `host`, `tpm2`, `host+tpm2` or `auto` (`ZALO_SYSTEMD_CREDS_WITH_KEY`); `user: true` for a unit with `User=` (needs systemd 256) |
| `kms.backend`, `kms.key` | | `aws`, `gcp`, `azure` or `vault`, and the key id (`ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`); the cloud SDK is an optional peer dependency you install |
| `passphrase.file` | | a file holding the passphrase (`ZALO_STORAGE_PASSPHRASE_FILE`); under systemd, `$CREDENTIALS_DIRECTORY/zalo-storage-passphrase` is found with no setting |
| `env.variable` | `ZALO_STORAGE_KEY` | the variable that holds the `env` provider's key (weak: warned about on every start) |
| `accounts.<ownId>.<provider section>`, `accounts.<ownId>.dkeyLayer` | | one account set apart, e.g. a tenant's KMS key (`accounts.<ownId>.kms.key`): it beats the top level **and** the environment for that account, so the daemon, `za`, the purge and the backup units all open its keyring. `account security provider kms <ownId> --key <id>` writes it |
| `rowMac.verifyOnRead` | `actions` | `off`: quote, forward, delete, recall, react, pin and `msg media` no longer check the cached row's MAC first |
| `quota.*`, `retention.*` | no limit, `minFree` `2GB`, `keep` | storage quotas, the disk reserve and age rules, also per account under `accounts.<ownId>`: [Storage quotas and retention](#storage-quotas-and-retention) |
| `groups.onLeave` | `purge` | what a left group's local history becomes, also under `accounts.<ownId>.groups`: [Leaving a group](#leaving-a-group-groupsonleave) |

A `storage.json` that is not valid JSON stops every command that needs a key (a setting that might weaken the protection is never guessed). The provider keys are read at start only: the runtime policy refuses them as `restartRequired`.

---

## 3. Recommended setups

Each setup lists the files and the commands. Replace `1000000000000000001` with the account id from `zalo-agent account list`, and every `CHANGE_ME…` with a value from `openssl rand -hex 32`.

### 3.1 Local · AI agent · stdio

For Claude Code, Claude Desktop or Cursor on the machine that holds the account. No port, no token: the client starts the server and talks to it over stdin/stdout.

- Files: none required. Optional [`mcp-config/local-agent.json`](config-samples/mcp-config/local-agent.json) at `~/.zalo-agent-cli/mcp-config.json`.
- Client: [`clients/claude-code-stdio.json`](config-samples/clients/claude-code-stdio.json) (`~/.claude/settings.json`, or the client's equivalent).
- Several accounts: one server entry per account, each with its own `--account`.

### 3.2 Local · same machine · HTTP on loopback

For a backend, n8n or a container on the same host that cannot use stdio.

```bash
# the port, the bind address and the token in a file only you can read:
install -m 600 docs/config-samples/env/loopback-server.env ~/.zalo-agent-cli/loopback.env
sed -i "s/CHANGE_ME_64_HEX_CHARACTERS/$(openssl rand -hex 32)/" ~/.zalo-agent-cli/loopback.env
zalo-agent --env-file ~/.zalo-agent-cli/loopback.env mcp start --account 1000000000000000001
```

- File: [`env/loopback-server.env`](config-samples/env/loopback-server.env). The token stays out of the command line, where `ps` and the shell history would show it.

- The default bind is `127.0.0.1`: nothing off the machine can connect. **Still set a token**: any local user, and any web page in a browser on the machine, can otherwise reach it (the server answers every origin).
- A Docker container reaches a loopback-bound server through `host.docker.internal` on Docker Desktop (Windows, macOS). On Linux, give the container `--add-host=host.docker.internal:host-gateway` and bind to the Docker bridge address (`ZALO_MCP_HOST=172.17.0.1`) rather than `0.0.0.0`.
- Use [`env/crm-backend.env`](config-samples/env/crm-backend.env) as the starting point and remove the webhook lines if you do not need them.

### 3.3 LAN · AI agents and a CRM on other machines

```bash
zalo-agent --env-file /etc/zalo-mcp/lan.env mcp start --account 1000000000000000001
```

- Files: [`env/lan-server.env`](config-samples/env/lan-server.env) and, if you want one, [`mcp-config/lan.json`](config-samples/mcp-config/lan.json).
- Bind to the LAN address (`ZALO_MCP_HOST=192.168.1.20`), not `0.0.0.0` on a multi-homed host. **The token is mandatory**: without one the server prints `WARNING: no --auth token` and serves anyone who can reach the port.
- Firewall the port to the subnet as well (`ufw allow from 192.168.1.0/24 to any port 3847`).
- HTTP on a trusted LAN is acceptable; if the LAN is shared, add TLS with `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` (a certificate from your own CA or `mkcert`).
- A client uses `http://192.168.1.20:3847/mcp` with `Authorization: Bearer <token>`.

### 3.4 Internet · AI agents (claude.ai connectors, remote agents)

Keep the engine on loopback and put a TLS reverse proxy in front of it.

- Files: [`env/internet-server.env`](config-samples/env/internet-server.env), [`mcp-config/internet.json`](config-samples/mcp-config/internet.json), and one proxy sample: [`proxy/Caddyfile.internet`](config-samples/proxy/Caddyfile.internet) or [`proxy/nginx.internet.conf`](config-samples/proxy/nginx.internet.conf).
- The proxy must not buffer responses and must allow reads of at least 310 s: `/events/wait` holds a request for up to 300 s. Both samples are tested for it.
- **Authentication:** a bearer token for scripts and backends; OAuth 2.1 for remote connectors that insist on it (below). Set `ZALO_MCP_PUBLIC_URL` (or `publicUrl`) to the public `https://` address: the OAuth issuer, the MCP endpoint and every link to a one-time page are built from it. Without it the links use the server's own address, and the OAuth metadata and the `WWW-Authenticate` header are built from the request's `Host` header (`X-Forwarded-Host` / `X-Forwarded-Proto` only from a proxy in `trustedProxies`); with OAuth on and the server listening off loopback, it refuses to start without one. (`ZALO_MCP_ISSUER_URL`, `--issuer-url` and `oauth.issuerUrl` are its deprecated 2.x names and still work.)
- **Files from remote agents.** A remote caller cannot pass a path: it sends `{data, name}` (small files), `{url}` (the server downloads it, public addresses only) or `{fileId}`. `zalo_file` `upload_begin` returns a one-time `<publicUrl>/zalo/files/u/<token>` to `PUT` the file to, with no token; a client holding the bearer can `POST <publicUrl>/zalo/files?name=<file>`. Let the proxy pass request bodies up to `uploads.maxBytes` (100 MB) on `/zalo/files` and up to about 4/3 of `uploads.inlineMaxBytes` plus 1 MB (15 MB with the defaults) on the MCP endpoint, and give uploads the same read timeout as `/events/wait`. A path a remote caller passes is refused with what to send instead, unless it lies under `uploads.localPathRoots`.
- Native HTTPS (`--cert` / `--key`) without a proxy works, but the engine **also tries to listen on port 443** next to your port. Prefer the proxy.
- Add what the engine does not have: an IP allow-list at the proxy, and a log that never records the `Authorization` header. The engine limits only the OAuth endpoints' request rate. The server answers most origins with `Access-Control-Allow-Origin: *` (not a `/register` answer carrying a client secret); strip or replace the header at the proxy if browsers should not call it.

#### OAuth for remote connectors (Claude.ai, Claude Desktop, Gemini)

OAuth is **off unless you turn it on** (since 3.0.1): a server with only `--auth` / `ZALO_MCP_AUTH_TOKEN` serves bearer tokens and answers `404` on every OAuth route, the discovery documents included. It is on when a client is configured (`ZALO_MCP_OAUTH_CLIENT_SECRET`, `oauth.redirectUris`, or an `oauth.clients[]` entry) or dynamic registration is.

**Before the first connection**

1. The public address: `ZALO_MCP_PUBLIC_URL=https://zalo.example.com`. It is the issuer, and the MCP endpoint is `<publicUrl>/mcp`. A base path works (`https://zalo.example.com/a/<ownId>`): the server also answers the path-inserted discovery URLs (`/.well-known/oauth-authorization-server/a/<ownId>`), and the multi-account Caddyfile (`fleet generate --domain`) routes them from the host root to the account.
2. A server secret to sign tokens with: the bearer token (`ZALO_MCP_AUTH_TOKEN`), else the first client secret. The signing key is derived from it per account, so a token of one account is refused by another. Changing it signs every OAuth client out.
3. An approver password: `zalo-agent mcp approver set --account <ownId>`. Every connection opens a one-time page on this server in the browser of the person connecting; it shows which client asks and where it returns, and asks for this password (with `approval.secret: "pin"`, the hidden-chat PIN instead). Only after **Approve** does the client get a code. With no approver secret set, `/authorize` refuses and says so.

**Static client or dynamic registration**

- **A static client** (recommended): you pick its id and secret, give both to the connector, and list the connector's callback URL. One client: `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET`, `ZALO_MCP_OAUTH_REDIRECT_URIS`. More: `oauth.clients[]` in `mcp-config.json`, `{clientId, clientSecret, redirectUris}` each. A secret authenticates its own client at `/token` and nothing else: it is not a bearer token for `/mcp` (`oauth.secretsAsBearer: true` restores that 3.0.0 behavior). A client with `redirectUris` and no secret is a public client.
- **Dynamic registration** (`ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION=true`): a connector registers itself at `/register` (RFC 7591) and gets a client of its own, public unless it asks for a secret, which is random per client and kept only as a hash. `redirect_uris` are required. At most 100 clients (one never used is dropped after a day when the list is full) and 10 registrations an hour per address; registrations survive a restart. Every connection still needs your approval.
- Redirect URIs match exactly. Only `https`, or `http` on `127.0.0.1`, `[::1]` or `localhost`, where any port matches (RFC 8252). `javascript:`, custom schemes and `http` elsewhere are refused.

**Claude.ai custom connector, and Claude Desktop** (Claude Desktop uses the connectors of your Claude account):

1. On the server: `ZALO_MCP_OAUTH_CLIENT_ID=zalo-connector`, `ZALO_MCP_OAUTH_CLIENT_SECRET=<openssl rand -hex 20>`, `ZALO_MCP_OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`; restart.
2. In Claude: Settings → Connectors → Add custom connector. URL `https://zalo.example.com/mcp`; under Advanced settings, the OAuth Client ID and Client Secret above. (With dynamic registration on, leave both empty.)
3. Connect. A tab opens this server's approve page: type the approver password, Approve. Claude returns to the chat connected.

**Gemini** (Gemini Enterprise custom MCP connectors, Connected Apps):

1. On the server, a client for Gemini with the callback its setup form shows (Google's is `https://vertexaisearch.cloud.google.com/oauth-redirect`), e.g. in `oauth.clients[]`: `{"clientId": "gemini", "clientSecret": "<random>", "redirectUris": ["https://vertexaisearch.cloud.google.com/oauth-redirect"]}`.
2. In Gemini's form: the MCP URL `https://zalo.example.com/mcp`, authorization URL `https://zalo.example.com/authorize`, token URL `https://zalo.example.com/token`, the client id and secret, scope `mcp:tools` (or `ACCESS_VIEW_MANAGE_MCP_CONTENT` if it asks for that one).
3. Authorize: the approve page opens; type the approver password, Approve.

**Protocol.** Authorization code with PKCE `S256` only (`plain` and a missing challenge are refused); `redirect_uri` again at `/token`; `iss` in the authorization response (RFC 9207); an optional `resource` (RFC 8707) must be `<publicUrl>/mcp`. Scopes: `mcp:tools`, `offline_access`, `ACCESS_VIEW_MANAGE_MCP_CONTENT`; each grants this account's tools, there is no narrower scope. `client_credentials` serves a confidential client acting for itself (a backend). Routes: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register` (when on), `/revoke`. There is no OpenID Connect (`/.well-known/openid-configuration` is `404`). `/register`, `/authorize`, `/token` and `/revoke` are rate limited per client address (`429` with `Retry-After`).

**Token lifetimes and revoking.** An access token lasts 1 hour (`oauth.accessTokenTtl`) and carries its issuer and audience, both checked. A refresh token lasts 30 days from its last use (`oauth.refreshTokenTtl`) and rotates on every refresh; one used twice revokes that whole connection, and the connector must be authorized again. To end a connection: `POST /revoke` (RFC 7009) with the token and the client's credentials; or remove the client from the configuration and restart (its tokens stop working at once); or, with the server stopped, delete `<account folder>/oauth-state.json` (every OAuth connection and registration). That file (`0600`) keeps the registered clients and one record per connection, with hashes only; authorization codes live in memory and do not survive a restart.

**Upgrading from 3.0.0.** `--auth` alone no longer turns OAuth on, and the OAuth client secret no longer defaults to it: set `ZALO_MCP_OAUTH_CLIENT_SECRET` (and its redirect URIs) to keep a connector. Dynamic registration is off by default. A client secret is no longer a bearer token. Tokens issued by 3.0.0 are not accepted: every connector authorizes again, through the approve page.

### 3.5 Backend for a CRM

A CRM needs three things from an account: to **hear** new messages, to **send**, and to **catch up** after its own downtime. They are three different mechanisms.

**Hear: push by webhook.** Files: [`env/crm-backend.env`](config-samples/env/crm-backend.env), [`mcp-config/crm-backend.json`](config-samples/mcp-config/crm-backend.json).

- `mcp start` posts `{event: "message", accountId, msgId, threadId, threadType, senderId, senderName, text, timestamp, type, attachment, replyTo}` for each message that passes `watchThreads`. `listen -w` posts a different, richer shape (`{accountId, event, msgId, threadId, type, isSelf, uidFrom, dName, msgType, content, …}`) and also friend, group, reaction and read events. Pick one per account.
- Every delivery carries `Authorization: Bearer <secret>` and `X-Zalo-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Verify the signature over the **raw** bytes: [`clients/crm-webhook-receiver.mjs`](config-samples/clients/crm-webhook-receiver.mjs) (Node) and [`clients/crm_webhook_receiver.py`](config-samples/clients/crm_webhook_receiver.py) (Python) do.
- **Delivery is durable, ordered and at least once.** Each event is written to `webhook-outbox.db` in the account directory before anything sends it, so a receiver that is down, slow (a POST has 10 seconds) or answering anything but 2xx costs a backlog, not messages: the sender retries with waits of 1 s doubling to 5 min, holds everything behind a failing event so order is kept, and carries on after a restart or crash. A payload the receiver refuses as malformed (400, 413, 422) is parked as a **dead letter**, and so is any event still undelivered after `ZALO_WEBHOOK_MAX_AGE` (24 h). Watch it with `zalo-agent mcp webhook status`, look with `mcp webhook list --dead`, and put events back with `mcp webhook retry`.
- **Acknowledge with 2xx at once, do the work afterwards, and de-duplicate on the message id.** At least once means a message can arrive twice (a crash after your reply, before the sender noted it). Every POST has `X-Zalo-Attempt`, and `X-Zalo-Delivery: <first>-<last>` (outbox numbers).
- **Batching.** With `ZALO_WEBHOOK_BATCH_SIZE=10` up to ten queued events go in one POST as `{"event":"batch","accountId":…,"count":N,"events":[…]}`, signed over the whole body; a lone event is still the plain payload. The sample receivers handle both. Turn it on when a backlog or many accounts make one POST per message too many.
- **System events** go through the same webhook (ids and counts only, never a name): `account_state` (the account's state: `stopped`, `idle`, `connecting`, `connected`, `kicked`, `yielded`, `login_needed`, `signed_out`, `maintenance`; see [on-demand presence](#users-the-always-on-cap-and-on-demand-presence)), `storage_quota` ([quotas](#storage-quotas-and-retention)), `group_gone` ([leaving a group](#leaving-a-group-groupsonleave)), `queue_overflow` (Zalo dropped part of the offline queue: `{event, accountId, fromTs, toTs, queues, direct, groups, pending, command}`; group messages are read back from the groups' cloud store, a 1-1 gap stays pending with the `sync --from` command that restores it), `session_expiring` (the saved login ends by itself about 90 days after its QR login, and nothing renews it: `{event, accountId, expiresAt, daysLeft, expired, threshold, command, at}`, once per threshold crossed, 14, 7, 3 and 1 days left and `threshold: 0` once ended, remembered across restarts; renew with a QR login, `zalo-agent --account <id> login` then a restart, or the fleet controller's QR add, which keeps the device id; once it has ended `account_state` `signed_out` follows; with a `publicUrl`, from 7 days before the end it carries a one-time renewal link, `renewUrl` with `renewExpiresAt`, and goes out again with each new link, see [renewing the saved login](#renewing-the-saved-login-sessionrenew)), `session_renewed` (the phone renewed the login through that link and the server uses it now: `{event, accountId, expiresAt, daysLeft, deviceKept, at}`) and, with `approval.deliver: "webhook"`, `approval_requested`. A message that arrives while the socket is parked is delivered on the next connect with `catchUp: true`. Route on `event` and ignore one you do not know.

**Hear: pull.** `GET /events/wait?timeout=55&since=<cursor>` returns every message already waiting in the buffer (`&limit=<n>` caps how many), or `{"status":"timeout"}`, with a cursor to resume from. The reply has `messages` (in order), `count`, `hasMore` and `cursor`, the **last** message's, so `since=<cursor>` continues exactly where the batch ended; `message` is the first. **Breaking in 3.0.0:** the default was one message per call; a client that reads only `message` and continues from `cursor` now skips the rest of the batch: read `messages`, or send `limit=1`. With a `limit`, drain a backlog by calling again at once while `hasMore` is true; `settle=200` (ms, at most 5000) waits that long after the first message so a burst lands in one reply. The same `limit` and `settleMs` exist on the `zalo_wait_for_message` tool and as `mcp wait --limit --settle`. The buffer behind it holds up to `limits.bufferMaxSize` messages per thread for `limits.bufferMaxAge` (the CRM sample raises both to 2,000 and 6 h). Past that, read the cache with `zalo_get_history` / `zalo_get_messages`.

**Send.** A JSON-RPC call to `POST /mcp`: [`clients/crm-send-message.sh`](config-samples/clients/crm-send-message.sh). Send `Accept: application/json, text/event-stream` (without both the server answers 406); the reply is one SSE `data:` line, and a successful send returns `{"success":true,"msgId":…,"cliMsgId":…,"threadType":…}`. `threadId` is a user id for a direct message or a group id for a group. Each `/mcp` request builds a fresh server with all 39 tools, which costs a few milliseconds of CPU: fine for a CRM, and the reason one account tops out at roughly 60–170 requests/s (see [`docs/deployment.md`](deployment.md) §1.4).

**Catch up.** After downtime, ask for what was missed: `zalo_get_history` per thread, or `zalo-agent sync --from <date>` (which can ask the owner's phone to confirm).

**Hidden chats and the secure input page.** The account's hidden chats are left out of everything a CRM reads (`hiddenChats: "exclude"`); `contentless` sends a webhook event `{event: "message", hidden: true, accountId}` with no thread id or content, the unread dot Zalo shows. Anything a person must type or approve (the hidden-chat PIN, a `confirmMode: "human"` approval) is a one-time page on the server's own port, `/zalo/secure/<token>`: the tool reply carries `secureUrl`, `ticketExpiresAt` (5 minutes) and `retryWith.ticket`; the CRM shows the link to the account owner and repeats the call with `ticket` once they are done. Route `/zalo/secure/` through the same proxy as `/mcp` and set `publicUrl` to its public address (links are never built from a request's `Host` header). The page needs no bearer token (its token is the key), sends `Cache-Control: no-store`, loads nothing from elsewhere, and its token is masked in the request log. See [`docs/deployment.md`](deployment.md) §5.6.

**Approvals in the CRM's own UI.** With `approval.deliver: "webhook"` the link never goes through the agent: the server POSTs `{event: "approval_requested", accountId, kind, action, wouldDo, target, secureUrl, expiresAt, approverSecret}` to the webhook (queued and signed like a message event), the CRM shows `wouldDo` and the link to a person, and the tool result carries only `{confirmationRequired or pinRequired: true, approvalPending: true, ticket, ticketExpiresAt, deliveredTo: "webhook"}`. The CRM repeats the call with that `ticket` once the person is done; the ticket is not the page's token, so nothing in the result opens the page. Where the link must go through the agent, set an approver password (`zalo-agent mcp approver set`) or `approval.secret: "pin"`, so the page asks for something only the person knows.

### 3.6 Many accounts

One account is one process, one WebSocket, one SQLite file and one port: there is no multi-account mode inside a process. Run one **systemd instance per account** with its own env file:

- [`systemd/zalo-mcp@.service`](config-samples/systemd/zalo-mcp@.service): the instance name is the account id; the token and port come from `/etc/zalo-mcp/accounts/<id>.env`, so nothing secret is on the command line. Instances spread their start-up inside the daemon (`ZALO_START_JITTER=30` in `common.env`: every start logs in and loads the account's lists; a fleet starting together is its heaviest moment) and each is capped at 600 MB (an idle one is about 100 MB). Its only `ReadWritePaths` is the service user's config dir; the key provider's passphrase comes from the drop-in [`systemd/credentials.conf`](config-samples/systemd/credentials.conf) (`LoadCredentialEncrypted=`).
- [`systemd/common.env`](config-samples/systemd/common.env) for what the units share (read by the units only: no paths in it), [`env/account.env`](config-samples/env/account.env) per account (its token, port and `ZALO_MCP_PUBLIC_URL`), and [`systemd/home.env`](config-samples/systemd/home.env), the service user's `~/.zalo-agent-cli/.env`: every command reads it, so the machine paths (`ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`) go there and a CLI run by hand opens the same files as the units.
- [`systemd/za`](config-samples/systemd/za): runs the CLI as the service user, with the units' home, `common.env` and credential; [`systemd/zalo-fleet-check.*`](config-samples/systemd/zalo-fleet-check.service) (`fleet status --check` every 5 minutes) and [`systemd/zalo-backup.*`](config-samples/systemd/zalo-backup.service) (nightly `db backup`); [`systemd/zalo-policy-audit.logrotate`](config-samples/systemd/zalo-policy-audit.logrotate).
- [`systemd/zalo-mcp-purge.service`](config-samples/systemd/zalo-mcp-purge.service) and [`systemd/zalo-mcp-purge.timer`](config-samples/systemd/zalo-mcp-purge.timer): `fleet purge --yes` every hour, so an account whose daemon is stopped still has its quota and retention purge (under its `daemon.lock`), and a daemon whose own timer is behind is asked to run it.
- **`zalo-agent fleet generate --out <dir>`** writes all of the above for the accounts named, or every registered one (units, timers, env files with a generated token each, `storage.json`, the drop-in, `za`, port table, and with `--domain` the Caddyfile and each account's public URL), and prints the install steps; `fleet status` shows every daemon in one table, `fleet start` / `restart` bring them up in shuffled batches, and `fleet restart --unhealthy` restarts only the ones that are down (see [`docs/deployment.md`](deployment.md) §4.8).
- **`zalo-agent fleet serve`** is the fleet controller for a CRM or console: one admin API per host (`/zalo/admin/accounts`: list, each with the account's own Zalo `name` and `phone` as its daemon last read them, start, stop, restart, presence wake/park/resume, a guarded logout and removal, the QR add of a new account, account jobs (`/zalo/admin/accounts/<ownId>/jobs`: a sync, an attachment download, a purge, run as this CLI), an SSE stream of `account_state` at `GET /zalo/admin/events`), behind the admin credential only, on `ZALO_FLEET_CONTROLLER_PORT` (default 3899), with `ZALO_FLEET_SUPERVISOR`, `ZALO_FLEET_DOMAIN`, `ZALO_FLEET_QR_FLOWS`, `ZALO_FLEET_JOBS` and `ZALO_FLEET_WEBHOOK[_SECRET]` from the table above; sample unit [`systemd/zalo-fleet-controller.service`](config-samples/systemd/zalo-fleet-controller.service). Under on-demand presence, `ZALO_CONNECT_SLOTS` (the samples set 16) keeps many accounts from waking at once.
- A port plan, e.g. `3900 + n`, kept in one table (`fleet ports` keeps it for you). Behind one hostname: [`proxy/Caddyfile.multi-account`](config-samples/proxy/Caddyfile.multi-account) routes `/a/<ownId>/…` to the right port; use bearer tokens, one per account.
- Give each account **its own proxy** at login (`zalo-agent login --proxy …`) and its own device fingerprint (automatic): hundreds of accounts from one address is what gets accounts banned.
- Shared settings in `mcp-config.json`, per-account differences in its `accounts` block ([`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json)).
- Read §1.4 and §3 of [`docs/deployment.md`](deployment.md) before going past a few dozen accounts.
- Whole sets per use case (desktop, LAN, VPS, CRM, SaaS), each with a README: [`config-samples/use-cases/`](config-samples/use-cases/).

---

## 4. Checklist before exposing a port

| Check | Why |
|---|---|
| a token is set (`ZALO_MCP_AUTH_TOKEN`), 32+ random bytes | with none, the server serves anyone who can reach it, and says so only in the log |
| the token is in an env file at `0600`, not in a flag | a flag shows in `ps` and `/proc/<pid>/cmdline`; the daemon's own log line masks it, `ps` does not |
| `ZALO_MCP_HOST` is `127.0.0.1` behind a proxy, a specific LAN address otherwise | `0.0.0.0` listens on every interface, including a public one |
| TLS terminates at the proxy, or `--cert`/`--key` are set | a bearer token over plain HTTP is readable on the wire |
| the proxy does not log `Authorization` and does not buffer `/events/wait` | tokens in logs; long-polls cut at the proxy's timeout |
| `GET /health` and `GET /ready` are the only unauthenticated routes | they say whether the process answers and whether it can serve the account (`/ready` is 200 while the socket is connected or parked, 503 while it is down, yielded or signed out), nothing about the account itself. `/status` and `/metrics` are behind the token: do not publish them through the proxy |
| one process per account, never two for the same account, and no browser login for an account a server holds | a second session of the same login closes the first (code 3000); a QR login into Zalo in a browser revokes the server's login (`signed_out`). The phone and the Zalo desktop app are fine |

## 5. Verify a setup

```bash
# up, and the token is enforced (expect 200, 401, 401):
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/health
# the account can be served (200 connected or parked; 503 down, yielded or signed out), and the detail is behind the token:
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/ready
curl -s -H "Authorization: Bearer $TOKEN" http://HOST:PORT/status | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp -H 'Authorization: Bearer wrong'

# the tools are served (expect 39 names):
curl -s http://HOST:PORT/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"zalo_[a-z_]*"' | wc -l

# the daemon, its log and its socket:
zalo-agent mcp start --account 1000000000000000001 --status
tail -f ~/.zalo-agent-cli/accounts/1000000000000000001/daemon.log   # when started with -d
```

## Notes

- Claude's custom connector form has cut a 64-character client secret short (the token request then fails with `invalid_client`): keep `ZALO_MCP_OAUTH_CLIENT_SECRET` at 40 characters or fewer, e.g. `openssl rand -hex 20`.
