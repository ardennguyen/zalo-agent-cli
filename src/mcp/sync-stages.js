/**
 * The zalo_sync stages the MCP server runs itself, beside the daemon's own runners (src/core/daemon-sync.js:
 * `messages`, `reactions`, `cloud`): `media` downloads the attachments a restore recorded, as `sync-media` does, and
 * `boards` stores notes, pins, polls and reminders, as `sync-boards` does. Neither taps the phone. Both write the
 * cache, and this server is the account's one writer, so they run here, under the same stage lock as the others.
 */

import { getSyncState, getThreadNames } from "../core/db.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { runBoardPass } from "../core/board-pass.js";

const DAY_MS = 86_400_000;

/**
 * @param {object} deps
 * @param {() => object} deps.getApi - the daemon's CURRENT session
 * @param {string} deps.accountDir - the account's folder; media goes under its `media/`
 * @param {string} [deps.mediaRoot] - the configured media root, when it is not `<accountDir>/media`
 * @returns {{media: Function, boards: Function}} stage runners, as createSyncJobs takes them
 */
export function createMcpStageRunners({ getApi, accountDir, mediaRoot }) {
    return {
        /**
         * @param {{threadId?: string, kinds?: string[], days?: number, limit?: number}} params
         * @param {(e: object) => void} onEvent
         */
        async media(params = {}, onEvent = () => {}) {
            // The window the last restore covered, unless days says otherwise: media outside it has the oldest
            // links, the likeliest to be dead (as `sync-media` without --all-history).
            let since = params.days ? Date.now() - params.days * DAY_MS : undefined;
            if (since === undefined) {
                const covered = Number(getSyncState("lastSyncOkFrom"));
                if (Number.isFinite(covered) && covered > 0) since = covered;
            }
            return downloadSyncedMedia({
                api: getApi(),
                accountDir,
                threadId: params.threadId,
                kinds: params.kinds,
                since,
                concurrency: 2,
                maxFiles: params.limit,
                timeoutMs: 60_000,
                threadNames: getThreadNames(),
                mediaRoot,
                onProgress: (p) => {
                    if (p.phase === "saved" && (p.done === p.total || p.done % 25 === 0)) {
                        onEvent({ phase: "media", detail: `${p.done}/${p.total} downloaded` });
                    }
                },
            });
        },

        /**
         * @param {{threadId?: string, limit?: number}} params
         * @param {(e: object) => void} onEvent
         */
        async boards(params = {}, onEvent = () => {}) {
            const api = getApi();
            if (!api) throw new Error("this server has no session to read the boards with");
            return runBoardPass(api, {
                thread: params.threadId,
                limit: params.limit,
                onProgress: (p) => {
                    if (p.done === p.total || p.done % 25 === 0) {
                        onEvent({ phase: "boards", detail: `${p.done}/${p.total} threads` });
                    }
                },
            });
        },
    };
}
