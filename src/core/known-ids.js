/**
 * Ids this account knows, and the refusal of one it does not (`UNKNOWN_TO_ACCOUNT`).
 *
 * Zalo gives the same person a different user id on each account. An agent that reaches several accounts can read a
 * user id on one and pass it to another, where it names someone else or no one; Zalo itself does not say which. So the
 * tools and commands that take a person or a conversation check the id against what THIS account has seen first, and
 * refuse one it has never seen, before any request goes out:
 *
 *  - its cache (src/core/db.js knownIdSource): its conversations, a message in one or from that sender, its contact
 *    book, the owner's aliases, a presence push;
 *  - what this process holds in memory: the friend list (src/core/typing.js), the alias and contact books
 *    (src/core/contact-names.js), and whatever the caller adds (the MCP server's thread index: every friend and group);
 *  - the ids this account itself handed out ({@link recordKnownIds}): a phone or username lookup, the friend requests
 *    listed, so a stranger found by phone moments before can be messaged;
 *  - the members of this account's groups ({@link recordGroupInfoMembers}, {@link recordGroupEventMembers}): every
 *    group read (`getGroupInfo`: a member list, the MCP server's group index at start, a sync's group pass) and every
 *    group event (a member added, joined, removed, an admin named), so a member who never wrote in the group is known;
 *  - last, on a miss, this account's own friend list and group list, read again at most once every
 *    {@link LIST_REFRESH_MS} (a friend added since the last read is not refused), and for a member a group action
 *    names, that group's member list (a list Zalo answers short of its own count proves nothing, so it refuses
 *    nothing).
 *
 * A refusal is made only on the account's own evidence: with no cache open, or when a list cannot be read, the call
 * goes ahead. `allowUnknown`
 * (CLI `--allow-unknown`) skips the check for the rare id the account knows but has never shown here.
 *
 * The ids handed out are kept in `known-ids.json` in the account folder, group members in `known-members.json`, as
 * hashes (keyed by the account), not as ids: a file says only whether an id was seen, never who was looked up or who
 * is in which group. Neither is zalo.db, whose rows have their own writers (AGENTS.md §13).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { getAccountDir } from "./credentials.js";
import { isDbOpen, knownIdSource } from "./db.js";
import { aliasFor, contactNameFor } from "./contact-names.js";
import { isKnownFriend, rememberFriends } from "./typing.js";

/** The error code of a refusal. */
export const UNKNOWN_TO_ACCOUNT = "UNKNOWN_TO_ACCOUNT";
/** How often, at most, a miss reads the friend list or the group list again. */
export const LIST_REFRESH_MS = 5 * 60 * 1000;
/** The file of the ids this account handed out, in the account folder. */
export const KNOWN_IDS_FILE = "known-ids.json";
/** The most ids kept in it; the oldest go first. */
export const KNOWN_IDS_MAX = 20000;
/** The file of the members seen in this account's groups, in the account folder. */
export const KNOWN_MEMBERS_FILE = "known-members.json";
/** The most members kept in it; the ones seen longest ago go first. */
export const KNOWN_MEMBERS_MAX = 50000;
/** An id recorded again within this long is not written again (a group read every few minutes rewrites nothing). */
export const RECORD_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Where each kind of record is kept, and how many it keeps. */
const RECORDS = {
    "looked up": { file: KNOWN_IDS_FILE, max: KNOWN_IDS_MAX },
    "group member": { file: KNOWN_MEMBERS_FILE, max: KNOWN_MEMBERS_MAX },
};

/** Ids that are never a person or a group of someone else's: My Documents, @All. */
const NEVER_CHECKED = new Set(["me", "-1", "0"]);

const hashOf = (ownId, id) =>
    createHash("sha256")
        .update(`${ownId ?? ""}:${id}`)
        .digest("hex")
        .slice(0, 32);

/** known-ids.json, as last read: path -> {mtimeMs, size, ids: Map<hash, at>} */
const files = new Map();

function readKnownFile(file) {
    let st;
    try {
        st = statSync(file);
    } catch {
        files.delete(file);
        return new Map();
    }
    const held = files.get(file);
    if (held && held.mtimeMs === st.mtimeMs && held.size === st.size) return held.ids;
    let ids = new Map();
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        ids = new Map(Object.entries(raw?.ids ?? {}).filter(([, at]) => Number.isFinite(at)));
    } catch {
        /* unreadable: as if empty; the next record writes it again */
    }
    files.set(file, { mtimeMs: st.mtimeMs, size: st.size, ids });
    return ids;
}

