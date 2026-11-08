/**
 * The local side of `logout` and `account remove`: the saved login tried again, the chat history wiped, the
 * trusted-device identity described, and the result told to a person.
 *
 * The server side -- Zalo Web's logout calls, the official six-step device sign-out, the session-key probe -- is the
 * protocol layer's: src/zalo/logout.js (and src/zalo/official-logout.js), whose header has the history.
 */
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { getAccountDir, deleteCredentials } from "./credentials.js";
import { checkLock } from "./lock.js";
import { isLoginRefused, serverLogout as zaloServerLogout } from "../zalo/logout.js";
import { TRUST_FILE } from "../zalo/trust-store.js";

/**
 * Try the saved login once, in a new login of its own.
 *
 * @param {{creds: object, proxy?: string|null, ownId?: string|null}} saved
 * @returns {Promise<"revoked"|"still-valid"|"unverified">} revoked: Zalo refused the saved login; still-valid: it
 *   logged in; unverified: the attempt failed for another reason (no network, a timeout), which proves nothing
 */
async function probeSavedLogin(saved) {
    try {
        const { probeSavedLogin: login } = await import("./zalo-client.js");
        await login(saved.creds, saved.proxy ?? null, { ownId: saved.ownId ?? null });
        return "still-valid";
    } catch (e) {
        return isLoginRefused(e) ? "revoked" : "unverified";
    }
}

/**
 * Sign this device out at Zalo, the way the official client does: `serverLogout` of src/zalo/logout.js, with the
 * saved login tried in a new login of this CLI's own making.
 *
 * @param {object} api - a logged-in session API
 * @param {object} [opts]
 * @param {boolean} [opts.keepSession] - only end this session's key (the pre-v3.0 behavior)
 * @param {{creds: object, proxy?: string|null, ownId?: string|null}|null} [opts.savedLogin] - the saved login to
 *   test afterwards; without it the result says the device sign-out could not be verified
 * @param {(saved: object) => Promise<"revoked"|"still-valid"|"unverified">} [opts.probeLogin] - replaces the
 *   default login attempt (tests)
 * @returns {Promise<object>} see src/zalo/logout.js
 */
export async function serverLogout(api, { keepSession = false, savedLogin = null, probeLogin = probeSavedLogin } = {}) {
    return zaloServerLogout(api, { keepSession, savedLogin, probeLogin });
}

/** The words for a reply with no body — what the probe got after every successful logout. */
const EMPTY_REPLY = /Failed to parse response data/;

/**
 * Delete the local chat cache (zalo.db + WAL/SHM sidecars) and downloaded media
 * for one account. Mirrors Zalo Web's "Xóa lịch sử trò chuyện khi đăng xuất"
 * checkbox — a purely local operation there too (a z_cleardata localStorage
 * flag consumed by the web's own deleteAllData(), no server call), so no
 * network round trip here either.
 *
 * @param {string} ownId
 * @returns {{dbDeleted: boolean, mediaDeleted: boolean}}
 */
export function deleteLocalHistory(ownId) {
    const accountDir = getAccountDir(ownId);
    let dbDeleted = false;
    let mediaDeleted = false;
    if (existsSync(accountDir)) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const p = join(accountDir, `zalo.db${suffix}`);
            if (existsSync(p)) {
                rmSync(p, { force: true });
                dbDeleted = true;
            }
        }
        const mediaDir = join(accountDir, "media");
        if (existsSync(mediaDir)) {
            rmSync(mediaDir, { recursive: true, force: true });
            mediaDeleted = true;
        }
    }
    return { dbDeleted, mediaDeleted };
}

/**
 * What a person should know about this client's companion-device identity when an account is signed out or removed
 * here (decision D19, 2026-10-28). The official QR login makes this CLI a trusted companion device of the account;
 * the identity that proves it lives in `accounts/<ownId>/trusted-device.json`.
 *
 * - `logout` (also `--delete-history`) keeps it, with the account's other data. Measured 2026-11-09: the next QR
 *   login still adds a NEW entry to the phone's device list and logs the older entry out, but it keeps the device id,
 *   so Zalo's offline queue for this device carries over.
 * - `logout --purge` and `account remove` delete it with the account's folder. Zalo still lists the entry on the phone
 *   until it is removed there (Settings, linked devices; `account devices` shows it), and a later QR login adds a
 *   new one.
 *
 * Null when this machine holds no such identity (a login by the old flow, or none made yet).
 *
 * @param {string} ownId
 * @param {"kept"|"deleted"} what - whether the caller's route keeps the identity or deletes it
 * @returns {string|null}
 */
export function describeTrustedDevice(ownId, what) {
    if (!existsSync(join(getAccountDir(ownId), TRUST_FILE))) return null;
    return what === "kept"
        ? "This CLI keeps its companion-device identity: the next QR login adds a new entry to the phone's device list and logs the older one out, but keeps the device id, so messages Zalo queued for this device while it was away are still delivered. `logout --purge` deletes it."
        : "This CLI's companion-device identity was deleted. Zalo still lists it as a linked device until you remove it on your phone (`account devices` shows the list); a later QR login adds a new entry.";
}

/**
 * The PID of the `listen`/`mcp` daemon holding this account's `daemon.lock`, or
 * null. `logout` checks this before anything else: with a daemon up, the server
 * logout would end the session that daemon is using, and deleting the
 * credentials would leave it unable to re-auth.
 *
 * @param {string} ownId
 * @returns {number|null}
 */
