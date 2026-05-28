/**
 * Sends notification to a configured Zalo group when DMs arrive
 * and no MCP agent is connected. Batches messages within a cooldown window.
 */

import { parseDuration } from "./mcp-config.js";

/** Emoji prefix per message type for notification previews */
const TYPE_EMOJI = {
    text: "💬",
    image: "📷",
    file: "📎",
    link: "🔗",
    video: "🎬",
    audio: "🎵",
    voice: "🎤",
    gif: "🎞️",
};

/** Vietnamese label per message type for notification breakdown */
const TYPE_LABEL = {
    text: "text",
    image: "ảnh",
    file: "file",
    link: "link",
    video: "video",
    audio: "audio",
    voice: "voice",
    gif: "gif",
};

export class ZaloNotifier {
    /**
     * @param {object} api - zca-js API instance
     * @param {object} config - Full MCP config (uses config.notify section)
     * @param {boolean} config.notify.enabled
     * @param {string|null} config.notify.thread - Group ID to send notifications to
     * @param {string[]} config.notify.on - Event types to notify on (e.g. ["dm"])
     * @param {string} config.notify.cooldown - Debounce window (e.g. "5m")
     */
    constructor(api, config) {
        this._api = api;
        this._enabled = config.notify?.enabled || false;
        this._notifyThread = config.notify?.thread || null;
        this._onTypes = new Set(config.notify?.on || ["dm"]);
        this._cooldownMs = parseDuration(config.notify?.cooldown || "5m");
        this._pending = []; // Messages queued during cooldown window
        this._timer = null;
        this._agentConnected = false;
    }

    /** Mark agent as connected/disconnected — suppresses notifications when connected */
    setAgentConnected(connected) {
        this._agentConnected = connected;
    }

    /**
     * Called when a new message arrives. Queues notification if conditions are met.
     * @param {object} message - Normalized message object
     */
    onMessage(message) {
        if (!this._shouldNotify(message)) return;
        this._pending.push(message);
        // Start cooldown timer only once per batch window
        if (!this._timer) {
            this._timer = setTimeout(() => this._flush(), this._cooldownMs);
        }
    }

    /**
     * Determine whether this message warrants a notification.
     * @param {object} message
     * @returns {boolean}
     */
    _shouldNotify(message) {
        if (!this._enabled || !this._notifyThread) return false;
        if (this._agentConnected) return false;
        return this._onTypes.has(message.threadType);
    }

    /** Flush pending notifications as a single batched message to the notify thread */
    async _flush() {
        this._timer = null;
        if (this._pending.length === 0) return;

        const count = this._pending.length;
        const typeBreakdown = this._buildTypeBreakdown(this._pending);
        const preview = this._pending
            .slice(0, 3) // Show at most 3 message previews
            .map((m) => {
                const type = m.type || "text";
                const prefix = TYPE_EMOJI[type] || "💬";
                const sender = m.senderName || m.senderId;
                const body = type === "text" ? (m.text || "").slice(0, 50) : `[${TYPE_LABEL[type] || type}]`;
                return `- ${sender}: ${prefix} ${body}`;
            })
            .join("\n");

        const suffix = count > 3 ? `\n...và ${count - 3} tin nhắn khác` : "";
        const text = `🔔 ${count} tin nhắn mới [${typeBreakdown}] trong ${this._formatWindow()}:\n${preview}${suffix}`;

        try {
            // threadType 1 = Group conversation
            await this._api.sendMessage(text, this._notifyThread, 1);
        } catch (err) {
            console.error("Notifier send failed:", err.message);
        }

        this._pending = [];
    }

    /**
     * Build a human-readable type breakdown string, e.g. "2 text, 1 ảnh".
     * @param {object[]} messages - Array of normalized messages
     * @returns {string}
     */
    _buildTypeBreakdown(messages) {
        const counts = {};
        for (const m of messages) {
            const t = m.type || "text";
            counts[t] = (counts[t] || 0) + 1;
        }
        return Object.entries(counts)
            .map(([type, n]) => `${n} ${TYPE_LABEL[type] || type}`)
            .join(", ");
    }

    /** Format cooldown duration as human-readable string (e.g. "5 phút", "1h") */
    _formatWindow() {
        const mins = Math.round(this._cooldownMs / 60000);
        return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins} phút`;
    }

    /** Clean up pending timer on shutdown and attempt final flush */
    destroy() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._flush();
        }
    }
}