/**
 * Remember ids this account itself handed out (a lookup, a member list, a friend request list), so the calls that
 * follow with them are not refused. Best effort: a write that fails is logged and costs only a later refusal. Ids all
 * recorded within RECORD_REFRESH_MS write nothing.
 *
 * @param {string|null} accountDir - the account folder (no folder: nothing kept)
 * @param {string|null} ownId - the account
 * @param {Iterable<string|number|null|undefined>} ids
 * @param {{kind?: "looked up"|"group member"}} [o] - which record: a lookup's (default) or a group's members
 * @returns {number} how many ids were new
 */
export function recordKnownIds(accountDir, ownId, ids, { kind = "looked up" } = {}) {
    if (!accountDir) return 0;
    const fresh = [...new Set([...(ids ?? [])].filter((id) => /^\d+$/.test(String(id ?? ""))).map(String))];
    if (!fresh.length) return 0;
    const { file: name, max } = RECORDS[kind] ?? RECORDS["looked up"];
    const file = join(accountDir, name);
    const now = Date.now();
    const current = (held) => fresh.every((id) => now - (held.get(hashOf(ownId, id)) ?? -Infinity) < RECORD_REFRESH_MS);
    if (current(readKnownFile(file))) return 0;
    let added = 0;
    try {
        withFileLock(`${file}.lock`, () => {
            const ids = new Map(readKnownFile(file));
            if (current(ids)) return;
            for (const id of fresh) {
                const h = hashOf(ownId, id);
                if (!ids.has(h)) added++;
                ids.set(h, now);
            }
            const kept = [...ids].sort((a, b) => b[1] - a[1]).slice(0, max);
            writeFileAtomic(file, JSON.stringify({ v: 1, ids: Object.fromEntries(kept) }) + "\n", { durable: false });
            files.delete(file);
        });
    } catch (e) {
        console.error(`[known-ids] not recorded: ${e.message}`);
        return 0;
    }
    return added;
}

/** A member list entry as a user id: `"<uid>_<version>"`, a bare uid, or `{id}` / `{uid}` / `{userId}`. */
function memberId(m) {
    const raw = m && typeof m === "object" ? (m.id ?? m.uid ?? m.userId) : m;
    const id = String(raw ?? "").split("_")[0];
    return /^\d+$/.test(id) ? id : null;
}

/**
 * The people a `getGroupInfo` answer names in this account's groups: each group's members (`memVerList`,
 * `memberIds`, `currentMems`), its admins and its creator.
 *
 * @param {object|null|undefined} result - what `api.getGroupInfo(ids)` answered
 * @returns {string[]}
 */
export function groupInfoMemberIds(result) {
    const out = new Set();
    for (const g of Object.values(result?.gridInfoMap ?? {})) {
        if (!g || typeof g !== "object") continue;
        for (const list of [g.memVerList, g.memberIds, g.currentMems, g.adminIds])
            if (Array.isArray(list)) for (const m of list) out.add(memberId(m));
        out.add(memberId(g.creatorId));
    }
    out.delete(null);
    return [...out];
}

/**
 * The people a group event names: the members it is about (`updateMembers`), who did it and the group's creator.
 *
 * @param {object|null|undefined} event - the listener's group event
 * @returns {string[]}
 */
export function groupEventMemberIds(event) {
    const d = event?.data;
    if (!d || typeof d !== "object") return [];
    const out = new Set((Array.isArray(d.updateMembers) ? d.updateMembers : []).map(memberId));
    for (const id of [d.sourceId, d.actorId, d.creatorId]) out.add(memberId(id));
    out.delete(null);
    return [...out];
}

function recordMembers(ownId, ids, accountDir) {
    if (ownId === undefined || ownId === null || ownId === "" || !ids.length) return 0;
    try {
        return recordKnownIds(accountDir ?? getAccountDir(ownId), String(ownId), ids, { kind: "group member" });
    } catch (e) {
        console.error(`[known-ids] group members not recorded: ${e.message}`);
        return 0;
    }
}

/**
 * Remember the members a `getGroupInfo` answer of this account names, so a member who never wrote in the group is not
 * refused. Best effort, never throws.
 *
 * @param {string|number|null|undefined} ownId - the account (none: nothing kept)
 * @param {object|null|undefined} result - what `api.getGroupInfo(ids)` answered
 * @param {{accountDir?: string|null}} [o] - the account folder; by default the account's own
 * @returns {number} how many ids were new
 */
export function recordGroupInfoMembers(ownId, result, { accountDir } = {}) {
    return recordMembers(ownId, groupInfoMemberIds(result), accountDir);
}

/**
 * Remember the people a group event of this account names (a member added, joined, removed, an admin named). Best
 * effort, never throws.
 *
 * @param {string|number|null|undefined} ownId
 * @param {object} event - the listener's group event
 * @param {{accountDir?: string|null}} [o]
 * @returns {number} how many ids were new
 */
export function recordGroupEventMembers(ownId, event, { accountDir } = {}) {
    return recordMembers(ownId, groupEventMemberIds(event), accountDir);
}

