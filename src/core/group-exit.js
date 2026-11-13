/**
 * A group stops being ours: the account LEFT it, was REMOVED or BLOCKED from it, or it was DISBANDED.
 *
 * Zalo's own apps delete the group's local history at once in all four cases: messages, media, pin and preview,
 * with a delete tombstone so a later restore or fetch cannot bring the old messages back. This module is that, for this
 * cache:
 *
 * - **purge** (default, `groups.onLeave: "purge"`): the messages (their row MACs and search entries go with them through
 *   their triggers; `secure_delete` zeroes the pages), reactions, board items (pins, notes, polls), reminders, the
 *   cloud index and the conversation state, and the downloaded media no other conversation points at. Media and export
 *   links into the group are revoked. Done in bounded chunks, each its own transaction, handing the event loop back
 *   between them (a daemon serves its socket on the same thread).
 * - **keep** (`groups.onLeave: "keep"`): nothing is deleted. The group stays readable and is shown flagged as gone
 *   (`gone: true`, `leftAt`, `goneReason`); sends to it are refused.
 *
 * Either way the thread row keeps `leftAt`, `goneReason` and the delete marker (`deleteMarkerAt`): no writer -- the
 * listener, a phone restore, a history or cloud fetch -- stores a message of the group from at or before it again
 * (src/core/db.js). While the group is gone, its later group events are ignored until a `join` naming us, which
 * clears `leftAt`; a chat message dated after `leftAt` is also proof we are back.
 *
 * The setting is a live runtime policy key (src/core/policy-schema.js), read at the moment of each exit. Lowest first:
 * the default (`purge`), `storage.json` `groups.onLeave` and `accounts.<ownId>.groups.onLeave`, the environment
 * `ZALO_GROUPS_ON_LEAVE[_<ownId>]`, then the policy (tenant < user < account). Switching keep -> purge purges the
 * groups kept so far on the next quota/retention pass (and `fleet purge` for a stopped account); switching
 * purge -> keep changes future exits only: purged history never comes back.
 */
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
    GONE_REASONS,
    clearGroupGone,
    getGroupGone,
    listGoneGroups,
    markGroupGone,
    purgeThreadMessagesChunk,
    purgeThreadSideRows,
    raiseDeleteMarker,
    referencedMediaPaths,
} from "./db.js";
import { readStorageFile } from "./keystore/config.js";
import { getMediaLinks } from "./media-deliver.js";
import { policyFor } from "./policy-layer.js";

/** What happens to a gone group's local history. */
export const ON_LEAVE_MODES = Object.freeze(["purge", "keep"]);
export { GONE_REASONS };
/** The environment variable (and `<name>_<ownId>` for one account). */
export const ON_LEAVE_ENV = "ZALO_GROUPS_ON_LEAVE";
/** Zalo's group-info answer for a group that no longer exists (GROUP_NO_EXIST). */
export const GROUP_GONE_CODE = 161;
/** Zalo's group-info answers for an account that is not a member (as src/core/group-admin.js NOT_A_MEMBER_CODES). */
const NOT_A_MEMBER = [166, 167];

const warned = new Set();

/**
 * The effective `groups.onLeave` of one account, and where it came from.
 *
 * @param {string} ownId
 * @param {{env?: NodeJS.ProcessEnv, policy?: object|null, file?: object}} [opts] - `policy`/`file`: pin the layers
 *   (tests); null for none
 * @returns {{mode: "purge"|"keep", source: string}}
 */
