/**
 * MCP server command — starts a Model Context Protocol server over stdio transport.
 * Allows Claude Code and other MCP clients to read/send Zalo messages via tool calls.
 *
 * IMPORTANT: All diagnostic output uses console.error() — stdout is the MCP transport channel.
 */

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { getApi, clearSession } from "../core/zalo-client.js";
import { liveApi } from "../core/live-api.js";
import { parseAccountId, selectDaemonAccount, loginDaemonAccount } from "../core/daemon-account.js";
import { updateAccountName } from "../core/accounts.js";
import { getAccountDir, MEDIA_DIR } from "../core/credentials.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import {
    createStageLock,
    startDaemonChannel,
    getDaemonStatus,
    stopDaemon,
    spawnDaemonProcess,
    waitViaDaemon,
    markReadViaDaemon,
} from "../core/daemon-channel.js";
import { success, error, info, output } from "../utils/output.js";
import { resolveWebhookSecret } from "../utils/secrets.js";
import { createSyncRunners } from "../core/daemon-sync.js";
import { createSocketContext, startEventLoopMonitor } from "../core/daemon-log.js";
import { setUserInfoLogger } from "../core/user-info.js";
import { createSyncJobs } from "../mcp/sync-jobs.js";
import { createSocketTap } from "../core/socket-tap.js";
import { createSelfHeal } from "../core/self-heal.js";
import { createReadStateSync } from "../core/read-state.js";
import { initDb, getPendingSyncGaps, getThreadNames } from "../core/db.js";
import { SyncManager } from "../core/sync.js";
import { createGapTracker, HEARTBEAT_MS } from "../core/listener-lifecycle.js";
import {
    storeLiveMessage,
    refreshLiveMessageIdentities,
    storeLiveReaction,
    storeLiveUndo,
    storeGroupEvent,
    storeGroupEventRow,
    noteBoardChange,
    storeReceipts,
} from "../core/live-store.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { classifyLiveMessage } from "../core/sync-v2/message-types.js";
import { createDeliveredReceipts } from "../core/receipts.js";
import { MessageBuffer } from "../mcp/message-buffer.js";
import { ThreadFilter } from "../mcp/thread-filter.js";
import { readMCPConfig, resolveAccountMCPConfig, envForAccount, parseDuration } from "../mcp/mcp-config.js";
import { createMCPServer } from "../mcp/mcp-server.js";
import { registerTools } from "../mcp/mcp-tools.js";
import { createHTTPServer } from "../mcp/mcp-http-transport.js";
import { ZaloNotifier } from "../mcp/notifier.js";
import { ThreadNameCache } from "../mcp/thread-name-cache.js";

/** Zalo close code for duplicate web session — fatal, do not retry */
const CLOSE_DUPLICATE = 3000;

/** Sync2.Message.MessageStatus values carried by live receipts. */
const STATUS_RECEIVED = 4;
const STATUS_SEEN = 5;

/**
 * Normalize a raw zca-js message event into the buffer's message shape.
 *
 * Classification comes from the shared `classifyLiveMessage`, the same
 * function the listener and the mobile sync use, so an agent reading
 * `zalo_get_messages` sees the same `type` vocabulary (`photo`, `video`,
 * `file`) as `msg history` and the same attachment fields — rather than the
 * raw `chat.photo` strings this used to emit, which never matched anything
 * else in the tool.
 *
 * @param {object} msg - Raw zca-js message event
 * @param {object} [info] - Pre-computed classification, when the caller has one
 * @returns {object} Normalized message
 */
export function normalizeMessage(msg, info = null) {
    const data = msg.data || {};
    const cls = info || classifyLiveMessage(data);
    const media = cls.attachments.find((a) => a.url || a.thumbUrl) || null;
    return {
        id: data.msgId,
        threadId: msg.threadId,
        threadType: msg.type === 0 ? "dm" : "group",
        senderId: data.uidFrom || null,
        senderName: data.dName || null,
        text: cls.text,
        // The message's own timestamp, not the moment we happened to process
        // it: buffer eviction is age-based, and Date.now() made every message
        // look brand new.
        timestamp: data.ts ? Number(data.ts) : Date.now(),
        type: cls.type,
        attachment: media
            ? {
                  type: cls.type,
                  url: media.url || media.thumbUrl || null,
                  description: media.title || null,
                  localPath: null,
              }
            : null,
        replyTo: null,
    };
}

/**
 * Fire-and-forget HTTP POST for an incoming buffered MCP message when a
 * webhook URL is configured (`-w, --webhook <url>` or `webhook` in
 * `mcp-config.json`). Never blocks or throws into the listener loop.
 *
 * @param {string|null} webhookUrl
 * @param {object} message - Normalized message object
 * @param {object} [extra] - Additional top-level fields (e.g. `{ accountId }`)
 * @param {Function} [fetchFn=fetch] - Injectable fetch for unit testing
 * @param {string|null} [webhookSecret=null] - Optional shared secret for Bearer auth & X-Zalo-Signature HMAC-SHA256
 * @returns {Promise<boolean>} True when dispatched, false when skipped or failed
 */
export async function postMCPWebhook(webhookUrl, message, extra = {}, fetchFn = fetch, webhookSecret = null) {
    if (!webhookUrl) return false;
    const payload = {
        event: "message",
        ...extra,
        ...message,
    };
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };
    if (typeof webhookSecret === "string" && webhookSecret.trim()) {
        const secret = webhookSecret.trim();
        headers["Authorization"] = `Bearer ${secret}`;
        headers["X-Zalo-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }
    try {
        await fetchFn(webhookUrl, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(5000),
        });
        return true;
    } catch (e) {
        console.error(`[mcp] Webhook failed: ${e.message}`);
        return false;
    }
}

