/**
 * `zalo-agent fleet ...` — run many accounts on one machine.
 *
 * One account is one daemon process with its own port, token and lock, so a hundred accounts are a hundred
 * of them. These commands do what an operator would otherwise script by hand: keep a port table, show every
 * daemon's health in one table, start and restart them in shuffled batches so they do not all log in at
 * once, and write the systemd unit, env files and proxy config that supervise them. See src/core/fleet.js.
 */

import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parseAccountId } from "../core/daemon-account.js";
import { listAccounts } from "../core/accounts.js";
import { CONFIG_DIR, getAccountDir } from "../core/credentials.js";
import {
    callViaDaemon,
    getDaemonStatus,
    spawnDaemonProcess,
    statusViaDaemon,
    stopDaemon,
} from "../core/daemon-channel.js";
import {
    DEFAULT_BASE_PORT,
    FleetError,
    assignPorts,
    classifyAccount,
    generateFleetFiles,
    loadPortTable,
    needsRestart,
    planBatches,
    releasePorts,
    renderStatusTable,
} from "../core/fleet.js";
import {
    createSpawnDriver,
    createSystemdDriver,
    detectSupervisor,
    supervisorOf,
    unitName,
} from "../core/fleet-supervisor.js";
import { FLEET_DEFAULTS, FLEET_PROVIDERS, KEYED_UNITS, writablePaths } from "../core/fleet-templates.js";
import { createFleetController } from "../core/fleet-controller.js";
import {
    DEFAULT_CONTROLLER_PORT,
    adminWebhook,
    agentTokenHashes,
    buildControllerApp,
    finishQrAdd,
    runSelf,
    spawnLoginChild,
} from "../core/fleet-serve.js";
import { DEFAULT_QR_FLOWS, createQrFlows } from "../core/fleet-qr.js";
import { applyPolicy, effectivePolicy, ownerOf } from "../core/policy-store.js";
import { resolvePublicUrl, resolveTrustedProxies, validatePublicUrl } from "../core/deploy-policy.js";
import { kickFile, readKickMarker } from "../core/kick-marker.js";
import { fleetPurge } from "../core/fleet-purge.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { envForAccount, loadMCPConfig } from "../mcp/mcp-config.js";
import { error, info, output, success, warning } from "../utils/output.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i], i);
            }
        }),
    );
    return out;
}

/** @param {string} label @param {string} value @param {number} min @param {number} max */
function intOption(label, value, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        error(`Invalid ${label} "${value}": must be a whole number from ${min} to ${max}.`);
        process.exit(1);
    }
    return n;
}

/**
 * Whether a `--domain` value is a bare host name (zalo.example.com) that makes a valid https address.
 * @param {string} host
 * @returns {boolean}
 */
function isHostName(host) {
    return /^[a-z0-9.-]+$/i.test(host) && !validatePublicUrl(`https://${host}`).error;
}

/**
 * The accounts a command acts on: the ones named, else every registered one.
 * @param {string[]} ids
 * @returns {Array<{ ownId: string, name: string }>}
 */
function pickAccounts(ids) {
    const all = listAccounts();
    if (!all.length) {
        error("No accounts are registered. Log in first: zalo-agent login");
        if (existsSync(join(FLEET_DEFAULTS.etcDir, "accounts"))) {
            info(
                `This machine runs a fleet as its service user: run the command as that user, e.g. \`za fleet status\` ` +
                    `(docs/config-samples/use-cases/c-vps-few-accounts), or \`sudo -u ${FLEET_DEFAULTS.user} -H zalo-agent ...\`.`,
            );
        }
        process.exit(1);
    }
    if (!ids.length) return all;
    const chosen = [];
    for (const raw of ids) {
        let id;
        try {
            id = parseAccountId(raw);
        } catch (e) {
            error(e.message);
            process.exit(1);
        }
        const acc = all.find((a) => a.ownId === id);
        if (!acc) {
            error(`Account ${id} is not registered. List them with: zalo-agent account list`);
            process.exit(1);
        }
        chosen.push(acc);
    }
    return chosen;
}

/** The port table, with every given account in it. */
function portsFor(accounts, basePort) {
    try {
        return assignPorts(
            accounts.map((a) => a.ownId),
            { basePort },
        ).ports;
    } catch (e) {
        if (e instanceof FleetError) {
            error(e.message);
            process.exit(1);
        }
        throw e;
    }
}