export function lockHolder(ownId) {
    const lock = checkLock(getAccountDir(ownId));
    return lock.locked ? lock.pid : null;
}

/**
 * Whether `logout` needs a live session at all — decided before the entry
 * point's auto-login. It does not with `--no-remote` (no server call), nor
 * while a daemon holds the account (logout then refuses, changing nothing).
 * Measured 2026-09-30: both used to log in first, contacting Zalo for nothing.
 *
 * @param {{remote?: boolean}} opts - the `logout` Commander options
 * @param {{ownId: string}|null} active - the active account, if any
 * @returns {boolean}
 */
export function logoutNeedsSession(opts, active) {
    if (opts?.remote === false) return false;
    if (active?.ownId && lockHolder(active.ownId) !== null) return false;
    return true;
}

/**
 * Finish a real (non-purge) logout on this machine: delete the saved
 * credentials so nothing auto-logs-in, keeping the chat cache unless
 * `deleteHistory` is set. This is what makes `logout` a logout rather than a
 * pause — without it the next command logs straight back in from the saved
 * cookie (measured 2026-09-30).
 *
 * Guarded by the account's `daemon.lock`, the same way `removeAccount` guards
 * the credential delete: pulling credentials out from under a running
 * `listen`/`mcp` daemon would leave it unable to re-auth after a drop. When a
 * daemon holds the lock nothing is deleted and `blockedPid` names it.
 *
 * @param {string} ownId
 * @param {{deleteHistory?: boolean}} [opts]
 * @returns {{blockedPid: number} | {credentialsDeleted: boolean, history: {dbDeleted: boolean, mediaDeleted: boolean}}}
 */
export function finishLocalLogout(ownId, { deleteHistory = false } = {}) {
    const holder = lockHolder(ownId);
    if (holder !== null) return { blockedPid: holder };

    const history = deleteHistory ? deleteLocalHistory(ownId) : { dbDeleted: false, mediaDeleted: false };
    const credentialsDeleted = deleteCredentials(ownId);
    return { credentialsDeleted, history };
}

/**
 * What to tell the user about a serverLogout result, one line per fact.
 *
 * "Ended" is printed only for a verified end. A session that still answers is a
 * warning, never a success line — printing success unconditionally is exactly
 * how the staging-only logout passed for correct.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @returns {{level: "success"|"warning"|"info", text: string}[]}
 */
export function describeLogout(r) {
    if (r.mode === "official") return describeOfficialLogout(r);
    const lines = [];
    if (!r.production.ok) {
        lines.push({ level: "warning", text: `Zalo's logout call failed: ${r.production.error}` });
        if (!r.v2.ok) lines.push({ level: "info", text: `The secondary logoutV2 call failed too: ${r.v2.error}` });
    }
    if (r.verdict === "ended") {
        lines.push({
            level: "success",
            text: "Zalo ended this session's key — the next call on it was rejected.",
        });
    } else if (r.verdict === "still-answers") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout, but this session still answers — it may still be valid at Zalo.",
        });
    } else if (r.production.ok && EMPTY_REPLY.test(String(r.probeError))) {
        // Not proof (an empty reply can have other causes), so not a success
        // line; but it is what every successful logout produced in testing.
        lines.push({
            level: "info",
            text: "Zalo accepted the logout, and the next call on this session came back empty, as it did after every successful logout in testing: this session's key is most likely gone.",
        });
    } else {
        lines.push({ level: "info", text: `Logout sent; could not confirm the session key died: ${r.probeError}` });
    }
    return lines;
}

/**
 * The lines for an official logout: what failed, then what was found out. "Signed out" is a success line only
 * for a saved login that Zalo then refused.
 *
 * @param {{steps: Array<{id: string, ok: boolean, error?: string}>, key: {verdict: string, probeError?: string},
 *   login: "revoked"|"still-valid"|"unverified"}} r
 * @returns {{level: "success"|"warning"|"info", text: string}[]}
 */
function describeOfficialLogout(r) {
    const lines = [];
    for (const s of r.steps.filter((x) => !x.ok)) {
        lines.push({ level: "warning", text: `Logout step "${s.id}" failed: ${s.error ?? "no answer"}` });
    }
    if (r.login === "revoked") {
        lines.push({
            level: "success",
            text: "Signed this device out at Zalo — a new login with the saved session was refused.",
        });
    } else if (r.login === "still-valid") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout calls, but the saved login still works — this device may still be signed in. Remove it from your phone's list of logged-in devices.",
        });
    } else if (r.key.verdict === "ended") {
        lines.push({
            level: "info",
            text: "Zalo ended this session's key — the next call on it was rejected. Whether the saved login was refused could not be checked.",
        });
    } else if (r.key.verdict === "still-answers") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout calls, but this session still answers — it may still be valid at Zalo.",
        });
    } else {
        lines.push({
            level: "info",
            text: `Logout sent; could not confirm that Zalo signed this device out${r.key.probeError ? `: ${r.key.probeError}` : ""}.`,
        });
    }
    return lines;
}

/**
 * Print a serverLogout result through the caller's output helpers.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @param {{success: Function, warning: Function, info: Function}} out - src/utils/output.js helpers
 */
export function reportLogout(r, out) {
    for (const { level, text } of describeLogout(r)) out[level](text);
}