/**
 * Whether this account handed out an id before, or saw it in one of its groups ({@link recordKnownIds}).
 *
 * @param {string|null} accountDir
 * @param {string|null} ownId
 * @param {string|number} id
 * @returns {boolean}
 */
export function isRecordedKnown(accountDir, ownId, id) {
    return recordedKind(accountDir, ownId, id) !== null;
}

/** Which record holds an id ("looked up", "group member"), or null. */
function recordedKind(accountDir, ownId, id) {
    if (!accountDir) return null;
    const h = hashOf(ownId, String(id));
    for (const [kind, { file }] of Object.entries(RECORDS)) {
        if (readKnownFile(join(accountDir, file)).has(h)) return kind;
    }
    return null;
}

/** The friend and group lists read on a miss, per account: {friends: {at, set}, groups: {at, set}}. */
const lists = new Map();
/** One group's member list read on a miss, per account and group: {at, set, complete}. */
const memberLists = new Map();

/** Forget the lists read on a miss (tests). */
export function _resetKnownIdLists() {
    lists.clear();
    memberLists.clear();
    files.clear();
}

/**
 * One group's members, read again when the last read is older than LIST_REFRESH_MS: `complete` is false when Zalo
 * listed fewer than its own count. null when the list cannot be read. What it lists is recorded.
 */
async function membersOf(api, ownId, accountDir, groupId) {
    const key = `${ownId ?? ""}:${groupId}`;
    const held = memberLists.get(key);
    if (held && Date.now() - held.at < LIST_REFRESH_MS) return held;
    if (typeof api?.getGroupInfo !== "function") return null;
    try {
        const result = await api.getGroupInfo([groupId]);
        const g = result?.gridInfoMap?.[groupId];
        if (!g) return null;
        const set = new Set(groupInfoMemberIds({ gridInfoMap: { [groupId]: g } }));
        const listed = Array.isArray(g.memVerList) ? g.memVerList.length : 0;
        const total = Number(g.totalMember);
        const entry = { at: Date.now(), set, complete: Number.isFinite(total) && listed >= total };
        memberLists.set(key, entry);
        recordMembers(ownId, [...set], accountDir);
        return entry;
    } catch (e) {
        console.error(`[known-ids] a group's members not read: ${e.message}`);
        return null;
    }
}

/**
 * The account's friend ids or group ids, read again when the last read is older than LIST_REFRESH_MS. null when the
 * list cannot be read (no session, or Zalo did not answer).
 */
async function listOf(api, ownId, which) {
    const mine = lists.get(ownId ?? "") ?? {};
    lists.set(ownId ?? "", mine);
    const held = mine[which];
    if (held && Date.now() - held.at < LIST_REFRESH_MS) return held.set;
    try {
        let set;
        if (which === "friends") {
            if (typeof api?.getAllFriends !== "function") return held?.set ?? null;
            const all = await api.getAllFriends();
            const arr = Array.isArray(all) ? all : Array.isArray(all?.data) ? all.data : null;
            if (!arr) return held?.set ?? null;
            rememberFriends(arr);
            set = new Set(arr.map((f) => String(f?.userId ?? f?.uid ?? "")).filter(Boolean));
        } else {
            if (typeof api?.getAllGroups !== "function") return held?.set ?? null;
            const all = await api.getAllGroups();
            const map = all?.gridVerMap ?? all?.data?.gridVerMap;
            if (!map || typeof map !== "object") return held?.set ?? null;
            set = new Set(Object.keys(map));
        }
        mine[which] = { at: Date.now(), set };
        return set;
    } catch (e) {
        console.error(`[known-ids] ${which} list not read: ${e.message}`);
        return held?.set ?? null;
    }
}

/**
 * One id a tool or command is about to use: `as` says what it must be ("user", "group", or "thread" when either).
 * `group`, for a member a group action names, is the group whose member list may also prove it.
 * @typedef {{id: string, as: "user"|"group"|"thread", field: string, group?: string}} IdTarget
 */

/**
 * The `@[uid]` mention tokens of a text (not @All).
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function mentionUids(text) {
    if (typeof text !== "string" || !text.includes("@[")) return [];
    return [...new Set([...text.matchAll(/@\[(\d+)\]/g)].map((m) => m[1]))];
}

/** The local evidence for one id, or null: the cache, the books in memory, the caller's index, the recorded ids. */
function localSource(t, { ownId, accountDir, extraKnown }) {
    const { id, as } = t;
    if (as !== "group") {
        if (isKnownFriend(id) === true) return "friends";
        if (aliasFor(id) || contactNameFor(id)) return "contact book";
    }
    try {
        if (extraKnown?.(id, as)) return "index";
    } catch {
        /* the caller's index is a hint */
    }
    if (isDbOpen()) {
        try {
            const s = knownIdSource(id, as);
            if (s) return s;
        } catch {
            /* no cache readable: the other sources */
        }
    }
    return recordedKind(accountDir, ownId, id);
}

