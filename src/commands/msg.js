/**
 * Message commands — send text, images, files, cards, bank cards, QR transfers,
 * stickers, reactions, delete, forward.
 */

import { resolve, join } from "path";
import { getApi, getOwnId } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";
import { extractMessageText } from "../utils/extract-message-text.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { initDb, getMessages, insertMessage } from "../core/db.js";
import { sendViaDaemon } from "../core/daemon-channel.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";

/**
 * Look one message up in the local SQLite cache by its global msgId.
 *
 * `deleteMessage` needs the message's `cliMsgId` and `uidFrom`, neither of
 * which can be derived from the msgId — cliMsgId is client-generated and
 * only the sender ever saw it. Anything `listen`, `sync` or a prior
 * `msg history` wrote is here, so a message the CLI has seen before does
 * not need the ids passed by hand. Returns null when the message is not
 * cached (a just-sent one will not be — `msg send` does not write to the db).
 *
 * @param {string} threadId
 * @param {string} msgId
 * @returns {{cliMsgId: string, uidFrom: string}|null}
 */
function cachedMessageById(threadId, msgId) {
    try {
        const activeAcc = getActive();
        if (!activeAcc) return null;
        initDb(join(CONFIG_DIR, "accounts", activeAcc.ownId, "zalo.db"));
        const row = getMessages(threadId, 200).find((m) => String(m.msgId) === String(msgId));
        if (!row) return null;

        let raw = {};
        try {
            raw = JSON.parse(row.raw_data || "{}");
        } catch {
            /* raw_data is optional */
        }
        const data = raw.data ?? raw;
        const cliMsgId = data.cliMsgId;
        const uidFrom = row.senderId ?? data.uidFrom;
        return cliMsgId ? { cliMsgId: String(cliMsgId), uidFrom: uidFrom ? String(uidFrom) : null } : null;
    } catch {
        return null;
    }
}

/**
 * TextStyle codes matching zca-js TextStyle enum.
 * Used for --style option and markdown parsing.
 */
const TEXT_STYLES = {
    bold: "b",
    b: "b",
    italic: "i",
    i: "i",
    underline: "u",
    u: "u",
    strikethrough: "s",
    s: "s",
    red: "c_db342e",
    orange: "c_f27806",
    yellow: "c_f7b503",
    green: "c_15a85f",
    small: "f_13",
    big: "f_18",
};

/**
 * Parse markdown-like syntax from message text into plain text + styles array.
 * Supports: **bold**, *italic*, __underline__, ~~strikethrough~~,
 *           {red:text}, {orange:text}, {green:text}, {yellow:text},
 *           {big:text}, {small:text}
 */
function parseMarkdownStyles(input) {
    const styles = [];
    let plain = input;

    // Process markdown patterns (order matters: ** before *)
    const patterns = [
        { regex: /\*\*(.+?)\*\*/g, st: "b" },
        { regex: /\*(.+?)\*/g, st: "i" },
        { regex: /__(.+?)__/g, st: "u" },
        { regex: /~~(.+?)~~/g, st: "s" },
        { regex: /\{(red|orange|yellow|green|big|small):(.+?)\}/g, st: null },
    ];

    for (const p of patterns) {
        let match;
        // Re-run from scratch each time since offsets shift
        while ((match = p.regex.exec(plain)) !== null) {
            const fullMatch = match[0];
            const start = match.index;
            let content, st;
            if (p.st === null) {
                // Color/size pattern: {color:text}
                st = TEXT_STYLES[match[1]];
                content = match[2];
            } else {
                st = p.st;
                content = match[1];
            }
            // Replace the markdown syntax with plain content
            plain = plain.slice(0, start) + content + plain.slice(start + fullMatch.length);
            styles.push({ start, len: content.length, st });
            // Reset regex since string changed
            p.regex.lastIndex = start + content.length;
        }
    }

    return { plain, styles };
}

/**
 * Extensions zca-js uploads through its inline-image path.
 *
 * uploadAttachment() routes on EXTENSION, not on which CLI command was used:
 * these four resolve their upload promise synchronously, `gif` is split off
 * by sendMessage() into its own inline path, and **everything else** —
 * bmp, tiff, heic, avif, svg, mp4, pdf, … — takes the "others"/"video" path,
 * which waits on a WebSocket upload-complete frame.
 *
 * Zalo does not restrict these formats (its `restricted_ext_file` denylist
 * covers only executables: exe, cmd, bat, com, lnk, vbs, msi, …), so a user
 * can legitimately hand `send-image` a .bmp. It simply arrives as a file
 * attachment rather than an inline image.
 */
