/**
 * One board pass over the cached threads: notes, pinned messages, polls and reminders, which live behind per-thread
 * board endpoints rather than in the message stream. What `sync-boards` and `sync`'s boards stage run, and what the
 * MCP server's `boards` sync stage calls too; it reports through `onProgress` instead of printing.
 */

import { clearSyncState, getRecentThreads, getSyncState, getThreadType, setSyncState } from "./db.js";
import { syncBoards } from "./sync-v2/board.js";

/** Where a pass stopped by Zalo's 221 left off; the next full pass starts there. */
export const BOARD_RESUME_KEY = "boardPass:resumeFrom";

/**
 * The threads one pass visits: exactly `thread` when one is named (whatever its age), else every cached thread, most
 * recent first, or the first `limit` of them when the caller asked for a bound.
 *
 * @param {{thread?: string, limit?: number}} opts
 * @returns {Array<{threadId: string, type: string, name?: string}>}
 */
function threadsFor(opts) {
    if (opts.thread) {
        const id = String(opts.thread);
        const type = getThreadType(id);
        if (!type) return [];
        const row = getRecentThreads(-1).find((t) => String(t.threadId) === id);
        return [{ threadId: id, type, name: row?.name }];
    }
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : -1;
    return getRecentThreads(limit).map((t) => ({ threadId: String(t.threadId), type: t.type, name: t.name }));
}

/**
 * Visit every cached thread (or one, or the first `limit`), the ones a live board event flagged first, and store
 * what their boards hold. A thread's "board changed" flag is cleared only once its own fetch worked. When Zalo answers
 * 221 the pass stops, remembers the thread it stopped at, and the next full pass starts from there.
 *
 * @param {object} api - logged-in session
 * @param {{limit?: number, thread?: string, boards?: boolean, reminders?: boolean, concurrency?: number,
 *   onProgress?: (p: object) => void, onNote?: (message: string) => void}} opts
 * @returns {Promise<{status: "ok"|"skipped", reason?: string, stats?: object, resumed?: boolean, note?: string}>}
 */
export async function runBoardPass(api, opts = {}) {
    const onProgress = opts.onProgress ?? (() => {});
    const onNote = opts.onNote ?? (() => {});
    const threads = threadsFor(opts);
    if (!threads.length) {
        return {
            status: "skipped",
            reason: opts.thread ? `thread ${opts.thread} is not in the local cache` : "no threads in the local cache",
        };
    }
    const whole = !opts.thread && !(Number(opts.limit) > 0);
    // A pass a 221 stopped resumes where it stopped; the threads before it come last.
    let resumed = false;
    if (whole) {
        const from = getSyncState(BOARD_RESUME_KEY);
        const at = from ? threads.findIndex((t) => t.threadId === from) : -1;
        if (at > 0) {
            threads.push(...threads.splice(0, at));
            resumed = true;
            onNote(`resuming the board pass a rate limit stopped, at thread ${from}`);
        }
    }
    // A live board event flags its thread; those go first, so a pass right after one refreshes what moved.
    if (!opts.thread) {
        const stale = threads.filter((t) => getSyncState(`boardStale:${t.threadId}`));
        if (stale.length) {
            onNote(`${stale.length} thread(s) had a board change since the last pass — doing those first`);
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
    const out = { status: "ok", stats, ...(resumed && { resumed }) };
    if (stats.stoppedBy === "rate-limit") {
        if (whole && stats.nextThreadId) setSyncState(BOARD_RESUME_KEY, stats.nextThreadId);
        out.note =
            `Zalo answered 221 (too many requests): the pass stopped with ${stats.left} thread(s) left.` +
            (whole ? " Run it again later; it resumes where it stopped." : " Run it again later.");
    } else if (whole) {
        clearSyncState(BOARD_RESUME_KEY);
    }
    return out;
}
