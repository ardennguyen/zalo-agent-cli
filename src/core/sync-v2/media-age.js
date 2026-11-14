/**
 * How long Zalo's CDN keeps a message's media, by the clock: the one place the windows are written.
 *
 * Zalo decides whether a file can still come from its CDN by the message's age, not by asking: a file is kept 14 days
 * after it was sent, 7 days when it is over 100 MB, and past that the file is not requested at all (it is in zCloud,
 * on another device, or gone). The media downloader follows the same rule, so a run over months of restored history
 * sorts the old rows locally instead of sending tens of thousands of requests that can only answer 404.
 *
 * My Cloud (the chat with oneself) is exempt: its files are fetched through their message link whatever their age.
 * A voice message follows the 14-day window like any other file.
 */

const DAY_MS = 86_400_000;

/** How long the CDN keeps a file after its message was sent. */
export const CDN_KEEP_MS = 14 * DAY_MS;

/** A file over this many bytes is a big file, kept for a shorter time. */
export const BIG_FILE_BYTES = 100 * 1024 * 1024;

/** How long the CDN keeps a big file. */
export const BIG_FILE_KEEP_MS = 7 * DAY_MS;

/**
 * How long the CDN keeps one attachment.
 *
 * @param {{size?: number}} att
 * @returns {number} milliseconds after the message was sent
 */
export function cdnKeepMs(att) {
    return Number(att?.size) > BIG_FILE_BYTES ? BIG_FILE_KEEP_MS : CDN_KEEP_MS;
}

/**
 * Whether an attachment is past the CDN's window, so that Zalo would not ask the CDN for it.
 *
 * @param {{timestamp?: number|string, threadId?: string}} row - the message
 * @param {{size?: number}} att
 * @param {object} [o]
 * @param {number} [o.now=Date.now()]
 * @param {string|null} [o.ownId] - the account: its chat with itself (My Cloud) is never past the window
 * @returns {boolean}
 */
export function pastCdnWindow(row, att, { now = Date.now(), ownId = null } = {}) {
    if (ownId !== null && ownId !== undefined && String(row?.threadId) === String(ownId)) return false;
    const sent = Number(row?.timestamp);
    if (!Number.isFinite(sent) || sent <= 0) return false;
    return now - sent > cdnKeepMs(att);
}
