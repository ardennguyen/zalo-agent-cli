/**
 * Profile refresh for non-friend DM peers, paced the way Zalo expects.
 *
 * `getprofiles/v2` is asked for up to 500 uids per request, one request after another. When the server answers
 * 221 ("too many requests") the client parks the uids of that request for an hour, or until the server's `nextTs` (+100
 * ms) when the reply carries one, and does not ask for them again until then. There is no cap per session: every peer
 * is asked for, in as many requests as it takes.
 *
 * This module does the same for a restore: every uid in requests of 500, sequential, and on a 221 it stops for this
 * run, parks the uids of the refused request in a small state file next to the account's sync state, and says how
 * many were left. A later run skips parked uids until their time is up and asks for the rest.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeLookupError, isRateLimitError } from "../zalo/custom/user-info.js";

/** Uids per `getprofiles/v2` request. */
export const PROFILE_CHUNK_SIZE = 500;
/** How long a refused request's uids stay parked when the reply names no `nextTs`. */
export const PARK_MS = 60 * 60 * 1000;
/** Added to the server's `nextTs`. */
const NEXT_TS_SLACK_MS = 100;
/** Pause between two requests of one refresh. */
const GAP_MS = 300;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the parked uids still in force: uid -> epoch ms until which it is not asked for.
 *
 * @param {string|null} file
 * @param {number} now
 * @returns {Map<string, number>}
 */
export function readParked(file, now = Date.now()) {
    const out = new Map();
    if (!file || !existsSync(file)) return out;
    try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        for (const [uid, until] of Object.entries(data?.parked || {})) {
            if (Number(until) > now) out.set(uid, Number(until));
        }
    } catch {
        /* a damaged file parks nothing */
    }
    return out;
}

function writeParked(file, parked) {
    if (!file) return;
    try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ parked: Object.fromEntries(parked) }), { mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        /* parking is best effort: without it the next run simply asks again */
    }
}

/**
 * When a refused request's uids may be asked for again.
 *
 * @param {unknown} e - the 221 error; `e.data.nextTs` (epoch ms) when the server named a time
 * @param {number} now
 * @returns {number}
 */
export function parkUntil(e, now = Date.now()) {
    const next = Number(e?.data?.nextTs ?? e?.nextTs);
    if (Number.isFinite(next) && next > now) return next + NEXT_TS_SLACK_MS;
    return now + PARK_MS;
}

/**
 * Fetch the current profiles of `uids`, every one of them, in requests of {@link PROFILE_CHUNK_SIZE}.
 *
 * @param {object} api - needs `getUserInfo(uids)`
 * @param {string[]} uids
 * @param {object} [opts]
 * @param {string|null} [opts.stateFile] - where parked uids are kept between runs
 * @param {(message: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.gapMs]
 * @returns {Promise<{profiles: Map<string, object>, requests: number, asked: number, parkedSkipped: number,
 *   left: number, stoppedBy: null|"rate-limit"|"error", parkedUntil: number|null, error: string|null}>}
 */
export async function refreshProfiles(api, uids, opts = {}) {
    const { stateFile = null, log = () => {}, now = Date.now, sleep = realSleep, gapMs = GAP_MS } = opts;
    const parked = readParked(stateFile, now());
    const ids = [...new Set(uids.map(String))];
    const todo = ids.filter((id) => !parked.has(id));
    const out = {
        profiles: new Map(),
        requests: 0,
        asked: 0,
        parkedSkipped: ids.length - todo.length,
        left: 0,
        stoppedBy: null,
        parkedUntil: null,
        error: null,
    };
    for (let i = 0; i < todo.length; i += PROFILE_CHUNK_SIZE) {
        const chunk = todo.slice(i, i + PROFILE_CHUNK_SIZE);
        if (i > 0 && gapMs > 0) await sleep(gapMs);
        out.requests++;
        try {
            const reply = await api.getUserInfo(chunk);
            out.asked += chunk.length;
            for (const bag of [reply?.changed_profiles, reply?.unchanged_profiles]) {
                for (const [uid, profile] of Object.entries(bag || {})) if (profile) out.profiles.set(uid, profile);
            }
        } catch (e) {
            out.error = describeLookupError(e);
            out.left = todo.length - i;
            if (Number(e?.code) === 221 || isRateLimitError(e)) {
                out.stoppedBy = "rate-limit";
                out.parkedUntil = parkUntil(e, now());
                for (const id of chunk) parked.set(id, out.parkedUntil);
                log(
                    `profile refresh: Zalo is limiting lookups (${out.error}); stopped with ${out.left} peer(s) left, ` +
                        `${chunk.length} parked until ${new Date(out.parkedUntil).toISOString()}`,
                );
            } else {
                out.stoppedBy = "error";
                log(`profile refresh: request failed (${out.error}); stopped with ${out.left} peer(s) left`);
            }
            break;
        }
    }
    // Rewritten every run: expired entries drop out, a new refusal is added.
    if (stateFile && (out.stoppedBy === "rate-limit" || existsSync(stateFile))) writeParked(stateFile, parked);
    return out;
}
