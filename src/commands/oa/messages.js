/**
 * `oa msg`, `oa upload`, `oa conv`, `oa quota`: consultation messages, anonymous-user messages, reactions, uploads,
 * conversation reads and message quotas, per Zalo's OA docs.
 */

import { resolve } from "node:path";
import {
    CS_REACT_ICONS,
    CS_TEXT_MAX,
    OA_CONV_PAGE_MAX,
    OA_QUOTA_PRODUCT_TYPES,
    OA_QUOTA_TYPES,
    getAllOAConversation,
    getAllOARecentChat,
    getConversation,
    getOAMessageQuota,
    getRecentChat,
    getUserMessageQuota,
    oaUploadedId,
    reactCsMessage,
    sendAnonymousMessage,
    sendCsGif,
    sendCsRequestInfo,
    sendCsSticker,
    sendFile,
    sendImage,
    sendText,
    uploadFile,
    uploadGif,
    uploadImage,
} from "../../core/oa/messages.js";
import { success, error, info, output } from "../../utils/output.js";

const OA_ID = ["--oa-id <id>", "OA identifier", "default"];

/** Exactly one of the named options is set; otherwise throws with the flags spelled out. */
function oneOf(opts, names, flags) {
    const set = names.filter((n) => opts[n] !== undefined);
    if (set.length !== 1) throw new Error(`Give exactly one of ${flags.join(", ")}`);
    return set[0];
}

/** Upload with `upload(path)` and return the id it gave, failing loudly when the reply has none. */
async function uploadThen(upload, filePath, oaId) {
    const reply = await upload(resolve(filePath), oaId);
    const id = oaUploadedId(reply);
    if (!id) throw new Error(`The upload answered without an id: ${JSON.stringify(reply?.data ?? reply)}`);
    return id;
}

function sentLine(what, result) {
    const d = result?.data || {};
    success(`${what} sent${d.message_id ? ` (message_id ${d.message_id})` : ""}`);
    if (d.quota?.quota_type) info(`Quota: ${d.quota.quota_type}${d.quota.remain ? `, ${d.quota.remain} left` : ""}`);
}

function printMessages(rows) {
    for (const r of rows) {
        const who = r.src === 0 ? "OA" : r.from_display_name || r.from_id;
        const when = r.time ? new Date(Number(r.time)).toISOString() : "";
        const body = r.message || r.url || r.type || "";
        console.log(`  ${when}  ${who}: ${body}  [${r.message_id}]`);
    }
}

/**
 * Register `oa msg`, `oa upload`, `oa conv` and `oa quota` on the `oa` command.
 * @param {import("commander").Command} oa
 */
