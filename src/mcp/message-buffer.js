/**
 * Ring buffer storing messages per thread with cursor-based incremental reads.
 * Shared by both stdio and HTTP MCP transports.
 */

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
     * Advance read cursor — discard messages at or before given cursor.
     * @param {number} cursor
     * @returns {number} Count of discarded messages
     */
    markRead(cursor) {
        let discarded = 0;
        for (const [, thread] of this._threads) {
            const before = thread.messages.length;
            thread.messages = thread.messages.filter((m) => m._cursor > cursor);
            discarded += before - thread.messages.length;
        }
        return discarded;
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
