/**
 * Names a restore did not look up because Zalo was limiting lookups (code 221), kept for the fill-in.
 *
 * A restore that meets the limit stops asking for the rest of its run (./senders.js): its rows keep the opaque
 * sender id, or the user id with no name. What it could not ask for is queued in
 * `<account dir>/sync/names-deferred.json` (0600): `{"opaque": [...], "uids": [...]}`, ids only. The fill-in runs at
 * the end of a restore and at the start of the next one, while lookups are not resting: an opaque id that now
 * resolves gives its rows the user id (and the name where they have none), a user id gives its nameless rows the
 * name. What still does not resolve stays queued; nothing is asked while the cool-down lasts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { resolveNonFriendDms } from "../../zalo/custom/gid.js";
import { lookupsCoolingDown, runPacedBatches } from "../../zalo/custom/user-info.js";
import { fillBlankSenderName, fillOpaqueSender } from "../db.js";

/** @param {string} accountDir */
export const deferredNamesPath = (accountDir) => join(accountDir, "sync", "names-deferred.json");

/**
 * What is queued.
 *
 * @param {string} accountDir
 * @returns {{opaque: string[], uids: string[]}}
 */
export function readDeferredNames(accountDir) {
    try {
        const s = JSON.parse(readFileSync(deferredNamesPath(accountDir), "utf8"));
        return {
            opaque: Array.isArray(s?.opaque) ? s.opaque.map(String) : [],
            uids: Array.isArray(s?.uids) ? s.uids.map(String) : [],
        };
    } catch {
        return { opaque: [], uids: [] };
    }
}

function writeDeferred(accountDir, { opaque, uids }) {
    const file = deferredNamesPath(accountDir);
    if (!opaque.length && !uids.length) {
        rmSync(file, { force: true });
        return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ opaque, uids }) + "\n", { mode: 0o600 });
}

/**
 * Add ids to the queue.
 *
 * @param {string} accountDir
 * @param {{opaque?: string[], uids?: string[]}} add
 * @returns {{opaque: number, uids: number}} what the queue holds now
 */
export function queueDeferredNames(accountDir, { opaque = [], uids = [] } = {}) {
    const cur = readDeferredNames(accountDir);
    const next = {
        opaque: [...new Set([...cur.opaque, ...opaque.map(String)])],
        uids: [...new Set([...cur.uids, ...uids.map(String)])],
    };
    if (next.opaque.length !== cur.opaque.length || next.uids.length !== cur.uids.length)
        writeDeferred(accountDir, next);
    return { opaque: next.opaque.length, uids: next.uids.length };
}

/**
 * Fill in the queued names, unless lookups are resting. Needs the account's database open.
 *
 * @param {object} api
 * @param {string} accountDir
 * @param {object} [o]
 * @param {(m: string) => void} [o.log]
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.resolveUsers] - opaque ids -> users (a test seam)
 * @param {(uids: string[]) => Promise<Map<string, string>>} [o.lookupNames] - user ids -> names (a test seam)
 * @returns {Promise<{skipped: boolean, filled: number, left: number}>}
 */
export async function fillDeferredNames(
    api,
    accountDir,
    { log = () => {}, signal, resolveUsers = resolveNonFriendDms, lookupNames = null } = {},
) {
    if (!existsSync(deferredNamesPath(accountDir))) return { skipped: false, filled: 0, left: 0 };
    const queued = readDeferredNames(accountDir);
    const left = queued.opaque.length + queued.uids.length;
    if (lookupsCoolingDown() || signal?.aborted) return { skipped: true, filled: 0, left };
    let filled = 0;
    const opaqueLeft = [];
    const uidsLeft = new Set(queued.uids);
    if (queued.opaque.length) {
        const users = await resolveUsers(api, queued.opaque, log, { signal });
        for (const id of queued.opaque) {
            const u = users.get(id);
            if (u && /^[1-9][0-9]*$/.test(String(u.id))) {
                filled += fillOpaqueSender(id, u.id, u.name || "");
                if (!u.name) uidsLeft.add(String(u.id));
            } else opaqueLeft.push(id);
        }
    }
    if (uidsLeft.size && !lookupsCoolingDown() && !signal?.aborted) {
        const names = lookupNames ? await lookupNames([...uidsLeft]) : await namesOf(api, [...uidsLeft], log, signal);
        for (const [uid, name] of names) {
            if (!name) continue;
            filled += fillBlankSenderName(uid, name);
            uidsLeft.delete(uid);
        }
    }
    writeDeferred(accountDir, { opaque: opaqueLeft, uids: [...uidsLeft] });
    const still = opaqueLeft.length + uidsLeft.size;
    log(`names filled in: ${filled} message row(s) updated; ${still} id(s) still queued`);
    return { skipped: false, filled, left: still };
}

async function namesOf(api, uids, log, signal) {
    const out = new Map();
    const r = await runPacedBatches(uids, {
        batchSize: 100,
        label: "getUserInfo",
        log,
        signal,
        call: (batch) => api.getUserInfo(batch),
    });
    for (const info of r.results) {
        for (const bag of [info?.changed_profiles, info?.unchanged_profiles]) {
            for (const [uid, p] of Object.entries(bag || {})) if (p) out.set(uid, p.zaloName || p.displayName || "");
        }
    }
    return out;
}