/**
 * Validate and load TLS certificate & private key buffers from paths.
 * @param {string|null|undefined} rawCert
 * @param {string|null|undefined} rawKey
 * @param {boolean} hasHttpPort
 * @param {(msg: string) => never} fail
 * @returns {{ cert: Buffer, key: Buffer, certPath: string, keyPath: string }|null}
 */
function loadTlsOptions(rawCert, rawKey, hasHttpPort, fail) {
    if ((rawCert === undefined || rawCert === null) && (rawKey === undefined || rawKey === null)) {
        return null;
    }
    const certPath = typeof rawCert === "string" ? rawCert.trim() : "";
    const keyPath = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!certPath || !keyPath) {
        fail("Refusing to start: --cert and --key must both be provided to enable HTTPS.");
    }
    if (!hasHttpPort) {
        fail("Refusing to start: --cert and --key require --http <port>.");
    }
    let cert;
    let key;
    try {
        cert = readFileSync(certPath);
    } catch (e) {
        fail(`Refusing to start: cannot read the TLS certificate file ${certPath} (${e.code || e.message}).`);
    }
    try {
        key = readFileSync(keyPath);
    } catch (e) {
        fail(`Refusing to start: cannot read the TLS private key file ${keyPath} (${e.code || e.message}).`);
    }
    if (!cert.length || !key.length) {
        fail("Refusing to start: TLS certificate or private key file is empty.");
    }
    return { cert, key, certPath, keyPath };
}

