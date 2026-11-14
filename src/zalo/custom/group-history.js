/**
 * Group chat history from Zalo's cloud-message store.
 *
 * The previous engine's getGroupChatHistory asked `{group}/api/group/history`, which Zalo
 * answers with HTTP 404. Zalo serves a group's history from a different
 * service -- the cloud-message ("cm") store:
 *
 *   GET {group_cloud_message}/api/cm/getrecentv2?nretry=0     (cmd 12506)
 *   GET {group_cloud_message}/api/cm/getoldv2?nretry=0        (cmd 12507)
 *       params = AES({groupId, globalMsgId, count, msgIds, imei, src})
 *
 * What is established, and what is not:
 *
 * - The newest page is `getrecentv2` with globalMsgId 2^63 (the largest
 *   message id) and `src: 1`, as sent when a group is opened.
 * - Older pages: the next globalMsgId is the response's `lastMsgId`, the
 *   request goes to `getoldv2` only when the response says `isOld`, and it
 *   carries `src: 3` (load more). No observed response ever carried messages,
 *   `hasMore` or `isOld`, so paging is implemented to that specification and
 *   is NOT yet verified against the live server.
 * - The response's `data` is a JSON string. Bare numbers in `uidFrom`,
 *   `uidTo`, `uid` and `ownerId` are quoted before parsing it, because uids
 *   run past 2^53.
 * - Recall (`chat.undo`) and delete (`chat.delete`) events and rows without
 *   content are dropped, and rows are de-duplicated on cliMsgId + sender.
 *
 * `group_cloud_message` was declared in the previous engine's own LoginInfo type
 * (zpw_service_map_v3, dist/context.d.ts). A session whose map lacks it gets a
 * clear error rather than a request to "undefined".
 *
 * Read-only: this module fetches and writes nothing. `msg history` caches what
 * it returns through storeHistoryMessage (src/core/live-store.js). The listener, sync
 * and msg history's fetch write Zalo-reported rows; history writes
 * insert-if-absent; msg send writes nothing (AGENTS.md §13).
 */
import { boundUtils } from "../kernel/bound.js";
import { GroupMessage } from "../listener/models.js";

/** The largest message id, `(BigInt(2) ** BigInt(63)).toString()`: start from the newest. */
export const NEWEST_MSG_ID = "9223372036854775808";

/**
 * Messages asked for per request: the server-configured page size, 50 in
 * every observed case; nothing else has been seen.
 */
export const CM_PAGE_SIZE = 50;

/** The cloud-load `src`: opening a conversation, and loading more (scrolling up). */
const SRC_OPEN = 1;
const SRC_LOAD_MORE = 3;

/** Pause between pages. Zalo rate-limits hard (see src/core/sync-v2/board.js). */
const PAGE_DELAY_MS = 150;

/**
 * `"uidFrom": 1234…` (or `\"uidFrom\": 1234…` inside an escaped string) with a
 * bare integer. Group 1 is the escaping; the key must close with the same.
 */
