/**
 * `zbs …`: ZBS Template Message (Zalo's official template messages by phone number, hashed phone, RSA, journey and
 * UID), per Zalo's ZBS docs. Uses the same OA access token and credentials as `oa` (src/core/oa/transport.js,
 * `ZBS_BASE`); `--oa-id <id>` picks which stored OA. The requests are built in src/core/zbs/.
 */

import fs from "node:fs";
import { resolve } from "node:path";
import {
    JOURNEY_TOKEN_TYPES,
    MESSAGE_STATUS,
    checkJourneyToken,
    createJourneyToken,
    createRsaKey,
    createTemplate,
    editTemplate,
    getAllRatings,
    getMessageStatus,
    getQuality,
    getQuickReplies,
    getQuota,
    getRatings,
    getRsaKey,
    getTemplate,
    getTemplateSample,
    listAllTemplates,
    listTemplates,
    sendByPhone,
    sendByUid,
    sendJourney,
    uploadImage,
} from "../core/zbs/api.js";
import { TEMPLATE_TAGS, TEMPLATE_TYPES } from "../core/zbs/template-check.js";
import { error, info, output, success } from "../utils/output.js";

const OA_OPT = ["--oa-id <id>", "OA identifier (which stored OA token to use, as for `oa`)", "default"];

/**
 * Read a JSON argument: inline JSON (starts with `{` or `[`), or else the path of a JSON file.
 *
 * @param {string} value
 * @param {string} what - for the message
 * @returns {any}
 */
export function readJsonArg(value, what = "JSON") {
    const s = String(value ?? "").trim();
    let text = s;
    let source = "inline";
    if (!s.startsWith("{") && !s.startsWith("[")) {
        try {
            text = fs.readFileSync(resolve(s), "utf8");
            source = s;
        } catch {
            throw new Error(`${what}: not inline JSON and no such file: ${s}`);
        }
    }
    try {
        return JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
        throw new Error(`${what} (${source}) is not valid JSON: ${e.message}`);
    }
}

function fmtTime(ms) {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : String(ms ?? "");
}

function quotaLine(q) {
    if (!q) return null;
    return `Quota today: ${q.remainingQuota ?? "?"} of ${q.dailyQuota ?? "?"} left`;
}

/**
 * Register the top-level `zbs` command group.
 * @param {import("commander").Command} program
 * @returns {import("commander").Command} the `zbs` command
 */
