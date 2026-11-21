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
        policy: resolveUploads({ config, accountId: account.ownId }),
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
        return await fn(files);
    } finally {
        cleanup();
    }
}
