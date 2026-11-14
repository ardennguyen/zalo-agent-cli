/**
 * OA webhook listener: a local HTTP server that receives Zalo OA (and ZBS) events.
 *
 * Signature: every event carries `X-ZEvent-Signature: mac = sha256(appId + data + timeStamp + OAsecretKey)`
 * (per Zalo's OA webhook docs), where `data` is the JSON body exactly as sent, `appId` its `app_id` and `timeStamp`
 * its `timestamp` (milliseconds, a string), and OAsecretKey the OA secret key from the app's Webhook settings. It is
 * a plain SHA-256 over the concatenation, in hex, not an HMAC.
 *
 * Usage:
 *   zalo-agent oa listen --port 3000 --secret <oa-secret-key>
 *   zalo-agent oa listen --events follow,user_send_text
 *
 * Then set the webhook URL in the app's settings on developers.zalo.me to https://your-domain/webhook.
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { success, error, info, warning, output } from "../utils/output.js";

/**
 * Every webhook event Zalo documents for OA (messages, anonymous users, GMF group chat, voice calls, user
 * management, widget, extension) and ZBS (docs.zaloplatforms.com OA and ZBS webhook pages).
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
    "oa_send_anonymous_image",
    "oa_send_anonymous_file",
    "oa_send_anonymous_sticker",
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
    // GMF group management
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
    // GMF group messages
    "user_send_group_text",
    "user_send_group_image",
    "user_send_group_link",
    "user_send_group_audio",
    "user_send_group_video",
    "user_send_group_business_card",
    "user_send_group_sticker",
    "user_send_group_gif",
    "user_send_group_file",
    "oa_send_group_text",
    "oa_send_group_image",
    "oa_send_group_link",
    "oa_send_group_audio",
    "oa_send_group_location",
    "oa_send_group_video",
    "oa_send_group_business_card",
    "oa_send_group_sticker",
    "oa_send_group_gif",
    "oa_send_group_file",
    // voice call
    "oa_send_consent",
    "user_reply_consent",
    "user_call_oa",
    "oa_call_user",
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

/** The largest event body accepted (Zalo's events are a few KB). */
export const MAX_WEBHOOK_BODY = 1024 * 1024;

/**
 * The names in an `--events` filter that Zalo documents no event for: a filter on one of them can never match.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function unknownEvents(names) {
    return names.filter((n) => !OA_WEBHOOK_EVENTS.includes(n));
}

/**
 * Which delivery attempt this is. Zalo redelivers at +30 s, +5 min, +15 min, +30 min and +1 h when it gets no 200
 * in time, marking each with `num_retry`; without reading it a redelivery looks like a new event.
 *
 * @param {Record<string, string|string[]|undefined>} headers - node's lower-cased request headers
 * @returns {number} 0 for a first delivery
 */