/**
 * The ids of `targets` this account does not know. Local evidence first; for the rest, the account's friend list
 * (a person or a conversation) and group list (a group or a conversation), read again at most every LIST_REFRESH_MS.
 * Nothing is reported without the account's cache open, nor an id whose list cannot be read (no refusal without the
 * account's own evidence).
 *
 * @param {IdTarget[]} targets
 * @param {object} ctx
 * @param {object|null} [ctx.api] - the session, for the lists
 * @param {string|null} [ctx.ownId] - the account (its own id is always known)
 * @param {string[]} [ctx.selfIds] - more ids of the account's own (My Documents)
 * @param {string|null} [ctx.accountDir] - for the recorded ids
 * @param {(id: string, as: string) => boolean} [ctx.extraKnown] - the caller's own index
 * @returns {Promise<IdTarget[]>}
 */
export async function findUnknownIds(targets, ctx = {}) {
    // The account's cache is the first and main evidence: without one open, nothing is refused.
    if (!isDbOpen()) return [];
    const own = new Set([ctx.ownId, ...(ctx.selfIds ?? [])].filter(Boolean).map(String));
    const seen = new Set();
    const pending = [];
    for (const t of targets ?? []) {
        if (!t || t.id === undefined || t.id === null) continue;
        const id = String(t.id).trim();
        // Only a numeric id is a Zalo id; anything else is the tool's own argument check's to refuse.
        if (!/^\d+$/.test(id) || NEVER_CHECKED.has(id) || own.has(id)) continue;
        const key = `${t.as}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const target = { ...t, id };
        if (!localSource(target, ctx)) pending.push(target);
    }
    if (!pending.length) return [];
    const unknown = [];
    for (const t of pending) {
        const friends = t.as !== "group" ? await listOf(ctx.api, ctx.ownId, "friends") : new Set();
        const groups = t.as !== "user" ? await listOf(ctx.api, ctx.ownId, "groups") : new Set();
        // A list that cannot be read proves nothing: the call goes ahead.
        if (friends === null || groups === null) continue;
        if (friends.has(t.id) || groups.has(t.id)) continue;
        if (t.group !== undefined && t.group !== null && /^\d+$/.test(String(t.group))) {
            const members = await membersOf(ctx.api, ctx.ownId, ctx.accountDir, String(t.group));
            // A member list that cannot be read, or that Zalo answered short of its own count, proves nothing either.
            if (!members || members.set.has(t.id) || !members.complete) continue;
        }
        unknown.push(t);
    }
    return unknown;
}

const KIND_WORD = { user: "user id", group: "group id", thread: "conversation id" };

/**
 * The refusal of ids this account does not know, worded for the MCP tools or the CLI.
 *
 * @param {IdTarget[]} unknown - from findUnknownIds (not empty)
 * @param {{surface?: "mcp"|"cli"}} [o]
 * @returns {{code: string, message: string, unknownIds: IdTarget[]}}
 */
export function unknownIdRefusal(unknown, { surface = "mcp" } = {}) {
    const cli = surface === "cli";
    const named = unknown.map((t) => `${KIND_WORD[t.as] ?? "id"} ${t.id}${t.field ? ` (${t.field})` : ""}`).join(", ");
    const onlyGroups = unknown.every((t) => t.as === "group");
    const findPerson = cli
        ? "by phone (`friend find <phone>`), username (`friend find-username <username>`) or name (`friend search <name>`, `conv recent`)"
        : "by phone or username (zalo_lookup_user) or by name (zalo_search_threads)";
    const findGroup = cli
        ? "by name (`group list`, `conv recent`)"
        : "by name (zalo_search_threads with type group, zalo_list_conversations)";
    const override = cli ? "--allow-unknown" : "allowUnknown: true";
    const message =
        `${UNKNOWN_TO_ACCOUNT}: ${named} ${unknown.length > 1 ? "are" : "is"} unknown to this Zalo account: ` +
        (onlyGroups
            ? "not one of its groups or conversations. "
            : "not a friend, a conversation, a contact, a member of one of its groups or a sender it has seen. ") +
        "Zalo gives the same person a different user id on each account, so an id read on another account names " +
        "someone else here, or no one. " +
        (onlyGroups
            ? `Find the group on this account ${findGroup}, and use the id it gives. `
            : `Find the person on this account ${findPerson}, and use the id it returns. `) +
        `Only when you are sure the id is this account's, repeat the call with ${override}.`;
    return { code: UNKNOWN_TO_ACCOUNT, message, unknownIds: unknown.map(({ id, as, field }) => ({ id, as, field })) };
}