export function resolveGroupOnLeave(ownId, { env = process.env, policy, file } = {}) {
    const id = ownId === undefined || ownId === null ? "" : String(ownId);
    const live = policy === undefined ? policyFor(id) : policy;
    let storage = file;
    if (storage === undefined) {
        try {
            storage = readStorageFile();
        } catch {
            storage = {};
        }
    }
    const layers = [
        [live?.groups?.onLeave, "policy:groups.onLeave"],
        ...(id ? [[env?.[`${ON_LEAVE_ENV}_${id}`], `${ON_LEAVE_ENV}_${id}`]] : []),
        [env?.[ON_LEAVE_ENV], ON_LEAVE_ENV],
        ...(id ? [[storage?.accounts?.[id]?.groups?.onLeave, `storage.json accounts.${id}.groups.onLeave`]] : []),
        [storage?.groups?.onLeave, "storage.json groups.onLeave"],
    ];
    for (const [value, source] of layers) {
        const mode = String(value ?? "")
            .trim()
            .toLowerCase();
        if (!mode) continue;
        if (ON_LEAVE_MODES.includes(mode)) return { mode, source };
        const key = `${source}=${value}`;
        if (!warned.has(key)) {
            warned.add(key);
            console.error(`[groups] ${source} "${value}" is not purge or keep; ignoring it`);
        }
    }
    return { mode: "purge", source: "default" };
}

/**
 * What a change of `groups.onLeave` means, for `policy set` and the admin API to say.
 *
 * @param {unknown} value - the new value (undefined: removed)
 * @returns {string}
 */
export function onLeaveChangeNote(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase() === "keep"
        ? "groups.onLeave keep: applies to groups left from now on; history already purged does not come back."
        : "groups.onLeave purge: groups kept as gone so far are purged on the next quota/retention pass " +
              "(or `fleet purge` for a stopped account).";
}

/**
 * A group event's `data.extraData` as an object (Zalo sends an object or the JSON text of one). Unreadable, absent or
 * not an object is null.
 *
 * @param {object|null|undefined} data - the group event's `data`
 * @returns {object|null}
 */
function extraDataOf(data) {
    let extra = data?.extraData;
    if (typeof extra === "string") {
        try {
            extra = JSON.parse(extra);
        } catch {
            return null;
        }
    }
    return extra && typeof extra === "object" && !Array.isArray(extra) ? extra : null;
}

/**
 * The `leaveType` a `leave` control may carry in `data.extraData` (an object, or the JSON text of one): "leave",
 * "kick" or "disband". No live exit has carried one. Kept for a server that sends it: when
 * present it wins in {@link exitReasonOf}. Unreadable is null.
 *
 * @param {object|null|undefined} data - the group event's `data`
 * @returns {string|null}
 */
export function leaveTypeOf(data) {
    const t = extraDataOf(data)?.leaveType;
    return typeof t === "string" && t ? t.toLowerCase() : null;
}

/**
 * The exit reason of a group event that is our own departure.
 *
 * Zalo sends all three ways out of a group as act `leave` naming us in `updateMembers`, with no `leaveType` to tell
 * them apart. Which keys `extraData` carries does, seen live and recovered from the
 * offline queue after a park (2026-11-12/13):
 *
 * - **disband** by the owner: `prjName`. The owner is `sourceId` live, but a replayed one names us, so who did it is
 *   not the signal. Our own disband (`group disperse`, or from the phone) is a disband too: the group is gone for
 *   everyone, which a leave is not.
 * - **our own leave**: `featureId`, `sourceId` us.
 * - **removed** by the owner or an admin: no key, `sourceId` the remover (live and replayed alike).
 *
 * Order: an explicit `leaveType`, then `prjName`, then `featureId`, then who did it: with no marker, a `leave` someone
 * else did is a removal. Without our own id or a `sourceId` it stays `leave`, never guessed. `remove_member` and
 * `block_member` are what their act says.
 *
 * @param {string} type - leave, remove_member, block_member
 * @param {object} [data] - the event's `data` (`sourceId`, `extraData`)
 * @param {string} [ownId] - the account's own uid
 * @returns {"leave"|"removed"|"blocked"|"disbanded"|null}
 */