export function retryCount(headers) {
    const n = Number(headers?.["num_retry"] ?? headers?.["num-retry"] ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The documented signature: hex SHA-256 of `app_id + rawBody + timestamp + OAsecretKey`.
 *
 * @param {string} appId - the body's `app_id`
 * @param {Buffer|string} rawBody - the body exactly as received
 * @param {string} timestamp - the body's `timestamp`
 * @param {string} secretKey - the OA secret key
 * @returns {string} 64 lower-case hex characters
 */
export function zaloSignature(appId, rawBody, timestamp, secretKey) {
    return createHash("sha256")
        .update(String(appId), "utf8")
        .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8"))
        .update(String(timestamp), "utf8")
        .update(String(secretKey), "utf8")
        .digest("hex");
}

/**
 * The MAC from the request headers: `X-ZEvent-Signature` (an undocumented `mac` header as a fallback), with a
 * leading `mac=` (the docs write the value as "mac = …") and spaces removed.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {string}
 */
export function signatureFromHeaders(headers) {
    let v = headers?.["x-zevent-signature"] ?? headers?.mac ?? "";
    if (Array.isArray(v)) v = v[0] ?? "";
    return String(v)
        .trim()
        .replace(/^mac\s*=\s*/i, "")
        .trim();
}

/**
 * Check an event's signature. Never throws: an odd header (wrong length, non-hex, non-ASCII) or a body without
 * `app_id`/`timestamp` is simply not valid.
 *
 * @param {Buffer|string} rawBody
 * @param {string} mac - from signatureFromHeaders
 * @param {string} secretKey
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyZaloSignature(rawBody, mac, secretKey) {
    if (!mac) return { ok: false, reason: "missing signature" };
    if (!/^[0-9a-fA-F]{64}$/.test(mac)) return { ok: false, reason: "malformed signature" };
    let event;
    try {
        event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch {
        return { ok: false, reason: "body is not JSON" };
    }
    const appId = event?.app_id;
    const timestamp = event?.timestamp;
    if (appId === undefined || appId === null || timestamp === undefined || timestamp === null) {
        return { ok: false, reason: "body has no app_id or timestamp to check the signature with" };
    }
    const expected = Buffer.from(zaloSignature(appId, rawBody, timestamp, secretKey), "hex");
    const given = Buffer.from(mac.toLowerCase(), "hex");
    if (given.length !== expected.length) return { ok: false, reason: "malformed signature" };
    return timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * The user an event is about: `follower.id` for follow/unfollow, `data.user_id` for widget events, else the
 * sender's id or `user_id`.
 *
 * @param {object} event
 * @returns {string} the id, or "N/A"
 */
export function eventUser(event = {}) {
    return (
        event.follower?.id ??
        (String(event.event_name ?? "").startsWith("widget_") ? event.data?.user_id : undefined) ??
        event.sender?.id ??
        event.user_id ??
        event.data?.user_id ??
        "N/A"
    );
}

/**
 * Read a request body up to `max` bytes. Resolves the raw bytes, or null after answering 413 (and stopping the
 * read) when the body is larger.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {number} [max]
 * @returns {Promise<Buffer|null>}
 */
export function readWebhookBody(req, res, max = MAX_WEBHOOK_BODY) {
    return new Promise((resolveBody) => {
        const chunks = [];
        let size = 0;
        let done = false;
        req.on("data", (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > max) {
                done = true;
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end('{"error":"Payload too large"}');
                req.destroy();
                resolveBody(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (done) return;
            done = true;
            resolveBody(Buffer.concat(chunks));
        });
        req.on("error", () => {
            if (done) return;
            done = true;
            resolveBody(null);
        });
    });
}

/**
 * Register `oa listen`.
 * @param {import("commander").Command} oaCommand
 * @param {import("commander").Command} program
 */
export function registerOAListenCommand(oaCommand, program) {
    oaCommand
        .command("listen")
        .description("Start a webhook listener for OA and ZBS events (follow, messages, group chat, calls, ZBS, …)")
        .option("-p, --port <port>", "Listen port", "3000")
        .option("-s, --secret <key>", "OA Secret Key for the X-ZEvent-Signature check (app's Webhook settings)")
        .option("--no-verify", "Skip the signature check (not recommended)")
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
            const checking = Boolean(opts.verify && opts.secret);

            if (!opts.secret && opts.verify) {
                warning("No --secret provided: signatures are not checked. Use --secret for security.");
            }
            const neverSent = eventFilter ? unknownEvents(eventFilter) : [];
            if (neverSent.length) {
                warning(`Zalo documents no event named ${neverSent.join(", ")}; the filter will never match it.`);
            }

            const server = createServer(async (req, res) => {
                // GET with hub.challenge: not a Zalo mechanism (Zalo's docs have none); answered for tools that
                // probe a webhook this way.
                if (req.method === "GET" && req.url?.startsWith(opts.path)) {
                    const url = new URL(req.url, `http://localhost:${port}`);
                    const challenge = url.searchParams.get("hub.challenge");
                    if (challenge) {
                        if (!json()) info("Answered a hub.challenge probe (not part of Zalo's webhook)");
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(challenge);
                        return;
                    }
                }

                if (req.method === "POST" && req.url?.startsWith(opts.path)) {
                    const raw = await readWebhookBody(req, res);
                    if (raw === null) return;
                    let event;
                    try {
                        if (checking) {
                            const check = verifyZaloSignature(raw, signatureFromHeaders(req.headers), opts.secret);
                            if (!check.ok) {
                                output(
                                    {
                                        event_type: "error",
                                        error: `Rejected: ${check.reason}`,
                                        timestamp: new Date().toISOString(),
                                    },
                                    json(),
                                    () => warning(`Rejected an event: ${check.reason}`),
                                );
                                res.writeHead(401, { "Content-Type": "application/json" });
                                res.end('{"error":"Invalid signature"}');
                                return;
                            }
                        }
                        event = JSON.parse(raw.toString("utf8"));
                    } catch (e) {
                        error(`Parse error: ${e.message}`);
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end('{"error":"Invalid JSON"}');
                        return;
                    }

                    // Zalo wants the 200 within 2 seconds, or it redelivers and in the end disables the webhook:
                    // acknowledge before anything else.
                    const eventName = event?.event_name || event?.event_type || "unknown";
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(
                        eventFilter && !eventFilter.includes(eventName) ? '{"status":"filtered"}' : '{"status":"ok"}',
                    );
                    if (eventFilter && !eventFilter.includes(eventName)) return;

                    try {
                        event._received_at = new Date().toISOString();
                        const retry = retryCount(req.headers);
                        if (retry) event._num_retry = retry;
                        output(event, json(), () => printEvent(eventName, event, retry));
                    } catch (e) {
                        error(`Print error: ${e.message}`);
                    }
                    return;
                }

                // Zalo domain verification file
                if (opts.verifyDomain && req.url?.includes("zalo_verifier")) {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(verificationPage(opts.verifyDomain, "zalo verification"));
                    if (!json()) info(`Served domain verification for: ${req.url}`);
                    return;
                }

                // Root page with meta tag (for meta-based verification)
                if (req.url === "/" && opts.verifyDomain) {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(verificationPage(opts.verifyDomain, "Zalo OA Webhook"));
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
                    info(`Signature check: ${checking ? "enabled" : "disabled"}`);
                    console.log();
                    info("Configure this URL at developers.zalo.me → Webhook settings");
                    info("Press Ctrl+C to stop\n");
                }
            });

            const shutdown = () => {
                if (!json()) info("\nShutting down listener...");
                server.close();
                process.exit(0);
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);

            await new Promise(() => {});
        });
}

/** The meta-tag page for Zalo's domain verification. */
function verificationPage(code, body) {
    const safe = String(code).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<html><head><meta name="zalo-platform-site-verification" content="${safe}" /></head><body>${body}</body></html>`;
}

/** One human line per event. */
function printEvent(eventName, event, retry) {
    const who = eventUser(event);
    const text = event.message?.text || "";
    if (retry) info(`(redelivery #${retry} of an event Zalo sent before)`);
    switch (eventName) {
        case "follow":
            success(`[follow] User ${who} followed OA`);
            break;
        case "unfollow":
            warning(`[unfollow] User ${who} unfollowed OA`);
            break;
        case "user_send_text":
            info(`[text] ${who}: ${text}`);
            break;
        case "user_send_image":
            info(`[image] ${who} sent an image`);
            break;
        case "user_send_file":
            info(`[file] ${who} sent a file`);
            break;
        case "user_send_location":
            info(`[location] ${who} sent location`);
            break;
        case "user_send_sticker":
            info(`[sticker] ${who} sent a sticker`);
            break;
        case "user_send_audio":
            info(`[audio] ${who} sent an audio message`);
            break;
        case "user_send_video":
            info(`[video] ${who} sent a video`);
            break;
        case "user_send_link":
            info(`[link] ${who} sent a link`);
            break;
        case "user_send_business_card":
            info(`[card] ${who} sent a business card`);
            break;
        case "user_click_chatnow":
            info(`[chat now] ${who} clicked the OA's chat button`);
            break;
        default:
            info(`[${eventName}] ${who !== "N/A" ? `${who}: ` : ""}${JSON.stringify(event).slice(0, 120)}`);
    }
}
