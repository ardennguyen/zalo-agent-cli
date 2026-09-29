/**
 * Message commands — send text, images, files, cards, bank cards, QR transfers,
 * stickers, reactions, delete, forward.
 */

import { existsSync } from "node:fs";
import { resolve, join } from "path";
import { getApi, getOwnId } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { initDb, getMessages, getMessageById, getDisplayName, upsertContact } from "../core/db.js";
import { sendViaDaemon } from "../core/daemon-channel.js";
import { storeLiveMessage } from "../core/live-store.js";
import { classifyLiveMessage } from "../core/sync-v2/message-types.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { expandMentions, parseMentionSpecs, shiftStyles, ALL_MENTION_UID } from "../utils/mentions.js";
import { buildQuote, resolveQuoteSender } from "../utils/quote.js";

/**
 * Open the active account's SQLite cache.
 *
 * Best-effort on purpose: every caller here has a useful fallback for "no
 * account, no cache file, or a db that will not open", so this reports that
 * as false rather than failing the command.
 *
 * @returns {boolean} true when db.js is initialized and safe to query
 */
function openAccountDb() {
    try {
        const acc = getActive();
        if (!acc) return false;
        initDb(join(CONFIG_DIR, "accounts", acc.ownId, "zalo.db"));
        return true;
    } catch {
        return false;
    }
}

/**
 * Display name for a `@[uid]` mention token, or null.
 *
 * Never throws. A name that cannot be looked up degrades to the uid, which
 * still tags the right person — failing the whole send over a cache miss
 * would be a far worse trade.
 *
 * @param {string} uid
 * @param {boolean} cacheOpen - whether openAccountDb() succeeded
 * @returns {string|null}
 */
function mentionName(uid, cacheOpen) {
    if (!cacheOpen) return null;
    try {
        return getDisplayName(uid);
    } catch {
        return null;
    }
}

/**
 * Ask Zalo for the names the local cache could not supply.
 *
 * The cache only knows someone who has already spoken — `senderName` comes
 * off their messages — so a member who has never posted in the group would
 * be tagged as a bare uid. `getGroupMembersInfo` takes the whole missing set
 * in one call, and only runs when there is something missing, so the common
 * case still costs no network at all.
 *
 * Whatever comes back is written to `contacts`, so the next send skips the
 * call entirely.
 *
 * Never throws: no session, not a member of that group, or an API hiccup all
 * leave the uid in place, which is still a valid mention.
 *
 * @param {string[]} uids - uids the cache had no name for
 * @param {boolean} cacheOpen - whether openAccountDb() succeeded
 * @returns {Promise<Map<string, string>>} uid → display name, for those found
 */
async function fetchMentionNames(uids, cacheOpen) {
    const found = new Map();
    if (uids.length === 0) return found;
    try {
        const profiles = (await getApi().getGroupMembersInfo(uids))?.profiles || {};
        for (const [key, profile] of Object.entries(profiles)) {
            // Keys come back as the uid, sometimes with zca-js's "_0" version suffix.
            const uid = String(key).replace(/_0$/, "");
            const name = profile?.displayName || profile?.zaloName;
            if (!name) continue;
            found.set(uid, name);
            if (cacheOpen) {
                try {
                    upsertContact({ userId: uid, name, phone: profile?.phoneNumber || null });
                } catch {
                    /* caching the name is a nicety, not a reason to fail the send */
                }
            }
        }
    } catch {
        /* fall back to the uid — see the doc comment */
    }
    return found;
}

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
        if (!openAccountDb()) return null;
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
 * A history row built with the classifier every other capture path uses.
 *
 * `msg history` is a third way into the cache, beside the listener and the
 * mobile sync, and it used to carry its own mapping: the raw live msgType
 * (chat.photo) as the row type -- the very spelling a one-off migration had to
 * clean out -- and no has_attachment, so replaying a synced photo overwrote it
 * to 0 and sync-media never fetched it again. It also won the merge below over
 * the correctly classified cached row, so even the printed history showed the
 * raw spelling.
 *
 * @param {object} data - a live-encoded message payload (msgType string + content)
 * @param {string} threadId
 * @returns {object} the row as printed; `raw_data` is dropped before output
 */
