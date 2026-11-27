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
 * **Storing never waits for a lookup.** `note(messages)` queues the senders it does not know and returns at once;
 * the lookups run in the background, one round after another, and each sender that resolves is handed to
 * `onResolved(opaqueId, {id, name})`, which fills in the rows already stored with the opaque id. Rows stored after
 * that read the resolved identity from `get()`. `settle()` waits for the queue to drain; `prepare(messages)` is
 * `note` then `settle` (the old, blocking shape).
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
 * @param {(opaqueId: string, user: {id: string, name: string}) => void} [options.onResolved] - a sender resolved
 *   in the background: fill in what was already stored under its opaque id
 * @returns {{note: Function, settle: () => Promise<void>, prepare: Function, refresh: Function, get: Function,
 *   deferred: () => {opaque: string[], uids: string[]}}}
 */
export function createSenderResolver(
    api,
    threadMap,
    {
        resolveUsers = resolveNonFriendDms,
        log = () => {},
        sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
        signal,
        onResolved = () => {},
    } = {},
) {
    const users = new Map();
    const attempted = new Set();
    const deferredOpaque = new Set();
    const deferredUids = new Set();
    /** Senders noted and not yet looked up. */
    const queue = new Set();
    /** The background lookups while they run. */
    let running = null;
    /** Set once a lookup of this restore met Zalo's limit: no more lookups in it. */
    let limited = false;
    const stopped = () => limited || signal?.aborted === true || (lookupsCoolingDown() && (limited = true));

    /** Conversation resolution may have added non-friend users since this resolver was built. */
    const refresh = () => {
        for (const [gid, user] of threadMap) {
            if (user.type === "dm")
                users.set(gid, {
                    id: String(user.id),
                    name: user.snapshotName ?? user.zaloName ?? user.name ?? "",
                });
        }
    };
    refresh();

    /** One lookup round for `missing`, with its two retries (Y9). */
    const lookup = async (missing) => {
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
                        const found = { id: String(user.id), name: user.name || "" };
                        users.set(id, found);
                        if (!user.name) deferredUids.add(found.id);
                        try {
                            onResolved(id, found);
                        } catch (e) {
                            log(`could not fill in a resolved sender: ${e?.message || e}`);
                        }
                    }
                }
            } catch {
                log(
                    "sender identity lookup failed" + (attempt < SENDER_RETRY_DELAYS_MS.length ? ", trying again" : ""),
                );
            }
            pending = pending.filter((id) => !users.has(id));
            if (stopped()) break;
        }
        if (!pending.length) return;
        if (limited || signal?.aborted) for (const id of pending) deferredOpaque.add(id);
        else log(`${pending.length} sender ID(s) stayed unresolved; they are preserved as they are`);
    };

    const drain = async () => {
        try {
            while (queue.size) {
                const missing = [...queue];
                queue.clear();
                await lookup(missing);
            }
        } finally {
            running = null;
        }
    };

    const resolver = {
        /** Queue the unknown senders of these messages for the background lookups; returns at once. */
        note(messages) {
            refresh();
            for (const m of messages) {
                const id = String(m.senderId || "");
                if (!NOISED_ID.test(id) || users.has(id) || attempted.has(id)) continue;
                attempted.add(id);
                queue.add(id);
            }
            if (queue.size && !running) running = drain();
        },
        /** Wait until every sender noted so far has been looked up (or deferred). */
        async settle() {
            while (running) await running;
        },
        /** `note`, then `settle`: the senders of these messages are looked up before it returns. */
        async prepare(messages) {
            resolver.note(messages);
            await resolver.settle();
        },
        refresh,
        get(senderId) {
            const id = String(senderId || "");
            return users.get(id) || { id, name: "" };
        },
        /** What this restore could not look up because of a rate limit (or a cancel): for the fill-in. */
        deferred() {
            const named = new Set([...users.values()].filter((u) => u.name).map((u) => u.id));
            return {
                opaque: [...deferredOpaque, ...queue],
                uids: limited || signal?.aborted ? [...deferredUids].filter((id) => !named.has(id)) : [],
            };
        },
    };
    return resolver;
}
