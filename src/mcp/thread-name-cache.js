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
     * @param {object} api - zca-js API instance
     */
    async init(api) {
        const start = Date.now();
        let groupCount = 0;
        let friendCount = 0;

        // Load groups: getAllGroups() → IDs → batched getGroupInfo()
        try {
            const groupsResult = await api.getAllGroups();
            const groupIds = Object.keys(groupsResult?.gridVerMap || {});
            const batchSize = 50;

            for (let i = 0; i < groupIds.length; i += batchSize) {
                const batch = groupIds.slice(i, i + batchSize);
                try {
                    const info = await api.getGroupInfo(batch);
                    const map = info?.gridInfoMap || {};
                    for (const [gid, g] of Object.entries(map)) {
                        this._cache.set(gid, {
                            name: g.name || "?",
                            type: "group",
                            memberCount: g.totalMember || 0,
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

        // Load friends (DM threads)
        try {
            const friends = await api.getAllFriends();
            const list = Array.isArray(friends) ? friends : [];
            for (const f of list) {
                if (f.userId) {
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

        this._ready = true;
        const elapsed = Date.now() - start;
        console.error(`[thread-name-cache] Ready: ${groupCount} groups, ${friendCount} friends (${elapsed}ms)`);
    }

    /**
     * Get thread info by ID. Returns null if not cached.
     * @param {string} threadId
     * @returns {{ name: string, type: "group"|"dm", memberCount?: number } | null}
     */
    get(threadId) {
        return this._cache.get(threadId) || null;
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
     * @param {number} [limit=10] - Max results
     * @returns {Array<{ threadId: string, name: string, type: "group"|"dm", memberCount?: number }>}
     */
    search(query, type = "all", limit = 10) {
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

        return results.slice(0, limit);
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