function historyRow(data, threadId) {
    const info = classifyLiveMessage(data || {});
    return {
        msgId: data?.msgId,
        threadId,
        senderId: data?.uidFrom || null,
        senderName: data?.dName || null,
        text: info.text,
        timestamp: data?.ts ? Number(data.ts) : null,
        type: info.type,
        has_attachment: info.hasAttachment ? 1 : 0,
        raw_data: info.raw,
    };
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
            "Mention users by raw offset. Format: pos:userId:len (e.g. 0:USER_ID:5). Prefer writing @[userId] in the message — offsets are then computed for you. Use userId=-1 for @All.",
        )
        .option(
            "--quote <msgId>",
            "Send as a quote-reply to this message. Text messages only, and it must be in the local cache — run `msg history <threadId>` first if not.",
        )
        .option("--style <specs...>", "Text styles. Format: start:len:style (e.g. 0:5:bold 6:5:italic)")
        .option("--md", "Parse markdown-like formatting: **bold** *italic* __underline__ ~~strike~~ {red:text}")
        .option(
            "--react <icon>",
            "Auto-react to sent message. Codes: :> (haha), /-heart (heart), /-strong (like), :o (wow), :-(( (cry), :-h (angry)",
        )
        .action(async (threadId, message, opts) => {
            try {
                // One cache open serves both the @[uid] name lookups and the
                // --quote rebuild. Absent cache is not fatal for either: names
                // fall back to the uid, and --quote reports why it cannot.
                const cached = openAccountDb();

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

                // Mentions expand last, on the post-markdown text: a `@[uid]`
                // token contains no markdown metacharacters, whereas a display
                // name may well contain `*` or `_` and would be eaten the other
                // way round. Styles are then moved across the substitutions,
                // since their offsets were counted before the names went in.
                //
                // Expanding is pure and cheap, so it runs twice: once off the
                // cache to learn which uids it could not name, then again with
                // whatever one batched lookup filled in.
                const missing = new Set();
                let expanded = expandMentions(finalMsg, (uid) => {
                    const name = mentionName(uid, cached);
                    if (!name && uid !== ALL_MENTION_UID) missing.add(uid);
                    return name;
                });
                if (missing.size > 0 && Number(opts.type) === 1) {
                    const fetched = await fetchMentionNames([...missing], cached);
                    if (fetched.size > 0) {
                        expanded = expandMentions(finalMsg, (uid) => fetched.get(uid) || mentionName(uid, cached));
                    }
                }

                finalMsg = expanded.text;
                styles = shiftStyles(styles, expanded.edits);
                const mentions = [...parseMentionSpecs(opts.mention), ...expanded.mentions];

                // zca-js drops mentions outside a group, so a `-t 0` send would
                // quietly arrive with the names as plain text and nobody tagged.
                if (mentions.length > 0 && Number(opts.type) !== 1) {
                    warning("Mentions only apply to group messages — pass -t 1 to tag anyone.");
                }

                let quote;
                if (opts.quote) {
                    const built = buildQuote(cached ? getMessageById(opts.quote) : null, {
                        msgId: opts.quote,
                        threadId,
                    });
                    if (built.error) {
                        error(built.error);
                        return;
                    }
                    if (built.warning) warning(built.warning);
                    quote = built.quote;
                    // A sync-restored row's sender is a noised id that Zalo
                    // rejects outright (code 114), so resolve it rather than
                    // send something that cannot land.
                    if (built.opaqueSender) {
                        const fixed = await resolveQuoteSender(quote, getApi());
                        if (fixed.error) {
                            error(fixed.error);
                            return;
                        }
                        if (fixed.resolved) info(`Resolved the quoted message's sender: ${fixed.resolved}`);
                    }
                }

                // Build message content
                const hasExtras = mentions.length > 0 || styles.length > 0 || Boolean(quote);
                const msgContent = hasExtras
                    ? {
                          msg: finalMsg,
                          ...(mentions.length > 0 && { mentions }),
                          ...(styles.length > 0 && { styles }),
                          ...(quote && { quote }),
                      }
                    : finalMsg;

                const result = await getApi().sendMessage(msgContent, threadId, Number(opts.type));

                // The cliMsgId comes back from zca-js, which hands over the
                // clientId it actually put on the wire (patches/zca-js+2.2.0.patch
                // — upstream stamps `params.clientId = Date.now()` inside
                // handleMessage() and returns only {msgId}).
                //
                // This used to be a second `Date.now()` read here, taken before
                // the call. That is a different number from the one zca-js sent,
                // by however long the AES encrypt and the POST took — usually
                // 0-2ms, never guaranteed equal. So every id `send --json`
                // printed was a near-miss, and all three things that key on it
                // (`msg react`, `msg undo`, and `--quote`, which rebuilds the
                // payload from a cached row's cliMsgId) failed silently on it.
                //
                // Report only an id Zalo really holds. When there is none, say
                // so — a fabricated one is worse than an absent one.
                const cliMsgId = result.message?.cliMsgId ? String(result.message.cliMsgId) : null;
                if (cliMsgId) result.cliMsgId = cliMsgId;
                output(result, program.opts().json, () => success("Message sent"));

                if (result.message && !cliMsgId) {
                    warning(
                        "Zalo returned no cliMsgId for this send, so none is reported — the zca-js patch " +
                            "is missing (run `npx patch-package`). `msg react`/`msg undo`/`msg send --quote` " +
                            "need one; the local cache gets the real value once `listen` or `sync` sees " +
                            "Zalo echo the message back.",
                    );
                }

                // Auto-react if --react flag provided
                if (opts.react && result.message?.msgId) {
                    // addReaction needs the message's real cliMsgId — with the
                    // wrong one Zalo accepts the call and the reaction never
                    // shows up. Falling back to the msgId keeps the flag from
                    // hard-failing on an unpatched install; it is the same
                    // fallback `msg react` takes when nobody passes -c.
                    if (!cliMsgId) warning("Reacting without a cliMsgId — the reaction may not appear.");
                    const dest = {
                        data: {
                            msgId: String(result.message.msgId),
                            cliMsgId: cliMsgId || String(result.message.msgId),
                        },
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
        .option("-c, --cli-msg-id <id>", "Message's cliMsgId. Looked up in the local cache when omitted")
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
                            "Pass --cli-msg-id (from `listen --json`).",
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
        .option("-c, --cli-msg-id <id>", "Message's cliMsgId. Looked up in the local cache when omitted")
        .action(async (msgId, threadId, opts) => {
            try {
                // Same lookup `msg delete` does. cliMsgId is client-generated
                // and not derivable from msgId, but anything `listen`, `mcp` or
                // a sync captured has it -- so asking the caller for it was
                // only ever necessary for a message this machine never saw.
                //
                // `send --json` is a valid source again. It used to print a
                // second Date.now() of its own -- zca-js stamps the real
                // clientId inside handleMessage() and upstream returns only
                // {msgId} -- so the id it gave matched only by luck. The zca-js
                // patch now hands that clientId back, and `msg send` reports
                // that value or none at all.
                const cliMsgId = opts.cliMsgId || cachedMessageById(threadId, msgId)?.cliMsgId;
                if (!cliMsgId) {
                    error(
                        "cliMsgId is required to recall a message and is not in the local cache. " +
                            "Pass --cli-msg-id (from `listen --json`).",
                    );
                    return;
                }
                const payload = { msgId, cliMsgId: String(cliMsgId) };
                const result = await getApi().undo(payload, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Message recalled (undone)"));
            } catch (e) {
                error(`Undo failed: ${e.message}`);
            }
        });

    msg.command("forward <msgId> <threadId>")
        .description("Forward a text message to another conversation (text only — see below)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (msgId, threadId, opts) => {
            // This command could never have worked. zca-js takes
            // `forwardMessage(payload, threadIds, type)` where payload is
            // `{ message: string }` and threadIds is an ARRAY; the old call
            // passed the msgId string as the payload and a bare string as the
            // thread list. `if (!payload.message) throw` fires on the first
            // line of the API, so every invocation died with "Missing message
            // content" before touching the network -- identically for -t 0 and
            // -t 1, for every message type. The zca-api-surface test did not
            // catch it because the method does exist; only its arity was wrong.
            const jsonMode = program.opts().json;
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }

            let row;
            try {
                initDb(join(CONFIG_DIR, "accounts", activeAcc.ownId, "zalo.db"));
                row = getMessageById(msgId);
            } catch (e) {
                error(
                    `Local cache unavailable (${e.message}). Run \`zalo-agent listen\` or \`zalo-agent sync\` first.`,
                );
                process.exit(1);
            }
            if (!row) {
                error(`Message ${msgId} is not in the local cache.`);
                info("Fetch the conversation first:  zalo-agent msg history <threadId> -t <0|1>");
                process.exit(1);
            }

            // "Forward" is not one operation in Zalo. Only TEXT rides the
            // mforward API and gets the "forwarded" badge. Everything else the
            // app re-sends as a fresh message of its own kind -- measured
            // 2026-09-28 by forwarding a contact card by hand: the copy that
            // arrived carried no `reference` and no `fwLvl` at all, where a
            // forwarded text carries both. So dispatch on the row's classified
            // type and reproduce what the app does.
            //
            // Guard on `type`, never on `typeof text === "string"`: a synced
            // photo/file/sticker stores a human placeholder ("[Hình ảnh]",
            // "[File] x.pdf") in the text column, and a type-of check would
            // forward that placeholder and call it a forwarded photo.
            const api = getApi();
            const threadType = Number(opts.type);
            let raw = {};
            try {
                raw = JSON.parse(row.raw_data || "{}");
            } catch {
                /* a row with unreadable raw_data can still forward as text */
            }
            const c = raw.content && typeof raw.content === "object" ? raw.content : null;

            /**
             * Re-send a downloaded file as its own attachment.
             *
             * Goes through sendAttachments, not api.sendMessage: a non-inline
             * upload needs a socket to settle its upload-complete frame, and a
             * running daemon holds the account's only one. Calling sendMessage
             * directly parks the send in ctx.uploadCallbacks with nothing left
             * to settle it -- measured, a file forward simply hung for four
             * minutes and returned nothing at all. sendAttachments hands the
             * upload to the daemon and falls back to its own socket when none
             * is running.
             */
            const resendLocal = async () => {
                if (!row.localPath || !existsSync(row.localPath)) {
                    error(`Message ${msgId} is "${row.type}" but its media is not downloaded locally.`);
                    info("Fetch it first:  zalo-agent sync-media -T <threadId>");
                    process.exit(1);
                }
                const out = await sendAttachments(api, [resolve(row.localPath)], threadId, threadType, {
                    caption: "",
                    uploadTimeout: 120000,
                });
                if (out.error) throw new Error(out.error);
                return out.result;
            };

            const forwarders = {
                // action "recommened.user" carries the shared person's uid in
                // `params`; sendCard reproduces the card exactly as the app does.
                card: async () => api.sendCard({ userId: String(c?.params ?? "").trim() }, threadId, threadType),
                sticker: async () =>
                    api.sendSticker({ id: c?.id, cateId: c?.catId, type: c?.type ?? 3 }, threadId, threadType),
                link: async () => api.sendLink({ link: c?.href }, threadId, threadType),
                // sendVideo wants the geometry too; Zalo rejects the call with
                // code 114 when duration/width/height are missing. They live in
                // the payload's `params` blob, not as top-level fields.
                video: async () => {
                    let p = {};
                    try {
                        p = typeof c?.params === "string" ? JSON.parse(c.params) : (c?.params ?? {});
                    } catch {
                        /* geometry falls back to the defaults below */
                    }
                    return api.sendVideo(
                        {
                            videoUrl: c?.href,
                            thumbnailUrl: c?.thumb || "",
                            duration: Number(p.duration) || 0,
                            width: Number(p.video_width || p.video_original_width) || 1280,
                            height: Number(p.video_height || p.video_original_height) || 720,
                        },
                        threadId,
                        threadType,
                    );
                },
                voice: async () => api.sendVoice({ voiceUrl: c?.href }, threadId, threadType),
                photo: resendLocal,
                file: resendLocal,
                gif: resendLocal,
                doodle: resendLocal,
            };

            // A shared contact arrives as a link whose action says otherwise.
            const kind = c?.action === "recommened.user" ? "card" : row.type;

            if (kind !== "text") {
                const send = forwarders[kind];
                if (!send) {
                    error(`Cannot forward a "${row.type}" message — no send path reproduces it.`);
                    info("Text uses the forward API; other kinds are re-sent as a new message of their own type.");
                    process.exit(1);
                }
                try {
                    const res = await send();
                    output(res, jsonMode, () => success(`Forwarded ${kind} to ${threadId}`));
                } catch (e) {
                    error(`Forward failed (${kind}): ${e.message}`);
                    process.exit(1);
                }
                return;
            }
            if (!row.text) {
                error(`Message ${msgId} has no text to forward.`);
                process.exit(1);
            }

            try {
                // `reference` (the "forwarded from" decoration) is deliberately
                // omitted. Real forwards carry an opaque 32-hex id there -- e.g.
                // 1751af19dac61f3e039457dc53dcd348 -- alongside logSrcType 1 and
                // fwLvl 1. That id is not the numeric msgId and nothing in the
                // local cache holds it (no row carries `realMsgId`), so passing
                // the numeric id would send a reference pointing at nothing.
                // Without it the text still arrives; it just is not badged as a
                // forward.
                const result = await getApi().forwardMessage({ message: row.text }, [threadId], Number(opts.type));
                const failed = result?.fail?.length ?? 0;
                if (failed > 0) {
                    error(`Forward rejected for ${failed} target(s): ${JSON.stringify(result.fail)}`);
                    process.exit(1);
                }
                output(result, jsonMode, () => success(`Forwarded to ${threadId}`));
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
                // The original frames, kept for the cache write: it goes through
                // the listener's own writer, not through the printed rows.
                const fetchedFrames = [];
                let usedRestApi = false;

                if (threadType === 1) {
                    // Group: Try REST API first
                    try {
                        const history = await api.getGroupChatHistory(threadId, limit);
                        for (const data of history || []) {
                            fetchedMessages.push(historyRow(data, threadId));
                            fetchedFrames.push({ threadId, type: threadType, data });
                        }
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
                            allMessages.push(historyRow(msg.data, msg.threadId));
                            fetchedFrames.push({ threadId: msg.threadId, type: threadType, data: msg.data });

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
                if (dbActive && fetchedFrames.length > 0) {
                    for (const frame of fetchedFrames) {
                        try {
                            // Same writer as `listen`: shared vocabulary,
                            // has_attachment, removals applied, and a thread
                            // name that a message's sender cannot overwrite.
                            storeLiveMessage(frame);
                        } catch {
                            // one bad frame must not stop the rest
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
