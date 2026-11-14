/**
 * Auto-reply rules, as `auto-reply` (src/commands/auto-reply.js) and the MCP tool `zalo_auto_reply` send them.
 */

/** One year in milliseconds — the default window for an open-ended rule. */
const DEFAULT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Resolve the {startTime, endTime} window for an auto-reply rule.
 *
 * These used to default to 0/0, which Zalo rejects outright with
 * "Tham số không hợp lệ" — so `auto-reply create` could never succeed on
 * its defaults. Zalo treats the pair as a real active window, so an unset
 * start means "from now" and an unset end means "no foreseeable end",
 * expressed as a far-future timestamp rather than 0.
 *
 * @param {{start?: number, end?: number}} opts
 * @returns {{startTime: number, endTime: number}}
 */
export function activeWindow(opts) {
    const startTime = Number.isFinite(opts.start) && opts.start > 0 ? opts.start : Date.now();
    const endTime = Number.isFinite(opts.end) && opts.end > 0 ? opts.end : startTime + DEFAULT_WINDOW_MS;
    return { startTime, endTime };
}

/** Who a rule answers, by name: Zalo's `scope` codes. */
export const AUTO_REPLY_SCOPES = Object.freeze({ all: 0, friends: 1, strangers: 2 });