const INLINE_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/** True when every path is a format Zalo renders inline. */
function allInlineImages(paths) {
    return paths.every((p) => INLINE_IMAGE_EXTS.has(p.split(".").pop().toLowerCase()));
}

/**
 * Send attachments, bringing the WebSocket listener up first when any of
 * them needs it.
 *
 * zca-js's uploadAttachment() resolves synchronously for inline images, but
 * for "video" and "others" it registers an entry in ctx.uploadCallbacks and
 * awaits a promise that ONLY apis/listen.js can settle, when the
 * upload-complete control frame arrives. With no listener there is no
 * timeout and no fallback — the await never settles and the command hangs
 * with no output at all.
 *
 * Both `send-image` and `send-file` hit this, because the routing is by
 * extension: `send-image photo.bmp` takes the same "others" path as
 * `send-file doc.pdf`. So the listener decision is made from the actual
 * paths, not from the command name.
 *
 * Opening that socket is only safe when nothing else holds one. A running
 * `listen` or `mcp` daemon does, and Zalo answers a second session by killing
 * the first, so this asks the daemon to do the upload when one is up and only
 * opens its own session when none is. See src/core/daemon-channel.js.
 *
 * @param {object} api
 * @param {string[]} absPaths
 * @param {string} threadId
 * @param {number} type
 * @param {object} opts - {caption, uploadTimeout}
 * @returns {Promise<{result?: object, error?: string, listenerStarted?: boolean, viaDaemon?: boolean}>}
 */
async function sendAttachments(api, absPaths, threadId, type, opts) {
    const needsListener = !allInlineImages(absPaths);
    let listenerStarted = false;

    // A running `listen`/`mcp` daemon already holds the account's one permitted
    // socket. Opening a second one here makes Zalo evict the daemon (cmd 3000),
    // which loses every message that arrives during its ~6s reconnect -- a real
    // message was lost this way, and the gap it recorded has no working repair
    // path. So hand the upload to the daemon when there is one.
    if (needsListener) {
        const acc = getActive();
        if (acc) {
            const viaDaemon = await sendViaDaemon(join(CONFIG_DIR, "accounts", acc.ownId), {
                paths: absPaths,
                threadId,
                type,
                caption: opts.caption,
                timeoutMs: Number(opts.uploadTimeout),
            });
            // null means no daemon answered; fall through and open our own.
            if (viaDaemon) {
                return viaDaemon.ok
                    ? { result: viaDaemon.result, viaDaemon: true }
                    : { error: viaDaemon.error, viaDaemon: true };
            }
        }
    }

    if (needsListener) {
        try {
            await new Promise((res, rej) => {
                const timer = setTimeout(() => rej(new Error("Listener connection timeout")), 15000);
                api.listener.once("connected", () => {
                    clearTimeout(timer);
                    listenerStarted = true;
                    res();
                });
                api.listener.once("error", (err) => {
                    clearTimeout(timer);
                    rej(err);
                });
                api.listener.start({ retryOnClose: false });
            });
        } catch (e) {
            return { error: `Could not open the upload channel: ${e.message}` };
        }
    }

    try {
        const result = await withTimeout(
            api.sendMessage({ msg: opts.caption, attachments: absPaths }, threadId, type),
            Number(opts.uploadTimeout),
            "Upload timed out waiting for Zalo's upload-complete event",
        );
        return { result, listenerStarted };
    } catch (e) {
        return { error: e.message, listenerStarted };
    } finally {
        if (listenerStarted) {
            try {
                api.listener.stop();
            } catch {
                // Nothing useful to do — we're exiting anyway.
            }
        }
    }
}

/**
 * Reject with `message` if `promise` hasn't settled within `ms`.
 *
 * Used by the attachment path: zca-js's non-inline upload waits on a
 * WebSocket event with no timeout of its own, so a dropped or missed
 * upload-complete frame would otherwise hang the command indefinitely.
 * Better to fail loudly than to look frozen.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} message
 */
function withTimeout(promise, ms, message) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]);
}

/**
 * Parse manual style specs: "start:len:style" → { start, len, st }
 * Style names: bold, italic, underline, strikethrough, red, orange, yellow, green, big, small
 */
