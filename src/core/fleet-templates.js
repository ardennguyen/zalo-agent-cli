/**
 * The files `zalo-agent fleet generate` writes: a systemd template unit (one instance per account, the
 * instance name IS the account id), the shared and per-account env files, the home `.env` every command
 * reads, the key provider's `storage.json` and the systemd credential drop-in that hands it its passphrase,
 * the maintenance units (purge, health check, nightly backup) and their timers, the polkit rule, the `za`
 * operator wrapper, a logrotate rule for policy-audit.log, and a Caddy reverse proxy with a path per account.
 *
 * They are the same files as docs/config-samples/ (the docs are not shipped in the npm package, the CLI
 * is), and a test holds the two together: change one and the other fails until it follows.
 *
 * One rule ties them: every path a daemon writes is in its unit's `ReadWritePaths`, and every machine path
 * (`ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`) is set in `<home>/.zalo-agent-cli/.env`, the file every zalo-agent
 * command reads (the units, and `za` by hand), never in common.env, which only the units read.
 */

/** What the files assume unless the caller says otherwise. */
export const FLEET_DEFAULTS = Object.freeze({
    user: "zalo",
    home: "/home/zalo",
    bin: "/usr/bin/zalo-agent",
    etcDir: "/etc/zalo-mcp",
    dataDir: null,
    mediaDir: null,
    backupDir: "/var/backups/zalo",
    provider: "passphrase",
});

/** The key providers `fleet generate --provider` wires; `none` leaves storage.json and the credential to you. */
export const FLEET_PROVIDERS = Object.freeze(["passphrase", "systemd-creds", "kms", "none"]);

/** The systemd credential name the passphrase provider reads from `$CREDENTIALS_DIRECTORY` with no setting. */
export const PASSPHRASE_CREDENTIAL = "zalo-storage-passphrase";

/** The units that open an account's keyed files, and so get the credential drop-in. */
export const KEYED_UNITS = Object.freeze(["zalo-mcp@.service", "zalo-mcp-purge.service", "zalo-backup.service"]);

const resolve = (o) => ({
    ...FLEET_DEFAULTS,
    ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)),
});

/**
 * Every directory the daemons write: the config dir, plus a data or media dir that is not inside it.
 * @param {typeof FLEET_DEFAULTS} v
 * @returns {string[]}
 */
export function writablePaths(v) {
    const cfg = `${v.home}/.zalo-agent-cli`;
    const out = [cfg];
    for (const p of [v.dataDir, v.mediaDir]) {
        if (p && p !== cfg && !p.startsWith(`${cfg}/`) && !out.includes(p)) out.push(p);
    }
    return out;
}

/** The common substitutions: user, home, binary, /etc dir, and the writable paths line. */
function substitute(text, v, extraRw = []) {
    return text
        .replaceAll("User=zalo", `User=${v.user}`)
        .replaceAll("Group=zalo", `Group=${v.user}`)
        .replaceAll("/home/zalo", v.home)
        .replaceAll("/usr/bin/zalo-agent ", `${v.bin} `)
        .replaceAll("/etc/zalo-mcp", v.etcDir)
        .replace(/^ReadWritePaths=.*$/m, () => `ReadWritePaths=${[...writablePaths(v), ...extraRw].join(" ")}`);
}