const UID_SCALAR = /(\\*)"(uidFrom|uidTo|uid|ownerId)\1"(\s*):(\s*)(-?\d+)(?![\d.eE])/g;
/** The same keys holding an array of bare integers. */
const UID_ARRAY = /(\\*)"(uidFrom|uidTo|uid|ownerId)\1"(\s*):(\s*)\[([^[\]{}"]*)\]/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Quote bare integers under `uidFrom`, `uidTo`, `uid` and `ownerId` in a JSON
 * text, so JSON.parse keeps every digit of a uid past 2^53. It runs over every
 * cloud-message response, including those keys inside escaped JSON held in a
 * string value.
 *
 * @param {string} json
 * @returns {string}
 */
export function quoteUids(json) {
    return json
        .replace(UID_SCALAR, (_m, esc, key, s1, s2, num) => `${esc}"${key}${esc}"${s1}:${s2}${esc}"${num}${esc}"`)
        .replace(
            UID_ARRAY,
            (_m, esc, key, s1, s2, items) =>
                `${esc}"${key}${esc}"${s1}:${s2}[${items.replace(/-?\d+/g, (n) => `${esc}"${n}${esc}"`)}]`,
        );
}

/** A msgId as a BigInt, or null when it is not a plain decimal id. */
function msgIdOf(v) {
    const s = String(v ?? "");
    return /^\d+$/.test(s) ? BigInt(s) : null;
}

/** Newest first: by msgId, which is what the server pages on, then by timestamp. */
function newestFirst(a, b) {
    const x = msgIdOf(a.data.msgId);
    const y = msgIdOf(b.data.msgId);
    if (x !== null && y !== null && x !== y) return x > y ? -1 : 1;
    return Number(b.data.ts || 0) - Number(a.data.ts || 0);
}

/** A real message, not a recall or delete event, with content. */
function isMessage(data) {
    return (
        Boolean(data) &&
        typeof data === "object" &&
        data.msgType !== "chat.undo" &&
        data.msgType !== "chat.delete" &&
        Boolean(data.content)
    );
}

/** getrecentv2's `data`, parsed. It arrives as a JSON string. */
function parsePage(raw) {
    if (raw === null || raw === undefined || raw === "") return {};
    const page = typeof raw === "string" ? JSON.parse(quoteUids(raw)) : raw;
    return page && typeof page === "object" ? page : {};
}

/** One request to the cloud-message store. */
async function fetchPage(api, host, { groupId, globalMsgId, src, old }) {
    const url = `${host}/api/cm/${old ? "getoldv2" : "getrecentv2"}`;
    const utils = boundUtils(api);
    // Key order as the server expects it.
    const params = { groupId, globalMsgId, count: CM_PAGE_SIZE, msgIds: [], imei: api.getContext().imei, src };
    const enc = utils.encodeAES(JSON.stringify(params));
    const resp = await utils.request(utils.makeURL(url, { nretry: 0, params: enc }), { method: "GET" });
    return parsePage(await utils.resolve(resp));
}

/**
 * Fetch a group's newest messages from Zalo's cloud-message store.
 *
 * A drop-in for the previous engine's `getGroupChatHistory(groupId, count)`, whose endpoint
 * is retired: it resolves to `{groupMsgs, more}` with each message a listener
 * `GroupMessage` (`.data`, `.isSelf`, `.threadId`), so a caller that read the
 * old call's `groupMsgs` and `more` reads this unchanged.
 *
 * @param {object} api - a logged-in session
 * @param {string} groupId - numeric group id; a leading "g" is stripped
 * @param {number} [count=50] - how many of the newest messages to return, a whole number >= 1, or `Infinity` for
 *   everything the store serves: pages of 50, one after another, until it says `hasMore: 0`, as Zalo pages a group
 * @param {object} [opts]
 * @param {number} [opts.delayMs=150] - pause between pages
 * @param {number} [opts.untilTs] - stop after the first page that reaches back to this time (ms): a caller that
 *   only needs what came after it
 * @returns {Promise<{groupMsgs: Array<object>, more: 0|1, pages: number, filtered: boolean, stalled: boolean}>}
 *   `groupMsgs` newest first; `more` is 1 when older messages can be fetched beyond those
 *   returned; `pages` is the number of requests made; `filtered` is true when Zalo withheld
 *   older messages (the page said `isFiltered`) — they exist but this store will not serve
 *   them, so `more` is 0; `stalled` is true when the store said more follows but its cursor
 *   did not move older (the walk stopped there instead of asking for the same page again)
 * @throws {Error} when `count` is not a whole number >= 1 (or Infinity), the session has no
 *   group_cloud_message host, a request fails, or the store reports an error and returns nothing
 */
export async function getGroupHistory(
    api,
    groupId,
    count = CM_PAGE_SIZE,
    { delayMs = PAGE_DELAY_MS, untilTs = null } = {},
) {
    if (count !== Infinity && (!Number.isInteger(count) || count < 1)) {
        throw new Error(`count must be a whole number of at least 1, got ${count}`);
    }
    const host = api?.zpwServiceMap?.group_cloud_message?.[0];
    if (!host) {
        throw new Error(
            'Zalo did not include the "group_cloud_message" service in this session\'s service map ' +
                "(zpw_service_map_v3), so group history is unavailable for this login.",
        );
    }

    const gid = String(groupId).replace(/^g/, "");
    const ownId = String(api.getContext().uid ?? "");
    // Enough for `count`, plus slack for pages thinned out by dropped events; no cap when everything is asked for.
    const maxPages = count === Infinity ? Infinity : Math.ceil(count / CM_PAGE_SIZE) + 2;
    let stalled = false;

    const kept = [];
    const seen = new Set();
    let cursor = NEWEST_MSG_ID;
    let old = false;
    let src = SRC_OPEN;
    let hasMore = false;
    let filtered = false;
    let pages = 0;

    while (pages < maxPages) {
        if (pages > 0 && delayMs) await sleep(delayMs);
        const page = await fetchPage(api, host, { groupId: gid, globalMsgId: cursor, src, old });
        pages++;

        const rows = Array.isArray(page.groupMsgs) ? page.groupMsgs : [];
        if (page.error && !rows.length) {
            if (!kept.length) throw new Error(`Zalo's group message store answered error ${page.error}`);
            hasMore = true; // an older page failed; do not claim the history ends here
            break;
        }

        for (const data of rows) {
            if (!isMessage(data)) continue;
            // Keyed before GroupMessage rewrites a self uidFrom of "0".
            const byId = `m:${data.msgId}`;
            const byClient = `c:${data.cliMsgId}_${data.uidFrom}`;
            if (seen.has(byId) || seen.has(byClient)) continue;
            seen.add(byId);
            seen.add(byClient);

            const msg = new GroupMessage(ownId, data);
            // Zalo marks our own messages with uidFrom "0"; the store may use the uid itself.
            if (!msg.isSelf && ownId && String(msg.data.uidFrom) === ownId) msg.isSelf = true;
            kept.push(msg);
        }

        hasMore = Number(page.hasMore) > 0;
        // Zalo withholds what it filters, and the filter is a point in time
        // (measured live 2026-09-30: only messages since this device's login
        // came back; everything older read `isFiltered: 1`, 0 rows, `hasMore:
        // 1`, page after page). Every older page is past the same point, so
        // walking on only fetched empty pages and then claimed "more".
        if (Number(page.isFiltered) > 0) {
            filtered = true;
            hasMore = false;
            break;
        }
        if (kept.length >= count || !hasMore) break;
        if (untilTs !== null && rows.some((d) => Number(d?.ts) <= untilTs)) break;

        // The next page starts at the lastMsgId the server
        // returned. A cursor that does not move older would ask for the same
        // page forever, so it ends the walk.
        const next = msgIdOf(page.lastMsgId);
        if (next === null || next === 0n || next >= BigInt(cursor)) {
            stalled = true;
            break;
        }
        cursor = next.toString();
        old = Number(page.isOld) > 0;
        src = SRC_LOAD_MORE;
    }

    kept.sort(newestFirst);
    return {
        groupMsgs: count === Infinity ? kept : kept.slice(0, count),
        more: kept.length > count || hasMore ? 1 : 0,
        pages,
        filtered,
        stalled,
    };
}
