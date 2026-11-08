/**
 * Queue overflow: what Zalo dropped from an offline queue, the no-tap repair for groups, and the notice.
 *
 * Zalo signals overflow with `queueStatus["<q>"].evict == 1` (or a `resetLastActionId`). Zalo Web and PC answer it
 * the same way (agent research: offline-queue retention §2): they record a missing range from the last time online to
 * now and show "Sync recent messages", which the phone-backed restore fills. Groups have a second, no-tap path: their
 * messages are kept in the group cloud-message store, which Zalo reads back for the affected groups (AFMC). 1-1
 * messages have no such path.
 *
 * This module does the group half here: for the groups the account is in (most recently active first, at most
 * `maxGroups` of them), it reads each group's newest messages from the cloud store until it reaches the start of the
 * loss, and stores what the cache lacks, insert-if-absent (the same writer `msg history` uses). A group whose newest
 * message is older than the loss had no activity in it and costs one request. The 1-1 half stays a pending gap that
 * `zalo-agent sync --from <date>` closes with a tap on the phone.
 *
 * A drain that returns 0 rows with no `evict` is NOT an overflow: it is a quiet queue (or a cursor from before this
 * device's login, which ./device-since.js handles).
 */
import { getRecentThreads } from "./db.js";
import { storeHistoryMessage } from "./live-store.js";
import { syncFromDate } from "./sync-v2/gap-advice.js";

/** At most this many groups are read per overflow (Zalo's own AFMC batch is 50). */
export const OVERFLOW_MAX_GROUPS = 50;

/** At most this many of a group's newest messages are read per overflow. */
export const OVERFLOW_MAX_PER_GROUP = 200;

/** The first, cheap read per group: one cloud-store page. */
const FIRST_COUNT = 50;

/** Pause between groups. Zalo rate-limits hard (src/core/sync-v2/board.js). */
const GROUP_DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The groups the account is in, from the server's group list (`getAllGroups`'s `gridVerMap`). */
async function listMemberGroups(api) {
    const res = await api.getAllGroups();
    const map = res?.gridVerMap ?? res?.data?.gridVerMap ?? null;
    if (!map || typeof map !== "object") throw new Error("the group list carried no gridVerMap");
    return Object.keys(map).map(String);
}

/** A group's newest messages from the cloud store (src/zalo/custom/group-history.js), loaded on demand. */
async function fetchGroupHistory(api, groupId, count) {
    const { getGroupHistory } = await import("../zalo/custom/group-history.js");
    return getGroupHistory(api, groupId, count);
}

const tsOf = (m) => Number(m?.data?.ts);

/**
 * Read the groups' cloud store back to `fromTs` and store what the cache lacks.
 *
 * @param {object} p
 * @param {object} p.api - a logged-in session
 * @param {number} p.fromTs - the start of the loss (ms)
 * @param {(api: object) => Promise<string[]>} [p.listGroups] - the groups the account is in
 * @param {(api: object, groupId: string, count: number) => Promise<{groupMsgs: object[], more: 0|1,
 *   filtered?: boolean}>} [p.fetchGroup] - one group's newest messages, newest first
 * @param {(limit: number) => string[]} [p.recentGroups] - group ids by local recency, most recent first
 * @param {(msg: object) => {stored: boolean, info?: object}} [p.store]
 * @param {number} [p.maxGroups]
 * @param {number} [p.maxPerGroup]
 * @param {number} [p.delayMs]
 * @returns {Promise<{checked: number, active: number, members: number|null, added: Array<{msg: object,
 *   info: object}>, complete: boolean, incomplete: string[]}>} `complete` true only when every group the account is
 *   in was read back to `fromTs` (or had nothing after it); `incomplete` names why not, without ids
 */