function parseStyleSpecs(specs) {
    return specs
        .map((spec) => {
            const [start, len, style] = spec.split(":");
            const st = TEXT_STYLES[style];
            if (!st) return null;
            return { start: Number(start), len: Number(len), st };
        })
        .filter(Boolean);
}

export function registerMsgCommands(program) {
    const msg = program.command("msg").description("Send and manage messages");

    msg.command("send <threadId> <message>")
        .description("Send a text message with optional formatting")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option(
            "--mention <specs...>",
            "Mention users in group message. Format: pos:userId:len (e.g. 0:USER_ID:5). Use userId=-1 for @All.",
        )
        .option("--style <specs...>", "Text styles. Format: start:len:style (e.g. 0:5:bold 6:5:italic)")
        .option("--md", "Parse markdown-like formatting: **bold** *italic* __underline__ ~~strike~~ {red:text}")
        .option(
            "--react <icon>",
            "Auto-react to sent message. Codes: :> (haha), /-heart (heart), /-strong (like), :o (wow), :-(( (cry), :-h (angry)",
        )
        .action(async (threadId, message, opts) => {
            try {
                // Parse mention specs: "pos:uid:len" → { pos, uid, len }
                const mentions = (opts.mention || []).map((spec) => {
                    const [pos, uid, len] = spec.split(":");
                    return { pos: Number(pos), uid, len: Number(len) };
                });

                // Parse text styles
                let styles = [];
                let finalMsg = message;

                if (opts.md) {
                    // Markdown-like parsing: **bold** *italic* __underline__ ~~strike~~
                    const parsed = parseMarkdownStyles(message);
                    finalMsg = parsed.plain;
                    styles = parsed.styles;
                }

                if (opts.style) {
                    // Manual style specs: start:len:style
                    styles = styles.concat(parseStyleSpecs(opts.style));
                }

                // Build message content
                const hasExtras = mentions.length > 0 || styles.length > 0;
                const msgContent = hasExtras
                    ? { msg: finalMsg, ...(mentions.length > 0 && { mentions }), ...(styles.length > 0 && { styles }) }
                    : finalMsg;

                const cliMsgId = String(Date.now());
                const result = await getApi().sendMessage(msgContent, threadId, Number(opts.type));
                result.cliMsgId = cliMsgId;
                output(result, program.opts().json, () => success("Message sent"));

                // Auto-react if --react flag provided
                if (opts.react && result.message?.msgId) {
                    const dest = {
                        data: { msgId: String(result.message.msgId), cliMsgId },
                        threadId,
                        type: Number(opts.type),
                    };
                    await getApi().addReaction(opts.react, dest);
                    success(`Auto-reacted with '${opts.react}'`);
                }
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-image <threadId> <paths...>")
        .description("Send one or more images (jpg/jpeg/png/webp/gif render inline; other formats arrive as files)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .option("--upload-timeout <ms>", "Max wait for the upload-complete event", "120000")
        .action(async (threadId, paths, opts) => {
            const absPaths = paths.map((p) => resolve(p));

            // A format Zalo does not render inline (bmp, tiff, heic, …) is
            // still uploaded — Zalo only denylists executables — but it
            // arrives as a file attachment. Say so rather than letting the
            // command name quietly mislead.
            const offbeat = absPaths.filter((p) => !INLINE_IMAGE_EXTS.has(p.split(".").pop().toLowerCase()));
            if (offbeat.length && !program.opts().json) {
                warning(
                    `Not an inline image format: ${offbeat.map((p) => p.split(/[\\/]/).pop()).join(", ")} — ` +
                        `will arrive as a file attachment. Convert to PNG/JPEG for an inline image.`,
                );
            }

            const {
                result,
                error: err,
                listenerStarted,
            } = await sendAttachments(getApi(), absPaths, threadId, Number(opts.type), opts);
            if (err) error(err);
            else output(result, program.opts().json, () => success(`Image(s) sent to ${threadId}`));

            // Only force-exit when the listener ran; it leaves handles behind
            // that keep the event loop alive. The pure-inline path needs no
            // such thing, so leave its exit behavior untouched.
            if (listenerStarted) process.exit(err ? 1 : 0);
            else if (err) process.exitCode = 1;
        });

    msg.command("send-file <threadId> <paths...>")
        .description("Send files (docx, pdf, zip, etc.)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .option("--upload-timeout <ms>", "Max wait for the upload-complete event", "120000")
        .action(async (threadId, paths, opts) => {
            // Shares sendAttachments() with `send-image`. It used to carry its
            // own copy of the bring-the-listener-up dance, which meant the
            // hand-off to a running daemon only ever applied to send-image --
            // and send-file is the command that needs it most, since every
            // non-inline attachment takes the socket path.
            const absPaths = paths.map((p) => resolve(p));
            const {
                result,
                error: err,
                listenerStarted,
            } = await sendAttachments(getApi(), absPaths, threadId, Number(opts.type), opts);
            if (err) error(err);
            else output(result, program.opts().json, () => success(`File(s) sent to ${threadId}`));

            // listener.stop() closes the socket but does not release every
            // handle it registered, so the event loop stays alive and the
            // command would sit there, done but not exited. `msg history`
            // resolves the same problem the same way. Nothing to force when
            // the daemon did the upload -- this process never opened a socket.
            if (listenerStarted) process.exit(err ? 1 : 0);
            else if (err) process.exitCode = 1;
        });

    msg.command("send-card <threadId> <userId>")
        .description("Send a contact card (danh thiếp)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--phone <num>", "Phone number (auto-fetched if omitted)")
        .action(async (threadId, userId, opts) => {
            try {
                const api = getApi();
                let phone = opts.phone;
                if (!phone) {
                    const userInfo = await api.getUserInfo(userId);
                    const profiles = userInfo?.changed_profiles || {};
                    phone = profiles[userId]?.phoneNumber || "";
                    if (phone) info(`Auto-detected phone: ${phone}`);
                }
                const cardOpts = { userId };
                if (phone) cardOpts.phoneNumber = phone;
                const result = await api.sendCard(cardOpts, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Card sent"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-bank <threadId> <accountNumber>")
        .description("Send a bank card (số tài khoản)")
        .requiredOption("-b, --bank <name>", "Bank name (ocb, vcb, bidv) or BIN code")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-n, --name <holder>", "Account holder name")
        .action(async (threadId, accountNumber, opts) => {
            try {
                const { resolveBankBin, BIN_TO_DISPLAY } = await import("../utils/bank-helpers.js");
                const bin = resolveBankBin(opts.bank);
                if (!bin) {
                    error(`Unknown bank: '${opts.bank}'`);
                    return;
                }
                info(`Bank: ${BIN_TO_DISPLAY[bin] || bin} (BIN ${bin})`);

                const payload = { binBank: bin, numAccBank: accountNumber };
                if (opts.name) payload.nameAccBank = opts.name;
                const result = await getApi().sendBankCard(payload, threadId, Number(opts.type));
                output(result, program.opts().json, () =>
                    success(`Bank card sent: ${BIN_TO_DISPLAY[bin]} / ${accountNumber}`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-qr-transfer <threadId> <accountNumber>")
        .description("Generate VietQR and send as image")
        .requiredOption("-b, --bank <name>", "Bank name or BIN code")
        .option("-a, --amount <n>", "Transfer amount in VND", parseIntOption)
        .option("-m, --content <text>", "Transfer content (max 50 chars)")
        .option("--template <tpl>", "QR style: compact, print, qronly", "compact")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, accountNumber, opts) => {
            try {
                const { resolveBankBin, BIN_TO_DISPLAY, generateQrTransferImage } =
                    await import("../utils/bank-helpers.js");
                const bin = resolveBankBin(opts.bank);
                if (!bin) {
                    error(`Unknown bank: '${opts.bank}'`);
                    return;
                }
                if (opts.content && opts.content.length > 50) {
                    error(`Content too long (${opts.content.length} chars). VietQR max is 50.`);
                    return;
                }
                info(
                    `Generating QR: ${BIN_TO_DISPLAY[bin]} / ${accountNumber}${opts.amount ? ` / ${opts.amount.toLocaleString()}đ` : ""}`,
                );

                const qrPath = await generateQrTransferImage(
                    bin,
                    accountNumber,
                    opts.amount,
                    opts.content,
                    opts.template,
                );
                if (!qrPath) {
                    error("Failed to generate QR image");
                    return;
                }

                const caption = [
                    `QR chuyển khoản ${BIN_TO_DISPLAY[bin]} - ${accountNumber}`,
                    opts.amount ? `${opts.amount.toLocaleString()}đ` : null,
                    opts.content || null,
                ]
                    .filter(Boolean)
                    .join(" - ");

                const result = await getApi().sendMessage(
                    { msg: caption, attachments: [qrPath] },
                    threadId,
                    Number(opts.type),
                );

                // Cleanup temp file
                try {
                    (await import("fs")).unlinkSync(qrPath);
                } catch {}

                output(result, program.opts().json, () => success(`QR transfer sent to ${threadId}`));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("sticker <threadId> <keyword>")
        .description("Search and send a sticker")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, keyword, opts) => {
            try {
                const api = getApi();
                const search = await api.searchSticker(keyword);
                const first = search?.[0];
                if (!first) {
                    error("No sticker found");
                    return;
                }
                // sendSticker expects {id, cateId, type} object
                const stickerObj = {
                    id: first.sticker_id || first.stickerId || first.id,
                    cateId: first.cate_id || first.cateId,
                    type: first.type || 7,
                };
                const result = await api.sendSticker(stickerObj, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Sticker sent"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("send-voice <threadId> <voiceUrl>")
        .description("Send a voice message from URL")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--ttl <ms>", "Time to live in milliseconds", parseIntOption, 0)
        .action(async (threadId, voiceUrl, opts) => {
            try {
                info(`Sending voice: ${voiceUrl}`);
                const result = await getApi().sendVoice({ voiceUrl, ttl: opts.ttl }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Voice sent to ${threadId}`));
            } catch (e) {
                error(`Send voice failed: ${e.message}`);
            }
        });

    msg.command("send-link <threadId> <url>")
        .description("Send a link with auto-preview (title, description, thumbnail)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text")
        .action(async (threadId, url, opts) => {
            try {
                info(`Sending link: ${url}`);
                const result = await getApi().sendLink({ link: url, msg: opts.caption }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Link sent to ${threadId}`));
            } catch (e) {
                error(`Send link failed: ${e.message}`);
            }
        });

    msg.command("send-video <threadId> <videoUrl>")
        .description("Send a video from URL")
        .requiredOption("--thumb <url>", "Thumbnail image URL")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-m, --caption <text>", "Caption text", "")
        .option("-d, --duration <ms>", "Video duration in milliseconds", parseIntOption)
        .option("-W, --width <px>", "Video width", parseIntOption, 1280)
        .option("-H, --height <px>", "Video height", parseIntOption, 720)
        .action(async (threadId, videoUrl, opts) => {
            try {
                info(`Sending video: ${videoUrl}`);
                const result = await getApi().sendVideo(
                    {
                        videoUrl,
                        thumbnailUrl: opts.thumb,
                        msg: opts.caption,
                        duration: opts.duration,
                        width: opts.width,
                        height: opts.height,
                    },
                    threadId,
                    Number(opts.type),
                );
                output(result, program.opts().json, () => success(`Video sent to ${threadId}`));
            } catch (e) {
                error(`Send video failed: ${e.message}`);
            }
        });

    msg.command("sticker-list <keyword>")
        .description("Search stickers by keyword (returns sticker IDs)")
        .action(async (keyword) => {
            try {
                const result = await getApi().getStickers(keyword);
                output(result, program.opts().json, () => {
                    const ids = Array.isArray(result) ? result : [];
                    info(`${ids.length} sticker(s) found for "${keyword}"`);
                    for (const id of ids) console.log(`  ${id}`);
                });
            } catch (e) {
                error(`Sticker search failed: ${e.message}`);
            }
        });

    msg.command("sticker-detail <stickerIds...>")
        .description("Get sticker details by IDs")
        .action(async (stickerIds) => {
            try {
                const ids = stickerIds.map(Number);
                const result = await getApi().getStickersDetail(ids);
                output(result, program.opts().json);
            } catch (e) {
                error(`Sticker detail failed: ${e.message}`);
            }
        });

    msg.command("sticker-category <categoryId>")
        .description("Get sticker category details")
        .action(async (categoryId) => {
            try {
                const result = await getApi().getStickerCategoryDetail(Number(categoryId));
                output(result, program.opts().json);
            } catch (e) {
                error(`Sticker category failed: ${e.message}`);
            }
        });

    msg.command("react <msgId> <threadId> <reaction>")
        .description(
            "React to a message. Reaction codes: :> (haha), /-heart (heart), /-strong (like), :o (wow), :-(( (cry), :-h (angry)",
        )
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-c, --cli-msg-id <id>", "Client message ID (required for reaction to appear, get from listen --json)")
        .action(async (msgId, threadId, reaction, opts) => {
            try {
                // zca-js addReaction(icon, dest) — dest needs msgId + cliMsgId
                const dest = {
                    data: { msgId, cliMsgId: opts.cliMsgId || msgId },
                    threadId,
                    type: Number(opts.type),
                };
                const result = await getApi().addReaction(reaction, dest);
                output(result, program.opts().json, () => success(`Reacted with '${reaction}'`));
            } catch (e) {
                error(`React failed: ${e.message}`);
            }
        });

    msg.command("delete <msgId> <threadId>")
        .description("Delete a message from your own view only (use `msg undo` to recall it for everyone)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-c, --cli-msg-id <id>", "Message's cliMsgId (get from `msg send --json` or `listen --json`)")
        .option("--uid-from <id>", "Message sender's id (defaults to your own id)")
        .option(
            "--everyone",
            "Delete for everyone instead of just you. Only valid for SOMEONE ELSE'S message in a group — " +
                "Zalo rejects it for your own messages (use `msg undo`) and in private chats",
        )
        .action(async (msgId, threadId, opts) => {
            try {
                const type = Number(opts.type);

                // zca-js takes deleteMessage(dest, onlyMe) where dest is
                // {data: {cliMsgId, msgId, uidFrom}, threadId, type} — NOT
                // (msgId, threadId, type), which is what this used to pass.
                // That shape put a bare string where `dest` belongs, so every
                // invocation died on "Cannot read properties of undefined
                // (reading 'uidFrom')" before reaching the network.
                //
                // cliMsgId is not derivable from msgId, exactly as for `undo`:
                // it is a client-generated id that only the sender ever saw.
                // Look in the local cache first, then insist the caller
                // supplies it rather than guessing.
                let cliMsgId = opts.cliMsgId;
                let uidFrom = opts.uidFrom;

                if (!cliMsgId || !uidFrom) {
                    const cached = cachedMessageById(threadId, msgId);
                    cliMsgId = cliMsgId || cached?.cliMsgId;
                    uidFrom = uidFrom || cached?.uidFrom;
                }
                uidFrom = uidFrom || getOwnId();

                if (!cliMsgId) {
                    error(
                        "cliMsgId is required to delete a message and is not in the local cache. " +
                            "Pass --cli-msg-id (from `msg send --json` or `listen --json`).",
                    );
                    return;
                }

                const result = await getApi().deleteMessage(
                    {
                        data: { cliMsgId: String(cliMsgId), msgId: String(msgId), uidFrom: String(uidFrom) },
                        threadId,
                        type,
                    },
                    Boolean(opts.everyone) === false,
                );
                output(result, program.opts().json, () =>
                    success(opts.everyone ? "Message deleted for everyone" : "Message deleted from your view"),
                );
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("undo <msgId> <threadId>")
        .description("Recall/undo a message for both sides (like Zalo app recall). Requires cliMsgId.")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-c, --cli-msg-id <id>", "Client message ID (required, get from listen --json or send --json)")
        .action(async (msgId, threadId, opts) => {
            try {
                if (!opts.cliMsgId) {
                    error("cliMsgId is required for undo. Get it from: listen --json or send --json output.");
                    return;
                }
                const payload = { msgId, cliMsgId: opts.cliMsgId };
                const result = await getApi().undo(payload, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message recalled (undone)"));
            } catch (e) {
                error(`Undo failed: ${e.message}`);
            }
        });

    msg.command("forward <msgId> <threadId>")
        .description("Forward a message to another thread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (msgId, threadId, opts) => {
            try {
                const result = await getApi().forwardMessage(msgId, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message forwarded"));
            } catch (e) {
                error(e.message);
            }
        });

    msg.command("history <threadId>")
        .description("Fetch message history. Groups try REST API then fallback to WebSocket. DMs use WebSocket.")
        .option("-t, --type <n>", "Thread type: 0=User(DM), 1=Group", "0")
        .option("-n, --limit <n>", "Max most-recent messages to fetch", "50")
        .option("--scan <n>", "Max raw global messages to scan (WebSocket only)", "2000")
        .option("--from-msg-id <id>", "Anchor message ID to scan older messages from")
        .option("--timeout <ms>", "Timeout in milliseconds waiting for response", "15000")
        .option("--no-cache", "Force live fetch instead of using local cache, and amend db")
        .action(async (threadId, opts) => {
            const jsonMode = program.opts().json;
            const threadType = Number(opts.type);
            const limit = Number(opts.limit);
            const timeout = Number(opts.timeout);
            const scanLimit = Number(opts.scan);

            // Order matters: getApi() throws when there is no session, and
            // this line sits outside any try/catch. Calling it ABOVE the
            // guard made the friendly message unreachable — a logged-out
            // user got a raw Node stack trace instead. `conv recent` gets
            // this order right; keep them consistent.
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }

            let api;
            try {
                api = getApi();
            } catch (e) {
                error(e.message);
                process.exit(1);
            }

            if (!jsonMode) {
                info(
                    "Note: To maintain a complete local cache without missing gaps, ensure the 'zalo-cli listen' daemon is running continuously on this device.",
                );
            }

            let localMsgs = [];
            let dbActive = false;

            try {
                const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
                initDb(join(accountDir, "zalo.db"));
                dbActive = true;

                if (opts.cache !== false) {
                    localMsgs = getMessages(threadId, limit);
                    if (localMsgs && localMsgs.length >= limit) {
                        if (!jsonMode) info(`Found ${localMsgs.length} messages in local cache.`);
                        // Fetch through the shared downloader, which writes to
                        // accounts/<ownId>/media/<threadName>/ and records the
                        // path itself. The old per-command downloader used a
                        // different flat layout and its extension logic keyed off
                        // Number(message.type) -- always NaN for a string type --
                        // so reading history quietly scattered files into a second
                        // location that nothing else knew about.
                        try {
                            await downloadSyncedMedia({
                                api,
                                accountDir,
                                threadId,
                                limit,
                                concurrency: 2,
                            });
                            localMsgs = getMessages(threadId, limit);
                        } catch {
                            /* showing history must not fail because media did */
                        }
                        const messages = localMsgs.map((m) => ({
                            msgId: m.msgId,
                            threadId: m.threadId,
                            senderId: m.senderId,
                            senderName: m.senderName,
                            text: m.text,
                            timestamp: m.timestamp,
                            type: m.type,
                            localPath: m.localPath,
                        }));

                        output(
                            {
                                threadId,
                                threadType: threadType === 0 ? "dm" : "group",
                                count: messages.length,
                                source: "sqlite",
                                messages,
                            },
                            jsonMode,
                            () => {
                                success(`${messages.length} message(s) from ${threadId} (Local Cache)`);
                                for (const m of messages) {
                                    const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                                    const name = m.senderName || m.senderId || "?";
                                    const mediaInfo = m.localPath ? ` [Media: ${m.localPath}]` : "";
                                    console.log(`  [${date}] ${name}: ${(m.text || "").slice(0, 200)}${mediaInfo}`);
                                }
                            },
                        );
                        return;
                    } else if (localMsgs && localMsgs.length > 0 && !jsonMode) {
                        info(
                            `Found only ${localMsgs.length} messages in cache. Falling back to live fetch to reach limit of ${limit}.`,
                        );
                    }
                } else if (opts.cache === false && !jsonMode) {
                    info(`--no-cache specified. Fetching live from server and amending database.`);
                }
            } catch (err) {
                if (!jsonMode && err.message !== "Database not initialized") {
                    warning(`Local DB query failed: ${err.message}. Falling back to network.`);
                }
            }

            try {
                if (!jsonMode && limit > 100) {
                    info(`Warning: fetching up to ${limit} messages.`);
                }

                let fetchedMessages = [];
                let usedRestApi = false;

                if (threadType === 1) {
                    // Group: Try REST API first
                    try {
                        const history = await api.getGroupChatHistory(threadId, limit);
                        fetchedMessages = (history || []).map((msg) => ({
                            msgId: msg.msgId,
                            threadId: threadId,
                            senderId: msg.uidFrom || null,
                            senderName: msg.dName || null,
                            text:
                                typeof msg.content === "string"
                                    ? msg.content
                                    : extractMessageText(msg.content, msg.msgType),
                            timestamp: msg.ts ? Number(msg.ts) : null,
                            type: typeof msg.content === "string" ? "text" : msg.msgType || "attachment",
                            raw_data: JSON.stringify(msg),
                        }));
                        usedRestApi = true;
                        if (!jsonMode) info("Fetched group history via REST API.");
                    } catch (restErr) {
                        if (!jsonMode)
                            warning(`REST API failed (${restErr.message}). Falling back to WebSocket stream...`);
                    }
                }

                if (!usedRestApi) {
                    // WebSocket global stream scanning (DM or fallback for Group)
                    const allMessages = [];
                    let lastMsgId = opts.fromMsgId || null;
                    let done = false;

                    // Start listener
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error("Listener connection timeout")), 10000);
                        api.listener.once("connected", () => {
                            clearTimeout(timer);
                            resolve();
                        });
                        api.listener.once("error", (err) => {
                            clearTimeout(timer);
                            reject(err);
                        });
                        api.listener.start({ retryOnClose: false });
                    });

                    let rawScanned = 0;

                    while (!done && rawScanned < scanLimit) {
                        const page = await new Promise((resolve) => {
                            const handler = (messages) => {
                                clearTimeout(timeoutId);
                                api.listener.removeListener("old_messages", handler);
                                resolve(messages);
                            };
                            const timeoutId = setTimeout(() => {
                                api.listener.removeListener("old_messages", handler);
                                resolve([]);
                            }, timeout);

                            api.listener.on("old_messages", handler);
                            api.listener.requestOldMessages(threadType, lastMsgId);
                        });

                        if (!page || page.length === 0) break;

                        rawScanned += page.length;

                        for (const msg of page) {
                            if (String(msg.threadId || "") !== String(threadId)) continue;
                            allMessages.push({
                                msgId: msg.data?.msgId,
                                threadId: msg.threadId,
                                senderId: msg.data?.uidFrom || null,
                                senderName: msg.data?.dName || null,
                                text:
                                    typeof msg.data?.content === "string"
                                        ? msg.data.content
                                        : extractMessageText(msg.data?.content, msg.data?.msgType),
                                timestamp: msg.data?.ts ? Number(msg.data.ts) : null,
                                type:
                                    typeof msg.data?.content === "string" ? "text" : msg.data?.msgType || "attachment",
                                raw_data: JSON.stringify(msg.data),
                            });

                            if (allMessages.length >= limit) {
                                done = true;
                                break;
                            }
                        }

                        // Advance cursor using the global actionId of the last raw message
                        const lastMsg = page[page.length - 1];
                        const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                        if (!nextId || nextId === lastMsgId) done = true;
                        lastMsgId = nextId;
                    }

                    try {
                        api.listener.stop();
                    } catch {}

                    if (!jsonMode)
                        info(`Scanned ${rawScanned} raw WS messages to find ${allMessages.length} target messages.`);
                    fetchedMessages = allMessages;
                }

                // Amend DB with live fetched messages
                if (dbActive && fetchedMessages.length > 0) {
                    for (const m of fetchedMessages) {
                        try {
                            insertMessage(m);
                        } catch (e) {
                            // ignore insert errors (e.g. duplicate constraint)
                        }
                    }
                    if (!jsonMode) info("Amended local database with live fetched messages.");
                }

                // Merge and sort
                // If we fetched live, we might want to merge with localMsgs in case we didn't fetch enough to hit the limit
                const mergedMap = new Map();
                for (const m of localMsgs) mergedMap.set(m.msgId, m);
                for (const m of fetchedMessages) mergedMap.set(m.msgId, m);

                const mergedArray = Array.from(mergedMap.values());
                // Sort newest-first (descending timestamp)
                mergedArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

                const result = mergedArray.slice(0, limit);

                // Format final output
                const cleanResult = result.map((m) => {
                    const r = { ...m };
                    delete r.raw_data;
                    return r;
                });

                output(
                    {
                        threadId,
                        threadType: threadType === 0 ? "dm" : "group",
                        count: cleanResult.length,
                        source: "live",
                        messages: cleanResult,
                    },
                    jsonMode,
                    () => {
                        success(`${cleanResult.length} message(s) from ${threadId}`);
                        for (const m of cleanResult) {
                            const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
                            const name = m.senderName || m.senderId || "?";
                            const mediaInfo = m.localPath ? ` [Media: ${m.localPath}]` : "";
                            console.log(`  [${date}] ${name}: ${(m.text || "").slice(0, 200)}${mediaInfo}`);
                        }
                    },
                );

                process.exit(0);
            } catch (e) {
                try {
                    api.listener.stop();
                } catch {}
                error(`History fetch failed: ${e.message}`);
                process.exit(1);
            }
        });
}
