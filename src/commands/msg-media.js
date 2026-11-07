/**
 * `msg media <msgId>`: a cached photo, voice message, video or file, decrypted for the person at the keyboard. The
 * cache itself stays encrypted (src/core/keystore/media-seal.js); this is the CLI's twin of `zalo_view_media`.
 *
 * - `--out <file>`: the plaintext written to a file the user names (0600).
 * - `--stdout`: the plaintext bytes on standard output (for a pipe).
 * - `--deliver tempfile` (the default): a private decrypted copy under `<config-dir>/tmp/media/`, deleted after
 *   `media.tempfileTtl` (10 minutes) by a running daemon's sweep or the next command's.
 * - `--deliver link`: a link the running `listen` / `mcp start` daemon serves (`/zalo/media/<token>`, 10 minutes),
 *   asked over its loopback channel; without a daemon there is no one to serve it.
 * - `--deliver inline`: the bytes as base64 in the `--json` reply (pictures and voice up to `inlineMaxBytes`).
 * - `--open`: a tempfile, opened with this machine's viewer.
 *
 * It reads the cache only (no login). A message in a hidden chat is refused, as `msg search` leaves those chats out.
 */
import { closeSync, openSync } from "node:fs";
import { getActive } from "../core/accounts.js";
import { getAccountDbPath, getAccountDir } from "../core/credentials.js";
import { getMessageById, initDb } from "../core/db.js";
import { mediaLinkViaDaemon } from "../core/daemon-channel.js";
import { resolveMediaDelivery } from "../core/deploy-policy.js";
import { hiddenChatsFor } from "../core/hidden-chats.js";
import { scopeOfDir } from "../core/keystore/keyring.js";
import { decryptMediaToFile, mediaFileState, openMedia } from "../core/keystore/media-seal.js";
import { INLINE_KINDS, deliverCachedMedia, mediaInfo } from "../core/media-deliver.js";
import { openFile } from "../utils/open-file.js";
import { error, info, output, success } from "../utils/output.js";

const MODES = ["inline", "link", "tempfile"];

/**
 * Register `msg media` on the `msg` group.
 *
 * @param {import("commander").Command} msg
 * @param {import("commander").Command} program
 * @returns {import("commander").Command}
 */
