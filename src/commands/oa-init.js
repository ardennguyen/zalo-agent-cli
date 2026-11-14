/**
 * OA setup wizard — works in both interactive (human) and non-interactive (agent) mode.
 *
 * Interactive (default):
 *   zalo-agent oa init
 *
 * Non-interactive (for coding agents like Claude Code, Codex):
 *   zalo-agent oa init --app-id <id> --secret <key> --tunnel ngrok --port 3000
 *   zalo-agent oa init --app-id <id> --secret <key> --webhook-url https://your-server.com/webhook
 *   zalo-agent oa init --app-id <id> --secret <key> --skip-webhook
 *   zalo-agent --json oa init --app-id <id> --secret <key> --skip-webhook
 */

import { createServer } from "node:http";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { exec, execFile } from "node:child_process";
import { saveOACreds, loadOACreds, getOAProfile } from "../core/oa-client.js";
import { startOAuthLogin, openInBrowser } from "../core/oa/oauth.js";
import {
    readWebhookBody,
    verifyZaloSignature,
    signatureFromHeaders,
    eventUser,
    domainVerification,
} from "./oa-listen.js";
import { success, error, info, warning, output } from "../utils/output.js";

/** Prompt user for input. In agent mode, returns the provided default. */
function ask(question, agentMode, defaultValue = "") {
    if (agentMode) return Promise.resolve(defaultValue);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim() || defaultValue);
        });
    });
}

/** Wait for Enter in interactive mode, skip in agent mode. */
async function waitForEnter(msg, agentMode) {
    if (agentMode) return;
    await ask(`\n  ${msg}`, false);
}

/** Check if a CLI tool exists (`where` on Windows, `which` elsewhere). */
function hasCli(name) {
    const finder = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => execFile(finder, [name], (err) => resolve(!err)));
}

/** Run the OAuth login flow (PKCE + state, callback on 127.0.0.1) and wait for the browser's redirect. */
async function runOAuthLogin(appId, secretKey, oaId, callbackPort = 3456) {
    const flow = startOAuthLogin({ appId, secretKey, port: callbackPort, oaId });
    openInBrowser(flow.authUrl);
    const { tokenData } = await flow.done;
    return tokenData;
}

/**
 * The wizard's webhook listener, with domain verification support. Bodies are capped at 1 MB; with the OA secret
 * key each event's X-ZEvent-Signature is checked the documented way (src/commands/oa-listen.js) and a bad one gets
 * 401. Without it events are printed unverified (the tunnel URL is public: anyone who knows it can post).
 *
 * @param {string} oaId
 * @param {{ oaSecret?: string }} [opts]
 * @returns {import("node:http").Server}
 */
export function createWebhookServer(oaId, { oaSecret } = {}) {
    return createServer(async (req, res) => {
        // Domain verification: what Zalo handed out, saved by the wizard (read per request: it may be saved after
        // the server starts)
        const creds = loadOACreds(oaId);
        try {
            const verification = domainVerification({ file: creds?.verifyFile, meta: creds?.verifyMeta });
            if (verification?.(req, res)) return;
        } catch {
            // a saved file that is gone: answer as if nothing were configured
        }
        if (req.method === "GET" && req.url === "/") {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Zalo OA webhook");
            return;
        }

        if (req.method === "POST" && req.url?.startsWith("/webhook")) {
            const raw = await readWebhookBody(req, res);
            if (raw === null) return;
            if (oaSecret) {
                const check = verifyZaloSignature(raw, signatureFromHeaders(req.headers), oaSecret, {
                    appId: loadOACreds(oaId)?.appId,
                });
                if (!check.ok) {
                    warning(`Rejected an event: ${check.reason}`);
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end('{"error":"Invalid signature"}');
                    return;
                }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"status":"ok"}');
            try {
                const event = JSON.parse(raw.toString("utf8"));
                const eventName = event.event_name || "unknown";
                const who = eventUser(event);
                const tag = oaSecret ? "" : " (unverified)";
                if (eventName === "user_send_text") info(`[text] ${who}: ${event.message?.text || ""}${tag}`);
                else info(`[${eventName}] from ${who}${tag}`);
            } catch {
                /* test ping */
            }
            return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
    });
}

/** Start ngrok or cloudflared tunnel and return the public URL. */
async function startTunnel(tunnelCmd, port) {
    if (tunnelCmd === "ngrok") {
        return new Promise((resolve, reject) => {
            const proc = exec(`ngrok http ${port} --log stdout --log-format json`);
            let resolved = false;
            proc.stdout.on("data", (data) => {
                if (resolved) return;
                const match = data.match(/"url":"(https:\/\/[^"]+)"/);
                if (match) {
                    resolved = true;
                    resolve(match[1]);
                }
            });
            setTimeout(() => {
                if (!resolved) reject(new Error("ngrok timeout"));
            }, 10000);
        });
    }
    // cloudflared
    return new Promise((resolve, reject) => {
        const proc = exec(`cloudflared tunnel --url http://localhost:${port}`);
        let resolved = false;
        const handler = (data) => {
            if (resolved) return;
            const match = data.toString().match(/(https:\/\/[^\s]+\.trycloudflare\.com)/);
            if (match) {
                resolved = true;
                resolve(match[1]);
            }
        };
        proc.stdout.on("data", handler);
        proc.stderr.on("data", handler);
        setTimeout(() => {
            if (!resolved) reject(new Error("cloudflared timeout"));
        }, 15000);
    });
}

