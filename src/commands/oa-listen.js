/**
 * OA Webhook listener — starts a local HTTP server to receive Zalo OA events.
 * Supports MAC verification, event filtering, and JSON output for piping.
 *
 * Usage:
 *   zalo-agent oa listen --port 3000 --secret <oa-secret-key>
 *   zalo-agent oa listen --events follow,user_send_text
 *
 * Then configure your webhook URL at developers.zalo.me to point to:
 *   https://your-domain:3000/webhook
 */

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { success, error, info, warning, output } from "../utils/output.js";

/**
 * Every webhook event Zalo documents for OA, GMF, voice call and ZBS
 * (docs.zaloplatforms.com, surveyed for the 2.0.0 triage). The previous list
 * had 10 names, three of which Zalo never sends (`user_send_gif`,
 * `user_click_button`, `user_click_link`), so `-e user_click_button` filtered
 * on nothing; the "chat now" click is `user_click_chatnow`.
 */
export const OA_WEBHOOK_EVENTS = Object.freeze([
    // follow and inbound messages
    "follow",
    "unfollow",
    "user_send_text",
    "user_send_image",
    "user_send_file",
    "user_send_audio",
    "user_send_video",
    "user_send_sticker",
    "user_send_link",
    "user_send_business_card",
    "user_send_location",
    "user_click_chatnow",
    // message lifecycle
    "user_seen_message",
    "user_received_message",
    "user_reacted_message",
    "oa_reacted_message",
    // outbound echo
    "oa_send_text",
    "oa_send_image",
    "oa_send_file",
    "oa_send_sticker",
    "oa_send_gif",
    "oa_send_list",
    // anonymous users
    "anonymous_send_text",
    "anonymous_send_image",
    "anonymous_send_file",
    "anonymous_send_sticker",
    "oa_send_anonymous_text",
    // user management
    "update_user_info",
    "user_submit_info",
    "add_user_to_tag",
    "remove_user_from_tag",
    "remove_tag",
    "user_withdraw",
    // widget
    "widget_interaction_accepted",
    "widget_failed_to_sync_user_external_id",
    // GMF groups
    "create_group",
    "delete_group",
    "update_group_info",
    "add_group_admin",
    "remove_group_admin",
    "user_join_group",
    "user_out_group",
    "user_request_join_group",
    "accept_request_join_group",
    "reject_request_join_group",
    "user_send_group_text",
    // voice call
    "oa_send_consent",
    "user_reply_consent",
    "user_call_oa",
    // extension
    "extension_purchased",
    // ZBS
    "change_template_status",
    "change_template_quality",
    "change_oa_daily_quota",
    "user_feedback",
    "user_click_response_button",
    "event_journey_acknowledged",
    "event_journey_time_out",
]);

/**
 * The names in an `--events` filter that Zalo documents no event for: a
 * filter on one of them can never match.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function unknownEvents(names) {
    return names.filter((n) => !OA_WEBHOOK_EVENTS.includes(n));
}

/**
 * Which delivery attempt this is. Zalo redelivers at +30 s, +5 min, +15 min,
 * +30 min and +1 h when it gets no 200 in time, marking each with `num_retry`;
 * without reading it a redelivery looks like a new event.
 *
 * @param {Record<string, string|string[]|undefined>} headers - node's lower-cased request headers
 * @returns {number} 0 for a first delivery
 */