export function exitReasonOf(type, data, ownId) {
    switch (String(type || "").toLowerCase()) {
        case "leave": {
            const how = leaveTypeOf(data);
            if (how === "disband") return "disbanded";
            if (how === "kick") return "removed";
            if (how === "leave") return "leave";
            const has = (v) => v !== undefined && v !== null && v !== "";
            const extra = extraDataOf(data) ?? {};
            if (has(extra.prjName) && !has(extra.featureId)) return "disbanded";
            if (has(extra.featureId)) return "leave";
            const source = data?.sourceId;
            if (ownId && has(source) && String(source) !== String(ownId)) return "removed";
            return "leave";
        }
        case "remove_member":
            return "removed";
        case "block_member":
            return "blocked";
        default:
            return null;
    }
}

let sink = null;

/** The most events kept while no sink is installed; the oldest go first. */
export const HELD_GROUP_GONE_MAX = 200;
const held = [];

/**
 * Where `group_gone` events go in this process: `listen` and `mcp start` install theirs (stdout/JSONL/webhook; the
 * MCP buffer, webhook and thread-name cache). With none, the caller reports the result itself (a CLI command), and the
 * event is also held: a daemon finds exits before its route is up (`mcp start`'s thread-name cache asks every group's
 * info at start-up), and installing the sink delivers what was held, in order.
 *
 * @param {((event: object) => void)|null} fn
 */
export function setGroupGoneSink(fn) {
    sink = typeof fn === "function" ? fn : null;
    if (!sink) return;
    for (const event of held.splice(0)) deliver(event);
}

/** Hand one event to the sink, or hold it until there is one. */
function deliver(event) {
    if (!sink) {
        held.push(event);
        if (held.length > HELD_GROUP_GONE_MAX) held.shift();
        return;
    }
    try {
        sink(event);
    } catch (e) {
        console.error(`[groups] the group_gone sink failed: ${e?.message ?? e}`);
    }
}

/** Let timers and socket reads run (setImmediate: after the I/O that is waiting). */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** What a purge step yields between two chunks. */
const CHUNK_DONE = "chunk";

/**
 * The purge of one group, as steps: a bounded chunk of messages per step, then the other rows, then the files no
 * other conversation points at. Drained at once ({@link purgeGroupHistorySync}) or sliced ({@link purgeGroupHistory}).
 *
 * @param {string} threadId
 * @param {object} out - the counts, filled in
 * @param {{chunk?: number}} [opts]
 */
function* purgeSteps(threadId, out, { chunk = 500 } = {}) {
    const files = [];
    let newest = 0;
    for (;;) {
        const r = purgeThreadMessagesChunk(threadId, chunk);
        if (!r.rows) break;
        out.messages += r.rows;
        out.reactions += r.reactions;
        files.push(...r.files);
        newest = Math.max(newest, r.newest);
        yield CHUNK_DONE;
    }
    // Nothing deleted may come back, even a row dated after the exit (the phone's own system line for it).
    if (newest) raiseDeleteMarker(threadId, newest);
    const side = purgeThreadSideRows(threadId);
    out.reactions += side.reactions;
    out.boardItems += side.boardItems;
    out.reminders += side.reminders;
    out.cloudItems += side.cloudItems;
    out.convState += side.convState;
    files.push(...side.files);
    yield CHUNK_DONE;
    // A file another conversation still points at stays (a forward can share one).
    const unique = [...new Set(files.map(String))];
    const kept = referencedMediaPaths(unique);
    for (const f of unique) {
        if (kept.has(f)) {
            out.filesShared++;
            continue;
        }
        try {
            rmSync(f, { force: true });
            out.files++;
        } catch {
            out.fileErrors++;
        }
        yield CHUNK_DONE;
    }
}

function emptyCounts() {
    return {
        messages: 0,
        reactions: 0,
        boardItems: 0,
        reminders: 0,
        cloudItems: 0,
        convState: 0,
        files: 0,
        filesShared: 0,
        fileErrors: 0,
    };
}

/**
 * Purge one group's local history at once (`fleet purge`, `db purge`: no socket is served on the thread).
 *
 * @param {string} threadId
 * @returns {ReturnType<typeof emptyCounts>}
 */
