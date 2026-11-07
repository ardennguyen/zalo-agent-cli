# Encryption at rest, and securing a server or SaaS deployment

[Tiếng Việt](security.vi.md)

Since 3.0.0 the files that hold a secret are encrypted on disk. This page says what is encrypted, how, what it protects you from and what it does not, which key provider to use where, and what to do after a leak. Running the service itself (systemd, backups, monitoring) is [deployment.md](deployment.md).

## 1. What is sealed

| File | Holds | Key |
|---|---|---|
| `credentials/cred_<ownId>.json` | the saved login: cookie, imei, user agent (full account takeover if read) | boot |
| `accounts/<ownId>/trusted-device.json` | the private key and linking secret of the device this CLI became at the official QR login | boot |
| `accounts/<ownId>/sync/open-sessions.json` | the phone's session ids of a history restore | data |
| `accounts/<ownId>/voice-text.json` | the text of transcribed voice messages | data |

**The message database** `accounts/<ownId>/zalo.db` (messages, conversations, contacts, the search index) is encrypted as a whole with SQLCipher v4 (AES-256-CBC with an HMAC-SHA512 per page, `cipher=sqlcipher, legacy=4`), keyed with a raw 256-bit subkey of the account's **data** key (`sqlcipher`), with `secure_delete` on so a deleted row is overwritten. Its write-ahead log (`zalo.db-wal`) is encrypted page by page as well. Opened without the key, by `sqlite3`, `better-sqlite3`, DB Browser for SQLite or a bot, it is `file is not a database`.

**The webhook outbox** `accounts/<ownId>/webhook-outbox.db` (the events waiting for, or refused by, the webhook receiver: message content) is encrypted the same way, under its own subkey of the data key (`outbox`). `mcp webhook status` / `list` / `retry` / `purge` read it with that key.

Each small file is a container: a magic `ZACSEAL`, a version, a JSON header (account, kind of file, key id, nonce) and AES-256-GCM ciphertext. The header is authenticated with the ciphertext, so an edited byte, a file copied over another account's or put in place of another kind of file does not open.

**Not sealed yet**, and why:

- `media/`: the rest of phase 2 moves it to encrypted media on the same keys. Until then they are protected by file modes (§4.2 of deployment.md, `UMask=0077`) and by disk encryption, which is not optional for company conversations.
- `daemon.log` at `debug` level holds one line per message, with its text. Keep the log level at `info` where that matters, and the log on an encrypted disk.
- `mcp-config.json`, the fleet's `accounts/<ownId>.env`: configuration an operator writes and systemd reads. Keep secrets out of them where you can: environment variables from systemd `LoadCredential=` / a secret manager, not values in a file.
- `daemon-channel.json`: a loopback token regenerated on every daemon start (0600); a copy is useless once the daemon stops.
- `dr-config.json`, `sock-anomaly.json`, `kicked.json`, `unknown-acts.json`, `hidden-pin-lockout.json`: numbers, times and codes, no secret. `hidden-threads.json` holds the ids of hidden conversations (no PIN): phase 2.
- The Official Account's `~/.zalo-agent/oa-credentials.json`: a separate API with its own directory, not covered by this release.

## 2. How the keys are arranged

```
key provider (DPAPI / keychain / Secret Service / systemd-creds / KMS / passphrase / env)
  └─ master key                       accounts/<ownId>/keyring.json, provider.wrapped
       ├─ boot key                    opens what a login needs: the saved login, the device identity
       └─ data key                    everything else, and phase 2's subkeys (sqlcipher, media, row-mac, outbox)
            └─ dkey layer (optional)  also wrapped under a key derived from the account's dkey
```

- **One keyring per account**, in the account's folder. Removing the account (`account remove`, `logout --purge`) removes its keys, so a sealed file that survives somewhere (a backup, a disk image) is noise. A SaaS can give each tenant its own KMS key, and `rekey` or `provider` changes touch one account.
- **Keys are only ever stored wrapped.** The keyring holds no raw key; unwrapped keys live in the process's memory and are never logged or written. `account security status` shows key ids and dates, never key material.
- **Fail closed.** No provider, a wrong key, an edited file: the command stops and says why. Nothing falls back to plaintext or to a key kept next to the data. A 2.x CLI cannot read the sealed files.
- **Cost.** The provider runs once per process per account. Measured on Windows 11: a DPAPI unwrap through Windows PowerShell takes about 0.4 s (0.5 s with PowerShell 7); every later file in that process is microseconds. A daemon pays it once at start.

## 3. What it protects, and what it does not

At-rest encryption protects data **at rest**: a stolen disk or laptop image, a backup that leaked, a file copied off the machine, another (non-admin) user on the same machine reading files they should not. It also turns "delete the account" into "the data is unreadable everywhere", because the keys go with it.

