/**
 * When a user was last online: `friend last-online` and zalo_friend `last_online` (one function, one reply), and the
 * cache the listener keeps from Zalo's presence pushes.
 *
 * What Zalo Web does (bundle 2026-11-06, `getLastOnlStatus`):
 *
 * - When this account's own `show_online_status` is off, it shows no one's online status and asks nothing: the
 *   answer is 0 without a request. {@link lastOnlineStatus} does the same and reports `hiddenBy: "you"`, unless the
 *   caller asks anyway (`--ask-anyway`, `askAnyway`) to see what Zalo answers.
 * - It asks `lastOnline` with `conv_type` 2 for an Official Account (a profile whose `type` is 1 or more), 1 for any
 *   other user. Its own profile cache tells it which; this asks for the profile first, unless the caller says.
 * - The answer's `settings` carry the other user's own `show_online_status`; off is `hiddenBy: "them"`.
 * - The 602 push `act_type: "profile"`, `act: "online_status"` (`{uid, lastOnline}`) moves a user's last-online time.
 *   {@link attachLastOnline} keeps it, in memory and in the account's db (`last_online`), for `--cached` reads that
 *   send nothing. Only the daemon (`listen`, `mcp start`) writes that table.
 *
 * `friend online` (cmd 11290) is not used: Zalo Web's contact list asks it and discards the answer, and it answers 404.
 */
import { getLastOnline, upsertLastOnline } from "./db.js";
import { settingValue } from "./profile-settings.js";
import { onlineStatusOf } from "../zalo/listener/dispatch.js";

/** The action push that carries `online_status`. */
export const CMD_ACTIONS = 602;

/** In this process: userId -> {lastOnline, updatedAt, source}. */
const memory = new Map();

/**
 * Keep a user's last-online time in this process's memory, the newer of the two.
 *
 * @param {{userId: string, lastOnline: number, source?: string}} row
 * @returns {boolean} whether it changed
 */
export function rememberLastOnline({ userId, lastOnline, source = "listen" }) {
    const t = Number(lastOnline);
    if (!userId || !Number.isFinite(t) || t <= 0) return false;
    const cur = memory.get(String(userId));
    if (cur && cur.lastOnline >= t) return false;
    memory.set(String(userId), { lastOnline: t, updatedAt: Date.now(), source });
    return true;
}

/**
 * A user's last-online time from this process's memory, then the account's db; null when neither has it. Sends
 * nothing.
 *
 * @param {string} userId
 * @param {{read?: typeof getLastOnline}} [deps]
 * @returns {{lastOnline: number, updatedAt: number, source: string}|null}
 */
export function cachedLastOnline(userId, { read = getLastOnline } = {}) {
    const mem = memory.get(String(userId)) ?? null;
    let row = null;
    try {
        row = read(String(userId));
    } catch {
        // No db open in this process: memory is all there is.
    }
    const stored = row ? { lastOnline: Number(row.lastOnline), updatedAt: row.updatedAt, source: row.source } : null;
    if (mem && stored) return mem.lastOnline >= stored.lastOnline ? mem : stored;
    return mem ?? stored;
}

/** Forget this process's memory (tests). */
export function clearLastOnlineMemory() {
    memory.clear();
}

/**
 * Whether a profile is an Official Account, as Zalo Web's `isOAType` reads one: a user id with `type` 1 or more.
 *
 * @param {object|null|undefined} profile
 * @returns {boolean}
 */
export function isOAProfile(profile) {
    return Number(profile?.type) >= 1;
}

/** A profile out of `getUserInfo`'s answer, keyed by uid (with or without a `_<version>` suffix). */
function profileOf(res, userId) {
    for (const bucket of [res?.changed_profiles, res?.unchanged_profiles]) {
        if (!bucket || typeof bucket !== "object") continue;
        const hit = bucket[userId] ?? bucket[`${userId}_0`];
        if (hit) return hit;
    }
    return null;
}

/**
 * When a user was last online, as Zalo Web reads it. The reply is the same for the CLI and MCP:
 *
 *   {userId, lastOnline, hiddenBy, myShowOnlineStatus, asked, source, convType?, note?, data?}
 *
 * - `lastOnline`: epoch ms, or null when unknown or hidden.
 * - `hiddenBy`: "you" (this account's own online status is hidden, so Zalo Web shows no one's), "them" (the user
 *   hides theirs) or null.
 * - `myShowOnlineStatus`: this account's own setting (true, false, or null when it could not be read).
 * - `asked`: whether Zalo was asked; `source` "zalo", "cache" or null.
 *
 * @param {object} api - logged-in session
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.askAnyway] - ask even when this account's own status is hidden (diagnostics)
 * @param {boolean} [opts.cached] - answer from the listener's cache only; send nothing
 * @param {boolean} [opts.isOA] - the user is an Official Account (skips the profile lookup); false skips it too
 * @param {(row: object) => boolean} [opts.remember] - where a fresh answer is kept (this process's memory)
 * @returns {Promise<object>}
 */
