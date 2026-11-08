/**
 * When this client's device id (imei) for an account came into use, and what that means for coverage.
 *
 * Zalo keeps the offline queue per device: a new device's queue starts at its login, and a cursor from an earlier
 * device is answered with what the new queue holds (often nothing), `more: 0`, with no `evict`. Zalo Web never meets
 * this because it keeps one imei per browser for good; a first login on a browser is a missing range `[0, now]`
 * (reason `first_login`) that only the phone-backed restore fills. So a catch-up from the queue can never cover
 * anything from before the device's login (agent research: offline-queue retention §4, §5).
 *
 * Two signals, the later one wins (a later floor claims less, never more):
 *  - `deviceSince`, stamped in the saved credentials whenever the imei changes (./credentials.js). A login saved before
 *    stamps existed uses its file's last write time, which is never earlier than the imei's first use.
 *  - `first_time_login_device` from the server settings the login fetched, when Zalo sends it (Web reads it at login,
 *    `checkFirstLogin`). Its unit is not documented: a value below 10^12 is read as seconds.
 *
 * Nothing here writes or sends anything.
 */
import { readSavedDevice } from "./credentials.js";

/** Earliest plausible time for a server-sent login time (2012-01-01): anything earlier is not one. */
const EARLIEST = Date.UTC(2012, 0, 1);

/**
 * `first_time_login_device` from a session's server settings, as ms, or null when absent or implausible.
 *
 * @param {object|null|undefined} api
 * @param {number} [now]
 * @returns {number|null}
 */
export function firstLoginDeviceOf(api, now = Date.now()) {
    let ctx;
    try {
        ctx = api?.getContext?.() ?? null;
    } catch {
        return null;
    }
    const settings = ctx?.settings ?? null;
    const raw =
        settings?.common?.first_time_login_device ??
        settings?.features?.common?.first_time_login_device ??
        ctx?.loginInfo?.first_time_login_device ??
        null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    // A little slack for clock skew; a value far in the future is not a login time.
    if (ms < EARLIEST || ms > now + 24 * 3600 * 1000) return null;
    return Math.min(ms, now);
}

/**
 * Since when this account's current device id is in use here: the floor below which no offline-queue drain can count
 * as coverage. When neither signal is known (the saved login cannot be read), `now`: nothing is claimed.
 *
 * @param {string} ownId
 * @param {object|null} [api] - the daemon's current session, for the server's own value
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {(ownId: string) => object} [opts.read] - readSavedDevice, replaceable in tests
 * @returns {{ts: number, source: "credentials"|"credentials-file"|"server"|"unknown"}}
 */
export function deviceSinceOf(ownId, api = null, { now = Date.now(), read = readSavedDevice } = {}) {
    let local = null;
    let source = "unknown";
    const saved = ownId ? read(String(ownId)) : { state: "none" };
    if (saved?.state === "ok") {
        if (Number.isFinite(saved.deviceSince)) {
            local = saved.deviceSince;
            source = "credentials";
        } else if (Number.isFinite(saved.mtime)) {
            local = saved.mtime;
            source = "credentials-file";
        }
    }
    const server = firstLoginDeviceOf(api, now);
    if (local === null && server === null) return { ts: now, source: "unknown" };
    if (server !== null && (local === null || server > local)) return { ts: server, source: "server" };
    return { ts: Math.min(local, now), source };
}

/**
 * What a login did to this account's device id, compared with what was saved before it.
 *
 * @param {{state: string, imei?: string|null}} before - readSavedDevice() taken BEFORE the new login was saved
 * @param {string|null|undefined} imei - the new login's imei
 * @returns {{newDevice: boolean, reason: "same-device"|"first-login"|"unreadable"|"no-device-id"|"device-changed"}}
 */
export function loginDeviceChange(before, imei) {
    if (before?.state === "ok" && before.imei && imei && before.imei === imei) {
        return { newDevice: false, reason: "same-device" };
    }
    if (!before || before.state === "none") return { newDevice: true, reason: "first-login" };
    if (before.state === "unreadable") return { newDevice: true, reason: "unreadable" };
    if (!before.imei) return { newDevice: true, reason: "no-device-id" };
    return { newDevice: true, reason: "device-changed" };
}

/**
 * One line for the login output about the device id.
 *
 * @param {{newDevice: boolean, reason: string}} change - loginDeviceChange()
 * @param {number} loginAt - ms
 * @returns {string}
 */
export function describeLoginDevice(change, loginAt) {
    if (!change.newDevice) {
        return (
            "Device: the same device id as this account's last login here, as Zalo Web keeps one per browser, so " +
            "Zalo's offline queue for it is expected to carry over to the next listen/mcp start."
        );
    }
    const why = {
        "first-login": "no saved login for this account here: a first login, or one after `logout`",
        unreadable: "the saved login could not be read",
        "no-device-id": "the saved login had no device id",
        "device-changed": "the saved login had another device id",
    }[change.reason];
    return (
        `Device: a new device id for this account (${why}). Zalo keeps its offline queue per device, so nothing ` +
        `from before this login (${new Date(loginAt).toISOString()}) can come from it; only the phone-backed ` +
        "restore (`zalo-agent sync`) brings that history in."
    );
}