export function registerMsgMedia(msg, program) {
    const cmd = msg
        .command("media <msgId>")
        .description(
            "Get a cached photo, voice message, video or file, decrypted: a private temporary copy (default), a file (--out), stdout (--stdout) or a link from the running daemon (--deliver link)",
        )
        .option("--out <file>", "Write the decrypted media to this file")
        .option("--stdout", "Write the decrypted bytes to standard output")
        .option("--deliver <mode>", "tempfile (default), link (needs a running listen / mcp start) or inline (--json)")
        .option("--open", "Open it with this machine's viewer (a temporary copy)")
        .action(async (msgId, opts) => {
            const jsonMode = program.opts().json;
            const fail = (message) => {
                error(message);
                process.exit(1);
            };
            const picked = [
                opts.out ? "--out" : null,
                opts.stdout ? "--stdout" : null,
                opts.deliver ? "--deliver" : null,
            ];
            if (picked.filter(Boolean).length > 1) fail(`Choose one of ${picked.filter(Boolean).join(", ")}.`);
            const mode = opts.deliver ? String(opts.deliver).trim().toLowerCase() : null;
            if (mode && !MODES.includes(mode)) fail(`--deliver is one of ${MODES.join(", ")}.`);
            if (opts.open && (opts.out || opts.stdout || (mode && mode !== "tempfile"))) {
                fail("--open opens a temporary copy: use it alone or with --deliver tempfile.");
            }
            const account = getActive();
            if (!account) fail("No active account. Please login first.");
            const accountDir = getAccountDir(account.ownId);
            let row;
            try {
                initDb(getAccountDbPath(account.ownId));
                row = getMessageById(String(msgId));
            } catch (e) {
                fail(`The local cache could not be opened: ${e.message}`);
            }
            if (!row) fail(`Message ${msgId} is not in the local cache.`);
            if (hiddenChatsFor(account.ownId, { stateDir: accountDir }).isHidden(row.threadId)) {
                fail("That message is in a hidden chat, which this command leaves out (as msg search does).");
            }
            if (!row.localPath || mediaFileState(row.localPath) === "absent") {
                fail(
                    `Message ${msgId} has no downloaded media. Fetch it first:  zalo-agent sync-media -T ${row.threadId}`,
                );
            }
            const scope = scopeOfDir(accountDir);
            const base = { msgId: row.msgId, threadId: row.threadId, mediaType: row.type || null };

            try {
                if (opts.stdout) {
                    const m = openMedia(row.localPath, scope, { msgId: row.msgId });
                    await new Promise((resolve, reject) => {
                        const s = m.stream();
                        s.on("error", reject);
                        process.stdout.on("error", reject);
                        s.on("end", resolve);
                        s.pipe(process.stdout, { end: false });
                    });
                    return;
                }
                if (opts.out) {
                    // Created 0600 before a byte is written: the plaintext is the user's to keep, not the world's.
                    closeSync(openSync(opts.out, "w", 0o600));
                    const written = decryptMediaToFile(row.localPath, opts.out, scope, { msgId: row.msgId });
                    return output({ ...base, delivery: "file", path: opts.out, size: written }, jsonMode, () =>
                        success(`Wrote ${written} bytes to ${opts.out}`),
                    );
                }
                if (mode === "link") {
                    const got = await mediaLinkViaDaemon(accountDir, { msgId: row.msgId });
                    if (!got) {
                        fail(
                            "A link is served by a running daemon, and none is running for this account. Start `zalo-agent listen` or `zalo-agent mcp start`, or use --out / the default tempfile.",
                        );
                    }
                    if (!got.ok) fail(`The daemon could not hand out a link: ${got.error}`);
                    const reply = {
                        ...base,
                        delivery: "link",
                        ...got,
                        expiresAt: new Date(got.expiresAt).toISOString(),
                    };
                    delete reply.ok;
                    return output(reply, jsonMode, () => {
                        success(got.url);
                        info(
                            `Works until ${new Date(got.expiresAt).toLocaleString()}${got.auth === "bearer" ? ", with the server's bearer token" : ""}.`,
                        );
                    });
                }
                const policy = resolveMediaDelivery({ accountId: account.ownId });
                const meta = mediaInfo(row.localPath);
                if (mode === "inline") {
                    if (!jsonMode) fail("--deliver inline prints base64 in the --json reply; for a file use --out.");
                    if (!INLINE_KINDS[row.type] || meta.size > policy.inlineMaxBytes) {
                        fail(
                            `Only pictures and voice up to ${policy.inlineMaxBytes} bytes go inline; use --out or the default tempfile.`,
                        );
                    }
                }
                const out = await deliverCachedMedia({
                    mode: mode || "tempfile",
                    file: row.localPath,
                    scope,
                    msgId: row.msgId,
                    threadId: row.threadId,
                    accountId: account.ownId,
                    info: meta,
                    policy,
                    // This process exits now: the copy outlives it and a sweep removes it after the TTL.
                    keepOnExit: true,
                });
                if (out.mode === "inline") {
                    return output(
                        {
                            ...base,
                            delivery: "inline",
                            mimeType: out.mimeType,
                            size: out.size,
                            data: out.bytes.toString("base64"),
                        },
                        true,
                    );
                }
                if (opts.open) openFile(out.path);
                return output(
                    {
                        ...base,
                        delivery: "tempfile",
                        path: out.path,
                        mimeType: out.mimeType,
                        size: out.size,
                        expiresAt: new Date(out.expiresAt).toISOString(),
                        opened: Boolean(opts.open),
                    },
                    jsonMode,
                    () => {
                        success(out.path);
                        info(`A private decrypted copy, deleted after ${new Date(out.expiresAt).toLocaleString()}.`);
                    },
                );
            } catch (e) {
                fail(`The media could not be read: ${e.message}`);
            }
        });
    // The preAction hook logs in before most commands. This one reads the cache and nothing else.
    cmd.zaloLocalOnly = true;
    return cmd;
}
