/**
 * `zalo-agent fleet ...` — run many accounts on one machine.
 *
 * One account is one daemon process with its own port, token and lock, so a hundred accounts are a hundred
 * of them. These commands do what an operator would otherwise script by hand: keep a port table, show every
 * daemon's health in one table, start and restart them in shuffled batches so they do not all log in at
 * once, and write the systemd unit, env files and proxy config that supervise them. See src/core/fleet.js.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parseAccountId } from "../core/daemon-account.js";
import { listAccounts } from "../core/accounts.js";
import { getAccountDir } from "../core/credentials.js";
import { getDaemonStatus, spawnDaemonProcess, statusViaDaemon, stopDaemon } from "../core/daemon-channel.js";
import {
    DEFAULT_BASE_PORT,
    FleetError,
    assignPorts,
    classifyAccount,
    generateFleetFiles,
    loadPortTable,
    needsRestart,
    planBatches,
    renderStatusTable,
} from "../core/fleet.js";
import { envForAccount } from "../mcp/mcp-config.js";
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
 * The accounts a command acts on: the ones named, else every registered one.
 * @param {string[]} ids
 * @returns {Array<{ ownId: string, name: string }>}
 */
function pickAccounts(ids) {
    const all = listAccounts();
    if (!all.length) {
        error("No accounts are registered. Log in first: zalo-agent login");
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
        return {
            accountId: acc.ownId,
            name: acc.name,
            port: ports[acc.ownId] ?? null,
            state: classifyAccount({ running: daemon.running, health }, { downForSec }),
            daemon: { running: daemon.running, pid: daemon.pid },
            health,
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

/**
 * Start daemons in shuffled batches, a pause between batches.
 *
 * @param {Array<{ ownId: string, kind: "mcp"|"listen", port: number }>} targets
 * @param {{ batch: number, staggerSec: number, envDir: string|null, dryRun: boolean, log: (m: string) => void }} o
 * @returns {Promise<Array<{ accountId: string, ok: boolean, detail: string }>>}
 */
async function startInBatches(targets, { batch, staggerSec, envDir, dryRun, log }) {
    const batches = planBatches(targets, { size: batch });
    const results = [];
    for (let b = 0; b < batches.length; b++) {
        log(`batch ${b + 1}/${batches.length}: ${batches[b].map((t) => t.ownId).join(", ")}`);
        const done = await Promise.all(
            batches[b].map(async (t) => {
                if (dryRun)
                    return {
                        accountId: t.ownId,
                        ok: true,
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
                        detail: `started (pid ${spawned.pid}${t.kind === "mcp" ? `, port ${t.port}` : ""})`,
                    };
                }
                return {
                    accountId: t.ownId,
                    ok: Boolean(spawned.alreadyRunning),
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
        .option("--check", "Exit 1 unless every account is ok or degraded (for monitoring scripts)")
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
            if (opts.check && rows.some((r) => !["ok", "degraded"].includes(r.state))) process.exit(1);
        });

    fleet
        .command("start [accounts...]")
        .description("Start the daemons that are not running, in shuffled batches with a pause between them")
        .option("--listen", "Start `listen` daemons (webhook only, no HTTP port) instead of MCP servers")
        .option("--batch <n>", "Accounts started at once (default 5)", "5")
        .option("--stagger <seconds>", "Pause between batches (default 15)", "15")
        .option("--env-dir <dir>", "Read <dir>/<ownId>.env into each daemon's environment (its token, port, webhook)")
        .option("--dry-run", "Print the plan and start nothing")
        .action(async (ids, opts) => {
            const batch = intOption("--batch", opts.batch, 1, 100);
            const staggerSec = intOption("--stagger", opts.stagger, 0, 3600);
            const accounts = pickAccounts(ids);
            const ports = portsFor(accounts);
            const targets = accounts
                .filter((a) => !getDaemonStatus(getAccountDir(a.ownId)).running)
                .map((a) => ({ ownId: a.ownId, kind: opts.listen ? "listen" : "mcp", port: ports[a.ownId] }));
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
            "Stop the daemons of these accounts (all of them if none are named), each with its graceful shutdown",
        )
        .action(async (ids) => {
            const accounts = pickAccounts(ids);
            const results = await mapLimit(accounts, 8, async (a) => {
                const res = await stopDaemon(getAccountDir(a.ownId));
                return { accountId: a.ownId, stopped: res.stopped, graceful: res.graceful, pid: res.pid };
            });
            output({ stopped: results }, json(), () => {
                for (const r of results) {
                    if (r.stopped) success(`${r.accountId}: stopped (pid ${r.pid}${r.graceful ? "" : ", forced"})`);
                    else info(`${r.accountId}: no daemon was running`);
                }
            });
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
        .option("--env-dir <dir>", "Read <dir>/<ownId>.env into each daemon's environment")
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
            if (!opts.dryRun) {
                await mapLimit(chosen, 8, (r) => stopDaemon(getAccountDir(r.accountId)));
            }
            const targets = chosen.map((r) => ({
                ownId: r.accountId,
                kind: r.health?.kind ?? (opts.listen ? "listen" : "mcp"),
                port: ports[r.accountId],
            }));
            const results = await startInBatches(targets, {
                batch,
                staggerSec,
                envDir: opts.envDir ?? null,
                dryRun: Boolean(opts.dryRun),
                log,
            });
            output({ restarted: results, dryRun: Boolean(opts.dryRun) }, json(), () => {
                for (const r of results) (r.ok ? success : error)(`${r.accountId}: ${r.detail}`);
            });
            if (results.some((r) => !r.ok)) process.exit(1);
        });

    fleet
        .command("generate")
        .description(
            "Write the systemd unit, per-account env files (with generated tokens), the port table and, optionally, a Caddyfile",
        )
        .requiredOption("--out <dir>", "Directory to write into")
        .option("--base-port <port>", `First port of a new table (default ${DEFAULT_BASE_PORT})`)
        .option("--user <name>", "Unix user the units run as (default zalo)")
        .option("--home <dir>", "That user's home directory (default /home/zalo)")
        .option("--bin <path>", "Path of the zalo-agent binary (default /usr/bin/zalo-agent)")
        .option("--domain <host>", "Also write a Caddyfile that serves every account under https://<host>/a/<ownId>/")
        .option("--force", "Overwrite files that already exist (account env files keep their token)")
        .option("--rotate-tokens", "Give every account a new token, replacing the ones in existing env files")
        .action((opts) => {
            const base = opts.basePort === undefined ? undefined : intOption("--base-port", opts.basePort, 1, 65535);
            const accounts = listAccounts();
            if (!accounts.length) {
                error("No accounts are registered. Log in first: zalo-agent login");
                process.exit(1);
            }
            const ports = portsFor(accounts, base);
            const paths = Object.fromEntries(
                Object.entries({ user: opts.user, home: opts.home, bin: opts.bin }).filter(([, v]) => v !== undefined),
            );
            const result = generateFleetFiles({
                outDir: opts.out,
                accounts: accounts.map((a) => ({ ownId: a.ownId, port: ports[a.ownId] })),
                paths,
                domain: opts.domain ?? null,
                force: Boolean(opts.force),
                rotateTokens: Boolean(opts.rotateTokens),
            });
            output({ outDir: opts.out, accounts: accounts.length, ...result }, json(), () => {
                success(`${result.written.length} file(s) written to ${opts.out} for ${accounts.length} account(s)`);
                for (const f of result.written) info(`wrote  ${f}`);
                for (const f of result.kept)
                    info(`kept   ${f} (already there; --force overwrites, --rotate-tokens renews tokens)`);
                info("Tokens are in accounts/<id>.env (mode 600) and are not printed here.");
                info(
                    `Install: sudo install -d /etc/zalo-mcp/accounts && sudo install -m 600 ${opts.out}/common.env /etc/zalo-mcp/ && sudo install -m 600 ${opts.out}/accounts/*.env /etc/zalo-mcp/accounts/`,
                );
                info(
                    `Then:    sudo install -m 644 ${opts.out}/zalo-mcp@.service /etc/systemd/system/ && sudo systemctl daemon-reload`,
                );
                info(
                    "Start:   systemctl enable --now zalo-mcp@<ownId>   (or: zalo-agent fleet start --env-dir /etc/zalo-mcp/accounts)",
                );
            });
        });
}
