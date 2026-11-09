import { readUserAliases, resolveCurrentUserNames } from "../core/current-user-names.js";
import { rememberFriends } from "../core/typing.js";
import { goneGroupMap, noteGroupInfo } from "../core/group-exit.js";

/**
 * In-memory cache mapping threadId → {name, type, memberCount}.
 * Built on startup by fetching all groups + friends from Zalo API.
 * Provides fuzzy Vietnamese-aware search for thread discovery.
 */

/**
 * Normalize Vietnamese text for fuzzy matching.
 * Strips diacritics and lowercases for accent-insensitive comparison.
 * @param {string} text
 * @returns {string}
 */
function normalizeVietnamese(text) {
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}

export class ThreadNameCache {
    constructor() {
        /** @type {Map<string, { name: string, type: "group"|"dm", memberCount?: number }>} */
        this._cache = new Map();
        this._ready = false;
    }

    /**
     * Initialize cache by fetching all groups and friends from Zalo API.
     * Batches group info requests (50 per batch) to avoid rate limits.
     * @param {object} api - session object
     * @param {{ownId?: string}} [opts] - the account: a group its info lists as removed is disbanded (group_gone)
     */
    async init(api, { ownId } = {}) {
        const start = Date.now();
        let groupCount = 0;
        let friendCount = 0;
        const friendProfiles = new Map();

        // Load groups: getAllGroups() → IDs → batched getGroupInfo()
        try {
            const groupsResult = await api.getAllGroups();
            const groupIds = Object.keys(groupsResult?.gridVerMap || {});
            const batchSize = 50;

            for (let i = 0; i < groupIds.length; i += batchSize) {
                const batch = groupIds.slice(i, i + batchSize);
                try {
                    const info = await api.getGroupInfo(batch);
                    // Disbanded: the group fetch lists it in removedsGroup (Zalo Web's version-map rule).
                    if (ownId && info?.removedsGroup?.length) {
                        for (const e of await noteGroupInfo({ ownId, result: info, groupIds: batch }))
                            this._cache.delete(e.threadId);
                    }
                    const map = info?.gridInfoMap || {};
                    for (const [gid, g] of Object.entries(map)) {
                        this._cache.set(gid, {
                            name: g.name || "?",
                            type: "group",
                            memberCount: g.totalMember || 0,
                            // A group recall sends it, as Zalo Web's does (src/zalo/custom/group-visibility.js).
                            ...(g.visibility !== undefined && g.visibility !== null && { visibility: g.visibility }),
                        });
                        groupCount++;
                    }
                } catch (e) {
                    console.error(`[thread-name-cache] Batch getGroupInfo failed (offset ${i}):`, e.message);
                }
            }
        } catch (e) {
            console.error("[thread-name-cache] getAllGroups failed:", e.message);
        }

        // Load friends (DM threads), honoring the owner's aliases explicitly.
        try {
            const friends = await api.getAllFriends();
            const list = Array.isArray(friends) ? friends : [];
            // The friend list zalo_conversation `typing` checks a DM against (src/core/typing.js).
            if (Array.isArray(friends)) rememberFriends(list);
            for (const f of list) {
                if (f.userId) {
                    friendProfiles.set(String(f.userId), f);
                    this._cache.set(f.userId, {
                        name: f.displayName || f.zaloName || "?",
                        type: "dm",
                    });
                    friendCount++;
                }
            }
        } catch (e) {
            console.error("[thread-name-cache] getAllFriends failed:", e.message);
        }

        await this.refreshUsers(api, friendProfiles);
        this.applyGone();
        this._ready = true;
        const elapsed = Date.now() - start;
        console.error(`[thread-name-cache] Ready: ${groupCount} groups, ${friendCount} friends (${elapsed}ms)`);
    }

    /**
     * Bring the cache in line with the groups the local cache records as gone (src/core/group-exit.js): one whose
     * history is kept is listed flagged (`gone`, `leftAt`, `goneReason`), one whose history was purged is left out.
     *
     * @param {Map<string, object>} [gone] - pin the gone groups (tests)
     */
    applyGone(gone = goneGroupMap()) {
        for (const [id, g] of gone) {
            if (g.messages > 0) {
                this.set(id, { name: g.name || this._cache.get(id)?.name || "?", type: "group" });
                this.set(id, { gone: true, leftAt: g.leftAt, goneReason: g.goneReason });
            } else this._cache.delete(id);
        }
    }

    /**
     * Forget one thread (a gone group whose history was purged).
     *
     * @param {string} threadId
     * @returns {boolean}
     */
    drop(threadId) {
        return this._cache.delete(String(threadId));
    }

    /**
     * Get thread info by ID. Returns null if not cached.
     * @param {string} threadId
     * @returns {{ name: string, type: "group"|"dm", memberCount?: number } | null}
     */
    get(threadId) {
        return this._cache.get(threadId) || null;
    }

    /** Refresh current DM labels without modifying per-message names or group titles. */
    async refreshUsers(api, profiles = new Map()) {
        const ids = [...this._cache].filter(([, v]) => v.type === "dm").map(([id]) => id);
        const aliases = await readUserAliases(api);
        const names = await resolveCurrentUserNames(api, ids, { aliases, profiles });
        for (const [id, current] of names) this.set(id, { name: current.name, type: "dm" });
    }

    /**
     * Get thread name by ID. Returns null if not cached.
     * @param {string} threadId
     * @returns {string | null}
     */
    getName(threadId) {
        return this._cache.get(threadId)?.name || null;
    }

    /**
     * Search threads by name with Vietnamese-aware fuzzy matching.
     * @param {string} query - Search keyword
     * @param {"group"|"dm"|"all"} [type="all"] - Filter by thread type
     * @param {number|null} [limit] - Max results; omitted, null or <= 0 = every match
     * @returns {Array<{ threadId: string, name: string, type: "group"|"dm", memberCount?: number }>}
     */
    search(query, type = "all", limit = null) {
        const normalizedQuery = normalizeVietnamese(query);
        const results = [];

        for (const [threadId, info] of this._cache) {
            if (type !== "all" && info.type !== type) continue;

            const normalizedName = normalizeVietnamese(info.name);
            if (normalizedName.includes(normalizedQuery)) {
                results.push({ threadId, ...info });
            }
        }

        // Sort: exact prefix match first, then alphabetical
        results.sort((a, b) => {
            const aNorm = normalizeVietnamese(a.name);
            const bNorm = normalizeVietnamese(b.name);
            const aPrefix = aNorm.startsWith(normalizedQuery) ? 0 : 1;
            const bPrefix = bNorm.startsWith(normalizedQuery) ? 0 : 1;
            if (aPrefix !== bPrefix) return aPrefix - bPrefix;
            return aNorm.localeCompare(bNorm);
        });

        return Number(limit) > 0 ? results.slice(0, limit) : results;
    }

    /**
     * Update a single thread entry (e.g. on group rename event).
     * @param {string} threadId
     * @param {object} info - Partial update: { name?, type?, memberCount? }
     */
    set(threadId, info) {
        const existing = this._cache.get(threadId);
        if (existing) {
            this._cache.set(threadId, { ...existing, ...info });
        } else {
            this._cache.set(threadId, { name: "?", type: "group", ...info });
        }
    }

    /** @returns {boolean} Whether cache has been initialized */
    get ready() {
        return this._ready;
    }

    /** @returns {number} Total cached entries */
    get size() {
        return this._cache.size;
    }
}
