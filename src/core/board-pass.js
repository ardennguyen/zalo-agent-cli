/**
 * One board pass over the cached threads: notes, pinned messages, polls and reminders, which live behind per-thread
 * board endpoints rather than in the message stream. What `sync-boards` runs, as a function the MCP server's `boards`
 * sync stage calls too; it reports through `onProgress` instead of printing.
 */

import { clearSyncState, getRecentThreads, getSyncState } from "./db.js";
import { syncBoards } from "./sync-v2/board.js";

/**
 * Visit the most recent cached threads (or one), the ones a live board event flagged first, and store what their
 * boards hold. A thread's "board changed" flag is cleared only once its own fetch worked.
 *
 * @param {object} api - logged-in session
 * @param {{limit?: number, thread?: string, boards?: boolean, reminders?: boolean, concurrency?: number,
 *   onProgress?: (p: object) => void}} opts
 * @returns {Promise<{status: "ok"|"skipped", reason?: string, stats?: object}>}
 */
export async function runBoardPass(api, opts = {}) {
    const onProgress = opts.onProgress ?? (() => {});
    const all = getRecentThreads(opts.limit ?? 200);
    const threads = (opts.thread ? all.filter((t) => String(t.threadId) === String(opts.thread)) : all).map((t) => ({
        threadId: String(t.threadId),
        type: t.type,
        name: t.name,
    }));
    if (!threads.length) {
        return {
            status: "skipped",
            reason: opts.thread ? `thread ${opts.thread} is not in the local cache` : "no threads in the local cache",
        };
    }
    // A live board event flags its thread; those go first, so a pass right after one refreshes what moved.
    if (!opts.thread) {
        const stale = threads.filter((t) => getSyncState(`boardStale:${t.threadId}`));
        if (stale.length) {
            const rest = threads.filter((t) => !getSyncState(`boardStale:${t.threadId}`));
            threads.splice(0, threads.length, ...stale, ...rest);
        }
    }
    const stats = await syncBoards({
        api,
        threads,
        boards: opts.boards !== false,
        reminders: opts.reminders !== false,
        concurrency: opts.concurrency,
        onProgress: (p) => {
            if (p.phase === "thread" && p.ok) clearSyncState(`boardStale:${p.threadId}`);
            onProgress(p);
        },
    });
    return { status: "ok", stats };
}
