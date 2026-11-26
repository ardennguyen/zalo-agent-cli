import { resolveNonFriendDms } from "../../zalo/custom/gid.js";
import { lookupsCoolingDown } from "../../zalo/custom/user-info.js";

const NOISED_ID = /^[0-9A-V]{32}$/;

/** A sender that did not resolve is asked for twice more, after these pauses, before it is left as it is (Y9). */
export const SENDER_RETRY_DELAYS_MS = Object.freeze([500, 1500]);

/**
 * Build a per-restore sender resolver. Only DM entries can seed user identities:
 * a group's globalId identifies the conversation, never one of its senders.
 * Unknown senders use the existing profile gid/decrypt + getUserInfo path.
 * A sender that does not resolve is asked for again, twice, 0.5 s and 1.5 s later (a lookup that failed once
 * often answers the next time); after that it keeps its original ID, and is not asked for again in this restore.
 *
 * **A rate limit ends lookups for the rest of the restore.** Once Zalo says it is limiting lookups (code 221; the
 * process-wide cool-down of src/zalo/custom/user-info.js starts), no batch asks again in this restore, whatever the
 * cool-down does: the senders not resolved, and the resolved ones whose name did not come, are `deferred()`, for the
 * fill-in after the stage (src/core/sync-v2/deferred-names.js). An aborted `signal` stops the lookups the same way.
 *
 * @param {object} api - logged-in session
 * @param {Map<string, {id: string, name: string, type: string}>} threadMap
 * @param {object} [options]
 * @param {Function} [options.resolveUsers] - batched global-ID resolver `(api, ids, log, {signal}) => Map`
 * @param {Function} [options.log] - diagnostic sink (never stdout in MCP mode)
 * @param {(ms: number) => Promise<void>} [options.sleep] - the pause between attempts (a test seam)
 * @param {AbortSignal} [options.signal] - the restore's cancel
 * @returns {{prepare: Function, get: Function, deferred: () => {opaque: string[], uids: string[]}}}
 */
export function createSenderResolver(
    api,
    threadMap,
    {
        resolveUsers = resolveNonFriendDms,
        log = () => {},
        sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
        signal,
    } = {},
) {
    const users = new Map();
    const attempted = new Set();
    const deferredOpaque = new Set();
    const deferredUids = new Set();
    /** Set once a lookup of this restore met Zalo's limit: no more lookups in it. */
    let limited = false;
    const stopped = () => limited || signal?.aborted === true || (lookupsCoolingDown() && (limited = true));
    for (const [gid, user] of threadMap) {
        if (user.type === "dm")
            users.set(gid, { id: String(user.id), name: user.snapshotName ?? user.zaloName ?? user.name ?? "" });
    }

    return {
        async prepare(messages) {
            // Conversation resolution may have added non-friend users since
            // this resolver was constructed. Do not repeat those lookups.
            for (const [gid, user] of threadMap) {
                if (user.type === "dm")
                    users.set(gid, {
                        id: String(user.id),
                        name: user.snapshotName ?? user.zaloName ?? user.name ?? "",
                    });
            }
            const missing = [...new Set(messages.map((m) => String(m.senderId || "")))].filter(
                (id) => NOISED_ID.test(id) && !users.has(id) && !attempted.has(id),
            );
            if (!missing.length) return;
            for (const id of missing) attempted.add(id);
            if (stopped()) {
                for (const id of missing) deferredOpaque.add(id);
                return;
            }
            let pending = missing;
            for (let attempt = 0; attempt <= SENDER_RETRY_DELAYS_MS.length && pending.length; attempt++) {
                if (attempt > 0) {
                    if (stopped()) break;
                    await sleep(SENDER_RETRY_DELAYS_MS[attempt - 1]);
                    if (stopped()) break;
                }
                try {
                    const resolved = await resolveUsers(api, pending, log, { signal });
                    for (const id of pending) {
                        const user = resolved.get(id);
                        // Never treat a missing mapping, or another opaque ID, as
                        // a canonical user. Keep unknown senders explicitly unknown.
                        if (user && /^[1-9][0-9]*$/.test(String(user.id))) {
                            users.set(id, { id: String(user.id), name: user.name || "" });
                            if (!user.name) deferredUids.add(String(user.id));
                        }
                    }
                } catch {
                    log(
                        "sender identity lookup failed" +
                            (attempt < SENDER_RETRY_DELAYS_MS.length ? ", trying again" : ""),
                    );
                }
                pending = pending.filter((id) => !users.has(id));
                if (stopped()) break;
            }
            if (!pending.length) return;
            if (limited || signal?.aborted) for (const id of pending) deferredOpaque.add(id);
            else log(`${pending.length} sender ID(s) stayed unresolved; they are preserved as they are`);
        },
        get(senderId) {
            const id = String(senderId || "");
            return users.get(id) || { id, name: "" };
        },
        /** What this restore could not look up because of a rate limit (or a cancel): for the fill-in. */
        deferred() {
            const named = new Set([...users.values()].filter((u) => u.name).map((u) => u.id));
            return {
                opaque: [...deferredOpaque],
                uids: limited || signal?.aborted ? [...deferredUids].filter((id) => !named.has(id)) : [],
            };
        },
    };
}
