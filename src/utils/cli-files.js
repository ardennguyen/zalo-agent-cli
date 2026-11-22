/**
 * The CLI's twin of the MCP file inputs (src/mcp/file-input.js): the commands that take a file take a path, `--url`
 * (downloaded here under the same guards as a `url` item) and `--file-id` (an upload in the account's store, `file
 * put` or zalo_file), resolved by the same code (src/core/file-inputs.js). The CLI runs on this machine, so a path is
 * always read.
 */

import { getActive } from "../core/accounts.js";
import { getAccountDir } from "../core/credentials.js";
import { resolveUploads } from "../core/deploy-policy.js";
import { materializeFiles } from "../core/file-inputs.js";
import { getUploadStore } from "../core/upload-store.js";
import { knownAccountFileLimit } from "../core/zalo-file-limit.js";
import { loadMCPConfig } from "../mcp/mcp-config.js";

/** Commander's collector for a repeatable option (`--url a --url b`). */
export const collect = (value, previous = []) => [...previous, value];

/**
 * The active account's upload store and the upload policy (mcp-config.json's `uploads`, the live policy on top).
 *
 * @returns {{store: import("../core/upload-store.js").UploadStore, policy: object, accountDir: string}}
 */
export function cliUploads() {
    const account = getActive();
    if (!account) throw new Error("No active account. Please login first.");
    const accountDir = getAccountDir(account.ownId);
    let config = {};
    try {
        config = loadMCPConfig() || {};
    } catch {
        /* no config file: the defaults */
    }
    return {
        store: getUploadStore(accountDir),
        // The limit a daemon last read from the account's session (the CLI may run without one).
        policy: resolveUploads({
            config,
            accountId: account.ownId,
            zaloLimitBytes: knownAccountFileLimit(accountDir)?.bytes ?? null,
        }),
        accountDir,
    };
}

/**
 * The files a command names: its paths, then `--url`s, then `--file-id`s.
 *
 * @param {{paths?: string[], urls?: string[], fileIds?: string[]}} sources
 * @returns {Array<string|object>}
 */
export function cliFileItems({ paths = [], urls = [], fileIds = [] }) {
    return [...paths, ...urls.map((url) => ({ url })), ...fileIds.map((fileId) => ({ fileId }))];
}

/**
 * The files as paths on this machine, and the function that removes what was downloaded for them.
 *
 * @param {Array<string|object>} items
 * @param {{label?: string}} [opts]
 * @returns {Promise<{files: object[], cleanup: () => void}>}
 */
export async function materializeCliFiles(items, { label = "file" } = {}) {
    // A plain path needs no store: the CLI works without an account for one.
    if (items.every((i) => typeof i === "string")) {
        return materializeFiles(items, {
            store: null,
            policy: { localPaths: "any", localPathRoots: [], inlineMaxBytes: 0, ttlMs: 0 },
            remote: false,
            label,
        });
    }
    const { store, policy } = cliUploads();
    return materializeFiles(items, { store, policy: { ...policy, localPaths: "any" }, remote: false, label });
}

/**
 * After a send: each stored upload (`--file-id`) that went out is marked sent with its message id; a running daemon
 * removes it once the message is recorded (src/core/upload-store.js). Files and photos are sent in the order given,
 * GIFs last (src/zalo/api/upload.js); a file that did not go out is kept for a retry.
 *
 * @param {object[]} files - from {@link materializeCliFiles}
 * @param {object[]|object|null|undefined} attachments - the send's `attachment` rows (or a failure's `partial` ones)
 * @param {string} threadId
 */
export function consumeCliSent(files, attachments, threadId) {
    const stored = files.filter((f) => f.from === "fileId");
    if (!stored.length) return;
    const { store } = cliUploads();
    const order = [
        ...files.map((f, i) => i).filter((i) => !/\.gif$/i.test(files[i].path)),
        ...files.map((f, i) => i).filter((i) => /\.gif$/i.test(files[i].path)),
    ];
    (Array.isArray(attachments) ? attachments : attachments ? [attachments] : []).forEach((row, j) => {
        const f = files[order[j]];
        if (f?.from === "fileId" && (row?.msgId ?? null) !== null) {
            store.markSent(f.fileId, { msgIds: [String(row.msgId)], threadId: String(threadId) });
        }
    });
}

/**
 * Run `fn` with the files as paths on this machine; what was downloaded for it is removed afterwards.
 *
 * @template T
 * @param {Array<string|object>} items
 * @param {(files: object[]) => Promise<T>} fn
 * @param {{label?: string}} [opts]
 * @returns {Promise<T>}
 */
export async function withCliFiles(items, fn, { label = "file" } = {}) {
    // The CLI is the machine's own user: every path it names is read.
    const { files, cleanup } = await materializeCliFiles(items, { label });
    try {
        const out = await fn(files);
        // Used (an avatar, a product photo, `file put`'s copy): a stored upload is no message to record, it goes now.
        const stored = files.filter((f) => f.from === "fileId");
        if (stored.length) for (const f of stored) cliUploads().store.markSent(f.fileId, { needsRecord: false });
        return out;
    } finally {
        cleanup();
    }
}