export function retryCount(headers) {
    const n = Number(headers?.["num_retry"] ?? headers?.["num-retry"] ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Verify MAC signature from Zalo OA using timing-safe comparison. */
function verifyMac(body, mac, secretKey) {
    const calculated = createHmac("sha256", secretKey).update(body).digest("hex");
    if (mac.length !== calculated.length) return false;
    return timingSafeEqual(Buffer.from(mac), Buffer.from(calculated));
}

export function registerOAListenCommand(oaCommand, program) {
    oaCommand
        .command("listen")
        .description("Start webhook listener for OA events (follow, messages, clicks, etc.)")
        .option("-p, --port <port>", "Listen port", "3000")
        .option("-s, --secret <key>", "OA Secret Key for MAC verification (from developers.zalo.me)")
        .option("--no-verify", "Skip MAC verification (not recommended)")
        .option(
            "-e, --events <list>",
            "Comma-separated event filter, e.g. follow,user_send_text,user_click_chatnow (all documented names: oa-command-reference)",
            "all",
        )
        .option("--path <path>", "Webhook URL path", "/webhook")
        .option("--verify-domain <code>", "Zalo domain verification code (serves /zalo_verifier<code>.html)")
        .action(async (opts) => {
            const json = () => program.opts().json;
            const port = Number(opts.port);
            const eventFilter = opts.events === "all" ? null : opts.events.split(",").map((e) => e.trim());

            if (!opts.secret && opts.verify) {
                warning("No --secret provided. MAC verification disabled. Use --secret for security.");
            }
            const neverSent = eventFilter ? unknownEvents(eventFilter) : [];
            if (neverSent.length) {
                warning(`Zalo documents no event named ${neverSent.join(", ")}; the filter will never match it.`);
            }

            const server = createServer((req, res) => {
                // GET — webhook verification (hub.challenge)
                if (req.method === "GET" && req.url?.startsWith(opts.path)) {
                    const url = new URL(req.url, `http://localhost:${port}`);
                    const challenge = url.searchParams.get("hub.challenge");
                    if (challenge) {
                        if (!json()) info(`Webhook verified (challenge: ${challenge})`);
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(challenge);
                        return;
                    }
                }

                // POST — receive events
                if (req.method === "POST" && req.url?.startsWith(opts.path)) {
                    let body = "";
                    let bodySize = 0;
                    const MAX_BODY = 1024 * 1024; // 1MB limit
                    req.on("data", (chunk) => {
                        bodySize += chunk.length;
                        if (bodySize > MAX_BODY) {
                            req.destroy();
                            res.writeHead(413);
                            res.end('{"error":"Payload too large"}');
                            return;
                        }
                        body += chunk;
                    });
                    req.on("end", () => {
                        try {
                            // MAC verification
                            if (opts.verify && opts.secret) {
                                // Zalo sends MAC as "mac=<hex>" in X-Zevent-Signature header or mac header
                                const sigHeader = req.headers["x-zevent-signature"] || req.headers.mac || "";
                                const mac = sigHeader.startsWith("mac=") ? sigHeader.slice(4) : sigHeader;
                                if (!mac || !verifyMac(body, mac, opts.secret)) {
                                    const errData = {
                                        event_type: "error",
                                        error: "Invalid or missing MAC",
                                        timestamp: new Date().toISOString(),
                                    };
                                    output(errData, json(), () => warning("Rejected: invalid MAC"));
                                    res.writeHead(401);
                                    res.end('{"error":"Invalid MAC"}');
                                    return;
                                }
                            }

                            const event = JSON.parse(body);
                            const eventName = event.event_name || event.event_type || "unknown";

                            // Filter events
                            if (eventFilter && !eventFilter.includes(eventName)) {
                                res.writeHead(200);
                                res.end('{"status":"filtered"}');
                                return;
                            }

                            // Zalo wants the 200 within 2 seconds, or it redelivers and in
                            // the end disables the webhook: acknowledge before anything else.
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end('{"status":"ok"}');

                            // Enrich with timestamp, and the delivery attempt
                            event._received_at = new Date().toISOString();
                            const retry = retryCount(req.headers);
                            if (retry) event._num_retry = retry;

                            // Output event
                            output(event, json(), () => {
                                const sender = event.sender?.id || event.user_id || "N/A";
                                const msg = event.message?.text || "";
                                if (retry) info(`(redelivery #${retry} of an event Zalo sent before)`);
                                switch (eventName) {
                                    case "follow":
                                        success(`[follow] User ${sender} followed OA`);
                                        break;
                                    case "unfollow":
                                        warning(`[unfollow] User ${sender} unfollowed OA`);
                                        break;
                                    case "user_send_text":
                                        info(`[text] ${sender}: ${msg}`);
                                        break;
                                    case "user_send_image":
                                        info(`[image] ${sender} sent an image`);
                                        break;
                                    case "user_send_file":
                                        info(`[file] ${sender} sent a file`);
                                        break;
                                    case "user_send_location":
                                        info(`[location] ${sender} sent location`);
                                        break;
                                    case "user_send_sticker":
                                        info(`[sticker] ${sender} sent a sticker`);
                                        break;
                                    case "user_send_audio":
                                        info(`[audio] ${sender} sent an audio message`);
                                        break;
                                    case "user_send_video":
                                        info(`[video] ${sender} sent a video`);
                                        break;
                                    case "user_send_link":
                                        info(`[link] ${sender} sent a link`);
                                        break;
                                    case "user_send_business_card":
                                        info(`[card] ${sender} sent a business card`);
                                        break;
                                    case "user_click_chatnow":
                                        info(`[chat now] ${sender} clicked the OA's chat button`);
                                        break;
                                    default:
                                        info(`[${eventName}] ${JSON.stringify(event).slice(0, 120)}`);
                                }
                            });
                        } catch (e) {
                            error(`Parse error: ${e.message}`);
                            // The 200 goes out before printing, so a failure there must not
                            // try to answer again (ERR_HTTP_HEADERS_SENT would crash the listener).
                            if (!res.headersSent) {
                                res.writeHead(400);
                                res.end('{"error":"Invalid JSON"}');
                            }
                        }
                    });
                    return;
                }

                // Zalo domain verification file
                if (opts.verifyDomain && req.url?.includes("zalo_verifier")) {
                    const html = `<html><head><meta name="zalo-platform-site-verification" content="${opts.verifyDomain}" /></head><body>zalo verification</body></html>`;
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(html);
                    if (!json()) info(`Served domain verification for: ${req.url}`);
                    return;
                }

                // Root page with meta tag (for meta-based verification)
                if (req.url === "/" && opts.verifyDomain) {
                    const html = `<html><head><meta name="zalo-platform-site-verification" content="${opts.verifyDomain}" /></head><body>Zalo OA Webhook</body></html>`;
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(html);
                    return;
                }

                // Health check / other routes
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", webhook: opts.path }));
            });

            server.listen(port, () => {
                if (!json()) {
                    success(`OA webhook listener started on port ${port}`);
                    info(`Webhook URL: http://localhost:${port}${opts.path}`);
                    info(`Events: ${eventFilter ? eventFilter.join(", ") : "all"}`);
                    info(`MAC verify: ${opts.verify && opts.secret ? "enabled" : "disabled"}`);
                    console.log();
                    info("Configure this URL at developers.zalo.me → Webhook settings");
                    info("Press Ctrl+C to stop\n");
                }
            });

            // Graceful shutdown
            const shutdown = () => {
                if (!json()) info("\nShutting down listener...");
                server.close();
                process.exit(0);
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);

            // Keep process alive
            await new Promise(() => {});
        });
}