export const UNIT_TEMPLATE = `# /etc/systemd/system/zalo-mcp@.service
# One instance per Zalo account: the instance name IS the account id.
#   systemctl enable --now zalo-mcp@<ownId>
#   journalctl -u zalo-mcp@<ownId> -f
#
# Each instance reads /etc/zalo-mcp/common.env, then /etc/zalo-mcp/accounts/<id>.env
# (\`zalo-agent fleet generate\` writes both). The account's token and port come from
# that file, so neither appears on the command line (\`ps\` shows only \`mcp start --account <id>\`).
# The key provider's passphrase comes from the drop-in zalo-mcp@.service.d/credentials.conf.
# Stop, start and restart an account with systemctl (or \`za fleet stop|start|restart\`, which
# drives systemctl for an account that runs here): a daemon started beside its unit fights it.
[Unit]
Description=Zalo MCP server for account %i
Documentation=https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/deployment.md
After=network-online.target
Wants=network-online.target
# A duplicate-session exit (exit code 3) means another web session took the
# account; cap the restart loop and alert on \`failed\` instead of fighting it.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=zalo
Group=zalo
WorkingDirectory=/home/zalo
UMask=0077
EnvironmentFile=/etc/zalo-mcp/common.env
EnvironmentFile=/etc/zalo-mcp/accounts/%i.env
Environment=NODE_ENV=production
Environment=ZALO_AGENT_NO_UPDATE_CHECK=1

# Refuse to start with no token (an empty one would serve unauthenticated).
ExecStartPre=/usr/bin/test -n "\${ZALO_MCP_AUTH_TOKEN}"
# A fleet starting together is the heaviest moment of its life (every start logs in and loads
# the account's friend and group lists): ZALO_START_JITTER and ZALO_LOGIN_SLOTS in common.env
# spread it inside the daemon (see docs/deployment.md §1.4).
ExecStart=/usr/bin/zalo-agent mcp start --account %i

# SIGINT is the shutdown signal mcp start handles; with the default SIGTERM the
# daemon exits without stamping its last-connected time or releasing its lock.
KillSignal=SIGINT
TimeoutStopSec=30
Restart=always
RestartSec=15
# Exit 3 means another session took the account; exit 4 means Zalo keeps refusing the saved
# login. A restart fixes neither (it would evict the other session again, or be refused
# again), so the unit stays down and enters \`failed\` for your alert to catch.
RestartPreventExitStatus=3 4

StandardOutput=journal
StandardError=journal
SyslogIdentifier=zalo-mcp-%i

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
# Every path the daemon writes, and nothing else. The data lives under the config dir unless
# ZALO_DATA_DIR / ZALO_MEDIA_DIR in /home/zalo/.zalo-agent-cli/.env move it; then the new
# folder goes here too (\`fleet generate --data-dir / --media-dir\` writes both). A folder named
# here must exist, or the unit fails to start (status 226/NAMESPACE).
ReadWritePaths=/home/zalo/.zalo-agent-cli
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# One instance's footprint is about 100 MB at rest; cap a runaway one.
MemoryMax=600M

[Install]
WantedBy=multi-user.target
`;

