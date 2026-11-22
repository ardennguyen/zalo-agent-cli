/**
 * `file`: the account's upload store (src/core/upload-store.js), zalo_file's twin. A file put here is named by a
 * `fileId` that `--file-id` on the sending commands, and `{fileId}` in the MCP tools, take until it expires.
 */

import { createReadStream } from "node:fs";
import { cliUploads, withCliFiles } from "../utils/cli-files.js";
import { sizeText } from "../core/upload-store.js";
import { error, info, output, success } from "../utils/output.js";

/**
 * Register the `file` commands.
 *
 * @param {import("commander").Command} program
 */
export function registerFileCommands(program) {
    const json = () => program.opts().json;
    const file = program
        .command("file")
        .description("The account's upload store: files kept a day under a fileId, for sends that name it");

    file.command("put [path]")
        .description("Store a file (a path here, or --url to download one) and print its fileId")
        .option("--url <url>", "Download this http(s) link instead (public addresses only)")
        .option("--name <name>", "The file name to keep it under (default: its own)")
        .action(async (path, opts) => {
            try {
                if (Boolean(path) === Boolean(opts.url)) throw new Error("Give a path or --url, one of them.");
                const { store, policy } = cliUploads();
                const item = opts.url ? { url: opts.url, ...(opts.name ? { name: opts.name } : {}) } : path;
                const saved = await withCliFiles([item], ([f]) =>
                    store.save(createReadStream(f.path), {
                        name: opts.name || f.name,
                        mimeType: f.mimeType,
                        maxBytes: policy.maxBytes,
                        quotaBytes: policy.quotaBytes,
                        ttlMs: policy.ttlMs,
                        declaredSize: f.size,
                    }),
                );
                output(saved, json(), () =>
                    success(`Stored ${saved.name} (${sizeText(saved.size)}) as ${saved.fileId}`),
                );
            } catch (e) {
                error(`File put failed: ${e.message}`);
            }
        });

    file.command("list")
        .description("List the stored files and the space they use")
        .action(() => {
            try {
                const { store, policy } = cliUploads();
                const files = store.list();
                const usage = store.usage();
                output(
                    { count: files.length, files, usage: { ...usage, quotaBytes: policy.quotaBytes } },
                    json(),
                    () => {
                        for (const f of files)
                            info(`${f.fileId}  ${f.name}  ${sizeText(f.size)}  until ${f.expiresAt}`);
                        info(`${files.length} file(s), ${sizeText(usage.bytes)} of ${sizeText(policy.quotaBytes)}`);
                    },
                );
            } catch (e) {
                error(e.message);
            }
        });

    file.command("info <fileId>")
        .description("Show a stored file's name, size and expiry")
        .action((fileId) => {
            try {
                const got = cliUploads().store.get(fileId);
                if (!got) throw new Error(`fileId ${fileId} is unknown or has expired.`);
                const view = { ...got };
                delete view.path;
                output(view, json(), () =>
                    info(`${view.fileId}  ${view.name}  ${sizeText(view.size)}  until ${view.expiresAt}`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    file.command("delete <fileId>")
        .description("Delete a stored file")
        .action((fileId) => {
            try {
                if (!cliUploads().store.delete(fileId)) throw new Error(`fileId ${fileId} is unknown or has expired.`);
                output({ success: true, fileId }, json(), () => success(`Deleted ${fileId}`));
            } catch (e) {
                error(e.message);
            }
        });
}