export function registerOAInitCommand(oaCommand, program) {
    oaCommand
        .command("init")
        .description("Setup wizard for Zalo OA — works interactive (human) and non-interactive (agent)")
        .option("--oa-id <id>", "OA identifier for multi-OA support", "default")
        .option("--app-id <id>", "Zalo App ID (non-interactive mode)")
        .option("--secret <key>", "Zalo App Secret Key (non-interactive mode)")
        .option("--tunnel <type>", "Tunnel type: ngrok | cloudflared | none (non-interactive mode)")
        .option("--webhook-url <url>", "Pre-existing webhook URL (VPS, n8n, etc.)")
        .option("--verify-file <path>", "Domain verification: the HTML file downloaded from Zalo, served as is")
        .option("--verify-meta <tag>", "Domain verification: the <meta …> tag Zalo shows, pasted whole")
        .option("--oa-secret <key>", "OA Secret Key (app's Webhook settings): checks each event's X-ZEvent-Signature")
        .option("-p, --port <port>", "Webhook listener port", "3000")
        .option("--skip-webhook", "Skip webhook setup entirely")
        .option("--skip-login", "Skip OAuth login (use existing token)")
        .action(async (opts) => {
            const json = () => program.opts().json;
            // Agent mode: when --app-id is provided, skip all interactive prompts
            const agentMode = !!opts.appId;
            const result = { steps: [], ok: true };

            if (!agentMode) {
                console.log();
                console.log("  ╔══════════════════════════════════════════╗");
                console.log("  ║   Zalo Official Account — Setup Wizard  ║");
                console.log("  ╚══════════════════════════════════════════╝");
                console.log();
            }

            // ─── Step 1: Credentials ─────────────────────────────────

            const existingCreds = loadOACreds(opts.oaId);
            let appId = opts.appId;
            let secretKey = opts.secret;

            if (!appId && existingCreds?.appId) {
                const reuse = await ask(
                    `  Found existing App ID: ${existingCreds.appId}. Reuse? (Y/n) `,
                    agentMode,
                    "y",
                );
                if (!reuse || reuse.toLowerCase() === "y") {
                    appId = existingCreds.appId;
                    secretKey = secretKey || existingCreds.secretKey;
                }
            }

            if (!appId) {
                if (agentMode) {
                    error("--app-id is required in non-interactive mode");
                    return;
                }
                info("Step 1/5 — App Credentials");
                console.log("  Go to https://developers.zalo.me → select your app\n");
                appId = await ask("  App ID: ", false);
                if (!appId) {
                    error("App ID is required.");
                    return;
                }
            }
            if (!secretKey) {
                if (agentMode) {
                    error("--secret is required in non-interactive mode");
                    return;
                }
                secretKey = await ask("  Secret Key: ", false);
                if (!secretKey) {
                    error("Secret Key is required.");
                    return;
                }
            }

            saveOACreds({ appId, secretKey }, opts.oaId);
            result.steps.push("credentials_saved");
            if (!agentMode) success("Credentials saved\n");

            // ─── Step 2: OAuth Login ─────────────────────────────────

            const skipLogin = opts.skipLogin || (existingCreds?.accessToken && agentMode);
            let doLogin = !skipLogin;

            if (!skipLogin && existingCreds?.accessToken && !agentMode) {
                const ans = await ask("  Already logged in. Re-login? (y/N) ", false, "n");
                doLogin = ans.toLowerCase() === "y";
            }

            if (doLogin) {
                if (!agentMode) {
                    info("Step 2/5 — OAuth Login");
                    console.log("  Starting OAuth flow — browser will open...\n");
                }

                try {
                    const tokenData = await runOAuthLogin(appId, secretKey, opts.oaId);
                    result.steps.push("oauth_login_ok");
                    result.expiresIn = tokenData.expires_in;
                    if (!agentMode) {
                        success(`Logged in! Token expires in ${Math.round((tokenData.expires_in || 90000) / 3600)}h`);
                    }
                } catch (e) {
                    result.ok = false;
                    result.error = e.message;
                    error(`Login failed: ${e.message}`);
                    if (json()) output(result, true);
                    return;
                }
            } else {
                result.steps.push("login_skipped");
                if (!agentMode) success("Using existing token");
            }

            // Verify connection
            try {
                const profile = await getOAProfile(opts.oaId);
                const d = profile.data || profile;
                result.oa = { name: d.name, id: d.oa_id ?? d.oaid, followers: d.num_follower, verified: d.is_verified };
                result.steps.push("profile_verified");
                if (!agentMode) success(`Connected to OA: ${d.name} (${d.num_follower} followers)\n`);
            } catch (e) {
                if (!agentMode) warning(`Could not verify OA profile: ${e.message}`);
                result.steps.push("profile_verify_failed");
            }

            // ─── Step 3: Prerequisites (interactive only) ────────────

            if (!agentMode) {
                info("Step 3/5 — Prerequisite Checklist");
                console.log("  Verify these at developers.zalo.me:\n");
                console.log("  ┌──────────────────────────────────────────────────────────┐");
                console.log("  │  □ Official Account → Thiết lập chung → Callback URL    │");
                console.log("  │    Set to: http://localhost:3456/callback                │");
                console.log("  │  □ Đăng ký sử dụng API → Official Account API → ON      │");
                console.log("  │  □ Official Account → Chọn quyền → tick all → Lưu       │");
                console.log("  └──────────────────────────────────────────────────────────┘");
                await waitForEnter("Done? Press Enter to continue...", false);
                console.log();
            }

            // ─── Step 4: Webhook Setup ──────────────────────────────

            if (opts.skipWebhook) {
                result.steps.push("webhook_skipped");
                if (!agentMode) info("Webhook setup skipped.\n");
            } else if (opts.webhookUrl) {
                // Pre-existing URL (VPS, n8n, etc.)
                saveOACreds({ webhookUrl: opts.webhookUrl }, opts.oaId);
                saveVerification(opts, result);
                result.steps.push("webhook_url_saved");
                result.webhookUrl = opts.webhookUrl;
                if (!agentMode) {
                    success(`Webhook URL saved: ${opts.webhookUrl}`);
                    info("Set this at developers.zalo.me → Webhook\n");
                }
            } else {
                // Tunnel mode
                let tunnelType = opts.tunnel;

                if (!tunnelType && !agentMode) {
                    info("Step 4/5 — Webhook Setup");
                    console.log("  How will you expose your webhook?\n");
                    console.log("  [1] ngrok       — auto tunnel (easiest)");
                    console.log("  [2] cloudflared — Cloudflare Tunnel");
                    console.log("  [3] Own server  — VPS with public IP");
                    console.log("  [4] n8n         — n8n webhook node");
                    console.log("  [5] Skip\n");

                    const choice = Number(await ask("  Choose (1-5, default 1): ", false, "1"));

                    if (choice === 5) {
                        tunnelType = "none";
                    } else if (choice === 4) {
                        tunnelType = "n8n";
                    } else if (choice === 3) {
                        tunnelType = "server";
                    } else if (choice === 2) {
                        tunnelType = "cloudflared";
                    } else {
                        tunnelType = "ngrok";
                    }
                }

                // Default to ngrok in agent mode
                tunnelType = tunnelType || "ngrok";

                if (tunnelType === "none") {
                    result.steps.push("webhook_skipped");
                    if (!agentMode) info("Skipped. Run 'zalo-agent oa listen' when ready.\n");
                } else if (tunnelType === "n8n") {
                    if (!agentMode) {
                        info("n8n: Install n8n-nodes-zalo-oa-integration");
                        info("Use 'Zalo OA Webhook' trigger node in n8n.");
                        const n8nUrl = await ask("  Your n8n webhook URL: ", false);
                        if (n8nUrl) {
                            saveOACreds({ webhookUrl: n8nUrl }, opts.oaId);
                            success(`Saved: ${n8nUrl}`);
                        }
                    }
                    result.steps.push("n8n_configured");
                } else if (tunnelType === "server") {
                    if (!agentMode) {
                        info("Deploy on your server:");
                        console.log("    npm install -g zalo-agent-cli");
                        console.log("    zalo-agent oa setup <access-token>");
                        console.log("    zalo-agent oa listen -p 3000 -s <secret>\n");
                        const serverUrl = await ask("  Server webhook URL: ", false);
                        if (serverUrl) {
                            saveOACreds({ webhookUrl: serverUrl }, opts.oaId);
                            result.webhookUrl = serverUrl;
                            success(`Saved: ${serverUrl}`);
                            info(
                                "Domain verification: on that server, serve what Zalo's 'Xác thực domain' page " +
                                    "gives you (oa listen --verify-file <file> or --verify-meta '<meta …>'), or add " +
                                    "its DNS TXT record.",
                            );
                        }
                    }
                    result.steps.push("server_configured");
                } else {
                    // ngrok or cloudflared
                    const tunnelCmd = tunnelType === "cloudflared" ? "cloudflared" : "ngrok";
                    if (!(await hasCli(tunnelCmd))) {
                        const msg = `${tunnelCmd} not found. Install: brew install ${tunnelCmd}`;
                        error(msg);
                        result.ok = false;
                        result.error = msg;
                        if (json()) output(result, true);
                        return;
                    }

                    const port = Number(opts.port) || 3000;

                    if (!agentMode) console.log(`\n  Starting listener + ${tunnelCmd}...\n`);

                    let oaSecret = opts.oaSecret;
                    if (!oaSecret && !agentMode) {
                        oaSecret = await ask(
                            "  OA Secret Key for the webhook signature check (Enter to skip): ",
                            false,
                        );
                    }
                    if (!oaSecret) {
                        warning("No OA secret key: events are printed unverified, and the tunnel URL is public.");
                    }
                    const webhookServer = createWebhookServer(opts.oaId, { oaSecret });
                    webhookServer.listen(port);
                    result.steps.push("listener_started");
                    if (!agentMode) success(`Listener on port ${port}`);

                    try {
                        const tunnelUrl = await startTunnel(tunnelCmd, port);
                        const webhookUrl = `${tunnelUrl}/webhook`;
                        saveOACreds({ webhookUrl }, opts.oaId);
                        result.steps.push("tunnel_started");
                        result.tunnelUrl = tunnelUrl;
                        result.webhookUrl = webhookUrl;

                        if (!agentMode) {
                            success(`Tunnel: ${tunnelUrl}`);
                            console.log();
                            info("At developers.zalo.me:");
                            console.log(`  1. Xác thực domain: ${tunnelUrl.replace("https://", "")}`);
                            console.log(`  2. Webhook URL: ${webhookUrl}`);
                            console.log("  3. Bật events: user_send_text, follow, etc\n");

                            const given = await ask(
                                "  Domain verification: path of the HTML file Zalo gives, or its <meta …> tag " +
                                    "(Enter to skip): ",
                                false,
                            );
                            if (given) {
                                const asked = given.trim().startsWith("<")
                                    ? { verifyMeta: given, oaId: opts.oaId }
                                    : { verifyFile: given, oaId: opts.oaId };
                                if (saveVerification(asked, result)) success("Saved — click 'Xác thực' in Zalo");
                            }
                            await waitForEnter("Webhook setup done? Press Enter...", false);
                        } else {
                            saveVerification(opts, result);
                        }
                    } catch (e) {
                        error(`Tunnel failed: ${e.message}`);
                        result.ok = false;
                        result.error = e.message;
                        if (json()) output(result, true);
                        return;
                    }
                }
            }

            // ─── Step 5: Summary ─────────────────────────────────────

            result.steps.push("complete");

            if (json()) {
                output(result, true);
            } else {
                console.log();
                info("Setup complete!\n");
                console.log("  ┌─────────────────────────────────────────────────────────┐");
                console.log("  │  Quick Reference:                                       │");
                console.log("  │                                                         │");
                console.log("  │  zalo-agent oa whoami          # OA profile             │");
                console.log("  │  zalo-agent oa msg text <uid> <text>  # Send message    │");
                console.log("  │  zalo-agent oa follower list   # List followers         │");
                console.log("  │  zalo-agent oa listen -p 3000  # Webhook listener       │");
                console.log("  │  zalo-agent oa refresh         # Refresh token          │");
                console.log("  │  zalo-agent --json oa whoami   # JSON output            │");
                console.log("  │                                                         │");
                console.log("  │  Note: Some APIs need OA tier upgrade.                  │");
                console.log("  │  See: https://zalo.cloud/oa/pricing                     │");
                console.log("  └─────────────────────────────────────────────────────────┘");
                console.log();

                if (result.webhookUrl) {
                    info("Webhook listener running. Ctrl+C to stop.\n");
                    await new Promise(() => {});
                }
            }
        });
}

/**
 * Check and save the domain verification the user handed over (the file Zalo gives, or its meta tag), so the
 * wizard's webhook server serves it. A bad one is reported and not saved.
 *
 * @param {{ verifyFile?: string, verifyMeta?: string, oaId?: string }} given
 * @param {{ steps: string[] }} result
 * @returns {boolean} true when something was saved
 */
function saveVerification(given, result) {
    if (!given.verifyFile && !given.verifyMeta) return false;
    const verifyFile = given.verifyFile ? resolvePath(given.verifyFile) : undefined;
    try {
        domainVerification({ file: verifyFile, meta: given.verifyMeta });
    } catch (e) {
        warning(e.message);
        result.steps.push("verification_invalid");
        return false;
    }
    saveOACreds({ verifyFile, verifyMeta: given.verifyMeta }, given.oaId ?? "default");
    result.steps.push("verification_saved");
    return true;
}
