import { runPacedBatches, userInfoLog } from "./user-info.js";

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
    const aliases = new Map();
    try {
        if (typeof api?.getAliasList !== "function") return aliases;
        for (let page = 1; page <= 1000; page++) {
            const result = await api.getAliasList(100, page);
            if (!Array.isArray(result?.items)) throw new Error("invalid alias page");
            let added = 0;
            for (const item of result.items) {
                if (item.userId && typeof item.alias === "string" && item.alias.trim()) {
                    const uid = String(item.userId);
                    if (!aliases.has(uid)) added++;
                    aliases.set(uid, item.alias);
                }
            }
            if (result.items.length < 100) return aliases;
            if (!added) throw new Error("alias pagination did not advance");
        }
        throw new Error("alias pagination limit reached");
    } catch {
        log("current aliases unavailable; falling back to profile names or UIDs");
        return new Map();
    }
}

/**
 * Select a current label independently of any per-message historical name.
 * @param {string} uid - canonical user ID
 * @param {object} [profile] - fresh Zalo profile
 * @param {Map<string, string>} [aliases] - account-owned aliases
 * @returns {{name: string, source: string}} label and provenance
 */
export function currentUserName(uid, profile, aliases = new Map()) {
    const id = String(uid || "");
    const alias = aliases.get(id);
    if (alias) return { name: alias, source: "alias" };
    // displayName can itself be an alias. Only zaloName establishes the
    // profile-name fallback independently of the owner's alias snapshot.
    const name = profile?.zaloName;
    return name ? { name, source: "zalo" } : { name: id, source: "uid" };
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
 * Decorate copied messages with current labels; senderName stays historical.
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
        return {
            ...m,
            senderDisplayName: sender.name,
            senderDisplayNameSource: sender.source,
            ...(peer && { threadName: peer.name }),
        };
    });
}
