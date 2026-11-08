/**
 * The full file set of each use case in docs/config-samples/use-cases/, and where each shared file comes from.
 *
 *   null                         written for this use case only (READMEs, its own env files, ...)
 *   { sample: "<kind>/<file>" }  a byte-identical copy of a per-kind sample in docs/config-samples/
 *   { gen: "<set>", file }       byte-identical to what `fleet generate` writes for that set (generateFor below)
 *   { useCase: "<case>/<file>" } a byte-identical copy of another use case's own file
 *
 * tests/unit/config-samples.test.js holds every folder to this list (nothing missing, nothing extra) and every
 * shared file to its source; agent/work/build-use-cases.mjs writes the shared files from it.
 */

/** The placeholder token every generated account env carries in the samples. */
export const SAMPLE_TOKEN = "CHANGE_ME_64_HEX_CHARACTERS";

const ACCOUNTS = [
    { ownId: "1000000000000000001", port: 3901 },
    { ownId: "1000000000000000002", port: 3902 },
];

/** The `fleet generate` runs the samples are made from: `za fleet generate --base-port 3901 --domain ...`. */
export const generateFor = {
    c: { accounts: ACCOUNTS, domain: "zalo.example.com", provider: "passphrase", makeToken: () => SAMPLE_TOKEN },
    e: { accounts: ACCOUNTS, domain: "zalo.example.com", provider: "kms", makeToken: () => SAMPLE_TOKEN },
};

const SYS = "etc/systemd/system";
const HOME = "home/zalo/.zalo-agent-cli";

/** The systemd, polkit, logrotate and wrapper files of a generated set. */
const fleetBase = (set, { credentials }) => ({
    [`${SYS}/zalo-mcp@.service`]: { gen: set, file: "zalo-mcp@.service" },
    [`${SYS}/zalo-mcp-purge.service`]: { gen: set, file: "zalo-mcp-purge.service" },
    [`${SYS}/zalo-mcp-purge.timer`]: { gen: set, file: "zalo-mcp-purge.timer" },
    [`${SYS}/zalo-fleet-check.service`]: { gen: set, file: "zalo-fleet-check.service" },
    [`${SYS}/zalo-fleet-check.timer`]: { gen: set, file: "zalo-fleet-check.timer" },
    [`${SYS}/zalo-backup.service`]: { gen: set, file: "zalo-backup.service" },
    [`${SYS}/zalo-backup.timer`]: { gen: set, file: "zalo-backup.timer" },
    ...(credentials
        ? {
              [`${SYS}/zalo-mcp@.service.d/credentials.conf`]: { gen: set, file: "credentials.conf" },
              [`${SYS}/zalo-mcp-purge.service.d/credentials.conf`]: { gen: set, file: "credentials.conf" },
              [`${SYS}/zalo-backup.service.d/credentials.conf`]: { gen: set, file: "credentials.conf" },
          }
        : {}),
    "etc/systemd/journald.conf.d/zalo.conf":
        set === "c" ? null : { useCase: "c-vps-few-accounts/etc/systemd/journald.conf.d/zalo.conf" },
    "etc/polkit-1/rules.d/50-zalo-fleet.rules": { gen: set, file: "zalo-fleet-polkit.rules" },
    "etc/logrotate.d/zalo-policy-audit": { gen: set, file: "zalo-policy-audit.logrotate" },
    [`${HOME}/.env`]: { gen: set, file: "home.env" },
    [`${HOME}/storage.json`]: { gen: set, file: "storage.json" },
    "usr/local/bin/za": { gen: set, file: "za" },
    "ufw.sh": set === "c" ? null : { useCase: "c-vps-few-accounts/ufw.sh" },
});

const generatedAccounts = (set) =>
    Object.fromEntries(
        ACCOUNTS.map((a) => [`etc/zalo-mcp/accounts/${a.ownId}.env`, { gen: set, file: `accounts/${a.ownId}.env` }]),
    );

