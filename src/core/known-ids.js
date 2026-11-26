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
 *  - the ids this account itself handed out ({@link recordKnownIds}): a phone or username lookup, a group's member
 *    list, the friend requests listed, so a stranger found by phone moments before can be messaged;
 *  - last, on a miss, this account's own friend list and group list, read again at most once every
 *    {@link LIST_REFRESH_MS} (a friend added since the last read is not refused).
 *
 * A refusal is made only on the account's own evidence: with no cache open, or when a list cannot be read, the call
 * goes ahead. `allowUnknown`
 * (CLI `--allow-unknown`) skips the check for the rare id the account knows but has never shown here.
 *
 * The ids handed out are kept in `known-ids.json` in the account folder as hashes (keyed by the account), not as ids:
 * the file says only whether an id was seen, never who was looked up. It is not zalo.db, whose rows have their own
 * writers (AGENTS.md §13).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../zalo/kernel/atomic-file.js";
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
 * follow with them are not refused. Best effort: a write that fails is logged and costs only a later refusal.
 *
 * @param {string|null} accountDir - the account folder (no folder: nothing kept)
 * @param {string|null} ownId - the account
 * @param {Iterable<string|number|null|undefined>} ids
 * @returns {number} how many ids were new
 */
export function recordKnownIds(accountDir, ownId, ids) {
    if (!accountDir) return 0;
    const fresh = [...new Set([...(ids ?? [])].filter((id) => /^\d+$/.test(String(id ?? ""))).map(String))];
    if (!fresh.length) return 0;
    const file = join(accountDir, KNOWN_IDS_FILE);
    let added = 0;
    try {
        withFileLock(`${file}.lock`, () => {
            const ids = new Map(readKnownFile(file));
            const now = Date.now();
            for (const id of fresh) {
                const h = hashOf(ownId, id);
                if (!ids.has(h)) added++;
                ids.set(h, now);
            }
            const kept = [...ids].sort((a, b) => b[1] - a[1]).slice(0, KNOWN_IDS_MAX);
            writeFileAtomic(file, JSON.stringify({ v: 1, ids: Object.fromEntries(kept) }) + "\n", { durable: false });
            files.delete(file);
        });
    } catch (e) {
        console.error(`[known-ids] not recorded: ${e.message}`);
        return 0;
    }
    return added;
}

/**
 * Whether this account handed out an id before ({@link recordKnownIds}).
 *
 * @param {string|null} accountDir
 * @param {string|null} ownId
 * @param {string|number} id
 * @returns {boolean}
 */
export function isRecordedKnown(accountDir, ownId, id) {
    if (!accountDir) return false;
    return readKnownFile(join(accountDir, KNOWN_IDS_FILE)).has(hashOf(ownId, String(id)));
}

/** The friend and group lists read on a miss, per account: {friends: {at, set}, groups: {at, set}}. */
const lists = new Map();

/** Forget the lists read on a miss (tests). */
export function _resetKnownIdLists() {
    lists.clear();
    files.clear();
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
 * @typedef {{id: string, as: "user"|"group"|"thread", field: string}} IdTarget
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
    if (isRecordedKnown(accountDir, ownId, id)) return "looked up";
    return null;
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