/**
 * The unit with the caller's user, home, binary, /etc dir and writable paths.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderUnit(o = {}) {
    return substitute(UNIT_TEMPLATE, resolve(o));
}

export const CREDENTIALS_DROPIN_TEMPLATE = `# /etc/systemd/system/zalo-mcp@.service.d/credentials.conf
# The same file goes in zalo-mcp-purge.service.d/ and zalo-backup.service.d/ (every unit that opens
# an account's sealed files), and \`za\` passes the same line to systemd-run.
#
# The storage passphrase of the key provider "passphrase" (storage.json in the service user's
# config dir). At rest it is /etc/zalo-mcp/storage-passphrase.cred, encrypted by root with
# \`systemd-creds encrypt\` under this machine's host key; at each start systemd decrypts it into
# $CREDENTIALS_DIRECTORY/zalo-storage-passphrase, a file only this service can read, where the
# provider finds it with no further setting. This works for User=zalo on systemd 250 and later
# (Ubuntu 24.04 ships 255), because systemd itself (root) does the decryption; the
# "systemd-creds" provider would need the service user to decrypt, which systemd 255 allows only
# root (\`systemd-creds --user\` arrived in 256).
#   sudo install -d -m 755 /etc/systemd/system/zalo-mcp@.service.d
#   sudo install -m 644 credentials.conf /etc/systemd/system/zalo-mcp@.service.d/
#   sudo -v && systemd-ask-password -n "Storage passphrase:" \\
#     | sudo systemd-creds encrypt --with-key=host --name=zalo-storage-passphrase - /etc/zalo-mcp/storage-passphrase.cred
# Keep the passphrase in your password manager: with it, a backup opens on a new machine.
[Service]
LoadCredentialEncrypted=zalo-storage-passphrase:/etc/zalo-mcp/storage-passphrase.cred
`;

/**
 * The credential drop-in with the caller's /etc dir.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderCredentialsDropin(o = {}) {
    return substitute(CREDENTIALS_DROPIN_TEMPLATE, resolve(o));
}

export const PURGE_SERVICE_TEMPLATE = `# /etc/systemd/system/zalo-mcp-purge.service
# The quota and retention purge for every account on this machine, run by zalo-mcp-purge.timer.
# Each running zalo-mcp@<id> purges on its own timer (retention.purgeEvery). This covers an account
# whose daemon is stopped (its grace period still runs out, under its daemon.lock) and asks a daemon
# whose timer is behind (no check within purgeEvery x 2) to run it now.
#   systemctl enable --now zalo-mcp-purge.timer
#   journalctl -u zalo-mcp-purge
# Per-account retention variables (ZALO_RETENTION_MEDIA_<id>) count here only from common.env; the
# runtime policy (zalo-agent policy set, the admin API) counts everywhere.
# Cron instead of the timer:  17 * * * *  zalo  /usr/bin/zalo-agent fleet purge --yes
[Unit]
Description=Zalo MCP quota and retention purge (every account on this machine)
Documentation=https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/configuration.md

[Service]
Type=oneshot
User=zalo
Group=zalo
WorkingDirectory=/home/zalo
UMask=0077
EnvironmentFile=/etc/zalo-mcp/common.env
Environment=NODE_ENV=production
Environment=ZALO_AGENT_NO_UPDATE_CHECK=1
ExecStart=/usr/bin/zalo-agent fleet purge --yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=zalo-mcp-purge

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/zalo/.zalo-agent-cli
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=600M
`;

export const PURGE_TIMER_TEMPLATE = `# /etc/systemd/system/zalo-mcp-purge.timer
# Runs zalo-mcp-purge.service every hour at a random minute, and once after a boot that missed a run.
#   systemctl enable --now zalo-mcp-purge.timer
#   systemctl list-timers zalo-mcp-purge.timer
[Unit]
Description=Hourly Zalo MCP quota and retention purge

[Timer]
OnCalendar=hourly
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * The purge service with the caller's user, home, binary, /etc dir and writable paths (the timer takes none).
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderPurgeService(o = {}) {
    const v = resolve(o);
    return substitute(PURGE_SERVICE_TEMPLATE.replaceAll("  zalo  /usr/bin/zalo-agent ", `  ${v.user}  ${v.bin} `), v);
}

export const CHECK_SERVICE_TEMPLATE = `# /etc/systemd/system/zalo-fleet-check.service
# The health check of every account on this machine, run by zalo-fleet-check.timer every 5 minutes:
# \`fleet status --check\` exits 1 unless every account is ok, idle or degraded, and the unit then
# shows in \`systemctl --failed\`. Add OnFailure= to be told: a unit of yours that mails, posts to
# ntfy or calls a webhook (it gets the failed unit's name as %i).
#   systemctl enable --now zalo-fleet-check.timer
#   journalctl -u zalo-fleet-check        (the last table)
# It reads the registry and asks each daemon over its loopback channel: no key, no Zalo traffic.
[Unit]
Description=Zalo MCP fleet health check (fleet status --check)
Documentation=https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/deployment.md
# OnFailure=notify-admin@%n.service

[Service]
Type=oneshot
User=zalo
Group=zalo
WorkingDirectory=/home/zalo
UMask=0077
EnvironmentFile=/etc/zalo-mcp/common.env
Environment=NODE_ENV=production
Environment=ZALO_AGENT_NO_UPDATE_CHECK=1
ExecStart=/usr/bin/zalo-agent fleet status --check

StandardOutput=journal
StandardError=journal
SyslogIdentifier=zalo-fleet-check

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/zalo/.zalo-agent-cli
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=300M
`;

export const CHECK_TIMER_TEMPLATE = `# /etc/systemd/system/zalo-fleet-check.timer
# Runs zalo-fleet-check.service 5 minutes after boot, then every 5 minutes.
#   systemctl enable --now zalo-fleet-check.timer
#   systemctl list-timers zalo-fleet-check.timer
[Unit]
Description=Zalo MCP fleet health check every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
`;

/**
 * The health-check service with the caller's user, home, binary, /etc dir and writable paths.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderCheckService(o = {}) {
    return substitute(CHECK_SERVICE_TEMPLATE, resolve(o));
}

export const BACKUP_SERVICE_TEMPLATE = `# /etc/systemd/system/zalo-backup.service
# The nightly backup, run by zalo-backup.timer: for each account, \`db backup\` (an encrypted,
# verified copy of zalo.db, written beside the daemon without stopping it) and its keyring.json;
# then the config dir without the databases, media and runtime files (saved logins, keyrings,
# policies, accounts.json, storage.json and mcp-config.json, all sealed or free of keys but the last
# two). Copies older than 14 days are deleted. Copy /var/backups/zalo off the machine yourself.
# None of it opens without the storage passphrase, which is NOT in the backup: keep it in your
# password manager.
#   sudo install -d -m 700 -o zalo -g zalo /var/backups/zalo
#   systemctl enable --now zalo-backup.timer
#   journalctl -u zalo-backup
[Unit]
Description=Zalo MCP nightly backup (db backup per account, and the config dir)
Documentation=https://github.com/ardennguyen/zalo-agent-cli/blob/main/docs/deployment.md

[Service]
Type=oneshot
User=zalo
Group=zalo
WorkingDirectory=/home/zalo
UMask=0077
EnvironmentFile=/etc/zalo-mcp/common.env
Environment=NODE_ENV=production
Environment=ZALO_AGENT_NO_UPDATE_CHECK=1
Environment=BACKUP_DIR=/var/backups/zalo
ExecStart=/bin/sh -c 'rc=0; at=$$(date -u +%%Y%%m%%dT%%H%%M); for d in /home/zalo/.zalo-agent-cli/accounts/*/; do a=$$(basename "$$d"); [ -f "$$d/zalo.db" ] || continue; /usr/bin/zalo-agent --account "$$a" db backup --out "$$BACKUP_DIR/$$a-$$at.db" && cp -p "$$d/keyring.json" "$$BACKUP_DIR/$$a-$$at.keyring.json" || rc=1; done; exit $$rc'
ExecStart=/bin/sh -c 'tar -C /home/zalo -czf "$$BACKUP_DIR/config-$$(date -u +%%Y%%m%%dT%%H%%M).tgz" --exclude="zalo.db*" --exclude=media --exclude=tmp --exclude=login-slots --exclude=qr-flows --exclude=daemon.lock --exclude=daemon-channel.json --exclude="daemon.log*" --exclude=qr.png --exclude="webhook-outbox.db*" .zalo-agent-cli'
ExecStartPost=/usr/bin/find /var/backups/zalo -maxdepth 1 -type f -mtime +14 -delete

