/**
 * `zalo_file`: the account's upload store (src/core/upload-store.js) as MCP actions, the `file` commands' twin. It is
 * how a caller on another machine gets a file to this server ahead of the call that sends it:
 *
 * - 'upload_begin': a one-time upload link on this server (PUT or POST the raw file to it, no token needed), and the
 *   fileId the file will have; the way for a file larger than a call carries inline, or for a sandbox with curl;
 * - 'upload': a file given inline (`data`) or by `url`, stored now (to send it to several conversations);
 * - 'info', 'list', 'delete'.
 *
 * Any tool that takes a file then takes `{fileId}`.
 */

import { createReadStream } from "node:fs";
import { z } from "zod";
import { validatePublicUrl } from "../core/deploy-policy.js";
import { actionTool } from "./action-tool.js";
import { getMediaLinks } from "../core/media-deliver.js";
import { getUploadStore, sizeText } from "../core/upload-store.js";
import { UPLOAD_PATH_PREFIX } from "../core/upload-route.js";
import { fileIdSchema } from "./file-input.js";

/** The store, or the refusal for a server that keeps none. */
function storeOf(ctx) {
    if (!ctx.accountDir) return { error: "This server keeps no upload store." };
    return { store: getUploadStore(ctx.accountDir) };
}

/** The usage line every listing carries. */
function usageOf(store, policy) {
    const u = store.usage();
    return {
        bytes: u.bytes,
        files: u.files,
        quotaBytes: policy.quotaBytes,
        percent: Math.round((u.bytes / policy.quotaBytes) * 1000) / 10,
    };
}

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const FILE_ACTIONS = {
    upload_begin: {
        async run(a, ctx) {
            const { store, error } = storeOf(ctx);
            if (error) throw new Error(error);
            const links = getMediaLinks();
            if (!links.mounted) {
                throw new Error(
                    "This server runs on your machine (it is not reached over HTTP): pass the file's path instead.",
                );
            }
            const problem = links.issueProblem();
            if (problem) throw new Error(`No upload link can be made: ${problem}.`);
            const policy = ctx.files.policy();
            const maxBytes = a.size ? Math.min(policy.maxBytes, a.size) : policy.maxBytes;
            if (a.size && a.size > policy.maxBytes) {
                throw new Error(`The file is over the ${sizeText(policy.maxBytes)} limit for one upload.`);
            }
            const link = store.beginUpload({
                name: a.name ?? null,
                mimeType: a.mimeType ?? null,
                maxBytes,
                ttlMs: policy.ttlMs,
                linkTtlMs: policy.uploadLinkTtlMs,
            });
            const base = validatePublicUrl(links.base()).url;
            const uploadUrl = `${base}${UPLOAD_PATH_PREFIX}/u/${link.token}${a.name ? `?name=${encodeURIComponent(a.name)}` : ""}`;
            return {
                fileId: link.fileId,
                uploadUrl,
                method: "PUT",
                maxBytes,
                expiresAt: new Date(link.expiresAt).toISOString(),
                howTo:
                    `PUT (or POST) the raw file as the request body to uploadUrl, once, before expiresAt; no ` +
                    `Authorization is needed. E.g. curl -T ./photo.jpg "${uploadUrl}". Then pass {"fileId": ` +
                    `"${link.fileId}"} wherever a tool takes a file. The file is kept ${Math.round(policy.ttlMs / 3_600_000)} h.`,
            };
        },
    },
    upload: {
        check: (a) =>
            (a.data === undefined) === (a.url === undefined)
                ? "Give the file as `data` (base64, with `name`) or as `url`, one of them."
                : a.data !== undefined && !a.name
                  ? "`name` is required with `data` (the file name with its extension, e.g. photo.jpg)."
                  : undefined,
        async run(a, ctx) {
            const { store, error } = storeOf(ctx);
            if (error) throw new Error(error);
            const policy = ctx.files.policy();
            const item = a.data !== undefined ? { data: a.data, name: a.name, mimeType: a.mimeType } : { url: a.url };
            if (a.url !== undefined && a.name) item.name = a.name;
            const out = await ctx.files.run([item], a.data !== undefined ? "data" : "url", async ([f]) => {
                return store.save(createReadStream(f.path), {
                    name: f.name,
                    mimeType: a.mimeType || f.mimeType || null,
                    maxBytes: policy.maxBytes,
                    quotaBytes: policy.quotaBytes,
                    ttlMs: policy.ttlMs,
                    declaredSize: f.size,
                });
            });
            if (out.fileError) throw new Error(out.fileError);
            return { ...out, usage: usageOf(store, policy) };
        },
    },
    info: {
        check: (a) => (a.fileId ? undefined : "fileId is required for action='info'."),
        async run(a, ctx) {
            const { store, error } = storeOf(ctx);
            if (error) throw new Error(error);
            const got = store.get(a.fileId);
            if (got) {
                const view = { ...got };
                delete view.path;
                return { ...view, status: "stored" };
            }
            const waiting = store.pending(a.fileId);
            if (waiting)
                return { fileId: a.fileId, status: "waiting", expiresAt: new Date(waiting.expiresAt).toISOString() };
            throw new Error(`fileId ${a.fileId} is unknown or has expired.`);
        },
    },
    list: {
        async run(_a, ctx) {
            const { store, error } = storeOf(ctx);
            if (error) throw new Error(error);
            const files = store.list();
            return { count: files.length, files, usage: usageOf(store, ctx.files.policy()) };
        },
    },
    delete: {
        check: (a) => (a.fileId ? undefined : "fileId is required for action='delete'."),
        async run(a, ctx) {
            const { store, error } = storeOf(ctx);
            if (error) throw new Error(error);
            if (!store.delete(a.fileId)) throw new Error(`fileId ${a.fileId} is unknown or has expired.`);
            return { success: true, fileId: a.fileId };
        },
    },
};

