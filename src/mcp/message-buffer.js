/**
 * Ring buffer storing messages per thread with cursor-based incremental reads.
 * Shared by both stdio and HTTP MCP transports.
 *
 * Several bots can share one listener, so "read" is per consumer: each named
 * consumer has its own read cursor, and marking messages read moves only that
 * cursor. It used to delete the messages, so one bot's zalo_mark_read emptied
 * every other bot's inbox (triage M7). Messages now leave only by eviction
 * (maxSize per thread, maxAge), which bounds memory as before.
 */

/** The consumer a caller that names none reads as. */
export const DEFAULT_CONSUMER = "default";

/** Consumers remembered at most; the least recently active is forgotten first. */
const MAX_CONSUMERS = 256;

export class MessageBuffer {
    /**
     * @param {number} maxSize - Max messages per thread before eviction
     * @param {number} maxAge - Max message age in ms before eviction (default 2h)
     */
    constructor(maxSize = 500, maxAge = 2 * 60 * 60 * 1000) {
        /** @type {Map<string, { messages: Array, lastActivity: number }>} */
        this._threads = new Map();
        this._maxSize = maxSize;
        this._maxAge = maxAge;
        this._globalCursor = 0;
        /** @type {Map<string, { cursor: number, at: number }>} */
        this._readCursors = new Map();
    }

    /**
     * The read cursor of one consumer: messages after it are unread for them.
     * @param {string} [consumer="default"]
     * @returns {number}
     */
    readCursor(consumer = DEFAULT_CONSUMER) {
        return this._readCursors.get(consumer)?.cursor ?? 0;
    }

    /**
     * Add message to thread buffer. Auto-evicts stale messages.
     * @param {string} threadId
     * @param {object} message - Normalized message object
     */
    push(threadId, message) {
        if (!this._threads.has(threadId)) {
            this._threads.set(threadId, { messages: [], lastActivity: Date.now() });
        }
        const thread = this._threads.get(threadId);
        // Assign global cursor for incremental reads
        message._cursor = ++this._globalCursor;
        thread.messages.push(message);
        thread.lastActivity = Date.now();
        this._evict(threadId);
    }

    /**
     * Read messages from a thread, optionally since a cursor.
     * @param {string} [threadId] - If omitted, reads from all threads
     * @param {number} [since=0] - Cursor to read from (exclusive)
     * @param {number} [maxCount=20] - Max messages to return
     * @returns {{ messages: Array, cursor: number, hasMore: boolean }}
     */
    read(threadId, since = 0, maxCount = 20) {
        const sources = threadId ? [this._threads.get(threadId)].filter(Boolean) : Array.from(this._threads.values());

        // Collect all messages after cursor, sorted by cursor
        const all = [];
        for (const thread of sources) {
            for (const msg of thread.messages) {
                if (msg._cursor > since) all.push(msg);
            }
        }
        all.sort((a, b) => a._cursor - b._cursor);

        const hasMore = all.length > maxCount;
        const messages = all.slice(0, maxCount);
        const cursor = messages.length > 0 ? messages[messages.length - 1]._cursor : since;

        return { messages, cursor, hasMore };
    }

    /**
     * Advance one consumer's read cursor to `cursor`. Nothing is deleted, and no
     * other consumer's cursor moves; a cursor never moves backwards.
     * @param {number} cursor
     * @param {string} [consumer="default"]
     * @returns {number} how many buffered messages this newly marked read for that consumer
     */
    markRead(cursor, consumer = DEFAULT_CONSUMER) {
        const from = this.readCursor(consumer);
        const to = Math.max(from, Number(cursor) || 0);
        let marked = 0;
        for (const [, thread] of this._threads) {
            for (const m of thread.messages) if (m._cursor > from && m._cursor <= to) marked++;
        }
        this._readCursors.delete(consumer); // re-insert: Map order is recency
        this._readCursors.set(consumer, { cursor: to, at: Date.now() });
        while (this._readCursors.size > MAX_CONSUMERS) {
            this._readCursors.delete(this._readCursors.keys().next().value);
        }
        return marked;
    }

    /**
     * Get stats for all threads with buffered messages.
     * @param {number} [readCursor=0] - Messages after this cursor are "unread"
     * @returns {Array<{ threadId: string, unread: number, total: number, lastActivity: number }>}
     */
    getStats(readCursor = 0) {
        const stats = [];
        for (const [threadId, thread] of this._threads) {
            if (thread.messages.length === 0) continue;
            const unread = thread.messages.filter((m) => m._cursor > readCursor).length;
            stats.push({
                threadId,
                unread,
                total: thread.messages.length,
                lastActivity: thread.lastActivity,
            });
        }
        return stats;
    }

    /**
     * Get thread type from first buffered message.
     * @param {string} threadId
     * @returns {string|null}
     */
    getThreadType(threadId) {
        const thread = this._threads.get(threadId);
        return thread?.messages?.[0]?.threadType ?? null;
    }

    /**
     * Evict messages that exceed maxSize or maxAge for a given thread.
     * @param {string} threadId
     */
    _evict(threadId) {
        const thread = this._threads.get(threadId);
        if (!thread) return;

        const now = Date.now();
        // Remove messages older than maxAge
        thread.messages = thread.messages.filter((m) => now - m.timestamp < this._maxAge);
        // Trim to maxSize (keep newest)
        if (thread.messages.length > this._maxSize) {
            thread.messages = thread.messages.slice(thread.messages.length - this._maxSize);
        }
        // Clean up empty threads
        if (thread.messages.length === 0) {
            this._threads.delete(threadId);
        }
    }
}
