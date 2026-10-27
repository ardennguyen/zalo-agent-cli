/**
 * Zalo's maintenance gate (plan item L3).
 *
 * While Zalo is in maintenance, every login and socket attempt fails, and a
 * retry ladder only adds load to a service that is down on purpose. The
 * official client asks one cheap question instead, `GET {maintenance host}/api/chk`,
 * and waits for the answer to change. This is that question and that wait.
 *
 * What the answer means, from the official client's own code (its maintenance
 * module, read in the 2026-10-23 Web bundle): `error_code` 0 is "no maintenance",
 * 70 is "in maintenance now" and 71 is "continue checking". The answer's `data`
 * may carry an announced window, `{startTime, endTime}` in milliseconds. A
 * running client that gets 70 restarts into its maintenance screen; one that gets
 * 71 keeps running and asks again; either way the next question comes after a
 * wait that depends on the window (see {@link pollDelayMs}). What 71 means on
 * Zalo's side (a notice before a window, or a degraded service) has never been
 * seen, because Zalo was not in maintenance in any capture; what is copied here
 * is what the client does with it, not why.
 *
 * The question is a plain GET with no session and no identity in it. The two
 * numbers it carries (`bkt`, `spt_mtn`) are the server's own disaster-recovery
 * settings, echoed back.
 */

/** Where the official client asks. */
export const MAINTENANCE_URL = "https://maint.chat.zalo.me";

/** How long to wait between questions, by where "now" is against the announced window. */
export const MAINTENANCE_POLL_MS = Object.freeze({
    /** Inside the announced window, which can run for hours. */
    inWindow: 3_600_000,
    /** No window, or past its end: Zalo should be back any minute. */
    afterWindow: 60_000,
});

/**
 * How long to wait before asking again: the official client's rule. Inside the window an hour, from its end (or
 * with no window) a minute. Before the window starts the official client waits 0 ms, which would ask in a loop;
 * this waits a minute instead.
 *
 * @param {{startTime?: number, endTime?: number}} [window] - milliseconds, 0 when none was announced
 * @param {number} [now] - milliseconds
 * @returns {number}
 */
export function pollDelayMs(window, now = Date.now()) {
    const start = Number(window?.startTime) || 0;
    const end = Number(window?.endTime) || 0;
    return now >= start && now < end ? MAINTENANCE_POLL_MS.inWindow : MAINTENANCE_POLL_MS.afterWindow;
}

/** The announced window of an answer's `data`, zeros when it holds none. */
function windowOf(data) {
    const startTime = Number(data?.startTime);
    const endTime = Number(data?.endTime);
    return { startTime: Number.isFinite(startTime) ? startTime : 0, endTime: Number.isFinite(endTime) ? endTime : 0 };
}

/**
 * The two numbers the question carries, as the session's login learned them: the disaster-recovery settings the
 * server sent (`features.dr_config`). The official client sends what it stored the same way; -1 and -1 is what a
 * client that has stored nothing sends, so a session without them asks exactly that.
 *
 * @param {object} [api] - a zca-js API from {@link loginWithSession}
 * @returns {{bkt?: number, sptMtn?: number}} empty when the session holds none
 */
export function maintenanceKeysOf(api) {
    let dr;
    try {
        dr = api?.getContext?.()?.settings?.features?.dr_config;
    } catch {
        return {};
    }
    const bkt = Number(dr?.bucketId);
    const sptMtn = Number(dr?.supportMaintenance);
    return Number.isFinite(bkt) && Number.isFinite(sptMtn) ? { bkt, sptMtn } : {};
}

/**
 * Ask once.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {string} [opts.base] - the maintenance host
 * @param {string|number} [opts.bkt] - the stored `bkt`, -1 when none is stored
 * @param {string|number} [opts.sptMtn] - the stored `sp_mtn`, -1 when none is stored
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{state: "ok"|"maintenance"|"notice"|"unreachable", code: number|null,
 *   window: {startTime: number, endTime: number}}>}
 *   `unreachable` is "could not ask or could not read the answer": it says nothing about maintenance.
 *   `window` is the announced window in milliseconds, zeros when the answer named none.
 */