/** The ports already assigned, without assigning any (status must not write). */
function readPorts() {
    try {
        return loadPortTable().ports;
    } catch (e) {
        if (e instanceof FleetError) {
            error(e.message);
            process.exit(1);
        }
        throw e;
    }
}

/**
 * What every account's daemon is doing right now, asked over each one's loopback channel (no port or token needed).
 * @param {Array<{ ownId: string, name: string }>} accounts
 * @param {Record<string, number>} ports
 * @param {number} downForSec
 */
async function collect(accounts, ports, downForSec) {
    return mapLimit(accounts, 16, async (acc) => {
        const accountDir = getAccountDir(acc.ownId);
        const daemon = getDaemonStatus(accountDir);
        const reply = daemon.running ? await statusViaDaemon(accountDir) : null;
        const health = reply?.ok ? reply.health : null;
        const kicked = daemon.running ? null : readKickMarker(kickFile(accountDir));
        return {
            accountId: acc.ownId,
            name: acc.name,
            port: ports[acc.ownId] ?? null,
            state: classifyAccount({ running: daemon.running, health, kicked }, { downForSec }),
            daemon: { running: daemon.running, pid: daemon.pid },
            health,
            ...(kicked && { kicked }),
        };
    });
}

/** `<dir>/<ownId>.env` as extra environment for that account's daemon, if the file exists. */
function envFromDir(dir, ownId) {
    if (!dir) return {};
    const file = join(dir, `${ownId}.env`);
    if (!existsSync(file)) return {};
    try {
        return parseEnv(readFileSync(file, "utf8"));
    } catch (e) {
        error(`Cannot read ${file}: ${e.message}`);
        process.exit(1);
    }
}

/** What to do when systemctl is refused for the service user. */
const SYSTEMCTL_HINT =
    "as root: sudo systemctl <verb> zalo-mcp@<id>; or let the service user do it with the polkit rule (zalo-fleet-polkit.rules)";

/** @param {string} verb @param {string} id */
const systemctlHint = (verb, id) => SYSTEMCTL_HINT.replace("<verb>", verb).replace("<id>", id);

/** Each account's supervisor (systemd unit or spawn), asked once per command. */
async function supervisorsOf(ids) {
    const out = {};
    await mapLimit(ids, 8, async (id) => {
        out[id] = await supervisorOf(id);
    });
    return out;
}

/**
 * Start (or, for a systemd unit, restart) daemons in shuffled batches, a pause between batches. An account its
 * zalo-mcp@<id> unit runs goes through systemctl; any other is spawned.
 *
 * @param {Array<{ ownId: string, kind: "mcp"|"listen", port: number, supervisor: "systemd"|"spawn" }>} targets
 * @param {{ batch: number, staggerSec: number, envDir: string|null, dryRun: boolean, log: (m: string) => void,
 *   verb?: "start"|"restart", systemd?: object }} o
 * @returns {Promise<Array<{ accountId: string, ok: boolean, detail: string, supervisor: string }>>}
 */