export async function lastOnlineStatus(
    api,
    userId,
    { askAnyway = false, cached = false, isOA, remember = rememberLastOnline } = {},
) {
    const id = String(userId);
    if (cached) {
        const hit = cachedLastOnline(id);
        return {
            userId: id,
            lastOnline: hit?.lastOnline ?? null,
            hiddenBy: null,
            myShowOnlineStatus: null,
            asked: false,
            source: hit ? "cache" : null,
            ...(hit ? { cachedAt: hit.updatedAt ?? null } : {}),
            note: hit
                ? "From the listener's cache (Zalo's presence pushes); nothing was sent."
                : "Not in the cache: the listener (`listen` or `mcp start`) has heard no presence push for this user.",
        };
    }

    let mine = null;
    try {
        const v = settingValue((await api.getSettings())?.show_online_status);
        mine = v === null ? null : v === 1;
    } catch {
        // Unknown: ask, as if it were on.
    }
    if (mine === false && !askAnyway) {
        return {
            userId: id,
            lastOnline: null,
            hiddenBy: "you",
            myShowOnlineStatus: false,
            asked: false,
            source: null,
            note:
                "Your own online status is hidden (profile setting online-status 0), so Zalo Web shows no one's and " +
                "asks nothing; neither did this. Use --ask-anyway (askAnyway) to ask Zalo regardless.",
        };
    }

    let oa = isOA;
    if (oa === undefined) {
        try {
            oa = isOAProfile(profileOf(await api.getUserInfo(id), id));
        } catch {
            oa = false;
        }
    }
    const convType = oa ? 2 : 1;
    const data = (await api.lastOnline(id, convType)) ?? null;
    const theirs = settingValue(data?.settings?.show_online_status);
    const t = Number(data?.lastOnline);
    const lastOnline = Number.isFinite(t) && t > 0 ? t : null;
    if (lastOnline) {
        try {
            remember({ userId: id, lastOnline, source: "zalo" });
        } catch {
            /* the cache is best-effort */
        }
    }
    const hiddenBy = theirs === 0 ? "them" : mine === false && !lastOnline ? "you" : null;
    return {
        userId: id,
        lastOnline,
        hiddenBy,
        myShowOnlineStatus: mine,
        asked: true,
        source: "zalo",
        convType,
        data,
    };
}

/**
 * Keep the presence pushes (602 `profile` / `online_status`) in memory and in the account's db, and tell `onEvent`
 * each one as an `online_status` event. `listen` and `mcp start` both attach it (AGENTS.md §13); only `listen` prints
 * the events (`--events online`).
 *
 * @param {object} args
 * @param {{on: (cmd: number, fn: (frame: object) => void) => () => void}} args.tap - the daemon's socket tap
 * @param {(event: {event: "online_status", userId: string, lastOnline: number}) => void} [args.onEvent]
 * @param {(line: string) => void} [args.log]
 * @param {typeof upsertLastOnline} [args.store] - test seam
 * @returns {{stop: () => void}}
 */
export function attachLastOnline({
    tap,
    onEvent = () => {},
    log = (line) => console.error(line),
    store = upsertLastOnline,
}) {
    const say = (line) => {
        try {
            log(`last online: ${line}`);
        } catch {
            /* a broken logger must not break the socket */
        }
    };
    const off = tap.on(CMD_ACTIONS, (frame) => {
        const actions = Array.isArray(frame?.data?.actions) ? frame.data.actions : [];
        for (const action of actions) {
            let status = null;
            try {
                status = onlineStatusOf(action);
            } catch (e) {
                say(`one presence push not readable (${e?.name ?? "Error"})`);
                continue;
            }
            if (!status) continue;
            rememberLastOnline({ ...status, source: "listen" });
            try {
                store({ ...status, source: "listen" });
            } catch (e) {
                say(`could not store it: ${e?.message || e}`);
            }
            try {
                onEvent({ event: "online_status", ...status });
            } catch (e) {
                say(`an event handler failed: ${e?.message || e}`);
            }
        }
    });
    return { stop: off };
}