StandardOutput=journal
StandardError=journal
SyslogIdentifier=zalo-backup

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/zalo/.zalo-agent-cli /var/backups/zalo
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=600M
`;

export const BACKUP_TIMER_TEMPLATE = `# /etc/systemd/system/zalo-backup.timer
# Runs zalo-backup.service every night between 03:00 and 03:30, and once after a boot that missed it.
#   systemctl enable --now zalo-backup.timer
#   systemctl list-timers zalo-backup.timer
[Unit]
Description=Nightly Zalo MCP backup

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * The backup service with the caller's user, home, binary, /etc dir, writable paths and backup folder.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderBackupService(o = {}) {
    const v = resolve(o);
    const text = BACKUP_SERVICE_TEMPLATE.replaceAll("/var/backups/zalo", v.backupDir);
    return substitute(v.dataDir ? text.replaceAll("/home/zalo/.zalo-agent-cli/accounts/", `${v.dataDir}/`) : text, v, [
        v.backupDir,
    ]);
}

export const POLKIT_RULE_TEMPLATE = `// /etc/polkit-1/rules.d/50-zalo-fleet.rules
// Lets the service user "zalo" (the fleet controller, and \`za fleet stop|start|restart\`) start, stop
// and restart the zalo-mcp@<id> units, and nothing else: no other unit, no enable/disable, no
// daemon-reload. Ubuntu 24.04 reads JavaScript rules (polkitd 124; \`apt install polkitd\` if absent).
polkit.addRule(function (action, subject) {
    if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== "zalo") return polkit.Result.NOT_HANDLED;
    var unit = action.lookup("unit");
    var verb = action.lookup("verb");
    if (/^zalo-mcp@[1-9][0-9]{0,30}\\.service$/.test(unit) && (verb === "start" || verb === "stop" || verb === "restart")) {
        return polkit.Result.YES;
    }
    return polkit.Result.NOT_HANDLED;
});
`;