async function startInBatches(
    targets,
    { batch, staggerSec, envDir, dryRun, log, verb = "start", systemd = createSystemdDriver() },
) {
    const batches = planBatches(targets, { size: batch });
    const results = [];
    for (let b = 0; b < batches.length; b++) {
        log(`batch ${b + 1}/${batches.length}: ${batches[b].map((t) => t.ownId).join(", ")}`);
        const done = await Promise.all(
            batches[b].map(async (t) => {
                if (t.supervisor === "systemd") {
                    const unit = unitName(t.ownId);
                    if (dryRun)
                        return { accountId: t.ownId, ok: true, supervisor: "systemd", detail: `would ${verb} ${unit}` };
                    const r = await systemd[verb](t.ownId);
                    return {
                        accountId: t.ownId,
                        ok: r.ok,
                        supervisor: "systemd",
                        detail: r.ok
                            ? `${verb === "start" ? "started" : "restarted"} ${unit}`
                            : `${r.detail} (${systemctlHint(verb, t.ownId)})`,
                    };
                }
                if (dryRun)
                    return {
                        accountId: t.ownId,
                        ok: true,
                        supervisor: "spawn",
                        detail: `would start (${t.kind}${t.kind === "mcp" ? `, port ${t.port}` : ""})`,
                    };
                const env = envFromDir(envDir, t.ownId);
                if (t.kind === "mcp" && !envForAccount("ZALO_MCP_AUTH_TOKEN", t.ownId, { ...process.env, ...env })) {
                    warning(
                        `Account ${t.ownId} has no ZALO_MCP_AUTH_TOKEN: its port will serve anyone who can reach it.`,
                    );
                }
                const args =
                    t.kind === "listen"
                        ? [process.argv[1], "listen", "--account", t.ownId]
                        : [process.argv[1], "mcp", "start", "--account", t.ownId, "--http", String(t.port)];
                const spawned = await spawnDaemonProcess({ accountDir: getAccountDir(t.ownId), args, env });
                if (spawned.ok) {
                    return {
                        accountId: t.ownId,
                        ok: true,
                        supervisor: "spawn",
                        detail: `started (pid ${spawned.pid}${t.kind === "mcp" ? `, port ${t.port}` : ""})`,
                    };
                }
                return {
                    accountId: t.ownId,
                    ok: Boolean(spawned.alreadyRunning),
                    supervisor: "spawn",
                    detail: spawned.alreadyRunning
                        ? `already running (pid ${spawned.pid})`
                        : `failed: ${spawned.error} (log: ${spawned.logPath})`,
                };
            }),
        );
        results.push(...done);
        if (b < batches.length - 1 && !dryRun && staggerSec > 0) {
            log(`waiting ${staggerSec}s before the next batch`);
            await sleep(staggerSec * 1000);
        }
    }
    return results;
}

/**
 * Drop a removed account from this host's fleet bookkeeping: its port, its env file, its owning user's list.
 *
 * @param {string} ownId
 * @param {string|null} envDir
 */
function forgetAccount(ownId, envDir) {
    releasePorts([ownId]);
    if (envDir) rmSync(join(envDir, `${ownId}.env`), { force: true });
    const owner = ownerOf(ownId);
    if (owner) {
        applyPolicy({
            target: { kind: "user", id: owner.id },
            op: "patch",
            policy: {},
            accounts: owner.accounts.filter((a) => a !== ownId),
            actor: "fleet-controller",
        });
    }
}

/**
 * @param {object} program - Commander root
 */