It does **not** protect against a live compromise of the account the service runs as. Anything that runs as that user can ask the provider for the key exactly as the CLI does (DPAPI, the keychain, systemd-creds, the instance's KMS role): malware on a desktop session, a shell on the server, a dependency that turned hostile. Administrators/root can do the same (LocalMachine DPAPI, the systemd host key, process memory). The dkey layer narrows this a little (the data key also needs a live login) but does not close it: an attacker who runs as the service can log in as the service does. Encryption at rest is one layer; the others are a dedicated service account, least privilege, patching and monitoring.

## 4. Choosing a provider

The default is chosen by platform. Change it in `<config-dir>/storage.json` (or `ZALO_STORAGE_PROVIDER`), then run `account security provider <name>` to move existing keyrings. Ready-made files per deployment are in [`docs/config-samples/storage/`](config-samples/storage/): `windows.json`, `windows-service.json`, `macos.json`, `linux-server.json`, `saas-kms.json`.

| Where | Provider | Notes |
|---|---|---|
| Windows desktop | `dpapi` (default, CurrentUser) | Bound to the Windows user: another user, or the same files on another machine, cannot open them. |
| Windows Server, service | `dpapi`, CurrentUser, under a **dedicated service account** (a gMSA or virtual account) | Do the QR login *as that account* (or run `account security provider dpapi` as it), or the service cannot open what an admin sealed. `--scope LocalMachine` only when several identities must share the files: then any process on the machine can unwrap them. |
| macOS | `keychain` (default) | A random key-encryption key in the login keychain; the keychain may ask to allow access the first time. |
| Linux desktop | `secret-service` (default when a session bus and `secret-tool` exist) | GNOME Keyring / KWallet. A locked keyring is reported as such. |
| Linux server | `systemd-creds` | `systemd-creds encrypt` with the host key and/or TPM2 (`"systemdCreds": {"withKey": "tpm2"}`). Needs root, or `"user": true` with systemd 256+ for a user service. With no desktop keyring and nothing configured, the CLI **refuses** and names these options. |
| Linux server, no systemd-creds | `passphrase` | scrypt from a passphrase in a file (`"passphrase": {"file": "/path"}`; under systemd, `LoadCredential=zalo-storage-passphrase:/path` is picked up from `$CREDENTIALS_DIRECTORY` with no setting) or typed at a prompt (desktop). If the file sits next to the data, it protects nothing: keep it on another volume or in the service manager. |
| Cloud, SaaS | `kms` | AWS KMS, Google Cloud KMS, Azure Key Vault, HashiCorp Vault transit, reached through the machine's identity (instance role, workload identity, managed identity, Vault agent). Use a key per tenant (or per account), restrict decrypt to the service's identity, and keep the audit log: every unwrap is a logged KMS call. Disabling the key is a crypto-shred. Install the SDK next to the CLI (`npm i -g @aws-sdk/client-kms`, `@google-cloud/kms`, or `@azure/identity @azure/keyvault-keys`; Vault needs none). **Not yet verified against the live services in this release**: the calls follow each SDK's documented shape and are tested with fakes. |
| Anything else | `env` | The key (32 random bytes, base64) in `ZALO_STORAGE_KEY`. Only when configured explicitly, and every start warns: the key is as safe as the process environment and the file that sets it, which on most hosts is close to plaintext next to the data. |

`storage.json` (no secret in it):

```json
{
  "provider": "kms",
  "kms": { "backend": "aws", "key": "arn:aws:kms:<region>:<account>:key/<id>", "region": "<region>" },
  "dkeyLayer": false,
  "accounts": { "<ownId>": { "dkeyLayer": true } }
}
```

Environment variables (they win over the file, so a fleet's per-account env file can set one account apart): `ZALO_STORAGE_PROVIDER`, `ZALO_STORAGE_DKEY_LAYER` (`1`/`0`), `ZALO_DPAPI_SCOPE`, `ZALO_SYSTEMD_CREDS_WITH_KEY`, `ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`, `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_STORAGE_KEY` (env provider only). For Vault: `VAULT_ADDR`, `VAULT_TOKEN` (or `"kms": {"tokenFile": …}`), `VAULT_NAMESPACE`.

## 5. The dkey layer (optional, off by default)

Zalo's login reply carries `dkey`, a 32-character constant per account that Zalo PC uses to open its own encrypted message databases. With `"dkeyLayer": true` (or `ZALO_STORAGE_DKEY_LAYER=1`) the account's **data key** is wrapped a second time under a key derived from it (HKDF-SHA256 with a per-account salt): opening it needs **both** the machine's provider and a live login. The dkey itself is never stored or logged; only the derived key is held in memory.

- **What it adds:** a copied disk, with the provider's secret too (a stolen DPAPI master key, a leaked passphrase), still reads nothing of the data without logging in to Zalo as the account.
- **What it costs:** no offline reads. A long-running `listen` / `mcp start` / fleet daemon unlocks once after its login and keeps the key in memory. A one-shot command that reads local data logs in first (most already do); when Zalo cannot be reached (offline, Zalo down) it says that the data is locked and why.
- **What it does not cover:** the saved login and the device identity stay under the boot key only: they must open *before* the login that brings the dkey. That is how Zalo PC works too: its session cookie is protected by the OS (DPAPI), its databases by the dkey.
- **dkey is an account constant held by Zalo.** Signing a device out from the phone, or a new QR login, does not change it. It protects against someone without the account, not against Zalo or someone who controls the account.
- Turning it on or off takes effect at the account's next login (or `account security migrate`, which logs in once).

## 6. Migration and the commands

- **First run of 3.0.0:** a command that reads a plaintext file seals it in place; every login seals the rest of its account. Sealing writes the sealed copy beside the file, reads it back and opens it, compares, and only then renames it over the plaintext, so a crash at any point leaves one readable copy. It is idempotent.
- **The message database** is encrypted by the first 3.0.0 command that opens it to write (any command that reads the cache does). It is checkpointed and held against other writers, copied to `zalo.db.encrypting`, the copy is encrypted in place and verified (`quick_check`, the row count of every table, no plaintext header), renamed to `zalo.db.encrypted`, swapped in, and only then is the plaintext overwritten with zeros and removed, with its `-wal` and `-shm`. **No plaintext copy is kept.** A crash at any step is finished or undone by the next open, so there is always one readable database. It takes about 1 s per 20 MB (a 190 MB cache took 10 s, measured on Windows 11), needs free disk of about 1.1× the database, and is told on stderr. It refuses while another process holds the account's `daemon.lock` (stop an older daemon first), and on Windows the swap fails while any other process has `zalo.db` open, which it says. A read-only opener never migrates: it stops with `PLAINTEXT` and names `account security migrate`.
- **The webhook outbox** is encrypted by the first 3.0.0 writer that opens it (the daemon with `-w`, `mcp webhook retry` / `purge`, or `account security migrate`). One with nothing queued and nothing dead-lettered holds only counters: it is overwritten, removed and recreated encrypted. One with a backlog is copied, encrypted and verified like the message database, so no queued event is lost. `mcp webhook status` and `list` only read: on a plaintext outbox they stop with `PLAINTEXT` and name `account security migrate`.
- `account security status [ownerId] [--all]`: provider, dkey layer (configured / active), keyring version and dates, which files are sealed, and the message database and the webhook outbox as `encrypted` (with the key id that opens it), `plaintext`, `locked` or `absent`. Never key material.
- `account security migrate [ownerId] [--all]`: seal what is still plaintext, encrypt the message database and the webhook outbox, and apply the dkey setting now.
- `account security rekey [ownerId]`: new keys, every file re-sealed and the message database and the webhook outbox re-encrypted in place under the new data key (`PRAGMA rekey`, about 2 s for a 50 MB cache, `-wal` included). The old keys stay in the keyring, retired, until every file and every database is done: a database still opens under a retired key in the meantime, and an interrupted rekey (a crash, a store that failed) is finished by running it again. A database already under the current key is left alone. Its reply lists each database and whether it is under the new key.
- `account security provider <name> [ownerId]`: re-wrap the keys for another provider (the files are not touched) and make it the default.
- There is **no way back to plaintext**. `account export --yes` still writes the saved login to a JSON file exactly as before (without `--yes` it writes nothing and exits 2): it is the deliberate way to move a login to another machine; treat that file as the login itself.

All but `status` refuse while a `listen` / `mcp start` daemon holds the account (it holds the keys in memory).

## 7. Operating a server

- **A dedicated service account**, never root or Administrator, owning the config directory alone (`UMask=0077`). Log in, migrate and run as that account.
- **Disk encryption** (BitLocker, LUKS, the cloud provider's volume encryption) under all of it: media is not encrypted yet, the shredding of the old plaintext database is best effort (an SSD or a copy-on-write filesystem can keep the old blocks, and so can earlier backups and snapshots), and logs at `debug` hold message text.
- **Backups:** keep `accounts/<ownId>/keyring.json` in the same backup as `credentials/` and `zalo.db`. Without the keyring neither the credentials nor the message database can be opened; without the provider (the same machine for DPAPI/systemd-creds, the same KMS key, the same passphrase) neither can. Plan disaster recovery as a new QR login, or use a KMS key the recovery site can reach.
- Each `account remove` / `logout --purge` deletes the keyring with the account, and a keychain / Secret Service item with it.

## 8. After a leak

1. **Revoke the device on the phone** (Zalo → Settings → Account and security → logged-in devices). This ends the login at Zalo; nothing on the server can.
2. `zalo-agent logout --purge` (or `account remove`) on every machine that held the account: this deletes the credentials, the data and the keyring.
3. If the machine stays in service: a new QR login, then `account security rekey` (new keys) and, if the provider's secret may have leaked, `account security provider` to a new one (a new KMS key, a new passphrase).
4. Rotate whatever else the host held: MCP bearer tokens, webhook secrets, OA tokens.
5. Remember what the dkey layer cannot do here: the dkey does not change when a device is revoked, so data copied together with a working login stays readable to whoever has both.