/** zalo_file's metadata. */
export const FILE_META = {
    title: "Upload Files to the Zalo Server",
    description:
        "Get a file onto this server before sending it, for a caller on another machine (an HTTP connection), " +
        "which cannot pass a path: the file tools then take `{fileId}`. Actions: 'upload_begin' (a one-time upload " +
        "link: PUT the raw file to `uploadUrl`, e.g. `curl -T photo.jpg <uploadUrl>`, no token needed; returns the " +
        "`fileId` it will have; for large files, up to 100 MB by default), 'upload' (a file given as `data` (base64, " +
        "with `name`) or as a `url` this server downloads, stored now so several sends can use it), 'info' (a " +
        "`fileId`'s name, size and expiry, or whether its upload link is still waiting), 'list' (the stored files " +
        "and the space they use) and 'delete'. Files are kept for a day, in a per-account store with its own quota " +
        "(500 MB by default). A small file can also go straight into a send as {data, name}, and a file on the web " +
        "as {url}, without this tool.",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(FILE_ACTIONS)).describe("Upload store operation to perform"),
            fileId: fileIdSchema().optional().describe("For 'info' and 'delete': the file's id"),
            name: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe(
                    "For 'upload_begin' and 'upload': the file name with its extension (photo.jpg); required with `data`",
                ),
            mimeType: z.string().min(3).max(100).optional().describe("For 'upload_begin' and 'upload': its media type"),
            size: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    "Only for 'upload_begin': the file's size in bytes, when known (refused at once when too big)",
                ),
            data: z.string().min(1).optional().describe("Only for 'upload': the file's bytes, base64"),
            url: z.string().url().optional().describe("Only for 'upload': an http(s) link this server downloads"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

/**
 * zalo_file's handler.
 *
 * @param {object} ctx - the tools' context (mcp-tools.js toolCtx)
 * @returns {(args: object, extra?: object) => Promise<object>}
 */
export function fileTool(ctx) {
    return actionTool("zalo_file", FILE_ACTIONS, ctx);
}
