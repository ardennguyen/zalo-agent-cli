# Moving two accounts from a Windows 2.5.9 home to the VPS

[Tiếng Việt](MIGRATE.vi.md) · The VPS setup: [README.md](README.md)

This keeps each account's **message history and media** and its **device identity** (the phone keeps seeing the same device). It works because a 2.5.9 home is **plaintext**: nothing in it is tied to Windows, and the VPS seals it under its own passphrase on the first run.

> [!CAUTION]
> **Two copies of the same saved login must never run at the same time.** The Windows home and the VPS hold the same login after the copy; the moment both connect, their two sockets kick each other off (an always-on daemon exits 3, an on-demand one yields and refuses every request) and keep doing so. Stop everything on Windows first, and never start a listener for these accounts there again.

## 1. Before you start

- The VPS is set up through step 4 of [README.md](README.md): the `zalo` user, the engine, `za`, `storage.json` (`"provider": "passphrase"`) and `/etc/zalo-mcp/storage-passphrase.cred`. Do not log in on the VPS: the accounts come from Windows.
- Free disk on the VPS: about 1.1 times the size of the two account folders (the encryption writes a copy before it replaces the database).
- **Run no 3.0 command on Windows before the copy.** A 3.0 command seals the files with Windows DPAPI, and DPAPI-sealed files do not open on another machine. Check what Windows runs: `zalo-agent --version` must print `2.5.9`. Sealing is one-way: once a 3.0 command has run on a home, no command turns it back into a 2.5.x one, so the copy you take in section 3 (step 1) is your only way back.

## 2. If Windows already ran 3.0

Then its files are sealed under DPAPI. Re-wrap them for the **same** storage passphrase as the VPS, on Windows, **before** the copy:

```powershell
# a file holding the VPS passphrase, readable by you only; delete it right after
zalo-agent account security provider passphrase --passphrase-file C:\Users\<you>\zalo-pass.txt
Remove-Item C:\Users\<you>\zalo-pass.txt
zalo-agent account security status --all          # provider: passphrase, for both accounts
```

The keyring is now wrapped by the passphrase instead of DPAPI, so the copied folders open on the VPS. Then go on with section 3.

## 3. Copy

1. **Stop everything on Windows** that uses these accounts: `zalo-agent listen --stop`, `zalo-agent mcp start --stop` for each account, quit Claude Desktop, Claude Code and any `zalo-mcp` service, and close any browser tab with Zalo open. Back up `%USERPROFILE%\.zalo-agent-cli` as it is.
2. **Pack only what moves** (PowerShell; `tar` ships with Windows 10 and later). Replace the two ids with yours:
   ```powershell
   cd $env:USERPROFILE\.zalo-agent-cli
   tar -czf $env:USERPROFILE\zalo-move.tgz `
     --exclude=daemon.lock --exclude=daemon-channel.json --exclude=qr.png `
     accounts.json credentials\cred_1000000000000000001.json credentials\cred_1000000000000000002.json `
     accounts\1000000000000000001 accounts\1000000000000000002
   ```
   Do not take `mcp-config.json` (it may hold Windows paths): the VPS uses the one from this folder.
3. **Encrypt it** before it leaves the machine (it holds two live logins and every message in plaintext): `7z a -p -mhe=on zalo-move.7z zalo-move.tgz` (or `age -p`), then delete `zalo-move.tgz`.
4. **Copy it** to the VPS: `scp zalo-move.7z admin@your-vps:/tmp/`.

## 4. Unpack and seal on the VPS

```bash
cd /tmp && 7z x zalo-move.7z && rm zalo-move.7z
sudo tar -xzf /tmp/zalo-move.tgz -C /home/zalo/.zalo-agent-cli
sudo chown -R zalo:zalo /home/zalo/.zalo-agent-cli && sudo chmod -R go-rwx /home/zalo/.zalo-agent-cli
shred -u /tmp/zalo-move.tgz
za account list                                   # both accounts
za account security migrate --all                 # seals every file and encrypts zalo.db (about 1 s per 20 MB)
za account security status --all                  # everything sealed / encrypted, provider passphrase
```

`tar` from Windows writes backslash paths as forward ones; if `za account list` shows nothing, check that `accounts.json` landed in `/home/zalo/.zalo-agent-cli/`, not in a subfolder.

Then continue with step 6 of [README.md](README.md) (`za fleet generate`, install, start).

## 5. After the move

- **On Windows, drop the saved logins without ending them** (a plain `logout` would end the very session the VPS now uses):
  ```powershell
  zalo-agent logout --no-remote --account 1000000000000000001
  zalo-agent logout --no-remote --account 1000000000000000002
  ```
  (If Windows already runs 3.0, `logout` is guarded: add `--yes`.)
  Then delete the encrypted archive and, once the VPS has run a few days, the old Windows folders.
- **Zalo may challenge a login that moves** from a home address to a datacenter one. If an account goes `signed_out` (`za presence status` or `journalctl -u zalo-mcp@<id>` says the login was refused; the daemon stays up and refuses requests), log that account in again on the VPS with `za login` (QR over the SSH tunnel), then `sudo systemctl restart zalo-mcp@<id>`; its history stays.
- **Keep using the phone or the Zalo desktop app** next to the server. Logging the account into **Zalo in a browser** signs the server out (one web login per account).

## 6. Other ways, and why not

| Way | History | Device | When |
|---|---|---|---|
| Copy the 2.5.9 home (this page) | kept | same | the default |
| `account export` on Windows, `za login --credentials <file>` on the VPS | **not kept** (a phone-tapped `sync` restores far less than the Windows machine's store) | same | a companion whose history does not matter |
| New QR login on the VPS, then drop the old `zalo.db` and `media/` into the new account folder before its first start, and `za account security migrate --all` | kept | new | you want a fresh device entry |
| Upgrade Windows to 3.0, then copy | only after section 2 | same | avoid |
