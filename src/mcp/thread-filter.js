/**
 * Filter which threads to watch and which messages to keep.
 * Supports glob-like patterns for thread matching and noise reduction.
 */

/** System message types to drop (join, leave, pin, etc.) */
const SYSTEM_MSG_TYPES = new Set(["system", "join", "leave", "pin", "unpin", "rename"]);

export class ThreadFilter {
    /**
     * @param {object} config - MCP config object
     * @param {string[]} config.watchThreads - Glob patterns like ["dm:*", "group:support"]
     * @param {string[]} [config.triggerKeywords] - Keywords that trigger attention
     */
    constructor(config) {
        this._watchPatterns = config.watchThreads || ["dm:*", "group:*"];
        this._triggerKeywords = (config.triggerKeywords || []).map((k) => k.toLowerCase());
    }

    /**
     * Check if a thread should be watched based on patterns.
     * Pattern format: "dm:*", "group:*", "group:exact_id", "dm:exact_id"
     * @param {string} threadId
     * @param {"group"|"dm"} threadType
     * @returns {boolean}
     */
    shouldWatch(threadId, threadType) {
        const key = `${threadType}:${threadId}`;
        for (const pattern of this._watchPatterns) {
            if (this._matchPattern(pattern, key, threadType)) return true;
        }
        return false;
    }

    /**
     * Check if a message passes noise filter (drop stickers, short emoji, system msgs).
     * @param {object} message - Normalized message
     * @returns {boolean}
     */
    shouldKeep(message) {
        // Drop system messages
        if (message.type && SYSTEM_MSG_TYPES.has(message.type)) return false;
        // Drop sticker-only messages
        if (message.type === "sticker") return false;
        // Drop very short emoji-only messages (< 3 chars, all emoji/whitespace)
        if (message.text && message.text.length < 3 && /^[\s\p{Emoji}]*$/u.test(message.text)) {
            return false;
        }
        // Keep everything else (including images, files, links)
        return true;
    }

    /**
     * Check if a message is a trigger (contains keyword or @mention).
     * @param {object} message - Normalized message
     * @returns {boolean}
     */
    isTrigger(message) {
        if (!message.text || this._triggerKeywords.length === 0) return false;
        const lower = message.text.toLowerCase();
        return this._triggerKeywords.some((kw) => lower.includes(kw));
    }

    /**
     * Match a pattern against a thread key.
     * @param {string} pattern - e.g. "dm:*", "group:support_123"
     * @param {string} key - e.g. "dm:user_456", "group:support_123"
     * @param {string} threadType - "dm" or "group"
     * @returns {boolean}
     */
    _matchPattern(pattern, key, threadType) {
        // Wildcard: "dm:*" matches all DMs, "group:*" matches all groups
        if (pattern === `${threadType}:*`) return true;
        // Catch-all patterns
        if (pattern === "*" || pattern === "*:*") return true;
        // Exact match
        return pattern === key;
    }
}