/**
 * The polkit rule for the caller's service user.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderPolkitRule(o = {}) {
    const v = resolve(o);
    return POLKIT_RULE_TEMPLATE.replaceAll('"zalo"', `"${v.user}"`);
}

export const ZA_TEMPLATE = `#!/bin/sh
# /usr/local/bin/za -- run zalo-agent as the service user "zalo", the way the units run it: the same
# home (/home/zalo/.zalo-agent-cli and its .env), the same /etc/zalo-mcp/common.env, and the storage
# passphrase systemd decrypts from /etc/zalo-mcp/storage-passphrase.cred. A command run any other
# way (as root, as you, or with another HOME) opens another config dir, or none, and finds no account.
#   sudo install -m 755 za /usr/local/bin/za
#   za account list      za login      za fleet status      za db backup --out /var/backups/zalo/x.db
# It asks for sudo (systemd-run starts a one-off service as zalo). Give paths absolute: the command
# runs in /home/zalo, a file it reads must be readable by zalo, and a file it writes is owned by zalo.
# Never \`za mcp start\` for an account whose unit runs: two copies of one login kick each other.
set -eu
if [ -t 0 ] && [ -t 1 ]; then io=--pty; else io=--pipe; fi
exec sudo systemd-run --quiet --wait --collect "$io" \\
    --property=User=zalo --property=Group=zalo \\
    --property=WorkingDirectory=/home/zalo --property=UMask=0077 \\
    --property=EnvironmentFile=-/etc/zalo-mcp/common.env \\
    --property=LoadCredentialEncrypted=zalo-storage-passphrase:/etc/zalo-mcp/storage-passphrase.cred \\
    --setenv=NODE_ENV=production --setenv=ZALO_AGENT_NO_UPDATE_CHECK=1 \\
    /usr/bin/zalo-agent "$@"
`;

/**
 * The `za` wrapper for the caller's user, home, binary, /etc dir and provider (no credential line unless the
 * provider is the passphrase).
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderZa(o = {}) {
    const v = resolve(o);
    let text = ZA_TEMPLATE.replaceAll('"zalo"', `"${v.user}"`)
        .replaceAll("User=zalo", `User=${v.user}`)
        .replaceAll("Group=zalo", `Group=${v.user}`)
        .replaceAll("as zalo", `as ${v.user}`)
        .replaceAll("by zalo", `by ${v.user}`)
        .replaceAll("/var/backups/zalo", v.backupDir)
        .replaceAll("/home/zalo", v.home)
        .replaceAll("/usr/bin/zalo-agent ", `${v.bin} `)
        .replaceAll("/etc/zalo-mcp", v.etcDir);
    if (v.provider !== "passphrase") {
        text = text
            .replace(/^.*LoadCredentialEncrypted=.*\n/m, "")
            .replace(
                ", and the storage\n# passphrase systemd decrypts from " + `${v.etcDir}/storage-passphrase.cred.`,
                ".",
            );
    }
    return text;
}

/**
 * The shared env file. `ZALO_MCP_TRUSTED_PROXIES` is set when the accounts sit behind the local proxy
 * (`--domain`); without one, a loopback client could claim any address in X-Forwarded-For.
 * @param {{ proxied?: boolean }} [o]
 * @returns {string}
 */
export function renderCommonEnv({ proxied = false } = {}) {
    return `# /etc/zalo-mcp/common.env        read by every zalo-mcp@<id> instance, the maintenance units and \`za\`
#   sudo install -m 600 common.env /etc/zalo-mcp/common.env
# Per-account settings go in /etc/zalo-mcp/accounts/<id>.env, which is read after this file.
# Machine paths (ZALO_DATA_DIR, ZALO_MEDIA_DIR) do not go here: they go in the service user's
# ~/.zalo-agent-cli/.env, which every zalo-agent command reads, so a login or a \`db backup\` run by
# hand opens the same files as the daemons.

ZALO_MCP_HOST=127.0.0.1
ZALO_MCP_CONFIRM_MODE=agent
# The accounts run as zalo-mcp@<id> units: \`fleet start|stop|restart\` (and \`fleet serve\`) drive
# them with systemctl, never by starting a second daemon beside the unit.
ZALO_FLEET_SUPERVISOR=systemd

# Behind the local Caddy (or nginx), which sends the client's address in X-Forwarded-For: trust it
# from loopback only, so a capability link's per-client limit counts clients, not the proxy.
${proxied ? "" : "# "}ZALO_MCP_TRUSTED_PROXIES=127.0.0.1

# Logs go to the journal. \`info\` leaves out the line per HTTP request and per message that
# \`debug\` adds (debug holds message text: never on a server). JSON lines suit a log shipper.
ZALO_LOG_LEVEL=info
# ZALO_LOG_FORMAT=json

# A fleet restarting together is the heaviest moment of each daemon's life (every start logs in and
# loads the friend and group lists): wait up to this many seconds before logging in, and let at most
# this many daemons on the machine be logging in at once (the rest wait for a slot).
ZALO_START_JITTER=30
# ZALO_LOGIN_SLOTS=3

# The admin console's credential for /zalo/admin/* (the runtime policy, usage, export): its own
# token, never an agent's. A file only the service user reads (install -m 600 -o zalo), or the
# token \`za policy token --rotate\` keeps sealed (then leave this unset). The proxy never lets
# /zalo/admin/* in from the internet: reach it on loopback, over an SSH tunnel or a VPN.
# ZALO_MCP_ADMIN_TOKEN_FILE=/etc/zalo-mcp/admin-token
`;
}