export function registerMCPCommands(program) {
    const mcp = program.command("mcp").description("MCP server for AI agent integration");

    mcp.command("start")
        .option(
            "--account <id>",
            "Pin this server to an exact registered account ID (default: active at startup)",
            parseAccountId,
        )
        .description("Start MCP server (stdio, HTTP, or HTTPS transport)")
        .option("--config <path>", "Config file path (default: ~/.zalo-agent-cli/mcp-config.json)")
        .option("--http <port>", "Use HTTP/HTTPS transport on specified port (default: stdio)")
        .option("--auth <token>", "Bearer token for HTTP/HTTPS auth (or set ZALO_MCP_AUTH_TOKEN in .env)")
        .option("--host <address>", "HTTP/HTTPS bind address (default: 127.0.0.1, only with --http)")
        .option("--cert <path>", "TLS certificate file path (PEM) to serve HTTPS (requires --http and --key)")
        .option("--key <path>", "TLS private key file path (PEM) to serve HTTPS (requires --http and --cert)")
        .option(
            "--client-id <id>",
            "OAuth 2.0 Client ID for remote MCP clients like Gemini (default: zalo-mcp, or ZALO_MCP_OAUTH_CLIENT_ID)",
        )
        .option(
            "--client-secret <key>",
            "OAuth 2.0 Client Secret (defaults to --auth / ZALO_MCP_AUTH_TOKEN, or ZALO_MCP_OAUTH_CLIENT_SECRET)",
        )
        .option(
            "--issuer-url <url>",
            "Explicit OAuth 2.0 issuer base URL (e.g. https://mcp.example.com:3100; default: inferred from request Host)",
        )
        .option(
            "-w, --webhook <url>",
            "POST each watched incoming message as JSON to this URL (or set webhook in mcp-config.json)",
        )
        .option(
            "--webhook-secret <secret>",
            "Sign webhook POSTs: sent as `Authorization: Bearer <secret>` and `X-Zalo-Signature: sha256=<HMAC of the body>`. Prefer the ZALO_WEBHOOK_SECRET[_<ownId>] environment variable: a flag is visible in the process list (or set webhookSecret in mcp-config.json)",
        )
        .option(
            "--no-delivered-receipts",
            "Do not acknowledge received messages as delivered (every Zalo client does; seen receipts are never sent)",
        )
        .option(
            "--no-self-heal",
            "Do not pull what a dropped socket missed from Zalo's offline queue on reconnect (the default does, as Zalo Web does, on this socket and with no phone tap)",
        )
        .option("-d, --daemon", "Run in the background (requires --http <port>; logs to <accountDir>/daemon.log)")
        .option("--stop", "Stop the running background daemon for this account")
        .option("--status", "Show background daemon status for this account")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const isDaemonCli = Boolean(opts.status || opts.stop || (opts.daemon && !process.env.ZALO_DAEMON_CHILD));
            const failStart = (msg) => {
                if (isDaemonCli) error(msg);
                else console.error(`[mcp] ${msg}`);
                process.exit(1);
            };

            let config = null;
            let tlsOptions = null;
            if (!opts.status && !opts.stop) {
                // An empty --auth is a token that went missing -- an unset variable
                // in a unit file -- not a request for no auth, and it used to start
                // the server open, saying nothing. Refused before anything logs in.
                // The same for a webhook secret: empty must not mean "unsigned".
                if (opts.webhookSecret !== undefined) {
                    try {
                        resolveWebhookSecret({ flag: opts.webhookSecret });
                    } catch (e) {
                        failStart(e.message);
                    }
                }
                if (opts.http && opts.auth !== undefined && !String(opts.auth).trim()) {
                    failStart(
                        "--auth was given an empty token. Refusing to start: that would serve this account's " +
                            "messages with no authentication at all.",
                    );
                }

                // The config, read before anything logs in. A file it cannot use is
                // refused, not replaced by the defaults: they watch every thread, so
                // a server meant for one group would buffer every DM for its bots.
                const { config: loadedConfig, problem: configProblem } = readMCPConfig(opts.config);
                if (configProblem) {
                    failStart(`Refusing to start: ${configProblem}. Without it the defaults would watch every thread.`);
                }
                config = loadedConfig;

                const rawCert =
                    opts.cert !== undefined ? opts.cert : (process.env.ZALO_MCP_TLS_CERT ?? config?.tls?.cert);
                const rawKey = opts.key !== undefined ? opts.key : (process.env.ZALO_MCP_TLS_KEY ?? config?.tls?.key);
                tlsOptions = loadTlsOptions(rawCert, rawKey, Boolean(opts.http || config?.httpPort), failStart);
            }

            // Select account first so --status, --stop, and --daemon can use
            // standard CLI output before redirecting console.log for stdio MCP.
            let activeAcc;
            try {
                const requestedAccount =
                    opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
                activeAcc = selectDaemonAccount(requestedAccount);
            } catch (e) {
                if (isDaemonCli) {
                    error(`Account selection failed: ${e.message}`);
                } else {
                    console.error("[mcp] Account selection failed:", e.message);
                }
                process.exit(1);
            }
            const accountDir = getAccountDir(activeAcc.ownId);

            if (opts.status) {
                const status = getDaemonStatus(accountDir);
                output({ accountId: activeAcc.ownId, ...status }, jsonMode, () => {
                    if (status.running) {
                        success(
                            `Daemon running for account ${activeAcc.ownId} (PID ${status.pid}${status.channelPort ? `, channel 127.0.0.1:${status.channelPort}` : ""})`,
                        );
                        info(`Log file: ${status.logPath}`);
                    } else {
                        info(`No daemon running for account ${activeAcc.ownId}`);
                        info(`Log file: ${status.logPath}`);
                    }
                });
                return;
            }

            if (opts.stop) {
                const res = await stopDaemon(accountDir);
                output({ accountId: activeAcc.ownId, ...res }, jsonMode, () => {
                    if (res.stopped) {
                        success(
                            `Stopped daemon for account ${activeAcc.ownId} (PID ${res.pid}${res.graceful ? "" : ", forced"})`,
                        );
                    } else {
                        info(`No daemon running for account ${activeAcc.ownId}`);
                    }
                });
                return;
            }

            // Merge per-account config (`config.accounts[ownId]` and `<accountDir>/mcp-config.json`)
            const { config: accountConfig, problem: accountProblem } = resolveAccountMCPConfig(config, {
                accountId: activeAcc.ownId,
                accountDir,
                explicitConfigPath: opts.config,
            });
            if (accountProblem) {
                failStart(`Refusing to start: ${accountProblem}.`);
            }
            config = accountConfig;

            const effectiveHttpPort =
                opts.http ?? envForAccount("ZALO_MCP_HTTP_PORT", activeAcc.ownId) ?? config?.httpPort ?? null;

            if (!tlsOptions) {
                const acctCert = envForAccount("ZALO_MCP_TLS_CERT", activeAcc.ownId) ?? config?.tls?.cert;
                const acctKey = envForAccount("ZALO_MCP_TLS_KEY", activeAcc.ownId) ?? config?.tls?.key;
                tlsOptions = loadTlsOptions(acctCert, acctKey, Boolean(effectiveHttpPort), failStart);
            }

            if (opts.daemon && !process.env.ZALO_DAEMON_CHILD) {
                if (!effectiveHttpPort) {
                    error(
                        "`mcp start --daemon` requires `--http <port>` (stdio transport cannot run detached in the background).",
                    );
                    process.exit(1);
                }
                const port = Number(effectiveHttpPort);
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    error(`Invalid port: ${effectiveHttpPort}. Must be 1-65535.`);
                    process.exit(1);
                }
                const spawned = await spawnDaemonProcess({ accountDir, args: process.argv.slice(1) });
                if (!spawned.ok) {
                    if (spawned.alreadyRunning) {
                        error(
                            `Another listener (listen daemon or MCP server) is already running for account ${activeAcc.ownId} (PID ${spawned.pid}).`,
                        );
                        info("Stop it first with: zalo-agent mcp start --stop");
                    } else {
                        error(`Failed to start background MCP server: ${spawned.error}`);
                        info(`Log file: ${spawned.logPath}`);
                    }
                    process.exit(1);
                }
                const scheme = tlsOptions ? "HTTPS" : "HTTP";
                output(
                    {
                        accountId: activeAcc.ownId,
                        pid: spawned.pid,
                        httpPort: port,
                        https: Boolean(tlsOptions),
                        channelPort: spawned.channelPort,
                        logPath: spawned.logPath,
                    },
                    jsonMode,
                    () => {
                        success(
                            `MCP server started in background for account ${activeAcc.ownId} (PID ${spawned.pid}, ${scheme} port ${port})`,
                        );
                        info(`Log file: ${spawned.logPath}`);
                        info("Stop with: zalo-agent mcp start --stop");
                    },
                );
                return;
            }

            // Safety net: redirect ALL console.log to stderr for the entire MCP process.
            // Stdout is the MCP JSON-RPC transport — any non-JSON output corrupts the stream.
            // This catches rogue prints from dependencies (zca-js, chalk, etc.) that we can't control.
            console.log = (...args) => console.error(...args);

            // This server now opens the account's WebSocket *and* writes to
            // zalo.db, which is exactly what the `listen` daemon does. Zalo
            // allows one web session per account and the cache allows one
            // writer, so the lock that used to guard only `listen` has to guard
            // this too — previously both could start, and Zalo silently killed
            // one of the two sockets.
            if (!acquireLock(accountDir)) {
                console.error(
                    `[mcp] Another listener (listen daemon or MCP server) is already running for account ${activeAcc.ownId}.`,
                );
                console.error("[mcp] Stop it first — Zalo permits one web session per account.");
                process.exit(1);
            }
            let lockHeld = true;
            // Torn down with the lock, and from the same single place, so no
            // exit path can leave a channel descriptor pointing at a dead port.
            let channel = null;
            const dropLock = () => {
                if (!lockHeld) return;
                lockHeld = false;
                try {
                    channel?.stop();
                } catch (e) {
                    console.error(`[mcp] Failed to close upload channel: ${e.message}`);
                }
                try {
                    releaseLock(accountDir);
                } catch (e) {
                    console.error(`[mcp] Failed to release lock: ${e.message}`);
                }
            };

            try {
                await loginDaemonAccount(activeAcc);
            } catch (e) {
                dropLock();
                console.error("[mcp] Pinned account login failed:", e.message);
                process.exit(1);
            }
            try {
                initDb(join(accountDir, "zalo.db"));
                console.error(`[mcp] Local cache: ${join(accountDir, "zalo.db")}`);
            } catch (e) {
                dropLock();
                console.error(`[mcp] Failed to initialize local DB: ${e.message}`);
                process.exit(1);
            }

            console.error("[mcp] Config loaded:", JSON.stringify(config.limits));

            // Build buffer + filter from config
            const maxAge = parseDuration(config.limits?.bufferMaxAge ?? "2h");
            const maxSize = config.limits?.bufferMaxSize ?? 500;
            const buffer = new MessageBuffer(maxSize, maxAge);
            const filter = new ThreadFilter(config);

            // Build thread name cache (groups + friends → in-memory index)
            const nameCache = new ThreadNameCache();
            try {
                await nameCache.init(getApi());
            } catch (e) {
                console.error("[mcp] Thread name cache init failed (non-fatal):", e.message);
            }

            // One stage at a time on this socket, shared by the sync routes, the
            // self-heal catch-up and the tools' own history fetch. Created before
            // the server so the tools can hold it too.
            const onSelfName = (name) => updateAccountName(activeAcc.ownId, name);
            const stageLock = createStageLock();
            // What daemon.log learns beyond one-line events: every stage's progress (the restore used to
            // report only to the caller), the event loop's stalls (a blocked loop cannot answer the socket's
            // pings, and a bare close 1006 says nothing else), and what Zalo said when a lookup was refused.
            const daemonLog = (m) => console.error(`[mcp] ${m}`);
            const loopMonitor = startEventLoopMonitor({
                log: daemonLog,
                context: () => {
                    const held = stageLock.current();
                    return held ? `the ${held.stage} stage was running` : "";
                },
            });
            const socketContext = createSocketContext({ lock: stageLock, monitor: loopMonitor });
            setUserInfoLogger(daemonLog);
            const syncRunners = createSyncRunners({
                getApi,
                accountName: activeAcc.ownId,
                log: daemonLog,
                monitor: loopMonitor,
                onSelfName,
                onMessagesRestored: () => {
                    for (const [tid, info] of getThreadNames()) {
                        if (info?.name) {
                            nameCache.set(tid, { name: info.name, type: info.type === "group" ? "group" : "dm" });
                        }
                    }
                },
            });
            const syncJobs = createSyncJobs({ runners: syncRunners, lock: stageLock });
            syncJobs.onSelfName = onSelfName;

            // What the tools and the notifier call. Not getApi()'s object:
            // a re-login after a dropped connection replaces it, and they
            // would keep the dead one (src/core/live-api.js).
            const sessionApi = liveApi(getApi, {
                unavailable:
                    "The Zalo session is logging in again after a dropped connection; try again in a few seconds.",
            });

            // Start MCP server — stdio (default) or HTTP/HTTPS
            let httpServer = null;
            try {
                if (effectiveHttpPort) {
                    const port = Number(effectiveHttpPort);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) {
                        dropLock();
                        console.error(`[mcp] Invalid port: ${effectiveHttpPort}. Must be 1-65535.`);
                        process.exit(1);
                    }
                    const host =
                        opts.host || envForAccount("ZALO_MCP_HOST", activeAcc.ownId) || config?.host || "127.0.0.1";
                    const deps = {
                        api: sessionApi,
                        buffer,
                        filter,
                        config,
                        nameCache,
                        accountDir,
                        stageLock,
                        syncJobs,
                    };
                    const authToken =
                        opts.auth?.trim() ||
                        envForAccount("ZALO_MCP_AUTH_TOKEN", activeAcc.ownId) ||
                        envForAccount("ZALO_MCP_OAUTH_CLIENT_SECRET", activeAcc.ownId) ||
                        config?.oauth?.clientSecret?.trim() ||
                        null;
                    const oauthClientId =
                        opts.clientId?.trim() ||
                        envForAccount("ZALO_MCP_OAUTH_CLIENT_ID", activeAcc.ownId) ||
                        config?.oauth?.clientId?.trim() ||
                        "zalo-mcp";
                    const oauthClientSecret =
                        opts.clientSecret?.trim() ||
                        envForAccount("ZALO_MCP_OAUTH_CLIENT_SECRET", activeAcc.ownId) ||
                        config?.oauth?.clientSecret?.trim() ||
                        authToken;
                    const oauthIssuerUrl =
                        opts.issuerUrl?.trim() ||
                        envForAccount("ZALO_MCP_ISSUER_URL", activeAcc.ownId) ||
                        config?.oauth?.issuerUrl?.trim() ||
                        null;
                    const oauthClients = Array.isArray(config?.oauth?.clients) ? config.oauth.clients : [];
                    const oauthOptions =
                        oauthClientSecret || oauthClients.length > 0
                            ? {
                                  clientId: oauthClientId,
                                  clientSecret: oauthClientSecret,
                                  issuerUrl: oauthIssuerUrl,
                                  clients: oauthClients,
                              }
                            : null;
                    const scheme = tlsOptions ? "HTTPS" : "HTTP";
                    httpServer = createHTTPServer(registerTools, deps, port, authToken, host, tlsOptions, oauthOptions);
                    console.error(`[mcp] ${scheme} server started on port ${port}`);
                    if (!authToken && !oauthClientSecret && oauthClients.length === 0) {
                        console.error(
                            `[mcp] WARNING: no --auth token. Anyone who can reach ${host}:${port} can read this ` +
                                "account's messages and send as it.",
                        );
                    }
                } else {
                    await createMCPServer(
                        sessionApi,
                        buffer,
                        filter,
                        config,
                        nameCache,
                        accountDir,
                        stageLock,
                        syncJobs,
                    );
                }
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start MCP server:", e.message);
                process.exit(1);
            }

            // Setup notifier (sends to Zalo group when agent is offline)
            const notifier = new ZaloNotifier(sessionApi, config);
            const webhookUrl =
                opts.webhook?.trim() ||
                envForAccount("ZALO_WEBHOOK_URL", activeAcc.ownId) ||
                config.webhook?.trim() ||
                null;
            const webhookSecret = resolveWebhookSecret({
                flag: opts.webhookSecret,
                env: envForAccount("ZALO_WEBHOOK_SECRET", activeAcc.ownId),
                config: config?.webhookSecret,
            });
            if (webhookSecret && !webhookUrl) {
                console.error("[mcp] A webhook secret is set but no webhook URL: nothing will be signed or sent.");
            }
            if (webhookUrl) {
                console.error(`[mcp] Webhook enabled: ${webhookUrl}${webhookSecret ? " (signed)" : ""}`);
            }

            // Delivered receipts: the same shared implementation `listen` uses
            // (AGENTS.md §13 -- the two listeners must not differ). Diagnostics
            // go to stderr only; stdout is the JSON-RPC stream. Seen receipts
            // are never sent from here: zalo_mark_read moves a local cursor only.
            const deliveredReceipts = createDeliveredReceipts({
                getApi,
                enabled: opts.deliveredReceipts !== false,
                log: (line) => console.error(`[mcp] ${line}`),
            });
            console.error(
                opts.deliveredReceipts !== false
                    ? "[mcp] Delivered receipts: ON (opt out with --no-delivered-receipts). Seen receipts: never sent."
                    : "[mcp] Delivered receipts: OFF. Seen receipts: never sent.",
            );

            let reconnectCount = 0;

            // `listen` and `mcp start` are two entry points to the SAME socket,
            // so `mcp start` gets the same coverage bookkeeping. Without it an
            // agent-driven install that only ever runs this command had zero
            // loss detection, and because it never wrote lastConnectedAt a later
            // `listen` filed a bogus 14-day gap over a covered window.
            const syncManager = new SyncManager(getApi(), activeAcc.ownId);
            const reportGap = (fromTs, reason) => {
                if (!fromTs) return false;
                // recordGap(from, to, reason) -- it has a 1-second floor and
                // returns null under it, which is not a gap worth announcing.
                const gapId = syncManager.recordGap(fromTs, Date.now(), reason);
                if (!gapId) return false;
                const since = new Date(fromTs).toISOString();
                console.error(
                    opts.selfHeal !== false
                        ? `[mcp] Coverage gap (${reason}) since ${since}: recovering it now from Zalo's offline ` +
                              "queue on this socket (no phone tap); whatever that cannot reach stays pending for: " +
                              `zalo-agent sync --from ${since.slice(0, 10)}`
                        : `[mcp] Coverage gap (${reason}): messages between ${since} and now are not in the local ` +
                              `cache. Close it with: zalo-agent sync --from ${since.slice(0, 10)}`,
                );
                return true;
            };
            const lifecycle = createGapTracker({ syncManager, reportGap });

            // Same startup check `listen` does: a window between the last
            // recorded connection and now is unobserved until something says so.
            if (!reportGap(syncManager.getLastConnectedAt(), "startup-gap")) {
                syncManager.markConnected();
            }
            const pending = getPendingSyncGaps();
            if (pending.length > 0) {
                console.error(
                    opts.selfHeal !== false
                        ? `[mcp] ${pending.length} coverage gap(s) pending — the self-heal closes what Zalo's offline ` +
                              "queue still holds once connected; `zalo-agent sync` closes the rest."
                        : `[mcp] ${pending.length} coverage gap(s) pending — run \`zalo-agent sync\` to close them.`,
                );
            }
            const mcpHeartbeatTimer = setInterval(() => lifecycle.heartbeat(), HEARTBEAT_MS);

            // The same catch-up `listen` runs (AGENTS.md §13): one stage at a
            // time on this socket, a raw reader for the fields zca-js drops, and
            // the offline-queue pull on every handshake (src/core/self-heal.js).
            // `stageLock` is the one created before the server above.
            const socketTap = createSocketTap({ log: (line) => console.error(`[mcp] ${line}`) });
            // The read state other devices report, stored exactly as `listen`
            // stores it, so a thread the human read on the phone stops
            // looking unread (src/core/read-state.js).
            createReadStateSync({ tap: socketTap, log: (line) => console.error(`[mcp] ${line}`) });
            const selfHeal = createSelfHeal({
                getApi,
                tap: socketTap,
                lock: stageLock,
                enabled: opts.selfHeal !== false,
                log: (line) => console.error(`[mcp] ${line}`),
                // A bot must see what arrived while the socket was down, as it
                // would have seen it live -- same filters, flagged as catch-up.
                onRecovered: (items) => {
                    for (const { msg, info } of items) {
                        if (info?.hasAttachment) fetchMedia(String(msg.threadId));
                        if (msg.isSelf) continue;
                        const normalized = { ...normalizeMessage(msg, info), catchUp: true };
                        if (!filter.shouldWatch(normalized.threadId, normalized.threadType)) continue;
                        if (!filter.shouldKeep(normalized)) continue;
                        buffer.push(normalized.threadId, normalized);
                        notifier.onMessage(normalized);
                        postMCPWebhook(webhookUrl, normalized, { accountId: activeAcc.ownId }, fetch, webhookSecret);
                    }
                },
            });
            console.error(
                opts.selfHeal !== false
                    ? "[mcp] Self-heal: ON — after a drop or restart, missed messages come back from Zalo's offline queue on this socket, no phone tap (opt out with --no-self-heal)."
                    : "[mcp] Self-heal: OFF — a coverage gap stays pending until `zalo-agent sync` closes it.",
            );

            /**
             * Fetch a message's attachments into the same per-conversation
             * folders every other command uses. Fire-and-forget.
             * @param {string} threadId
             */
            function fetchMedia(threadId) {
                downloadSyncedMedia({
                    api: getApi(),
                    accountDir,
                    threadId,
                    limit: 5,
                    concurrency: 2,
                    mediaRoot: MEDIA_DIR || config.media?.downloadDir || undefined,
                }).catch((e) => console.error(`[mcp] media download failed: ${e.message}`));
            }

            /**
             * Attach Zalo listener handlers to the current API instance.
             * Must be called again after each re-login with the new API instance.
             * @param {object} api - zca-js API instance
             */
            function attachListenerHandlers(api) {
                api.listener.on("message", (msg) => {
                    // Persist FIRST and unconditionally. The buffer is what an
                    // agent polls; the cache is the durable record, and it must
                    // not depend on whether a thread happens to be watched or
                    // whether a message survives the noise filter. This server
                    // used to hold everything in memory only, so a restart lost
                    // every message it had ever seen.
                    const cachedThread = nameCache?.get(String(msg.threadId));
                    const threadName = cachedThread?.type === "group" ? cachedThread.name || undefined : undefined;
                    const stored = storeLiveMessage(msg, { threadName });
                    // A "delete for me" frame removes a message; it must not be
                    // buffered as one for an agent to read.
                    if (stored.removal) {
                        const r = stored.removal;
                        if (r.stored) console.error(`[mcp] deleted for me: ${r.msgId}`);
                        else console.error(`[mcp] delete-for-me not applied: ${r.reason}`);
                        return;
                    }
                    if (!stored.stored) {
                        console.error(`[mcp] message not stored: ${stored.reason}`);
                        return;
                    }
                    refreshLiveMessageIdentities(api, msg, {
                        onSelfName,
                        nameCache,
                        log: (line) => console.error(`[mcp] ${line}`),
                    }).catch((e) => console.error(`[mcp] identity refresh failed: ${e.message}`));
                    if (stored.info.hasAttachment) fetchMedia(String(msg.threadId));

                    // Skip self-sent messages for the agent-facing buffer
                    if (msg.isSelf) return;

                    const normalized = normalizeMessage(msg, stored.info);

                    // Apply thread watch filter
                    if (!filter.shouldWatch(normalized.threadId, normalized.threadType)) return;

                    // Apply noise filter (stickers, system msgs, short emoji)
                    if (!filter.shouldKeep(normalized)) return;

                    buffer.push(normalized.threadId, normalized);
                    notifier.onMessage(normalized);
                    postMCPWebhook(webhookUrl, normalized, { accountId: activeAcc.ownId }, fetch, webhookSecret);
                    console.error(`[mcp] Buffered ${normalized.threadType} msg from ${normalized.threadId}`);
                });

                // After the storing handler, exactly as in `listen`: the write
                // always runs first, and the receipt handler only queues. Here
                // because re-login calls this function again with a new listener.
                deliveredReceipts.attach(api.listener);

                // Likewise, and for the same two reasons: the self-heal moves its
                // cursor only past a row already written, and a tap left on the
                // old listener after a re-login would go deaf.
                socketTap.attach(api.listener);
                selfHeal.attach(api.listener);

                // Everything below is durable state that exists only on this
                // socket, so it is stored regardless of the watch filter — the
                // filter decides what an agent is shown, not what is kept.
                api.listener.on("reaction", (reaction) => {
                    const r = storeLiveReaction(reaction);
                    if (!r.stored && r.reason) console.error(`[mcp] reaction not stored: ${r.reason}`);
                });

                api.listener.on("undo", (u) => {
                    const r = storeLiveUndo(u);
                    if (!r.stored && r.reason) console.error(`[mcp] recall not applied: ${r.reason}`);
                });

                api.listener.on("delivered_messages", (m) => storeReceipts(m, STATUS_RECEIVED));
                api.listener.on("seen_messages", (m) => storeReceipts(m, STATUS_SEEN));

                api.listener.on("group_event", (event) => {
                    noteBoardChange(event);
                    storeGroupEventRow(event);
                    const groupName = typeof event?.data?.groupName === "string" ? event.data.groupName.trim() : "";
                    if (groupName && event?.threadId !== undefined && event?.threadId !== null) {
                        const tid = String(event.threadId);
                        if (String(event?.type || "").toLowerCase() === "update" || !nameCache?.get(tid)?.name) {
                            nameCache?.set(tid, { name: groupName, type: "group" });
                        }
                    }
                    // Same call as `listen`: our uid tells being removed from
                    // removing someone else, and a later event clears the flag.
                    const gone = storeGroupEvent(event, { ownId: activeAcc.ownId });
                    if (gone.gone) console.error(`[mcp] no longer in ${gone.threadId} — local history orphaned`);
                });

                api.listener.on("connected", () => {
                    socketContext.markUp();
                    if (reconnectCount > 0) {
                        console.error(`[mcp] Reconnected (#${reconnectCount})`);
                    }
                    lifecycle.noteUp();
                });

                api.listener.on("disconnected", (code) => {
                    if (lifecycle.isStopping()) return;
                    console.error(`[mcp] Disconnected (code: ${code}). Auto-retrying... (${socketContext.describe()})`);
                    lifecycle.noteDown();
                });

                api.listener.on("closed", async (code) => {
                    if (lifecycle.isStopping()) return;
                    lifecycle.noteDown();
                    if (code === CLOSE_DUPLICATE) {
                        dropLock();
                        console.error("[mcp] Duplicate Zalo Web session detected. Exiting.");
                        process.exit(1);
                    }
                    reconnectCount++;
                    console.error(
                        `[mcp] Connection closed (code: ${code}). Re-login in 5s... (reconnect #${reconnectCount}; ${socketContext.describe()})`,
                    );
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        clearSession();
                        await loginDaemonAccount(activeAcc);
                        console.error("[mcp] Re-login successful. Restarting listener...");
                        const newApi = getApi();
                        attachListenerHandlers(newApi);
                        newApi.listener.start({ retryOnClose: true });
                    } catch (e) {
                        console.error(`[mcp] Re-login failed: ${e.message}. Retrying in 30s...`);
                        await new Promise((r) => setTimeout(r, 30000));
                        try {
                            clearSession();
                            await loginDaemonAccount(activeAcc);
                            const retryApi = getApi();
                            attachListenerHandlers(retryApi);
                            retryApi.listener.start({ retryOnClose: true });
                            console.error("[mcp] Re-login successful on retry.");
                        } catch (e2) {
                            dropLock();
                            console.error(`[mcp] Re-login retry failed: ${e2.message}. Exiting.`);
                            process.exit(1);
                        }
                    }
                });

                api.listener.on("error", () => {
                    // WS errors are followed by close/disconnect — suppress to avoid noise
                });
            }

            const shutdown = () => {
                // First, before listener.stop() emits closed(1000) -- otherwise
                // the shutdown is indistinguishable from a drop and files a gap
                // for a window nothing was missed in.
                lifecycle.setStopping();
                clearInterval(mcpHeartbeatTimer);
                deliveredReceipts.stop();
                const receipts = deliveredReceipts.stats();
                if (receipts.calls) {
                    console.error(`[mcp] Delivered receipts: ${receipts.sent} acknowledged, ${receipts.failed} failed`);
                }
                try {
                    syncManager.markConnected();
                } catch (e) {
                    console.error(`[mcp] Failed to stamp shutdown state: ${e.message}`);
                }
                try {
                    getApi().listener.stop();
                } catch {
                    /* already stopped */
                }
                notifier?.destroy();
                httpServer?.close();
                dropLock();
                process.exit(0);
            };

            // Wire listener and start
            try {
                const api = getApi();
                attachListenerHandlers(api);
                api.listener.start({ retryOnClose: true });
                console.error("[mcp] Zalo listener started. MCP server ready.");
                // This process holds the account's one permitted socket, so it
                // performs the work that needs one on behalf of the CLI:
                // attachment uploads, and the socket stages of `zalo-agent
                // sync`. Otherwise `msg send-file` opens a second session and
                // Zalo kills this one, and a sync cannot run at all while this
                // server is up. Best-effort: a failed channel only costs the
                // fallback. `getApi` rather than an api, because a
                // duplicate-session close rebuilds it under us.
                try {
                    channel = await startDaemonChannel({
                        getApi,
                        accountDir,
                        onLog: (m) => console.error(`[mcp] ${m}`),
                        runners: syncRunners,
                        // The self-heal's lock: a stage and a catch-up never share the socket.
                        lock: stageLock,
                        onStop: shutdown,
                        onWait: async (params, signal) => {
                            const cleanThreadId =
                                typeof params?.threadId === "string" && params.threadId.trim()
                                    ? params.threadId.trim()
                                    : null;
                            const consumer =
                                typeof params?.consumer === "string" && params.consumer.trim()
                                    ? params.consumer.trim()
                                    : undefined;
                            const clampedSec = Math.max(1, Math.min(300, Number(params?.timeoutSec) || 55));
                            const explicitSince =
                                typeof params?.since === "number" && Number.isFinite(params.since)
                                    ? params.since
                                    : undefined;
                            const effectiveSince =
                                explicitSince !== undefined
                                    ? explicitSince
                                    : consumer
                                      ? buffer.readCursor(consumer)
                                      : undefined;
                            const msg = await buffer.waitForMessage({
                                threadId: cleanThreadId,
                                since: effectiveSince,
                                timeoutMs: clampedSec * 1000,
                                signal,
                            });
                            if (msg) {
                                const tid = String(msg.threadId || "");
                                const threadName = nameCache?.get(tid)?.name || null;
                                return {
                                    status: "message",
                                    message: {
                                        ...msg,
                                        ...(threadName ? { threadName } : {}),
                                    },
                                    cursor: msg._cursor,
                                };
                            }
                            return {
                                status: "timeout",
                                message: null,
                                cursor: Math.max(
                                    effectiveSince ?? 0,
                                    Number(buffer._globalCursor) || 0,
                                    buffer.readCursor(consumer),
                                ),
                            };
                        },
                        onMarkRead: async (params) => {
                            const cursorNum = Number(params?.cursor);
                            if (!Number.isInteger(cursorNum) || cursorNum < 0) {
                                throw new Error("cursor must be a non-negative integer");
                            }
                            const consumer =
                                typeof params?.consumer === "string" && params.consumer.trim()
                                    ? params.consumer.trim()
                                    : undefined;
                            const marked = buffer.markRead(cursorNum, consumer);
                            return {
                                marked,
                                readCursor: buffer.readCursor(consumer),
                                consumer: consumer || "default",
                            };
                        },
                    });
                    console.error(`[mcp] Sync & upload channel ready on 127.0.0.1:${channel.port}`);
                } catch (e) {
                    console.error(`[mcp] Daemon channel unavailable: ${e.message}`);
                    console.error("[mcp] Attachment sends open their own session, and `zalo-agent sync` will refuse.");
                }
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start listener:", e.message);
                process.exit(1);
            }

            // Graceful shutdown on SIGINT / SIGTERM
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
            // A lock outliving its process blocks the next launch until the
            // stale-PID check reclaims it, so release it on any exit path.
            process.on("exit", dropLock);

            // Keep process alive (MCP server runs on stdio — process must not exit)
            await new Promise(() => {});
        });

    mcp.command("wait [since]")
        .description(
            "Zero-CPU long-poll on the running MCP server's live message buffer (CLI equivalent of zalo_wait_for_message)",
        )
        .option("--account <id>", "Target a specific registered account ID (default: active account)", parseAccountId)
        .option("-s, --since <cursor>", "Return immediately if a buffered message after this cursor already exists")
        .option("-t, --thread <threadId>", "Only wake on messages from this thread ID")
        .option("--timeout <seconds>", "Maximum seconds to wait before returning timeout (1-300, default: 55)", "55")
        .option(
            "-c, --consumer <name>",
            "Consumer name whose read cursor is used when --since is omitted (matches zalo_mark_read)",
        )
        .action(async (sinceArg, opts) => {
            const jsonMode = program.opts().json;
            const rawSince = opts.since !== undefined ? opts.since : sinceArg;
            let parsedSince;
            if (rawSince !== undefined) {
                const n = Number(rawSince);
                if (!Number.isInteger(n) || n < 0 || !/^\d+$/.test(String(rawSince).trim())) {
                    error(`Invalid cursor "${rawSince}": must be a non-negative integer.`);
                    process.exit(1);
                }
                parsedSince = n;
            }
            const rawTimeout = Number(opts.timeout);
            if (!Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 300) {
                error(`Invalid --timeout "${opts.timeout}": must be an integer between 1 and 300 seconds.`);
                process.exit(1);
            }
            const consumer = opts.consumer?.trim() || undefined;
            if (consumer && !/^[A-Za-z0-9._:@-]{1,64}$/.test(consumer)) {
                error(`Invalid --consumer "${consumer}": must be 1-64 characters matching [A-Za-z0-9._:@-].`);
                process.exit(1);
            }

            let activeAcc;
            try {
                const requestedAccount =
                    opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
                activeAcc = selectDaemonAccount(requestedAccount);
            } catch (e) {
                error(`Account selection failed: ${e.message}`);
                process.exit(1);
            }
            const accountDir = getAccountDir(activeAcc.ownId);
            const res = await waitViaDaemon(accountDir, {
                threadId: opts.thread?.trim() || null,
                since: parsedSince,
                timeoutSec: rawTimeout,
                consumer,
            });
            if (!res) {
                error(
                    `No running MCP server found for account ${activeAcc.ownId}. Start one with: zalo-agent mcp start`,
                );
                process.exit(1);
            }
            if (!res.ok) {
                error(`Wait failed: ${res.error}`);
                process.exit(1);
            }
            output(
                {
                    status: res.status,
                    message: res.message,
                    cursor: res.cursor,
                },
                jsonMode,
                () => {
                    if (res.status === "message" && res.message) {
                        const m = res.message;
                        const label = m.threadName ? `${m.threadName} (${m.threadId})` : m.threadId;
                        success(
                            `[cursor ${res.cursor}] ${m.senderName || m.senderId} in ${label}: ${m.text || `(${m.type})`}`,
                        );
                    } else {
                        info(`Timeout after ${rawTimeout}s (cursor: ${res.cursor})`);
                    }
                },
            );
        });

    mcp.command("mark-read <cursor>")
        .description(
            "Advance a consumer's read cursor in the running MCP server's live buffer (CLI equivalent of zalo_mark_read)",
        )
        .option("--account <id>", "Target a specific registered account ID (default: active account)", parseAccountId)
        .option(
            "-c, --consumer <name>",
            'Consumer name whose read cursor to advance (default: "default"; deletes nothing for other consumers)',
        )
        .action(async (cursorArg, opts) => {
            const jsonMode = program.opts().json;
            const trimmedCursor = String(cursorArg ?? "").trim();
            const parsedCursor = Number(trimmedCursor);
            if (!Number.isInteger(parsedCursor) || parsedCursor < 0 || !/^\d+$/.test(trimmedCursor)) {
                error(`Invalid cursor "${cursorArg}": must be a non-negative integer.`);
                process.exit(1);
            }
            const consumer = opts.consumer?.trim() || undefined;
            if (consumer && !/^[A-Za-z0-9._:@-]{1,64}$/.test(consumer)) {
                error(`Invalid --consumer "${consumer}": must be 1-64 characters matching [A-Za-z0-9._:@-].`);
                process.exit(1);
            }

            let activeAcc;
            try {
                const requestedAccount =
                    opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
                activeAcc = selectDaemonAccount(requestedAccount);
            } catch (e) {
                error(`Account selection failed: ${e.message}`);
                process.exit(1);
            }
            const accountDir = getAccountDir(activeAcc.ownId);
            const res = await markReadViaDaemon(accountDir, {
                cursor: parsedCursor,
                consumer,
            });
            if (!res) {
                error(
                    `No running MCP server found for account ${activeAcc.ownId}. Start one with: zalo-agent mcp start`,
                );
                process.exit(1);
            }
            if (!res.ok) {
                error(`Mark-read failed: ${res.error}`);
                process.exit(1);
            }
            output(
                {
                    success: true,
                    marked: res.marked,
                    readCursor: res.readCursor,
                    consumer: res.consumer,
                },
                jsonMode,
                () => {
                    success(
                        `Marked ${res.marked} message(s) read for consumer "${res.consumer}" (readCursor: ${res.readCursor})`,
                    );
                },
            );
        });
}