export function purgeGroupHistorySync(threadId) {
    const out = emptyCounts();
    const steps = purgeSteps(String(threadId), out);
    while (!steps.next().done);
    return out;
}

/**
 * Purge one group's local history, handing the event loop back every `sliceMs` (a daemon's socket is on the thread).
 *
 * @param {string} threadId
 * @param {{sliceMs?: number, pause?: () => Promise<void>, chunk?: number}} [opts] - `pause`: how the loop is handed back
 *   (tests)
 * @returns {Promise<ReturnType<typeof emptyCounts>>}
 */
export async function purgeGroupHistory(threadId, { sliceMs = 25, pause = yieldToLoop, chunk = 500 } = {}) {
    const out = emptyCounts();
    let sliceStart = performance.now();
    const steps = purgeSteps(String(threadId), out, { chunk });
    while (!steps.next().done) {
        if (performance.now() - sliceStart < sliceMs) continue;
        await pause();
        sliceStart = performance.now();
    }
    return out;
}

/** Revoke the links into a purged group: its media links, and export links made before (they hold its history). */
function revokeLinks(threadId, { exports = true } = {}) {
    try {
        const links = getMediaLinks();
        let n = links.revokeThread(threadId, "its group is gone");
        if (exports) n += links.revokeWhere((l) => l.kind === "export", "a group in it was purged");
        return n;
    } catch {
        return 0;
    }
}

const inFlight = new Map();

/**
 * A group stopped being ours: record it, and purge its local history unless `groups.onLeave` is `keep`. Emits a
 * `group_gone` event to this process's sink. The database must be open.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {string} args.threadId
 * @param {"leave"|"removed"|"blocked"|"disbanded"} args.reason
 * @param {number} [args.at] - the exit's time (epoch ms); now when unknown
 * @param {"purge"|"keep"} [args.mode] - pin the mode (tests); else read now ({@link resolveGroupOnLeave})
 * @param {"own-action"|"event"|"group-info"|"policy"} [args.source]
 * @param {{sliceMs?: number, pause?: () => Promise<void>, chunk?: number}} [args.slice]
 * @returns {Promise<object>} the `group_gone` event
 */
export function applyGroupExit({ ownId, threadId, reason, at = Date.now(), mode, source = "event", slice } = {}) {
    const id = String(threadId);
    const running = inFlight.get(id);
    if (running) return running;
    const job = (async () => {
        const marked = markGroupGone(id, { at, reason });
        const { mode: chosen, source: modeSource } = mode ? { mode, source: "pinned" } : resolveGroupOnLeave(ownId);
        let purged = null;
        if (chosen === "purge") {
            purged = await purgeGroupHistory(id, slice);
            purged.links = revokeLinks(id, { exports: purged.messages > 0 });
        }
        const event = groupGoneEvent({
            accountId: ownId,
            threadId: id,
            reason,
            leftAt: marked.leftAt,
            mode: chosen,
            modeSource,
            source,
            purged,
        });
        deliver(event);
        return event;
    })();
    inFlight.set(id, job);
    job.finally(() => inFlight.delete(id)).catch(() => {});
    return job;
}

/**
 * One `group_gone` event: who, why, when, what was done. Counts and ids only: no content.
 *
 * @param {object} r
 * @returns {object}
 */
export function groupGoneEvent({ accountId, threadId, reason, leftAt, mode, modeSource, source, purged }) {
    return {
        event: "group_gone",
        ...(accountId ? { accountId: String(accountId) } : {}),
        threadId: String(threadId),
        reason,
        leftAt,
        mode,
        ...(modeSource ? { modeSource } : {}),
        ...(source ? { source } : {}),
        purged: purged ?? null,
    };
}

/**
 * One `group_gone` event as a line for a person.
 *
 * @param {object} e
 * @returns {string}
 */