/** The shared env file as `fleet generate` writes it without `--domain` (docs/config-samples/systemd/common.env). */
export const COMMON_ENV_TEMPLATE = renderCommonEnv();

/**
 * The service user's `~/.zalo-agent-cli/.env`: what every zalo-agent command run as that user reads.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderHomeEnv(o = {}) {
    const v = resolve(o);
    const cfg = `${v.home}/.zalo-agent-cli`;
    const line = (name, value, example) => (value ? `${name}=${value}` : `# ${name}=${example}`);
    return `# ${cfg}/.env      read by EVERY zalo-agent command run as ${v.user}: each unit (systemd sets
# HOME for User=${v.user}) and each \`za ...\` by hand, so all of them open the same files.
#   sudo install -m 600 -o ${v.user} -g ${v.user} home.env ${cfg}/.env
# Machine paths belong here, never in common.env (a command run by hand does not read that).
# A folder set here must also be in the units' ReadWritePaths, and exist: \`fleet generate
# --data-dir / --media-dir\` writes both; by hand, change both.

ZALO_AGENT_NO_UPDATE_CHECK=1
${line("ZALO_DATA_DIR", v.dataDir, "/srv/zalo/accounts")}
${line("ZALO_MEDIA_DIR", v.mediaDir, "/srv/zalo/media")}
`;
}

/**
 * The key layer's `storage.json` for a provider (null for `none`). The passphrase variant names no file: the
 * provider reads `$CREDENTIALS_DIRECTORY/zalo-storage-passphrase` (the drop-in), or asks at a terminal.
 * @param {string} provider
 * @returns {string|null}
 */
export function renderStorageJson(provider = FLEET_DEFAULTS.provider) {
    const tail = `    "rowMac": { "verifyOnRead": "actions" },
    "retention": { "messages": "keep", "media": "keep", "outboxDead": "30d", "purgeEvery": "6h" },
    "quota": { "account": { "limit": null }, "graceDays": 45, "warnAt": 0.8, "purgeOrder": "media-first" }
}
`;
    if (provider === "passphrase") return `{\n    "provider": "passphrase",\n    "dkeyLayer": false,\n${tail}`;
    if (provider === "systemd-creds") {
        return `{\n    "provider": "systemd-creds",\n    "dkeyLayer": true,\n    "systemdCreds": { "withKey": "auto", "user": true },\n${tail}`;
    }
    if (provider === "kms") {
        return `{
    "provider": "kms",
    "dkeyLayer": true,
    "kms": {
        "backend": "aws",
        "key": "arn:aws:kms:ap-southeast-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    },
    "rowMac": { "verifyOnRead": "actions" },
    "retention": { "messages": "90d", "media": "30d", "outboxDead": "7d", "purgeEvery": "1h" },
    "quota": { "account": { "limit": null }, "graceDays": 45, "warnAt": 0.8, "purgeOrder": "media-first" }
}
`;
    }
    return null;
}

export const LOGROTATE_TEMPLATE = `# /etc/logrotate.d/zalo-policy-audit
# policy-audit.log gets one JSON line per policy change or refusal (keys and revisions, never a value)
# and is never rotated by the engine. Weekly, a year kept; copytruncate, because the daemons keep it
# open for appending.
#   sudo install -m 644 zalo-policy-audit.logrotate /etc/logrotate.d/zalo-policy-audit
/home/zalo/.zalo-agent-cli/policy-audit.log {
    su zalo zalo
    weekly
    rotate 52
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
`;

/**
 * The logrotate rule for the caller's user and home.
 * @param {Partial<typeof FLEET_DEFAULTS>} [o]
 * @returns {string}
 */
export function renderLogrotate(o = {}) {
    const v = resolve(o);
    return LOGROTATE_TEMPLATE.replaceAll("su zalo zalo", `su ${v.user} ${v.user}`).replaceAll("/home/zalo", v.home);
}

