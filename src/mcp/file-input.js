/**
 * The file inputs of the MCP tools: one shape everywhere a tool takes a file (src/core/file-inputs.js resolves it).
 *
 * A file is a path on the machine the server runs on (a string: for a caller on that machine), or an object with
 * exactly one of `fileId` (an upload, zalo_file), `url` (the server downloads it) or `data` (base64, with `name`).
 */

import { z } from "zod";
import { resolveUploads } from "../core/deploy-policy.js";
import { getUploadStore } from "../core/upload-store.js";
import { FileInputError, materializeFiles } from "../core/file-inputs.js";

/** What every file input's description ends with: how a caller on another machine sends a file. */
export const REMOTE_FILE_HINT =
    "A caller on another machine (an HTTP connection) cannot pass a path: send {data: <base64>, name} for a small " +
    "file, {url} for one on the web, or {fileId} after uploading it through zalo_file 'upload_begin'";

/** `fileId`: an upload kept in the account's upload store. */
export const fileIdSchema = () =>
    z
        .string()
        .regex(/^f_[A-Za-z0-9_-]{24}$/, "a fileId from zalo_file (f_ and 24 letters, digits, _ or -)")
        .describe("A file uploaded earlier (zalo_file 'upload_begin' or 'upload'), kept for a day");

/**
 * A file given as itself rather than a path: `{fileId}`, `{url, name?}` or `{data, name, mimeType?}`.
 *
 * @returns {import("zod").ZodType}
 */
export function fileSourceSchema() {
    return z.union([
        z.object({ fileId: fileIdSchema() }).strict(),
        z
            .object({
                url: z.string().url().describe("An http(s) link this server downloads (public addresses only)"),
                name: z
                    .string()
                    .min(1)
                    .max(200)
                    .optional()
                    .describe("The file name to send it under (default: the link's own)"),
            })
            .strict(),
        z
            .object({
                data: z.string().min(1).describe("The file's bytes, base64 (a data: URL works too)"),
                name: z
                    .string()
                    .min(1)
                    .max(200)
                    .describe("The file name, with its extension (photo.jpg): Zalo decides by it how to show it"),
                mimeType: z.string().min(3).max(100).optional().describe("Its media type, e.g. image/png"),
            })
            .strict(),
    ]);
}

/**
 * One file: a path on the server's machine (a string), or {@link fileSourceSchema}.
 *
 * @returns {import("zod").ZodType}
 */
export function fileItemSchema() {
    return z.union([z.string().min(1), fileSourceSchema()]);
}

/**
 * `file`, the single-file input of an action tool (beside its `filePath`).
 *
 * @param {string} which - the actions it applies to, for the description
 * @returns {import("zod").ZodOptional<import("zod").ZodType>}
 */
export const fileInput = (which) =>
    fileSourceSchema()
        .optional()
        .describe(
            `Only for ${which}: the image as {fileId} (an upload, zalo_file), {url, name?} (this server downloads ` +
                "it) or {data, name, mimeType?} (base64): the way for a caller on another machine. `filePath` is a " +
                "path on the machine this server runs on instead",
        );

/**
 * The refusal when an action that takes one file got none or both of `filePath` and `file`.
 *
 * @param {{filePath?: string, file?: object}} a
 * @returns {string|undefined}
 */
export function singleFileCheck(a) {
    if (a.filePath === undefined && a.file === undefined)
        return `Give the image as \`file\` ({fileId}, {url} or {data, name}) or, for a caller on the server's machine, \`filePath\`.`;
    if (a.filePath !== undefined && a.file !== undefined) return "Give `file` or `filePath`, not both.";
    return undefined;
}

/**
 * The one file of an action as a file item.
 *
 * @param {{filePath?: string, file?: object}} a
 * @returns {string|object}
 */
export const singleFileOf = (a) => (a.file !== undefined ? a.file : a.filePath);

/**
 * Run an action's call with its one file as a path; a refusal of the file is thrown as the action's error.
 *
 * @template T
 * @param {object} a - the action's input
 * @param {{files: ReturnType<typeof fileResolver>}} ctx
 * @param {(path: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSingleFile(a, ctx, fn) {
    const label = a.file !== undefined ? "file" : "filePath";
    const out = await ctx.files.run([singleFileOf(a)], label, ([f]) => fn(f.path).then((value) => ({ value })));
    if (out.fileError) throw new Error(out.fileError);
    return out.value;
}

/**
 * Whether the MCP server serving this call is talking to a caller on another machine: an HTTP request from an
 * address that is not this machine's. A stdio client always runs here.
 *
 * @param {object} server - the per-request McpServer (mcp-http-transport.js sets statelessHttp and clientLoopback)
 * @returns {boolean}
 */
export function isRemoteCaller(server) {
    return server?.statelessHttp === true && server?.clientLoopback !== true;
}

/**
 * The file resolver a tool's handler uses: items in, paths out for one call, removed afterwards.
 *
 * @param {{server: object, config: object, accountDir?: string|null, accountId: () => string|undefined}} deps
 * @returns {{run: <T>(items: Array<string|object>, label: string, fn: (files: object[]) => Promise<T>) => Promise<T|
 *   {fileError: string}>, policy: () => object, remote: () => boolean}}
 */
export function fileResolver({ server, config, accountDir, accountId }) {
    const policy = () => resolveUploads({ config, accountId: accountId() || undefined });
    return {
        policy,
        remote: () => isRemoteCaller(server),
        /**
         * Resolve the items and run `fn` with them; a refusal of an item comes back as `{fileError}`.
         */
        async run(items, label, fn) {
            let resolved;
            try {
                resolved = await materializeFiles(items, {
                    store: accountDir ? getUploadStore(accountDir) : null,
                    policy: policy(),
                    remote: isRemoteCaller(server),
                    label,
                });
            } catch (e) {
                if (e instanceof FileInputError) return { fileError: e.message };
                throw e;
            }
            try {
                return await fn(resolved.files);
            } finally {
                resolved.cleanup();
            }
        },
    };
}
