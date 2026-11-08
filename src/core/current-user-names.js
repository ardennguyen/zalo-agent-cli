import { runPacedBatches, userInfoLog } from "../zalo/custom/user-info.js";
import { readAllAliases } from "../zalo/api/people.js";
import { noteAliasSnapshot, pickName } from "./contact-names.js";

/** Aliases asked per page. */
const ALIAS_PAGE_SIZE = 100;

/** Pages read before the alias list is given up on as endless. */
const MAX_ALIAS_PAGES = 1000;

/** The default `log`: silent unless a daemon registered a sink with `setUserInfoLogger`. */
const NO_LOG = () => {};

/**
 * Read the account's complete alias snapshot. Do not reuse a previous snapshot:
 * an absent entry means the owner removed that alias. Failed/partial reads do
 * not pretend an old alias is current. Diagnostics never include identities.
 * @param {object} api - current authenticated API
 * @param {Function} [log] - diagnostic sink
 * @returns {Promise<Map<string, string>>} UID -> account-owned alias
 */
export async function readUserAliases(api, log = () => {}) {
    const aliases = await readUserAliasSnapshot(api);
    if (aliases) return aliases;
    log("current aliases unavailable; falling back to profile names or UIDs");
    return new Map();
}

/**
 * Like {@link readUserAliases}, but null when the snapshot could not be read completely, so a caller that keeps a
 * snapshot (./contact-names.js) never mistakes a failed read for "the owner removed every alias". A complete read is
 * also handed to the account's alias book, so every later display in this process sees it.
 * @param {object} api - current authenticated API
 * @returns {Promise<Map<string, string>|null>} UID -> account-owned alias, or null
 */
export async function readUserAliasSnapshot(api) {
    const aliases = new Map();
    try {
        if (typeof api?.getAliasList !== "function") return null;
        // readAllAliases pages the way Zalo Web does (`hasMore`, a full page, 212 past page 1). This wrapper keeps
        // this function's own contract on top: a malformed page, a page that repeats ids already read, or running
        // past the page cap fails the whole read instead of handing back part of the list.
        const seen = new Set();
        const checked = {
            getAliasList: async (count, page) => {
                if (page > MAX_ALIAS_PAGES) throw new Error("alias pagination limit reached");
                const result = await api.getAliasList(count, page);
                if (!Array.isArray(result?.items)) throw new Error("invalid alias page");
                const ids = result.items.map((item) => String(item?.userId ?? ""));
                if (ids.length && ids.every((id) => seen.has(id))) throw new Error("alias pagination did not advance");
                for (const id of ids) seen.add(id);
                return result;
            },
        };
        const items = await readAllAliases(checked, { pageSize: ALIAS_PAGE_SIZE, maxPages: MAX_ALIAS_PAGES + 1 });
        for (const item of items) {
            if (item?.userId && typeof item.alias === "string" && item.alias.trim()) {
                aliases.set(String(item.userId), item.alias);
            }
        }
    } catch {
        return null;
    }
    noteAliasSnapshot(aliases);
    return aliases;
}

/**
 * Select a current label independently of any per-message historical name: the owner's alias, then the profile's
 * Zalo name, then its display name, then the UID (./contact-names.js `pickName`, the one precedence every output uses).
 * @param {string} uid - canonical user ID
 * @param {object} [profile] - fresh Zalo profile
 * @param {Map<string, string>} [aliases] - account-owned aliases
 * @returns {{name: string, source: string}} label and provenance (`alias`, `display`, `zalo` or `uid`)
 */
export function currentUserName(uid, profile, aliases = new Map()) {
    const id = String(uid || "");
    const picked = pickName(id, { ...profile, alias: aliases.get(id) ?? null });
    return { name: picked.name ?? id, source: picked.source };
}

/**
 * Resolve current names in batches, with no cross-request/account name cache.
 * Failures degrade to UID, never to a historical senderName. Profiles can be
 * supplied by a fresh friend-list response to avoid fetching them twice.
 * @param {object} api - current authenticated API
 * @param {string[]} uids - IDs to display
 * @param {object} [options]
 * @returns {Promise<Map<string, {name: string, source: string}>>} UID -> current label
 */
export async function resolveCurrentUserNames(api, uids, { aliases, profiles = new Map(), log = NO_LOG } = {}) {
    const ids = [...new Set(uids.filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const aliasRequest = aliases ? Promise.resolve(aliases) : readUserAliases(api, log);
    const fresh = new Map(profiles);
    const missing = ids.filter((id) => /^[1-9][0-9]*$/.test(id) && !fresh.has(id));
    // A live-API proxy throws on any property read while a session is re-logging in, so even the probe is guarded.
    let canLookup = false;
    try {
        canLookup = typeof api?.getUserInfo === "function";
    } catch {
        /* session is reconnecting: fall back to aliases or UIDs */
    }
    if (missing.length && canLookup) {
        // Paced, retried on a rate limit and stopped when Zalo keeps refusing; what Zalo said is logged.
        const lookup = await runPacedBatches(missing, {
            batchSize: 100,
            label: "user-info",
            log: log === NO_LOG ? undefined : log,
            call: (batch) => api.getUserInfo(batch),
        });
        for (const result of lookup.results) {
            for (const bag of [result?.changed_profiles, result?.unchanged_profiles]) {
                for (const [uid, profile] of Object.entries(bag || {})) {
                    if (profile) fresh.set(uid, profile);
                }
            }
        }
        if (lookup.failed || lookup.skippedIds) {
            (log === NO_LOG ? userInfoLog : log)(
                "current profiles unavailable for some ids; falling back to aliases or UIDs",
            );
        }
    }
    const ownedAliases = await aliasRequest;
    return new Map(ids.map((id) => [id, currentUserName(id, fresh.get(id), ownedAliases)]));
}

/**
 * Decorate copied messages with current labels. `senderName` is the name to show, alias first: the owner's alias
 * when one is set, else the name the message carried, else the current profile name. `senderZaloName` keeps the
 * name the message carried (the stored snapshot, never rewritten), `senderAlias` the alias or null, and
 * `senderDisplayName`/`senderDisplayNameSource` the current label (alias, phonebook name, Zalo name, display name or UID).
 * DM titles use the peer's UID, including for an outgoing message from self.
 * @param {object} api - current authenticated API
 * @param {object[]} messages - cached or live rows
 * @param {string[]} [dmThreadIds] - known DM peer IDs, never group IDs
 * @returns {Promise<object[]>} detached display rows
 */
export async function withCurrentSenderNames(api, messages, dmThreadIds = []) {
    const peers = new Set(dmThreadIds.map(String));
    const names = await resolveCurrentUserNames(api, [...messages.map((m) => m.senderId), ...peers]);
    return messages.map((m) => {
        const sender = names.get(String(m.senderId)) || { name: null, source: "uid" };
        const peer = peers.has(String(m.threadId)) && names.get(String(m.threadId));
        const raw = "senderZaloName" in m ? m.senderZaloName || null : m.senderName || null;
        const alias = sender.source === "alias" ? sender.name : null;
        return {
            ...m,
            senderName: alias ?? raw ?? (sender.source !== "uid" ? sender.name : null),
            senderAlias: alias,
            senderZaloName: raw,
            senderDisplayName: sender.name,
            senderDisplayNameSource: sender.source,
            ...(peer && { threadName: peer.name }),
        };
    });
}