/**
 * One account's env file. The token is generated by the caller.
 * @param {{ ownId: string, port: number, token: string, publicUrl?: string|null, etcDir?: string }} a
 * @returns {string}
 */
export function renderAccountEnv({ ownId, port, token, publicUrl = null, etcDir = FLEET_DEFAULTS.etcDir }) {
    return `# ${etcDir}/accounts/${ownId}.env     account ${ownId}; read by zalo-mcp@${ownId}.service
#   sudo install -m 600 ${ownId}.env ${etcDir}/accounts/${ownId}.env
# Generated by \`zalo-agent fleet generate\`. The token is the bearer token a client of THIS account sends.

ZALO_MCP_HOST=127.0.0.1
ZALO_MCP_HTTP_PORT=${port}
ZALO_MCP_AUTH_TOKEN=${token}
# The address clients reach this account at through the proxy: the one-time pages, media and
# approval links are built from it, never from 127.0.0.1. \`fleet generate --domain <host>\` writes it.
${publicUrl ? `ZALO_MCP_PUBLIC_URL=${publicUrl}` : `# ZALO_MCP_PUBLIC_URL=https://zalo.example.com/a/${ownId}`}

# Presence: on-demand (the server default) closes the Zalo socket after 5 idle minutes and opens it
# again on the next tool call, wait or CRM lease; what arrived meanwhile comes in on that reconnect
# (webhooks flagged catchUp). always-on keeps it open for real-time webhooks (the paid tier; one per
# user). The daemons follow it once on-demand presence is switched on; until then they stay connected.
# ZALO_PRESENCE_MODE=always-on

# Where this account's incoming messages are POSTed, and the secret that signs them:
# ZALO_WEBHOOK_URL=https://crm.example.com/hooks/zalo/${ownId}
# ZALO_WEBHOOK_SECRET=CHANGE_ME_WEBHOOK_SIGNING_SECRET
`;
}

/**
 * A Caddyfile with one path per account: https://<domain>/a/<id>/mcp reaches that account's daemon.
 * @param {{ domain: string, accounts: Array<{ ownId: string, port: number }> }} a
 * @returns {string}
 */
export function renderCaddyfile({ domain, accounts }) {
    const exampleId = accounts[0]?.ownId ?? "<id>";
    const blocks = accounts
        .map(
            ({ ownId, port }) => `	handle_path /a/${ownId}/* {
		@internal path /metrics /status /zalo/admin /zalo/admin/*
		respond @internal 404

		reverse_proxy 127.0.0.1:${port} {
			flush_interval -1
			transport http {
				read_timeout 310s
			}
		}
	}
`,
        )
        .join("\n");
    return `# Caddyfile: several accounts behind one hostname, one path prefix per account.
# Each account is its own zalo-mcp@<id> instance on its own loopback port. Bearer-token auth per
# account; OAuth issuer URLs are awkward behind a path prefix, so use tokens here.
# Only /mcp, /events/wait and the one-time pages and links are meant for outside clients. Each block
# answers 404 for /metrics and /status (Prometheus, inside your network) and for /zalo/admin/* (the
# admin API: reach it on loopback, e.g. \`ssh -L 3901:127.0.0.1:3901 <host>\`, or a VPN, never here).
# Each account's env file gives it its public address with the prefix as a base path, so the links
# to its one-time pages (/zalo/secure/<token>) come back through its own block:
#   ZALO_MCP_PUBLIC_URL=https://${domain}/a/${exampleId}
# (\`fleet generate --domain\` writes it). handle_path strips the prefix. common.env trusts this proxy:
#   ZALO_MCP_TRUSTED_PROXIES=127.0.0.1
${domain} {
	# Media links (/a/<id>/zalo/media/<token>) are never compressed: it breaks byte ranges.
	@compress not path /a/*/zalo/media/*
	encode @compress zstd gzip

	# The QR page of \`za login --public-url https://${domain}\`: one-time token, answered only while
	# that login runs (port 18927 unless --qr-port). The SSH tunnel to 127.0.0.1:18927 is the safer way.
	handle /zalo/qr/* {
		reverse_proxy 127.0.0.1:18927
	}

${blocks}
	# A client for an account talks to  https://${domain}/a/<id>/mcp  and  https://${domain}/a/<id>/events/wait
	respond 404
}
`;
}