export function registerMessagesCommands(oa) {
    const json = () => oa.parent?.opts().json;
    /** Wrap an action: run it, print its result, report a failure through error() (exit 1). */
    const act =
        (fn, human) =>
        async (...args) => {
            try {
                const result = await fn(...args);
                output(result, json(), () => human(result));
            } catch (e) {
                error(e.message);
            }
        };

    const msg = oa
        .command("msg")
        .description(
            "Send consultation (CS) messages to OA followers. Transaction and promotion messages moved to `zbs` " +
                "(Zalo stopped them on the OA API on 01/03/2026)",
        );

    msg.command("text <user-id> <text>")
        .description(`Send a CS text message (≤ ${CS_TEXT_MAX} characters), optionally quoting a message`)
        .option("--quote <message-id>", "Reply quoting this message (message_id from a webhook or `oa conv`)")
        .option(...OA_ID)
        .action(
            act(
                (userId, text, opts) => sendText(userId, text, opts.oaId, { quoteMessageId: opts.quote }),
                (r) => sentLine("Text message", r),
            ),
        );

    msg.command("image <user-id>")
        .description("Send a CS image (jpg/png ≤ 1 MB) by URL, attachment id, or a local file uploaded first")
        .option("--url <url>", "Image URL")
        .option("--attachment-id <id>", "attachment_id from `oa upload image`")
        .option("--file <path>", "Local jpg/png: uploaded first, then sent")
        .option("--caption <text>", `Caption (≤ ${CS_TEXT_MAX} characters)`)
        .option(...OA_ID)
        .action(
            act(
                async (userId, opts) => {
                    oneOf(opts, ["url", "attachmentId", "file"], ["--url", "--attachment-id", "--file"]);
                    const attachmentId = opts.file
                        ? await uploadThen(uploadImage, opts.file, opts.oaId)
                        : opts.attachmentId;
                    return sendImage(userId, { url: opts.url, attachmentId, caption: opts.caption }, opts.oaId);
                },
                (r) => sentLine("Image message", r),
            ),
        );

    msg.command("gif <user-id>")
        .description("Send a CS GIF (≤ 5 MB) by URL, attachment id, or a local file uploaded first")
        .option("--url <url>", "GIF URL")
        .option("--attachment-id <id>", "attachment_id from `oa upload gif`")
        .option("--file <path>", "Local .gif: uploaded first, then sent")
        .requiredOption("--width <px>", "GIF width in pixels (required by Zalo for a GIF)")
        .requiredOption("--height <px>", "GIF height in pixels (required by Zalo for a GIF)")
        .option("--caption <text>", `Caption (≤ ${CS_TEXT_MAX} characters)`)
        .option(...OA_ID)
        .action(
            act(
                async (userId, opts) => {
                    oneOf(opts, ["url", "attachmentId", "file"], ["--url", "--attachment-id", "--file"]);
                    const attachmentId = opts.file
                        ? await uploadThen(uploadGif, opts.file, opts.oaId)
                        : opts.attachmentId;
                    const gif = { url: opts.url, attachmentId, width: opts.width, height: opts.height };
                    return sendCsGif(userId, { ...gif, caption: opts.caption }, opts.oaId);
                },
                (r) => sentLine("GIF message", r),
            ),
        );

    msg.command("file <user-id>")
        .description("Send a CS file (PDF/DOC/DOCX/CSV ≤ 5 MB) by upload token, or a local file uploaded first")
        .option("--token <token>", "token from `oa upload file`")
        .option("--file <path>", "Local file: uploaded first, then sent")
        .option(...OA_ID)
        .action(
            act(
                async (userId, opts) => {
                    oneOf(opts, ["token", "file"], ["--token", "--file"]);
                    const token = opts.file ? await uploadThen(uploadFile, opts.file, opts.oaId) : opts.token;
                    return sendFile(userId, token, opts.oaId);
                },
                (r) => sentLine("File message", r),
            ),
        );

    msg.command("sticker <user-id> <sticker-id>")
        .description("Send a CS sticker (sticker id from stickers.zaloapp.com)")
        .option(...OA_ID)
        .action(
            act(
                (userId, stickerId, opts) => sendCsSticker(userId, stickerId, opts.oaId),
                (r) => sentLine("Sticker", r),
            ),
        );

    msg.command("request-info <user-id>")
        .description("Ask a follower to share their information (the request_user_info template)")
        .requiredOption("--title <text>", "Title (≤ 100 characters)")
        .requiredOption("--subtitle <text>", "Subtitle (≤ 500 characters)")
        .requiredOption("--image-url <url>", "Image URL")
        .option(...OA_ID)
        .action(
            act(
                (userId, opts) =>
                    sendCsRequestInfo(
                        userId,
                        { title: opts.title, subtitle: opts.subtitle, imageUrl: opts.imageUrl },
                        opts.oaId,
                    ),
                (r) => sentLine("Information request", r),
            ),
        );

    msg.command("react <user-id> <message-id> <reaction>")
        .description(
            `React to a message as the OA: ${CS_REACT_ICONS.join(" ")}, or like, heart, remove ` +
                "(remove takes the reaction back; at most 50 per message)",
        )
        .option(...OA_ID)
        .action(
            act(
                (userId, messageId, reaction, opts) => reactCsMessage(userId, messageId, reaction, opts.oaId),
                (r) => sentLine("Reaction", r),
            ),
        );

    msg.command("anonymous <anonymous-id>")
        .description(
            "Message an anonymous user in a conversation: one of --text, --image, --attachment-id, " +
                "--file, --file-token, --sticker",
        )
        .requiredOption("--conversation <id>", "conversation_id (from the anonymous user's webhook event)")
        .option("--text <text>", `Text (≤ ${CS_TEXT_MAX} characters)`)
        .option("--image <url|path>", "Image: an http(s) URL, or a local jpg/png uploaded first")
        .option("--attachment-id <id>", "Image attachment_id from `oa upload image`")
        .option("--file <path>", "Local PDF/DOC/DOCX/CSV: uploaded first, then sent")
        .option("--file-token <token>", "token from `oa upload file`")
        .option("--sticker <id>", "Sticker id")
        .option(...OA_ID)
        .action(
            act(
                async (anonymousId, opts) => {
                    const kind = oneOf(
                        opts,
                        ["text", "image", "attachmentId", "file", "fileToken", "sticker"],
                        ["--text", "--image", "--attachment-id", "--file", "--file-token", "--sticker"],
                    );
                    const content = {};
                    if (kind === "text") content.text = opts.text;
                    else if (kind === "image" && /^https?:\/\//i.test(opts.image)) content.imageUrl = opts.image;
                    else if (kind === "image")
                        content.attachmentId = await uploadThen(uploadImage, opts.image, opts.oaId);
                    else if (kind === "attachmentId") content.attachmentId = opts.attachmentId;
                    else if (kind === "file") content.fileToken = await uploadThen(uploadFile, opts.file, opts.oaId);
                    else if (kind === "fileToken") content.fileToken = opts.fileToken;
                    else content.stickerId = opts.sticker;
                    return sendAnonymousMessage({ anonymousId, conversationId: opts.conversation }, content, opts.oaId);
                },
                (r) => sentLine("Anonymous message", r),
            ),
        );

    msg.command("user-quota <user-id>")
        .description("A user's last interaction with the OA and the messages left for them")
        .option(...OA_ID)
        .action(
            act(
                (userId, opts) => getUserMessageQuota(userId, opts.oaId),
                (r) => {
                    const d = r?.data || {};
                    const last = d.last_interaction ? new Date(Number(d.last_interaction)).toISOString() : "never";
                    info(`Last interaction: ${last}`);
                    if (d.cs_reply) info(`CS replies: ${d.cs_reply.remain}/${d.cs_reply.total}`);
                    if (d.promotion) {
                        const p = d.promotion;
                        info(
                            `Promotion today: ${p.daily_remain}/${p.daily_total}, this month: ${p.monthly_remain}/${p.monthly_total}`,
                        );
                    }
                },
            ),
        );

    const upload = oa
        .command("upload")
        .description("Upload media for OA messages (Zalo keeps uploads 7 days; 5000 requests a month)");

    upload
        .command("image <file-path>")
        .description("Upload an image, jpg/png up to 1 MB (returns the attachment_id to send)")
        .option(...OA_ID)
        .action(
            act(
                (filePath, opts) => uploadImage(resolve(filePath), opts.oaId),
                (r) => success(`Image uploaded: ${oaUploadedId(r)}`),
            ),
        );

    upload
        .command("file <file-path>")
        .description("Upload a file, PDF/DOC/DOCX/CSV up to 5 MB (returns the token to send)")
        .option(...OA_ID)
        .action(
            act(
                (filePath, opts) => uploadFile(resolve(filePath), opts.oaId),
                (r) => success(`File uploaded: ${oaUploadedId(r)}`),
            ),
        );

    upload
        .command("gif <file-path>")
        .description("Upload a GIF up to 5 MB (returns the attachment_id to send)")
        .option(...OA_ID)
        .action(
            act(
                (filePath, opts) => uploadGif(resolve(filePath), opts.oaId),
                (r) => success(`GIF uploaded: ${oaUploadedId(r)}`),
            ),
        );

    const conv = oa.command("conv").description("Read OA conversations");
    const pageOpts = (cmd) =>
        cmd
            .option("--offset <n>", "Offset (0 is the newest message)", "0")
            .option("--count <n>", `Messages per request, 1–${OA_CONV_PAGE_MAX}`, String(OA_CONV_PAGE_MAX))
            .option("--all", "Walk every page from --offset")
            .option("--max <n>", "With --all: stop after this many messages")
            .option(...OA_ID);
    const printRows = (r) => {
        const rows = Array.isArray(r?.data) ? r.data : [];
        info(`Messages: ${rows.length}`);
        printMessages(rows);
    };
    const maxOf = (opts) => (opts.max === undefined ? undefined : Number(opts.max));

    pageOpts(conv.command("recent").description("The OA's most recent messages")).action(
        act(
            (opts) =>
                opts.all
                    ? getAllOARecentChat({ offset: Number(opts.offset), max: maxOf(opts) }, opts.oaId)
                    : getRecentChat(opts.offset, opts.count, opts.oaId),
            printRows,
        ),
    );

    pageOpts(conv.command("history <user-id>").description("Messages between the OA and one user")).action(
        act(
            (userId, opts) =>
                opts.all
                    ? getAllOAConversation(userId, { offset: Number(opts.offset), max: maxOf(opts) }, opts.oaId)
                    : getConversation(userId, opts.offset, opts.count, opts.oaId),
            printRows,
        ),
    );

    oa.command("quota")
        .description("The OA's message quota by owner, product and source")
        .option("--owner <owner>", "Quota owner: OA or APP", "OA")
        .option("--product <type>", `Product: ${OA_QUOTA_PRODUCT_TYPES.join(", ")}`)
        .option("--type <type>", `Quota source: ${OA_QUOTA_TYPES.join(", ")}`)
        .option(...OA_ID)
        .action(
            act(
                (opts) =>
                    getOAMessageQuota(
                        { owner: opts.owner, productType: opts.product, quotaType: opts.type },
                        opts.oaId,
                    ),
                (r) => {
                    const rows = Array.isArray(r?.data) ? r.data : [];
                    info(`Quota assets: ${rows.length}`);
                    for (const q of rows) {
                        console.log(
                            `  ${q.product_type} ${q.quota_type}: ${q.remain}/${q.total} until ${q.valid_through} [${q.asset_id}]`,
                        );
                    }
                },
            ),
        );
}
