/**
 * The zCloud queue, kept current from the daemon: what Zalo Web does when the server sends it cmd 621.
 *
 * cmd 621 (`mycloudMedia`) is the server saying "your copy of the cloud queue may be stale, go and verify". It arrives
 * after login as plain JSON in the frame's `data.data`:
 *
 *   {"mycloudMedia": {"pageSize": 300, "lastNoiseId": "<24 characters>", "forceVerify": 0,
 *                     "onboardingCompleted": 0, "auditLocalCloudQueue": 0, "correctCloudKey": 0}}
 *
 * Zalo Web answers it by walking the queue from its saved place, at most once in 30 minutes. This does the same, with
 * the rules that keep a daemon from doing anything its owner would not expect:
 *
 * - **Only after a person has walked it once.** A first walk reads the whole queue (megabytes of JSON for an old
 *   account) and is `zalo-agent sync-cloud`'s job, run on purpose. With no saved place, a notice is logged and left.
 * - **Only when there is something new.** The notice carries the server's newest noise id; when it equals the saved
 *   place the index is current and nothing is requested.
 * - **At most once in 30 minutes**, counted from the last walk this daemon started.
 * - **Never beside another stage.** It takes the daemon's stage lock (`tryAcquire`, never waits): a notice that meets
 *   a running sync or history fetch is dropped, and the next one (or a `sync-cloud`) catches up.
 * - **Never an acknowledgment.** The onboarding ack the web client sends after its first verify changes what Zalo
 *   does with this account's cloud; it is not ours to send.
 * - **`forceVerify` and `forceReset` walk the whole queue from the top**, as the Web does (`verifyFromNothing`): past
 *   the 30-minute pace and the "already current" check, which the Web skips for them too, as a `--full` walk, so that
 *   once the server says it is done every item no page listed is swept (an interrupted walk sweeps nothing). Where the
 *   Web empties its store first, this keeps it until the walk has finished. A walk, forced or not, has no page cap
 *   (it reads until the server is done or its cursor stops moving); forced walks are paced at one in 30 minutes, a guard the Web has
 *   not. Still no baseline means still no walk, and the Web's report afterwards (`submit_verify_action`) is not sent.
 * - **`correctCloudKey` and `auditLocalCloudQueue` are read and left.** The first makes the Web fetch the account's
 *   cloud key again, which this client never holds (D8); the second audits its local media against the store and
 *   reports to the server. Each is named in the log.
 *
 * `listen` and `mcp start` both build one (AGENTS.md §13: any asymmetry between them is a defect).
 */
import { getSyncState, setSyncState } from "./db.js";
import { syncCloudIndex } from "./sync-v2/zcloud.js";

/** The server's "verify your cloud queue" push. */
export const CMD_MYCLOUD = 621;

/** The web client acts on this event at most once per 30 minutes. */
export const THROTTLE_MS = 30 * 60 * 1000;

// No page cap: a walk, automatic or forced, reads until the server says it is done or its cursor stops moving
// (src/core/sync-v2/zcloud.js). What bounds the work is the 30-minute pace above, as on the Web.

/**
 * Read a cmd 621 frame.
 *
 * @param {{data?: object|null}} frame - a frame from the socket tap
 * @returns {{lastNoiseId: string|null, pageSize: number|null, forced: boolean, left: string[]}|null} null for
 *   anything that is not a `mycloudMedia` notice. `forced`: `forceVerify` or `forceReset` is set (walk from the top);
 *   `left`: the other flags that are set, which this client does not act on
 */
export function readCloudNotice(frame) {
    let payload = frame?.data?.data;
    if (typeof payload === "string") {
        try {
            payload = JSON.parse(payload);
        } catch {
            return null;
        }
    }
    const n = payload?.mycloudMedia;
    if (!n || typeof n !== "object") return null;
    return {
        lastNoiseId: typeof n.lastNoiseId === "string" && n.lastNoiseId ? n.lastNoiseId : null,
        pageSize: Number.isFinite(Number(n.pageSize)) ? Number(n.pageSize) : null,
        forced: Boolean(Number(n.forceVerify) || Number(n.forceReset)),
        left: ["correctCloudKey", "auditLocalCloudQueue"].filter((k) => Number(n[k])),
    };
}