export function describeGroupGone(e) {
    const why = { leave: "left", removed: "removed from", blocked: "blocked from", disbanded: "disbanded:" }[e.reason];
    const head = e.reason === "disbanded" ? `Group disbanded: ${e.threadId}` : `${why} group ${e.threadId}`;
    if (e.mode === "keep")
        return `${head[0].toUpperCase()}${head.slice(1)} — history kept, marked gone (groups.onLeave keep)`;
    const p = e.purged ?? {};
    return (
        `${head[0].toUpperCase()}${head.slice(1)} — local history purged: ${p.messages ?? 0} message(s), ` +
        `${p.files ?? 0} media file(s)${p.filesShared ? ` (${p.filesShared} shared with another chat kept)` : ""}`
    );
}

/**
 * The `group_gone` event as the MCP live buffer carries it (`type`, and `text` for a person).
 *
 * @param {object} e
 * @returns {object}
 */
export function groupGoneSystemEvent(e) {
    return { type: "group_gone", ...e, text: describeGroupGone(e) };
}

/**
 * The fields a list, a search or an export adds to a gone group's entry.
 *
 * @param {{leftAt: number, goneReason: string}|null} gone - from {@link getGroupGone}
 * @returns {{gone: true, leftAt: number, goneReason: string}|{}}
 */
export function goneFields(gone) {
    return gone ? { gone: true, leftAt: gone.leftAt, goneReason: gone.goneReason } : {};
}

/**
 * The gone groups by id (for a list to flag or leave out), or an empty map when there is no cache.
 *
 * @returns {Map<string, ReturnType<typeof listGoneGroups>[number]>}
 */
export function goneGroupMap() {
    try {
        return new Map(listGoneGroups().map((g) => [g.threadId, g]));
    } catch {
        return new Map();
    }
}

/**
 * Why a send to this conversation is refused, or null: the group is gone.
 *
 * @param {string} threadId
 * @returns {string|null}
 */
export function sendRefusal(threadId) {
    let gone = null;
    try {
        gone = getGroupGone(String(threadId));
    } catch {
        return null;
    }
    if (!gone) return null;
    const why = {
        leave: "this account left it",
        removed: "this account was removed from it",
        blocked: "this account was blocked from it",
        disbanded: "it was disbanded",
    }[gone.goneReason];
    return (
        `Group ${threadId} is gone: ${why} on ${new Date(gone.leftAt).toISOString()}. Nothing was sent. ` +
        "If the account has been added back, the next message or the join event clears this."
    );
}

/**
 * Where group info says a group is gone: listed in `removedsGroup`, or answered with 161 (it no longer exists) or
 * not-a-member. Zalo treats the same three as the group being gone.
 *
 * @param {{result?: object, error?: Error|null, groupIds: string[]}} args
 * @returns {Array<{threadId: string, reason: "disbanded"|"removed"}>}
 */
export function goneFromGroupInfo({ result = null, error = null, groupIds = [] }) {
    const ids = groupIds.map(String);
    if (error) {
        const code = Number(error.code ?? /\b(\d{3})\b/.exec(String(error.message ?? ""))?.[1]);
        // Only for one group asked alone: a batch error names no group.
        if (ids.length !== 1) return [];
        if (code === GROUP_GONE_CODE) return [{ threadId: ids[0], reason: "disbanded" }];
        if (NOT_A_MEMBER.includes(code)) return [{ threadId: ids[0], reason: "removed" }];
        return [];
    }
    const removed = new Set((result?.removedsGroup ?? []).map(String));
    return ids.filter((id) => removed.has(id)).map((threadId) => ({ threadId, reason: "disbanded" }));
}

/**
 * Act on what group info said (see {@link goneFromGroupInfo}): each group not already marked gone is exited.
 * Never throws; with no open cache nothing is done.
 *
 * @param {object} args - as goneFromGroupInfo, plus `ownId`
 * @returns {Promise<object[]>} the `group_gone` events
 */