export function registerFleetCommands(program) {
    const fleet = program
        .command("fleet")
        .description(
            "Run many accounts on one machine: port table, one status table, batched start/restart, supervisor files",
        );

    const json = () => program.opts().json;

    fleet
        .command("ports")
        .description(
            "Show the port each account's daemon uses, assigning one to any account that has none (kept in fleet.json)",
        )
        .option(
            "--base <port>",
            `First port of a new table (default ${DEFAULT_BASE_PORT}); ignored once ports are assigned`,
        )
        .action((opts) => {
            const base = opts.base === undefined ? undefined : intOption("--base", opts.base, 1, 65535);
            const accounts = listAccounts();
            if (!accounts.length) {
                error("No accounts are registered. Log in first: zalo-agent login");
                process.exit(1);
            }
            const ports = portsFor(accounts, base);
            const rows = accounts.map((a) => ({ accountId: a.ownId, name: a.name, port: ports[a.ownId] }));
            output({ ports: rows }, json(), () => {
                for (const r of rows) info(`${r.accountId}  ${String(r.port).padEnd(5)}  ${r.name || ""}`);
            });
        });

    fleet
        .command("status [accounts...]")
        .description(
            "One table for every account: daemon, socket, last event, webhook backlog, gaps, memory, and a state",
        )
        .option("--check", "Exit 1 unless every account is ok, idle or degraded (for monitoring scripts)")
        .option(
            "--down-for <seconds>",
            "How long a socket may be down before the account counts as `down` (default 180)",
            "180",
        )
        .action(async (ids, opts) => {
            const downFor = intOption("--down-for", opts.downFor, 0, 86400);
            const accounts = pickAccounts(ids);
            const rows = await collect(accounts, readPorts(), downFor);
            const summary = {};
            for (const r of rows) summary[r.state] = (summary[r.state] ?? 0) + 1;
            output({ accounts: rows, summary }, json(), () => {
                for (const line of renderStatusTable(rows)) console.log(line);
                console.log();
                info(
                    Object.entries(summary)
                        .map(([s, n]) => `${n} ${s}`)
                        .join(", "),
                );
            });
            if (opts.check && rows.some((r) => !["ok", "idle", "degraded"].includes(r.state))) process.exit(1);
        });

    fleet
        .command("start [accounts...]")
        .description("Start the daemons that are not running, in shuffled batches with a pause between them")
        .option("--listen", "Start `listen` daemons (webhook only, no HTTP port) instead of MCP servers")
        .option("--batch <n>", "Accounts started at once (default 5)", "5")
        .option("--stagger <seconds>", "Pause between batches (default 15)", "15")
        .option(
            "--env-dir <dir>",
            "Read <dir>/<ownId>.env into each spawned daemon's environment (its token, port, webhook); a unit reads its own",
        )
        .option("--dry-run", "Print the plan and start nothing")
        .action(async (ids, opts) => {
            const batch = intOption("--batch", opts.batch, 1, 100);
            const staggerSec = intOption("--stagger", opts.stagger, 0, 3600);
            const accounts = pickAccounts(ids);
            const ports = portsFor(accounts);
            const idle = accounts.filter((a) => !getDaemonStatus(getAccountDir(a.ownId)).running);
            const sup = await supervisorsOf(idle.map((a) => a.ownId));
            const targets = idle.map((a) => ({
                ownId: a.ownId,
                kind: opts.listen ? "listen" : "mcp",
                port: ports[a.ownId],
                supervisor: sup[a.ownId],
            }));
            const skipped = accounts.length - targets.length;
            const log = (m) => (json() ? console.error(`  ● ${m}`) : info(m));
            if (skipped) log(`${skipped} account(s) already have a daemon running and are left alone`);
            const results = await startInBatches(targets, {
                batch,
                staggerSec,
                envDir: opts.envDir ?? null,
                dryRun: Boolean(opts.dryRun),
                log,
            });
            output({ started: results, alreadyRunning: skipped, dryRun: Boolean(opts.dryRun) }, json(), () => {
                for (const r of results) (r.ok ? success : error)(`${r.accountId}: ${r.detail}`);
                if (!results.length) info("Nothing to start.");
            });
            if (results.some((r) => !r.ok)) process.exit(1);
        });

    fleet
        .command("stop [accounts...]")
        .description(
            "Stop the daemons of these accounts (all of them if none are named), each with its graceful shutdown; a systemd unit through systemctl",
        )
        .action(async (ids) => {
            const accounts = pickAccounts(ids);
            const sup = await supervisorsOf(accounts.map((a) => a.ownId));
            const systemd = createSystemdDriver();
            const results = await mapLimit(accounts, 8, async (a) => {
                if (sup[a.ownId] === "systemd") {
                    // Stopping the process would be undone by the unit's Restart=always 15 s later: stop the unit.
                    const r = await systemd.stop(a.ownId);
                    return {
                        accountId: a.ownId,
                        supervisor: "systemd",
                        stopped: r.ok,
                        ok: r.ok,
                        detail: r.ok
                            ? `stopped ${unitName(a.ownId)}`
                            : `${r.detail} (${systemctlHint("stop", a.ownId)})`,
                    };
                }
                const res = await stopDaemon(getAccountDir(a.ownId));
                return {
                    accountId: a.ownId,
                    supervisor: "spawn",
                    stopped: res.stopped,
                    ok: true,
                    graceful: res.graceful,
                    pid: res.pid,
                    detail: res.stopped
                        ? `stopped (pid ${res.pid}${res.graceful ? "" : ", forced"})`
                        : "no daemon was running",
                };
            });
            output({ stopped: results }, json(), () => {
                for (const r of results) {
                    if (!r.ok) error(`${r.accountId}: ${r.detail}`);
                    else if (r.stopped) success(`${r.accountId}: ${r.detail}`);
                    else info(`${r.accountId}: ${r.detail}`);
                }
            });
            if (results.some((r) => !r.ok)) process.exit(1);
        });

    fleet
        .command("restart [accounts...]")
        .description(
            "Stop and start daemons in batches; name accounts, or use --unhealthy (down or unresponsive) or --all",
        )
        .option(
            "--unhealthy",
            "Only the accounts whose daemon is down or not answering (not a backlog: a restart does not fix a receiver)",
        )
        .option("--all", "Every account")
        .option("--down-for <seconds>", "How long a socket may be down before it counts as `down` (default 180)", "180")
        .option(
            "--listen",
            "Start `listen` daemons for accounts whose kind cannot be told (a daemon that does not answer)",
        )
        .option("--batch <n>", "Accounts restarted at once (default 5)", "5")
        .option("--stagger <seconds>", "Pause between batches (default 15)", "15")
        .option("--env-dir <dir>", "Read <dir>/<ownId>.env into each spawned daemon's environment")
        .option("--dry-run", "Print the plan and change nothing")
        .action(async (ids, opts) => {
            if (!ids.length && !opts.unhealthy && !opts.all) {
                error(
                    "Name the accounts to restart, or pass --unhealthy or --all (a bare `fleet restart` restarts nothing).",
                );
                process.exit(1);
            }
            const batch = intOption("--batch", opts.batch, 1, 100);
            const staggerSec = intOption("--stagger", opts.stagger, 0, 3600);
            const downFor = intOption("--down-for", opts.downFor, 0, 86400);
            const accounts = pickAccounts(ids);
            const ports = portsFor(accounts);
            const rows = await collect(accounts, ports, downFor);
            const chosen = opts.unhealthy && !ids.length ? rows.filter((r) => needsRestart(r.state)) : rows;
            const log = (m) => (json() ? console.error(`  ● ${m}`) : info(m));
            if (!chosen.length) {
                output({ restarted: [], considered: rows.length }, json(), () =>
                    info("Every account is serving: nothing to restart."),
                );
                return;
            }
            log(
                `restarting ${chosen.length} of ${rows.length} account(s): ${chosen.map((r) => `${r.accountId} (${r.state})`).join(", ")}`,
            );
            const sup = await supervisorsOf(chosen.map((r) => r.accountId));
            if (!opts.dryRun) {
                // A unit restarts in its batch (systemctl restart); only a spawned daemon is stopped here first.
                const spawned = chosen.filter((r) => sup[r.accountId] !== "systemd");
                await mapLimit(spawned, 8, (r) => stopDaemon(getAccountDir(r.accountId)));
            }
            const targets = chosen.map((r) => ({
                ownId: r.accountId,
                kind: r.health?.kind ?? (opts.listen ? "listen" : "mcp"),
                port: ports[r.accountId],
                supervisor: sup[r.accountId],
            }));
            const results = await startInBatches(targets, {
                batch,
                staggerSec,
                envDir: opts.envDir ?? null,
                dryRun: Boolean(opts.dryRun),
                log,
                verb: "restart",
            });
            output({ restarted: results, dryRun: Boolean(opts.dryRun) }, json(), () => {
                for (const r of results) (r.ok ? success : error)(`${r.accountId}: ${r.detail}`);
            });
            if (results.some((r) => !r.ok)) process.exit(1);
        });

    fleet
        .command("purge [accounts...]")
        .description(
            "Run the quota/retention purge for accounts with no daemon, and ask a daemon whose purge timer is behind; asks first: --yes",
        )
        .option("--dry-run", "Count what would be purged, and purge nothing")
        .action(async (ids, opts) => {
            const accounts = pickAccounts(ids);
            const dryRun = Boolean(opts.dryRun);
            const log = (m) => (json() ? console.error(`  ● ${m}`) : info(m));
            const results = await fleetPurge({ accounts: accounts.map((a) => a.ownId), dryRun, log });
            const mib = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)} MiB`;
            output({ purge: results, dryRun }, json(), () => {
                for (const r of results) {
                    const s = r.summary;
                    const counts = s
                        ? `: ${s.mediaFiles} media file(s), ${s.messages} message(s)` +
                          (dryRun ? " due" : `, ${s.outboxDead} dead deliver(ies)`) +
                          (s.usedAfter !== null ? `; ${mib(s.usedBefore)} -> ${mib(s.usedAfter)}` : "")
                        : "";
                    const line = `${r.accountId}: ${r.detail}${counts}${r.error ? ` (${r.error})` : ""}`;
                    if (r.action === "failed") error(line);
                    else if (r.action === "skipped") info(line);
                    else success(line);
                }
            });
            if (results.some((r) => r.action === "failed")) process.exit(1);
        });

    fleet
        .command("generate [accounts...]")
        .description(
            "Write the systemd units (daemon, purge, health check, backup) and timers, env files with generated tokens, the key provider's storage.json and credential drop-in, the za wrapper and, optionally, a Caddyfile",
        )
        .requiredOption("--out <dir>", "Directory to write into")
        .option("--base-port <port>", `First port of a new table (default ${DEFAULT_BASE_PORT})`)
        .option("--user <name>", `Unix user the units run as (default ${FLEET_DEFAULTS.user})`)
        .option("--home <dir>", `That user's home directory (default ${FLEET_DEFAULTS.home})`)
        .option("--bin <path>", `Path of the zalo-agent binary (default ${FLEET_DEFAULTS.bin})`)
        .option("--etc-dir <dir>", `Where the env files and the credential go (default ${FLEET_DEFAULTS.etcDir})`)
        .option("--backup-dir <dir>", `Where the nightly backup writes (default ${FLEET_DEFAULTS.backupDir})`)
        .option(
            "--provider <name>",
            `Key provider to wire: ${FLEET_PROVIDERS.join(", ")} (default ${FLEET_DEFAULTS.provider}: its passphrase through LoadCredentialEncrypted=)`,
        )
        .option(
            "--domain <host>",
            "Also write a Caddyfile that serves every account under https://<host>/a/<ownId>/, and each account's public URL",
        )
        .option("--force", "Overwrite files that already exist (account env files keep their token)")
        .option("--rotate-tokens", "Give every account a new token, replacing the ones in existing env files")
        .action((ids, opts) => {
            const base = opts.basePort === undefined ? undefined : intOption("--base-port", opts.basePort, 1, 65535);
            const accounts = pickAccounts(ids);
            // The data and media dirs are this run's own (the global --data-dir / --media-dir, or ZALO_DATA_DIR /
            // ZALO_MEDIA_DIR from the home .env `za` reads): the files then give the units the same ones.
            const g = program.opts();
            const dataDir = g.dataDir ?? process.env.ZALO_DATA_DIR ?? undefined;
            const mediaDir = g.mediaDir ?? process.env.ZALO_MEDIA_DIR ?? undefined;
            const provider = opts.provider ?? FLEET_DEFAULTS.provider;
            if (!FLEET_PROVIDERS.includes(provider)) {
                error(`Invalid --provider "${provider}": one of ${FLEET_PROVIDERS.join(", ")}.`);
                process.exit(1);
            }
            for (const [flag, dir] of [
                ["--home", opts.home],
                ["--etc-dir", opts.etcDir],
                ["--data-dir", dataDir],
                ["--media-dir", mediaDir],
                ["--backup-dir", opts.backupDir],
                ["--bin", opts.bin],
            ]) {
                if (dir !== undefined && !/^\/[^\s'"$`\\]*[^/\s'"$`\\]$/.test(dir)) {
                    error(`Invalid ${flag} "${dir}": an absolute Linux path with no spaces, quotes or trailing slash.`);
                    process.exit(1);
                }
            }
            if (opts.user !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(opts.user)) {
                error(`Invalid --user "${opts.user}": a Unix user name.`);
                process.exit(1);
            }
            if (opts.domain !== undefined && !isHostName(opts.domain)) {
                error(`Invalid --domain "${opts.domain}": a host name only (zalo.example.com).`);
                process.exit(1);
            }
            const ports = portsFor(accounts, base);
            const paths = Object.fromEntries(
                Object.entries({
                    user: opts.user,
                    home: opts.home,
                    bin: opts.bin,
                    etcDir: opts.etcDir,
                    dataDir,
                    mediaDir,
                    backupDir: opts.backupDir,
                }).filter(([, v]) => v !== undefined),
            );
            const result = generateFleetFiles({
                outDir: opts.out,
                accounts: accounts.map((a) => ({ ownId: a.ownId, port: ports[a.ownId] })),
                paths,
                domain: opts.domain ?? null,
                provider,
                force: Boolean(opts.force),
                rotateTokens: Boolean(opts.rotateTokens),
            });
            const v = { ...FLEET_DEFAULTS, ...paths, provider };
            const out = opts.out;
            const cfg = `${v.home}/.zalo-agent-cli`;
            const own = `-o ${v.user} -g ${v.user}`;
            const dirs = [v.backupDir, ...writablePaths(v).slice(1)];
            const steps = [
                `sudo install -d -m 750 ${v.etcDir}/accounts && sudo install -m 600 ${out}/common.env ${v.etcDir}/ && sudo install -m 600 ${out}/accounts/*.env ${v.etcDir}/accounts/`,
                `sudo install -m 644 ${out}/zalo-mcp@.service ${out}/zalo-mcp-purge.service ${out}/zalo-mcp-purge.timer ${out}/zalo-fleet-check.service ${out}/zalo-fleet-check.timer ${out}/zalo-backup.service ${out}/zalo-backup.timer /etc/systemd/system/`,
                ...(provider === "passphrase"
                    ? [
                          KEYED_UNITS.map(
                              (u) =>
                                  `sudo install -D -m 644 ${out}/credentials.conf /etc/systemd/system/${u}.d/credentials.conf`,
                          ).join(" && "),
                          `sudo -v && systemd-ask-password -n "Storage passphrase:" | sudo systemd-creds encrypt --with-key=host --name=zalo-storage-passphrase - ${v.etcDir}/storage-passphrase.cred   (keep the passphrase in your password manager)`,
                      ]
                    : []),
                `sudo install -m 600 ${own} ${out}/home.env ${cfg}/.env${result.written.includes("storage.json") || result.kept.includes("storage.json") ? ` && sudo install -m 600 ${own} ${out}/storage.json ${cfg}/storage.json   (merge into files you already have)` : ""}`,
                `sudo install -m 755 ${out}/za /usr/local/bin/za && sudo install -m 644 ${out}/zalo-fleet-polkit.rules /etc/polkit-1/rules.d/50-zalo-fleet.rules && sudo install -m 644 ${out}/zalo-policy-audit.logrotate /etc/logrotate.d/zalo-policy-audit`,
                `sudo install -d -m 700 ${own} ${dirs.join(" ")}`,
                ...(opts.domain
                    ? [`sudo install -m 644 ${out}/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`]
                    : []),
                `sudo systemctl daemon-reload && sudo systemctl enable --now ${accounts.map((a) => `zalo-mcp@${a.ownId}`).join(" ")} zalo-mcp-purge.timer zalo-fleet-check.timer zalo-backup.timer`,
            ];
            output({ outDir: out, accounts: accounts.length, provider, install: steps, ...result }, json(), () => {
                success(`${result.written.length} file(s) written to ${out} for ${accounts.length} account(s)`);
                for (const f of result.written) info(`wrote  ${f}`);
                for (const f of result.kept)
                    info(`kept   ${f} (already there; --force overwrites, --rotate-tokens renews tokens)`);
                info("Tokens are in accounts/<id>.env (mode 600) and are not printed here.");
                info("Install, as an admin (docs/config-samples/use-cases/c-vps-few-accounts/README.md):");
                steps.forEach((step, i) => info(`  ${i + 1}. ${step}`));
                info(
                    `Then run every CLI step as the service user with \`za ...\`, and start, stop or restart an account with systemctl (or \`za fleet start|stop|restart\`), never \`fleet start --env-dir\` beside a unit.`,
                );
            });
        });

    fleet
        .command("serve")
        .description(
            "The account-lifecycle admin API for this host (start/stop/restart, guarded logout and remove, QR add, account_state SSE); admin credential only",
        )
        .option("--http <port>", `Port (default ZALO_FLEET_CONTROLLER_PORT, else ${DEFAULT_CONTROLLER_PORT})`)
        .option("--host <addr>", "Address to bind (default 127.0.0.1; put a TLS proxy in front for another machine)")
        .option(
            "--env-dir <dir>",
            "Per-account env files (<dir>/<ownId>.env): daemon environment, and where a QR add writes",
        )
        .option("--listen", "Spawned daemons are `listen` (webhook only) instead of `mcp start --http`")
        .option(
            "--public-url <url>",
            "The address a CRM reaches this controller at (QR page links); or ZALO_MCP_PUBLIC_URL",
        )
        .option(
            "--domain <host>",
            "The proxy host of `fleet generate --domain`: a QR-added account's env file gets ZALO_MCP_PUBLIC_URL=https://<host>/a/<ownId>; or ZALO_FLEET_DOMAIN",
        )
        .action(async (opts) => {
            const port = intOption(
                "--http",
                opts.http ?? process.env.ZALO_FLEET_CONTROLLER_PORT ?? String(DEFAULT_CONTROLLER_PORT),
                1,
                65535,
            );
            const host = opts.host || "127.0.0.1";
            const envDir = opts.envDir ?? null;
            const config = loadMCPConfig();
            const kind = detectSupervisor();
            const driver =
                kind === "systemd"
                    ? createSystemdDriver()
                    : createSpawnDriver({
                          spawnDaemon: spawnDaemonProcess,
                          stopDaemon,
                          daemonStatus: getDaemonStatus,
                          accountDir: getAccountDir,
                          argsFor: (id) =>
                              opts.listen
                                  ? [process.argv[1], "listen", "--account", id]
                                  : [
                                        process.argv[1],
                                        "mcp",
                                        "start",
                                        "--account",
                                        id,
                                        "--http",
                                        String(portsFor([{ ownId: id }])[id]),
                                    ],
                          envFor: (id) => envFromDir(envDir, id),
                      });
            const pub = resolvePublicUrl({ flag: opts.publicUrl, env: process.env, config, aliases: false });
            if (pub.error) {
                error(pub.error);
                process.exit(1);
            }
            const domain = opts.domain ?? (process.env.ZALO_FLEET_DOMAIN || null);
            if (domain !== null && !isHostName(domain)) {
                error(`Invalid --domain "${domain}" (or ZALO_FLEET_DOMAIN): a host name only (zalo.example.com).`);
                process.exit(1);
            }
            // As `fleet generate --domain` does in common.env: behind the proxy its X-Forwarded-For is trusted from
            // loopback. When this host's shared env does not say so, the new account's own env file does.
            const trustProxy = Boolean(domain) && resolveTrustedProxies({ config, env: process.env }).length === 0;
            if (trustProxy) {
                warning(
                    "ZALO_MCP_TRUSTED_PROXIES is not set (common.env): a QR-added account's env file will trust 127.0.0.1",
                );
            }
            const webhook = adminWebhook(
                process.env.ZALO_FLEET_WEBHOOK || null,
                process.env.ZALO_FLEET_WEBHOOK_SECRET || null,
            );
            const log = (l) => console.error(l);
            // The QR add (src/core/fleet-qr.js): one child login per flow, at most ZALO_FLEET_QR_FLOWS at once.
            const qr = createQrFlows({
                spawnLogin: spawnLoginChild,
                finish: (o) => finishQrAdd({ ...o, envDir, domain, trustProxy, driver }),
                isRunning: (id) => getDaemonStatus(getAccountDir(id)).running,
                dir: join(CONFIG_DIR, "qr-flows"),
                publicUrl: pub.publicUrl,
                localBaseUrl: `http://${host}:${port}`,
                maxFlows: Number(process.env.ZALO_FLEET_QR_FLOWS) || DEFAULT_QR_FLOWS,
                webhook,
                log,
            });
            const controller = createFleetController({
                driver,
                listAccounts: () => listAccounts().map((a) => ({ ownId: a.ownId })),
                probe: async (ownId) => {
                    const dir = getAccountDir(ownId);
                    const daemon = getDaemonStatus(dir);
                    const reply = daemon.running ? await statusViaDaemon(dir) : null;
                    return {
                        running: daemon.running,
                        pid: daemon.pid,
                        health: reply?.ok ? reply.health : null,
                        kicked: !daemon.running && Boolean(readKickMarker(kickFile(dir))),
                    };
                },
                relay: (ownId, path, params) => callViaDaemon(getAccountDir(ownId), path, params),
                runCli: (args) => runSelf(args),
                describe: (ownId) => ({
                    port: readPorts()[ownId] ?? null,
                    userId: ownerOf(ownId)?.id ?? null,
                    presence: effectivePolicy(ownId)?.presence?.mode ?? null,
                }),
                forget: (ownId) => forgetAccount(ownId, envDir),
                qr,
                webhook,
                log,
            });
            const { app } = buildControllerApp({
                controller,
                config,
                agentHashes: agentTokenHashes(envDir),
                qrPages: qr,
                log,
            });
            const server = app.listen(port, host, () => {
                info(`Fleet controller on http://${host}:${port}/zalo/admin (supervisor: ${driver.kind})`);
            });
            server.on("error", (e) => {
                error(`Cannot listen on ${host}:${port}: ${e.message}`);
                process.exit(1);
            });
            controller.start();
            const stop = () => {
                qr.stop();
                controller.stop();
                server.close();
                process.exit(0);
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
        });

    // A purge deletes for good: --yes to run it, --dry-run (its own: it counts) to preview, exit 2 without either.
    guardSubcommand(fleet, "purge", "fleet.purge", {
        target: (ids) => ({ accounts: ids?.length ? `account(s) ${ids.join(", ")}` : null }),
        ownDryRun: true,
    });
}