/**
 * Answer cmd 621 notices with a bounded, read-only walk of the cloud queue.
 *
 * @param {object} args
 * @param {ReturnType<import("../zalo/listener/socket-tap.js").createSocketTap>} args.tap
 * @param {() => object} args.getApi - the logged-in api, or throws
 * @param {ReturnType<import("./daemon-channel.js").createStageLock>} args.lock
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {number} [args.throttleMs]
 * @param {typeof syncCloudIndex} [args.walk] - injected walker (tests)
 * @returns {{stop: () => void, handle: (frame: object) => Promise<string>}} `handle` is what the tap calls; it
 *   resolves to what it did (`"walked"`, or why not), for tests
 */
export function createCloudVerifier({
    tap,
    getApi,
    lock,
    log = (line) => console.error(line),
    now = Date.now,
    throttleMs = THROTTLE_MS,
    walk = syncCloudIndex,
}) {
    const say = (line) => {
        try {
            log(`cloud verify: ${line}`);
        } catch {
            /* a broken logger must not break the socket */
        }
    };
    let lastStartedAt = null;
    let lastForcedAt = null;
    let running = false;
    let toldNoBaseline = false;

    async function handle(frame) {
        const notice = readCloudNotice(frame);
        if (!notice) return "ignored";
        if (running) return "busy";
        const saved = getSyncState("cloudCursor");
        if (!saved) {
            if (!toldNoBaseline)
                say("the cloud queue was never walked here; run `zalo-agent sync-cloud` once to start it");
            toldNoBaseline = true;
            return "no-baseline";
        }
        for (const k of notice.left) {
            say(
                k === "correctCloudKey"
                    ? "the server asked to correct the cloud key; skipped (this client never holds that key)"
                    : "the server asked for an audit of the local cloud queue; skipped (a report this client does not send)",
            );
        }
        const forced = notice.forced;
        if (forced) {
            if (lastForcedAt !== null && now() - lastForcedAt < throttleMs) return "throttled";
        } else {
            if (notice.lastNoiseId && notice.lastNoiseId === saved) return "current";
            if (lastStartedAt !== null && now() - lastStartedAt < throttleMs) return "throttled";
        }
        const release = lock.tryAcquire("cloud-verify");
        if (!release) return "stage-running";

        running = true;
        lastStartedAt = now();
        if (forced) lastForcedAt = lastStartedAt;
        try {
            const api = getApi();
            const stats = await walk({
                api,
                lastNoiseId: forced ? "" : saved,
                full: forced,
                onPage: (p) => setSyncState("cloudCursor", p.cursor),
            });
            if (stats.failed && !stats.items && !stats.removed) {
                say(`could not read the cloud queue: ${stats.failures[0]?.reason || "no reason given"}`);
                return "failed";
            }
            if (forced) {
                say(
                    `forced verify (the server asked): ${stats.items} item(s) recorded, ${stats.removed} removed over ` +
                        `${stats.pages} page(s) from the top` +
                        (stats.complete
                            ? `, ${stats.swept || 0} no page listed swept`
                            : "; stopped before the end, so nothing was swept (`zalo-agent sync-cloud --full` finishes it)"),
                );
                return "walked";
            }
            say(
                `${stats.items} item(s) recorded, ${stats.removed} removed over ${stats.pages} page(s)` +
                    (stats.complete ? "" : "; more remains, the next notice continues"),
            );
            return "walked";
        } catch (e) {
            say(`failed: ${e?.message || e}`);
            return "failed";
        } finally {
            running = false;
            release();
        }
    }

    // Every notice leaves one line saying what was done with it; `walked` and `failed` already said so themselves.
    const WHY = {
        current: "the index is already at the server's newest id: nothing to do",
        throttled: "skipped: walked less than 30 minutes ago",
        "stage-running": "skipped: another stage is running; the next notice walks it",
        busy: "skipped: a walk is already running",
    };
    const off = tap.on(CMD_MYCLOUD, (frame) => {
        void handle(frame).then((outcome) => {
            if (WHY[outcome]) say(`notice (cmd 621): ${WHY[outcome]}`);
        });
    });
    return {
        stop: off,
        handle,
    };
}