export async function checkMaintenance({
    fetchFn = fetch,
    base = MAINTENANCE_URL,
    bkt = -1,
    sptMtn = -1,
    timeoutMs = 10_000,
} = {}) {
    const url = `${base}/api/chk?bkt=${encodeURIComponent(bkt)}&spt_mtn=${encodeURIComponent(sptMtn)}`;
    const none = windowOf();
    try {
        const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { state: "unreachable", code: null, window: none };
        const body = await res.json();
        const code = typeof body === "number" ? body : Number(body?.error_code);
        const window = windowOf(body?.data);
        if (code === 0) return { state: "ok", code, window };
        if (code === 70) return { state: "maintenance", code, window };
        if (code === 71) return { state: "notice", code, window };
        return { state: "unreachable", code: Number.isFinite(code) ? code : null, window: none };
    } catch {
        return { state: "unreachable", code: null, window: none };
    }
}

/**
 * Wait until Zalo is out of maintenance.
 *
 * Returns as soon as the answer is anything but "in maintenance now": "ok" (carry on), "notice"
 * (a window is announced, do not block on it) or "unreachable" (the question itself failed, which
 * is for the caller's ordinary retry to deal with). Stops early, returning `{state: "aborted"}`,
 * when the signal fires.
 *
 * @param {object} opts
 * @param {() => Promise<{state: string, code: number|null}>} opts.check - normally {@link checkMaintenance}
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} opts.sleep
 * @param {(state: string, code: number|null) => void} [opts.onPoll] - told each answer, for logs and health
 * @param {AbortSignal} [opts.signal]
 * @param {() => number} [opts.now] - milliseconds, for the window
 * @returns {Promise<{state: string, code: number|null, polls: number, window?: object}>}
 */
export async function waitOutMaintenance({ check, sleep, onPoll = () => {}, signal, now = Date.now }) {
    let polls = 0;
    for (;;) {
        if (signal?.aborted) return { state: "aborted", code: null, polls };
        const answer = await check();
        polls += 1;
        onPoll(answer.state, answer.code);
        if (answer.state !== "maintenance") return { ...answer, polls };
        await sleep(pollDelayMs(answer.window, now()), signal);
    }
}

/**
 * Keep asking after a 71, as the official client does ("continue checking"): the caller carries on, and this
 * asks again after each {@link pollDelayMs} wait until Zalo says it is fine (0, which ends the watch) or says it
 * is in maintenance now (70, which is handed to `onMaintenance` and ends the watch: the caller restarts into
 * its maintenance wait, as the official client restarts into its maintenance screen). 71 and an unanswered
 * question both mean "ask again". Resolves with why it ended.
 *
 * @param {object} opts
 * @param {() => Promise<{state: string, code: number|null, window?: object}>} opts.check
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} opts.sleep
 * @param {{startTime?: number, endTime?: number}} [opts.window] - what the answer that started the watch announced
 * @param {() => void} opts.onMaintenance - Zalo is in maintenance now
 * @param {(state: string, code: number|null) => void} [opts.onPoll]
 * @param {AbortSignal} [opts.signal]
 * @param {() => number} [opts.now]
 * @returns {Promise<"ok"|"maintenance"|"aborted">}
 */
export async function watchMaintenance({
    check,
    sleep,
    window,
    onMaintenance,
    onPoll = () => {},
    signal,
    now = Date.now,
}) {
    let announced = window;
    for (;;) {
        if (signal?.aborted) return "aborted";
        await sleep(pollDelayMs(announced, now()), signal);
        if (signal?.aborted) return "aborted";
        const answer = await check();
        onPoll(answer.state, answer.code);
        if (answer.state === "ok") return "ok";
        if (answer.state === "maintenance") {
            onMaintenance(answer);
            return "maintenance";
        }
        if (answer.state === "notice") announced = answer.window;
    }
}