export const USE_CASES = {
    "a-desktop-stdio": {
        "README.md": null,
        "README.vi.md": null,
        "home/.zalo-agent-cli/mcp-config.json": { sample: "mcp-config/local-agent.json" },
        "home/.zalo-agent-cli/storage.windows.json": { sample: "storage/windows.json" },
        "home/.zalo-agent-cli/storage.macos.json": { sample: "storage/macos.json" },
        "home/.zalo-agent-cli/.env": { sample: "env/config-dir.env" },
        "clients/claude-code.json": { sample: "clients/claude-code-stdio.json" },
        "clients/claude-desktop.json": { sample: "clients/claude-desktop.json" },
    },
    "b-desktop-lan-http": {
        "README.md": null,
        "README.vi.md": null,
        "home/.zalo-agent-cli/mcp-config.json": { sample: "mcp-config/lan.json" },
        "home/.zalo-agent-cli/storage.windows.json": { sample: "storage/windows.json" },
        "home/.zalo-agent-cli/storage.macos.json": { sample: "storage/macos.json" },
        "home/.zalo-agent-cli/.env": { sample: "env/config-dir.env" },
        "server-loopback.env": { sample: "env/loopback-server.env" },
        "server-lan.env": { sample: "env/lan-server.env" },
        "windows/zalo-mcp-service.xml": null,
        "macos/com.example.zalo-mcp.plist": null,
        "clients/claude-code-http-lan.json": { sample: "clients/claude-code-http-lan.json" },
    },
    "c-vps-few-accounts": {
        "README.md": null,
        "README.vi.md": null,
        "MIGRATE.md": null,
        "MIGRATE.vi.md": null,
        ...fleetBase("c", { credentials: true }),
        "etc/zalo-mcp/common.env": { gen: "c", file: "common.env" },
        ...generatedAccounts("c"),
        "etc/caddy/Caddyfile": { gen: "c", file: "Caddyfile" },
        [`${HOME}/mcp-config.json`]: null,
    },
    "d-crm-backend": {
        "README.md": null,
        "README.vi.md": null,
        ...fleetBase("c", { credentials: true }),
        "etc/systemd/journald.conf.d/zalo.conf": {
            useCase: "c-vps-few-accounts/etc/systemd/journald.conf.d/zalo.conf",
        },
        "ufw.sh": { useCase: "c-vps-few-accounts/ufw.sh" },
        [`${SYS}/zalo-fleet-controller.service`]: { sample: "systemd/zalo-fleet-controller.service" },
        [`${SYS}/zalo-fleet-controller.service.d/credentials.conf`]: { gen: "c", file: "credentials.conf" },
        "etc/zalo-mcp/common.env": null,
        "etc/zalo-mcp/accounts/1000000000000000001.env": null,
        "etc/zalo-mcp/accounts/1000000000000000002.env": null,
        "etc/caddy/Caddyfile": null,
        [`${HOME}/mcp-config.json`]: null,
        "clients/crm-webhook-receiver.mjs": { sample: "clients/crm-webhook-receiver.mjs" },
        "clients/crm_webhook_receiver.py": { sample: "clients/crm_webhook_receiver.py" },
        "clients/crm-send-message.sh": { sample: "clients/crm-send-message.sh" },
        "clients/admin-policy.sh": { sample: "clients/admin-policy.sh" },
    },
    "e-saas-kms": {
        "README.md": null,
        "README.vi.md": null,
        ...fleetBase("e", { credentials: false }),
        "etc/zalo-mcp/common.env": { gen: "e", file: "common.env" },
        "etc/zalo-mcp/accounts/1000000000000000001.env": null,
        "etc/zalo-mcp/accounts/1000000000000000002.env": null,
        "etc/caddy/Caddyfile": { gen: "e", file: "Caddyfile" },
        [`${HOME}/mcp-config.json`]: { sample: "mcp-config/multi-account.json" },
        [`${HOME}/tenants/tenant-a.json`]: null,
    },
};