export function registerZbsCommands(program) {
    const zbs = program
        .command("zbs")
        .description(
            "ZBS Template Message (official API): templates, sends by phone number or UID, status, quota " +
                "(uses the OA's token: `oa login`)",
        );
    const json = () => program.opts().json;
    const run =
        (fn) =>
        async (...args) => {
            try {
                await fn(...args);
            } catch (e) {
                error(e.message);
            }
        };

    // ─── Templates ────────────────────────────────────────────────────

    const template = zbs
        .command("template")
        .description("ZBS templates: list, detail, sample data, create/update, ratings, quick replies");

    template
        .command("list")
        .description("List the OA's templates, newest first (up to 100 per request; --all walks every page)")
        .option("--status <status>", "Only this status: enable, pending, reject, disable")
        .option("--mine", "Only templates created by this app (filterPreset=1)")
        .option("--offset <n>", "Position of the first template (newest is 0)", "0")
        .option("--limit <n>", "Templates per request, 1-100", "100")
        .option("--all", "Fetch every page")
        .option(...OA_OPT)
        .action(
            run(async (opts) => {
                const result = opts.all
                    ? await listAllTemplates({ status: opts.status, mine: opts.mine, oaId: opts.oaId })
                    : await listTemplates({
                          offset: opts.offset,
                          limit: opts.limit,
                          status: opts.status,
                          mine: opts.mine,
                          oaId: opts.oaId,
                      });
                output(result, json(), () => {
                    const rows = Array.isArray(result.data) ? result.data : [];
                    if (!rows.length) return info("No templates");
                    for (const t of rows) {
                        info(
                            `${t.templateId}  ${t.templateName}  [${t.status}]` +
                                (t.templateQuality ? `  quality ${t.templateQuality}` : "") +
                                (t.createdTime ? `  created ${fmtTime(t.createdTime)}` : ""),
                        );
                    }
                    info(`${rows.length} shown of ${result.metadata?.total ?? rows.length}`);
                });
            }),
        );

    template
        .command("detail <template-id>")
        .description("A template's status, tag, quality, prices, params and buttons")
        .option(...OA_OPT)
        .action(
            run(async (id, opts) => {
                const result = await getTemplate(id, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`${d.templateId} ${d.templateName}`);
                    info(`Status: ${d.status}${d.reason ? ` (${d.reason})` : ""}`);
                    if (d.templateTag) info(`Tag: ${d.templateTag}`);
                    if (d.templateQuality) info(`Quality: ${d.templateQuality}`);
                    if (d.price_sdt || d.price_uid)
                        info(`Price: ${d.price_sdt ?? "?"} by phone, ${d.price_uid ?? "?"} by UID`);
                    if (d.timeout) info(`Timeout: ${d.timeout} ms`);
                    for (const p of d.listParams || []) {
                        info(
                            `  param ${p.name}: ${p.type}, ${p.minLength ?? 0}-${p.maxLength ?? "?"} chars` +
                                (p.require ? ", required" : "") +
                                (p.acceptNull ? ", may be empty" : ""),
                        );
                    }
                    for (const b of d.listButtons || []) info(`  button ${b.type}: ${b.title} → ${b.content}`);
                    if (d.previewUrl) info(`Preview: ${d.previewUrl}`);
                });
            }),
        );

    template
        .command("sample <template-id>")
        .description("A template's params with sample values (a template_data to start from)")
        .option(...OA_OPT)
        .action(
            run(async (id, opts) => {
                const result = await getTemplateSample(id, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    const keys = Object.keys(d);
                    if (!keys.length) return info("No params");
                    for (const k of keys) info(`${k}: ${d[k]}`);
                });
            }),
        );

    const writeOpts = (cmd) =>
        cmd
            .option("--tracking-id <id>", "Your tracking id (generated when the JSON has none)")
            .option("--no-check", "Skip the local check against Zalo's template rules")
            .option(...OA_OPT);
    const describeTemplateReply = (result, verb) => {
        const d = result.data || {};
        success(`Template ${d.template_id} ${verb}: ${d.status ?? "PENDING_REVIEW"} (Zalo reviews it next)`);
        if (d.template_type) info(`Type: ${d.template_type} (${TEMPLATE_TYPES[d.template_type] ?? "?"})`);
        if (d.tag) info(`Tag: ${d.tag} (${TEMPLATE_TAGS[d.tag] ?? "?"})`);
        if (d.price_sdt || d.price_uid) info(`Price: ${d.price_sdt ?? "?"} by phone, ${d.price_uid ?? "?"} by UID`);
        if (d.preview_url) info(`Preview: ${d.preview_url}`);
    };

    writeOpts(
        template
            .command("create <template-json>")
            .description(
                "Create a template from its JSON (inline, or a file path): template_name, template_type, tag, layout, " +
                    "params, note. Checked against Zalo's rules first; 100 a day",
            ),
    ).action(
        run(async (value, opts) => {
            const body = readJsonArg(value, "template");
            const result = await createTemplate(body, {
                trackingId: opts.trackingId,
                check: opts.check,
                oaId: opts.oaId,
            });
            output(result, json(), () => describeTemplateReply(result, "created"));
        }),
    );

    writeOpts(
        template
            .command("update <template-id> <template-json>")
            .description(
                "Edit a template in REJECT status from its JSON (inline, or a file path); it goes back to review. " +
                    "100 a day",
            ),
    ).action(
        run(async (id, value, opts) => {
            const body = readJsonArg(value, "template");
            const result = await editTemplate(id, body, {
                trackingId: opts.trackingId,
                check: opts.check,
                oaId: opts.oaId,
            });
            output(result, json(), () => describeTemplateReply(result, "updated"));
        }),
    );

    template
        .command("rating <template-id>")
        .description("Ratings customers left through a service-rating template, in a time window")
        .requiredOption("--from <time>", "Start: milliseconds or a date (e.g. 2026-11-01)")
        .option("--to <time>", "End: milliseconds or a date (default: now)")
        .option("--offset <n>", "Position of the first rating", "0")
        .option("--limit <n>", "Ratings per request", "100")
        .option("--all", "Fetch every page")
        .option(...OA_OPT)
        .action(
            run(async (id, opts) => {
                const to = opts.to ?? Date.now();
                const result = opts.all
                    ? await getAllRatings(id, { from: opts.from, to, pageSize: Number(opts.limit), oaId: opts.oaId })
                    : await getRatings(id, {
                          from: opts.from,
                          to,
                          offset: opts.offset,
                          limit: opts.limit,
                          oaId: opts.oaId,
                      });
                output(result, json(), () => {
                    const rows = result.data?.data || [];
                    if (!rows.length) return info("No ratings in this window");
                    for (const r of rows) {
                        info(
                            `${fmtTime(r.submitDate)}  rate ${r.rate} (${r.option})` +
                                (r.note ? `  "${r.note}"` : "") +
                                (r.trackingId ? `  tracking ${r.trackingId}` : ""),
                        );
                        const fb = r.feedbacks ?? r.feedback;
                        if (Array.isArray(fb) && fb.length) info(`    ${fb.join("; ")}`);
                    }
                    info(`${rows.length} shown of ${result.data?.total ?? rows.length}`);
                });
            }),
        );

    template
        .command("quick-reply <template-id>")
        .description("Answers customers gave through a quick-response template, in a time window")
        .requiredOption("--from <time>", "Start: milliseconds or a date (e.g. 2026-11-01)")
        .option("--to <time>", "End: milliseconds or a date (default: now)")
        .option("--limit <n>", "At most this many answers", "100")
        .option(...OA_OPT)
        .action(
            run(async (id, opts) => {
                const result = await getQuickReplies(id, {
                    from: opts.from,
                    to: opts.to ?? Date.now(),
                    limit: opts.limit,
                    oaId: opts.oaId,
                });
                output(result, json(), () => {
                    const rows = result.data?.data || [];
                    if (!rows.length) return info("No answers in this window");
                    for (const r of rows) {
                        info(
                            `${fmtTime(r.submitDate)}  "${r.data}"  msg ${r.msgId}${r.trackingId ? `  tracking ${r.trackingId}` : ""}`,
                        );
                    }
                    info(`${rows.length} shown of ${result.data?.total ?? rows.length}`);
                });
            }),
        );

    zbs.command("upload-image <file>")
        .description(
            "Upload a template image or logo (JPG/PNG, at most 500 KB; 5,000 a month per app); returns media_id",
        )
        .option("--kind <kind>", "Also check the template rule: logo (PNG 400x96 px) or image (16:9)")
        .option(...OA_OPT)
        .action(
            run(async (file, opts) => {
                const result = await uploadImage(resolve(file), { kind: opts.kind, oaId: opts.oaId });
                output(result, json(), () => success(`Uploaded: media_id ${result.data?.media_id}`));
            }),
        );

    // ─── Send by phone ────────────────────────────────────────────────

    zbs.command("send <phone> <template-id> <data-json>")
        .description(
            "Send a template message by phone number (84xxxxxxxxx or 0xxxxxxxxx). <data-json> is template_data, " +
                "inline or a file path. Modes: plain (default), --hash-phone, --dev, --rsa",
        )
        .option("--tracking-id <id>", "Your id for reconciliation, at most 48 letters/digits/_/- (generated if absent)")
        .option("--hash-phone", "Send the SHA-256 of the number instead (or pass a 64-hex digest as <phone>)")
        .option("--dev", "Development mode: test send, only to the app's or OA's admins")
        .option("--rsa", "Encrypt the number and every template_data value with the OA's RSA public key")
        .option("--rsa-key <file>", "The RSA public key (Base64 or PEM file); default: fetched with `rsa/key/get`")
        .option("--encrypted", "With --rsa: <phone> and the template_data values are already RSA ciphertexts")
        .option("--rsa-mgf1 <hash>", "With --rsa: the OAEP MGF1 digest, sha1 or sha256", "sha1")
        .option("--sending-mode <mode>", "1 normal (default), 3 over quota (whitelisted OAs, tag 3 only)")
        .option(...OA_OPT)
        .action(
            run(async (phone, templateId, dataJson, opts) => {
                const modes = [opts.hashPhone && "hash", opts.dev && "dev", opts.rsa && "rsa"].filter(Boolean);
                if (modes.length > 1) throw new Error("Pick one of --hash-phone, --dev, --rsa");
                const mode = modes[0] || "phone";
                if ((opts.rsaKey || opts.encrypted) && mode !== "rsa")
                    throw new Error("--rsa-key/--encrypted need --rsa");
                const result = await sendByPhone({
                    phone,
                    templateId,
                    data: readJsonArg(dataJson, "template_data"),
                    trackingId: opts.trackingId,
                    mode,
                    sendingMode: opts.sendingMode,
                    publicKey: opts.rsaKey ? fs.readFileSync(resolve(opts.rsaKey), "utf8") : undefined,
                    encrypted: Boolean(opts.encrypted),
                    mgf1Hash: opts.rsaMgf1,
                    oaId: opts.oaId,
                });
                output(result, json(), () => {
                    const d = result.data || {};
                    success(`Sent${mode === "dev" ? " (development mode)" : ""}: msg_id ${d.msg_id}`);
                    info(`tracking_id: ${result.tracking_id}`);
                    if (d.sent_time) info(`Sent at: ${fmtTime(d.sent_time)}`);
                    if (d.sending_mode === "3") info("Sent over quota (sending_mode 3)");
                    const q = quotaLine(d.quota);
                    if (q) info(q);
                });
            }),
        );

    const rsaKey = zbs
        .command("rsa-key")
        .description("The OA's RSA key for encrypted sends (Zalo keeps the private key)");
    rsaKey
        .command("create")
        .description("Create the OA's RSA key pair and print the public key (fails if one exists)")
        .option(...OA_OPT)
        .action(
            run(async (opts) => {
                const result = await createRsaKey(opts.oaId);
                output(result, json(), () => info(result.data?.public_key ?? ""));
            }),
        );
    rsaKey
        .command("get")
        .description("Print the OA's RSA public key (Base64)")
        .option(...OA_OPT)
        .action(
            run(async (opts) => {
                const result = await getRsaKey(opts.oaId);
                output(result, json(), () => info(result.data?.public_key ?? ""));
            }),
        );

    // ─── Journey ──────────────────────────────────────────────────────

    const journey = zbs
        .command("journey")
        .description("Journey sends (logistics / coach bus): a token per recipient and journey, then sends with it");
    journey
        .command("token <phone>")
        .description("Create a journey token for a recipient (Zalo must enable journeys for the OA first)")
        .option(
            "--type <type>",
            `Journey token type: ${JOURNEY_TOKEN_TYPES.join(", ")} (Zalo's default: token_logistics_7)`,
        )
        .option(...OA_OPT)
        .action(
            run(async (phone, opts) => {
                const result = await createJourneyToken(phone, { type: opts.type, oaId: opts.oaId });
                output(result, json(), () => {
                    success(`Journey ${result.journey_id} created`);
                    info(`Token: ${result.token}`);
                });
            }),
        );
    journey
        .command("check <journey-token>")
        .description("Show a journey token's type, creation and expiry")
        .option(...OA_OPT)
        .action(
            run(async (token, opts) => {
                const result = await checkJourneyToken(token, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`Type: ${d.tokenType ?? d["tokenType "] ?? "?"}`);
                    info(`Created: ${fmtTime(d.createdAt)}`);
                    info(`Expires: ${fmtTime(d.expiredAt)}`);
                });
            }),
        );
    journey
        .command("send <phone> <template-id> <data-json>")
        .description("Send a journey template with its journey token (token and template must be the same type)")
        .requiredOption("--token <journey-token>", "The journey token from `zbs journey token`")
        .option(...OA_OPT)
        .action(
            run(async (phone, templateId, dataJson, opts) => {
                const result = await sendJourney({
                    phone,
                    templateId,
                    data: readJsonArg(dataJson, "template_data"),
                    journeyToken: opts.token,
                    oaId: opts.oaId,
                });
                output(result, json(), () => {
                    const d = result.data || {};
                    success(`Sent: msg_id ${d.msg_id}`);
                    const q = quotaLine(d.quota);
                    if (q) info(q);
                });
            }),
        );

    // ─── Send by UID ──────────────────────────────────────────────────

    zbs.command("uid <user-id> <template-id> <data-json>")
        .description(
            "Send a template message to a user id of the OA (custom, rating, payment request and voucher templates " +
                "created since 10/12/2025). <data-json> is template_data, inline or a file path",
        )
        .option(...OA_OPT)
        .action(
            run(async (userId, templateId, dataJson, opts) => {
                const result = await sendByUid({
                    userId,
                    templateId,
                    data: readJsonArg(dataJson, "template_data"),
                    oaId: opts.oaId,
                });
                output(result, json(), () => {
                    const d = result.data || {};
                    success(`Sent: message_id ${d.message_id}`);
                    if (d.quota?.quota_type)
                        info(`Quota: ${d.quota.quota_type} (${d.quota.owner_type} ${d.quota.owner_id})`);
                    else info("Charged as a paid message");
                });
            }),
        );

    // ─── Status, quota, quality ──────────────────────────────────────

    zbs.command("status <message-id>")
        .description("Delivery status of a message sent by phone number")
        .option("--phone <phone>", "The recipient's number (the docs' example URL carries it)")
        .option(...OA_OPT)
        .action(
            run(async (messageId, opts) => {
                const result = await getMessageStatus(messageId, { phone: opts.phone, oaId: opts.oaId });
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`Status ${d.status}: ${MESSAGE_STATUS[d.status] ?? d.message ?? "unknown"}`);
                    if (d.delivery_time) info(`Delivered: ${fmtTime(d.delivery_time)}`);
                });
            }),
        );

    zbs.command("quota")
        .description("The OA's quota for messages by phone number: daily, and monthly promotion")
        .option(...OA_OPT)
        .action(
            run(async (opts) => {
                const result = await getQuota(opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`Daily: ${d.remainingQuota ?? "?"} of ${d.dailyQuota ?? "?"} left`);
                    if (d.monthlyPromotionQuota !== undefined && d.monthlyPromotionQuota !== null) {
                        info(
                            `Promotion this month: ${d.remainingMonthlyPromotionQuota ?? "?"} of ${d.monthlyPromotionQuota} left`,
                        );
                    }
                    if (
                        d.estimatedNextMonthPromotionQuota !== undefined &&
                        d.estimatedNextMonthPromotionQuota !== null
                    ) {
                        info(`Promotion next month (estimate): ${d.estimatedNextMonthPromotionQuota}`);
                    }
                });
            }),
        );

    zbs.command("quality")
        .description("The OA's quality for messages by phone number: last 48 hours and last 7 days")
        .option(...OA_OPT)
        .action(
            run(async (opts) => {
                const result = await getQuality(opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`Last 48 hours: ${d.oaCurrentQuality ?? "?"}`);
                    info(`Last 7 days: ${d.oa7dayQuality ?? "?"}`);
                });
            }),
        );

    return zbs;
}
