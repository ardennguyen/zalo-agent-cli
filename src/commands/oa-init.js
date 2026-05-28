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
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import { saveOACreds, loadOACreds, getOAuthUrl, exchangeCode, getOAProfile } from "../core/oa-client.js";
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

/** Open URL in default browser. */
function openBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${url}"`);
}

/** Check if a CLI tool exists. */
function hasCli(name) {
    return new Promise((resolve) => exec(`which ${name}`, (err) => resolve(!err)));
}

/** Run OAuth login flow — starts callback server and waits for browser redirect. */
async function runOAuthLogin(appId, secretKey, oaId, callbackPort = 3456) {
    const redirectUri = `http://localhost:${callbackPort}/callback`;
    const authUrl = getOAuthUrl(appId, redirectUri);
    openBrowser(authUrl);

    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            if (!req.url?.startsWith("/callback")) {
                res.writeHead(404);
                res.end();
                return;
            }
            const url = new URL(req.url, `http://localhost:${callbackPort}`);
            const code = url.searchParams.get("code");
            const returnedOaId = url.searchParams.get("oa_id");

            if (!code) {
                const msg = url.searchParams.get("error_description") || "No authorization code";
                res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                res.end(`<h2>Login failed</h2><p>${msg}</p>`);
                server.close();
                reject(new Error(msg));
                return;
            }

            try {
                const data = await exchangeCode(code, appId, secretKey, redirectUri);
                if (data.error) {
                    throw new Error(`Token error ${data.error}: ${data.error_description || data.error_name}`);
                }
                saveOACreds(
                    {
                        accessToken: data.access_token,
                        refreshToken: data.refresh_token,
                        expiresIn: data.expires_in,
                        oaId: returnedOaId || oaId,
                    },
                    oaId,
                );
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<h2>Login successful!</h2><p>Return to terminal.</p>");
                server.close();
                resolve(data);
            } catch (e) {
                res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
                res.end(`<h2>Login failed</h2><p>${e.message}</p>`);
                server.close();
                reject(e);
            }
        });
        server.listen(callbackPort);
        setTimeout(() => {
            server.close();
            reject(new Error("Login timed out (2 min)"));
        }, 120_000);
    });
}

/** Create webhook listener HTTP server with domain verification support. */
function createWebhookServer(oaId) {
    return createServer((req, res) => {
        // Domain verification file
        if (req.url?.includes("zalo_verifier")) {
            const creds = loadOACreds(oaId);
            const code = creds?.verifyCode || "placeholder";
            const html = `<html><head><meta name="zalo-platform-site-verification" content="${code}" /></head><body>zalo verification</body></html>`;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
            return;
        }

        // Root with meta tag
        if (req.url === "/") {
            const creds = loadOACreds(oaId);
            const code = creds?.verifyCode || "";
            const html = `<html><head><meta name="zalo-platform-site-verification" content="${code}" /></head><body>Zalo OA Webhook</body></html>`;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
            return;
        }

        // Webhook POST
        if (req.method === "POST" && req.url?.startsWith("/webhook")) {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                try {
                    const event = JSON.parse(body);
                    const eventName = event.event_name || "unknown";
                    const sender = event.sender?.id || "N/A";
                    const msg = event.message?.text || "";
                    if (eventName === "user_send_text") info(`[text] ${sender}: ${msg}`);
                    else info(`[${eventName}] from ${sender}`);
                } catch {
                    /* test ping */
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"status":"ok"}');
            });
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
        .option("--verify-code <code>", "Zalo domain verification code")
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
                        success(`Logged in! Token expires in ${Math.round((tokenData.expires_in || 86400) / 3600)}h`);
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
                result.oa = { name: d.name, id: d.oa_id, followers: d.num_follower };
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
                if (opts.verifyCode) saveOACreds({ verifyCode: opts.verifyCode }, opts.oaId);
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
                            const wantVerify = await ask("  Domain verification help? (y/N) ", false, "n");
                            if (wantVerify.toLowerCase() === "y") {
                                const vc = await ask("  Verification code: ", false);
                                if (vc) {
                                    console.log(
                                        `\n  Meta tag: <meta name="zalo-platform-site-verification" content="${vc}" />`,
                                    );
                                    console.log(`  Or serve at: /zalo_verifier${vc}.html\n`);
                                }
                            }
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

                    const webhookServer = createWebhookServer(opts.oaId);
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

                            const verifyCode = await ask("  Verification code: ", false);
                            if (verifyCode) {
                                saveOACreds({ verifyCode }, opts.oaId);
                                success("Code saved — click 'Xác thực' in Zalo");
                            }
                            await waitForEnter("Webhook setup done? Press Enter...", false);
                        } else if (opts.verifyCode) {
                            saveOACreds({ verifyCode: opts.verifyCode }, opts.oaId);
                            result.steps.push("verify_code_saved");
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