export async function repairGroupsFromCloud({
    api,
    fromTs,
    listGroups = listMemberGroups,
    fetchGroup = fetchGroupHistory,
    recentGroups = (limit) => getRecentThreads(limit, "group").map((t) => String(t.threadId)),
    store = (msg) => storeHistoryMessage(msg, { src: "group-cloud" }),
    maxGroups = OVERFLOW_MAX_GROUPS,
    maxPerGroup = OVERFLOW_MAX_PER_GROUP,
    delayMs = GROUP_DELAY_MS,
}) {
    const out = { checked: 0, active: 0, members: null, added: [], complete: true, incomplete: [] };
    const note = (why) => {
        out.complete = false;
        if (!out.incomplete.includes(why)) out.incomplete.push(why);
    };

    let members = null;
    try {
        members = await listGroups(api);
        out.members = members.length;
    } catch {
        note("the group list could not be read");
    }
    let local = [];
    try {
        local = recentGroups(maxGroups * 4);
    } catch {
        /* an unreadable cache only changes the order */
    }
    // Most recently active first; only groups the account is in when the list is known.
    const memberSet = members ? new Set(members) : null;
    const order = [...new Set([...local.filter((g) => !memberSet || memberSet.has(g)), ...(members ?? [])])];
    if (order.length > maxGroups) note(`more than ${maxGroups} groups; the least recently active were not read`);
    const groups = order.slice(0, maxGroups);

    for (const [i, groupId] of groups.entries()) {
        if (i > 0 && delayMs) await sleep(delayMs);
        out.checked++;
        try {
            let page = await fetchGroup(api, groupId, Math.min(FIRST_COUNT, maxPerGroup));
            let rows = Array.isArray(page?.groupMsgs) ? page.groupMsgs : [];
            const reached = (list) => list.some((m) => tsOf(m) <= fromTs);
            if (!rows.some((m) => tsOf(m) > fromTs)) continue; // nothing new in the window
            out.active++;
            if (!reached(rows) && page?.more && maxPerGroup > FIRST_COUNT) {
                page = await fetchGroup(api, groupId, maxPerGroup);
                rows = Array.isArray(page?.groupMsgs) ? page.groupMsgs : rows;
            }
            for (const msg of rows) {
                if (!(tsOf(msg) > fromTs)) continue;
                const r = store(msg);
                if (r?.stored) out.added.push({ msg, info: r.info });
            }
            if (!reached(rows) && (page?.more || page?.filtered)) {
                note(
                    page?.filtered
                        ? "a group's cloud store withholds messages from before this device's login"
                        : `a group had more than ${maxPerGroup} messages in the window`,
                );
            }
        } catch {
            note("a group's cloud store could not be read");
        }
    }
    // Oldest first, as a bot would have seen them live.
    out.added.sort((a, b) => tsOf(a.msg) - tsOf(b.msg));
    return out;
}

/**
 * The `queue_overflow` event: ids and counts only, never a name or a message.
 *
 * @param {object} p
 * @param {string|null} p.accountId
 * @param {number} p.fromTs - last known online
 * @param {number} p.toTs
 * @param {string[]} p.queues - the queues Zalo said it dropped from, e.g. ["510_1"]
 * @param {boolean} p.direct - whether 1-1 messages may be missing (a 1-1 queue overflowed)
 * @param {{checked: number, active: number, added: number, complete: boolean}|null} p.groups - the group repair, or
 *   null when no group queue overflowed
 * @param {boolean} p.pending - whether a gap stays pending
 * @param {number} [p.at]
 * @returns {object}
 */
export function queueOverflowEvent({ accountId, fromTs, toTs, queues, direct, groups, pending, at = Date.now() }) {
    return {
        event: "queue_overflow",
        accountId: accountId ?? null,
        fromTs,
        toTs,
        queues: [...queues],
        direct: Boolean(direct),
        groups: groups
            ? { checked: groups.checked, active: groups.active, added: groups.added, complete: groups.complete }
            : null,
        pending: Boolean(pending),
        command: pending ? `zalo-agent sync --from ${syncFromDate(fromTs)}` : null,
        at,
    };
}

/**
 * One `queue_overflow` event as a line for a person.
 *
 * @param {object} e
 * @returns {string}
 */
export function describeQueueOverflow(e) {
    const since = new Date(e.fromTs).toISOString();
    const parts = [`Zalo's offline queue overflowed (${e.queues.join(", ")}): messages since ${since} were dropped.`];
    if (e.groups) {
        parts.push(
            e.groups.complete
                ? `Groups were repaired from Zalo's group store without a tap (${e.groups.added} message(s) added, ${e.groups.active} active group(s)).`
                : `Groups were partly repaired from Zalo's group store (${e.groups.added} message(s) added, ${e.groups.checked} group(s) read).`,
        );
    }
    if (e.pending) {
        parts.push(
            `${e.direct ? "1-1 messages" : "What is left"} can only come back from the phone: run \`${e.command}\` and tap on the phone.`,
        );
    }
    return parts.join(" ");
}

/**
 * The event as an MCP system event (the buffer's `pushSystem`).
 *
 * @param {object} e
 * @returns {object}
 */
export function queueOverflowSystemEvent(e) {
    return { type: "queue_overflow", ...e, text: describeQueueOverflow(e) };
}
