import { resolveNonFriendDms } from "./gid.js";

const NOISED_ID = /^[0-9A-V]{32}$/;

/**
 * Build a per-restore sender resolver. Only DM entries can seed user identities:
 * a group's globalId identifies the conversation, never one of its senders.
 * Unknown senders use the existing profile gid/decrypt + getUserInfo path.
 * Failures leave the original ID intact and are attempted once per restore.
 *
 * @param {object} api - authenticated zca-js API
 * @param {Map<string, {id: string, name: string, type: string}>} threadMap
 * @param {object} [options]
 * @param {Function} [options.resolveUsers] - batched global-ID resolver
 * @param {Function} [options.log] - diagnostic sink (never stdout in MCP mode)
 * @returns {{prepare: Function, get: Function}} chunk preparation and row lookup
 */
export function createSenderResolver(api, threadMap, { resolveUsers = resolveNonFriendDms, log = () => {} } = {}) {
    const users = new Map();
    const attempted = new Set();
    for (const [gid, user] of threadMap) {
        if (user.type === "dm") users.set(gid, { id: String(user.id), name: user.name || "" });
    }

    return {
        async prepare(messages) {
            // Conversation resolution may have added non-friend users since
            // this resolver was constructed. Do not repeat those lookups.
            for (const [gid, user] of threadMap) {
                if (user.type === "dm") users.set(gid, { id: String(user.id), name: user.name || "" });
            }
            const missing = [...new Set(messages.map((m) => String(m.senderId || "")))].filter(
                (id) => NOISED_ID.test(id) && !users.has(id) && !attempted.has(id),
            );
            if (!missing.length) return;
            for (const id of missing) attempted.add(id);
            try {
                const resolved = await resolveUsers(api, missing, log);
                for (const id of missing) {
                    const user = resolved.get(id);
                    // Never treat a missing mapping, or another opaque ID, as
                    // a canonical user. Keep unknown senders explicitly unknown.
                    if (user && /^[1-9][0-9]*$/.test(String(user.id))) {
                        users.set(id, { id: String(user.id), name: user.name || "" });
                    }
                }
            } catch {
                log("sender identity lookup failed; unresolved sender IDs are preserved");
            }
        },
        get(senderId) {
            const id = String(senderId || "");
            return users.get(id) || { id, name: "" };
        },
    };
}