export async function noteGroupInfo({ ownId, ...args }) {
    const out = [];
    for (const g of goneFromGroupInfo(args)) {
        try {
            if (getGroupGone(g.threadId)) continue;
            out.push(await applyGroupExit({ ownId, threadId: g.threadId, reason: g.reason, source: "group-info" }));
        } catch {
            /* no cache open: nothing to mark */
        }
    }
    return out;
}

/**
 * The groups kept as gone that `purge` now applies to (a keep -> purge switch): purged at once, for a quota/retention
 * pass. Empty while the effective mode is `keep`.
 *
 * @param {string} ownId
 * @param {{dryRun?: boolean, policy?: object|null}} [opts]
 * @returns {{groups: number, messages: number, files: number}}
 */
export function purgeKeptGoneGroupsSync(ownId, { dryRun = false, policy } = {}) {
    const out = { groups: 0, messages: 0, files: 0 };
    if (resolveGroupOnLeave(ownId, { policy }).mode !== "purge") return out;
    for (const g of listGoneGroups().filter((x) => x.messages > 0)) {
        out.groups++;
        if (dryRun) {
            out.messages += g.messages;
            continue;
        }
        const r = purgeGroupHistorySync(g.threadId);
        revokeLinks(g.threadId);
        out.messages += r.messages;
        out.files += r.files;
    }
    return out;
}

/**
 * {@link purgeKeptGoneGroupsSync} for a daemon: sliced, and each group reported as a `group_gone` event (source
 * `policy`).
 *
 * @param {string} ownId
 * @param {{slice?: object}} [opts]
 * @returns {Promise<object[]>} the events
 */
export async function purgeKeptGoneGroups(ownId, { slice } = {}) {
    if (resolveGroupOnLeave(ownId).mode !== "purge") return [];
    const events = [];
    for (const g of listGoneGroups().filter((x) => x.messages > 0)) {
        events.push(
            await applyGroupExit({
                ownId,
                threadId: g.threadId,
                reason: g.goneReason,
                at: g.leftAt,
                mode: "purge",
                source: "policy",
                slice,
            }),
        );
    }
    return events;
}

/**
 * A `join` that names us brings a gone group back.
 *
 * @param {string} threadId
 * @returns {boolean}
 */
export function rejoinGroup(threadId) {
    return clearGroupGone(String(threadId)).changes > 0;
}

/**
 * `api.getGroupInfo(groupIds)`, watching the answer for gone groups ({@link noteGroupInfo}): a group listed in
 * `removedsGroup`, or one group asked alone and answered 161 or not-a-member, is exited (disbanded / removed) when
 * the cache is open. The answer or the error is passed on unchanged.
 *
 * @param {object} api
 * @param {string|null} ownId - null: watch nothing
 * @param {string[]} groupIds
 * @returns {Promise<object>} what getGroupInfo answered
 */
export async function getGroupInfoWatched(api, ownId, groupIds) {
    const ids = groupIds.map(String);
    let result;
    try {
        result = await api.getGroupInfo(ids);
    } catch (error) {
        if (ownId) await noteGroupInfo({ ownId, error, groupIds: ids });
        throw error;
    }
    if (ownId && result?.removedsGroup?.length) await noteGroupInfo({ ownId, result, groupIds: ids });
    return result;
}

/**
 * Our own successful leave or disperse: the group's exit, on the API's success
 * (`leaveGroup` / `disperseGroup`), whether or not a listener sees an echo. Never throws:
 * the Zalo action already happened, and a cache that cannot record it says so in the reply.
 *
 * @param {{ownId: string, groupId: string, reason: "leave"|"disbanded"}} args
 * @returns {Promise<{localHistory: object}>}
 */
export async function recordOwnExit({ ownId, groupId, reason }) {
    try {
        const e = await applyGroupExit({ ownId, threadId: String(groupId), reason, source: "own-action" });
        return { localHistory: { mode: e.mode, leftAt: e.leftAt, purged: e.purged } };
    } catch (e) {
        return { localHistory: { error: `the local cache did not record it: ${e.message}` } };
    }
}
