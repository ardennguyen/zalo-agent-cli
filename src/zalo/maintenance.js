/**
 * Zalo's maintenance gate (plan item L3).
 *
 * While Zalo is in maintenance, every login and socket attempt fails, and a
 * retry ladder only adds load to a service that is down on purpose. The
 * official client asks one cheap question instead, `GET {maintenance host}/api/chk`,
 * and waits for the answer to change. This is that question and that wait.
 *
 * What the answer means, as far as it is known: `error_code` 0 is "no
 * maintenance", 70 is "in maintenance now", and 71 is accepted beside them. 71
 * is read as an announced window that has not started: it does not block, and
 * the poller looks again later. That reading of 71 is an inference, not an
 * observation, and is kept to this one place so it is easy to change.
 *
 * The question is a plain GET with no session and no identity in it. The two
 * numbers it carries (`bkt`, `spt_mtn`) are the server's own disaster-recovery
 * settings, echoed back.
 */

/** Where the official client asks. */
export const MAINTENANCE_URL = "https://maint.chat.zalo.me";

/** How long to wait between questions, by answer. */
export const MAINTENANCE_POLL_MS = Object.freeze({
    /** In maintenance now: ask again soon. */
    maintenance: 60_000,
    /** A window was announced: it can be an hour away. */
    notice: 3_600_000,
});

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
 * @returns {Promise<{state: "ok"|"maintenance"|"notice"|"unreachable", code: number|null}>}
 *   `unreachable` is "could not ask or could not read the answer": it says nothing about maintenance
 */
export async function checkMaintenance({
    fetchFn = fetch,
    base = MAINTENANCE_URL,
    bkt = -1,
    sptMtn = -1,
    timeoutMs = 10_000,
} = {}) {
    const url = `${base}/api/chk?bkt=${encodeURIComponent(bkt)}&spt_mtn=${encodeURIComponent(sptMtn)}`;
    try {
        const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { state: "unreachable", code: null };
        const body = await res.json();
        const code = typeof body === "number" ? body : Number(body?.error_code);
        if (code === 0) return { state: "ok", code };
        if (code === 70) return { state: "maintenance", code };
        if (code === 71) return { state: "notice", code };
        return { state: "unreachable", code: Number.isFinite(code) ? code : null };
    } catch {
        return { state: "unreachable", code: null };
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
 * @returns {Promise<{state: string, code: number|null, polls: number}>}
 */
export async function waitOutMaintenance({ check, sleep, onPoll = () => {}, signal }) {
    let polls = 0;
    for (;;) {
        if (signal?.aborted) return { state: "aborted", code: null, polls };
        const answer = await check();
        polls += 1;
        onPoll(answer.state, answer.code);
        if (answer.state !== "maintenance") return { ...answer, polls };
        await sleep(MAINTENANCE_POLL_MS.maintenance, signal);
    }
}
