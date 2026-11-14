/**
 * The zCloud queue, kept current from the daemon: what a client does when the server sends it cmd 621.
 *
 * cmd 621 (`mycloudMedia`) is the server saying "your copy of the cloud queue may be stale, go and verify". It arrives
 * after login as plain JSON in the frame's `data.data`:
 *
 *   {"mycloudMedia": {"pageSize": 300, "lastNoiseId": "<24 characters>", "forceVerify": 0,
 *                     "onboardingCompleted": 0, "auditLocalCloudQueue": 0, "correctCloudKey": 0}}
 *
 * A client answers it by walking the queue from its saved place, at most once in 30 minutes. This does the same, with
 * the rules that keep a daemon from doing anything its owner would not expect:
 *
 * - **Only after a person has walked it once.** A first walk reads the whole queue (megabytes of JSON for an old
 *   account) and is `zalo-agent sync-cloud`'s job, run on purpose. With no saved place, a notice is logged and left.
 * - **Only when there is something new.** The notice carries the server's newest noise id; when it equals the saved
 *   place the index is current and nothing is requested.
 * - **At most once in 30 minutes**, counted from the last walk this daemon started.
 * - **Never beside another stage.** It takes the daemon's stage lock (`tryAcquire`, never waits): a notice that meets
 *   a running sync or history fetch is dropped, and the next one (or a `sync-cloud`) catches up.
 * - **Never an acknowledgment.** The onboarding ack a client sends after its first verify changes what Zalo
 *   does with this account's cloud; it is not ours to send.
 * - **`forceVerify` and `forceReset` walk the whole queue from the top**: past the 30-minute pace and the "already
 *   current" check, as a `--full` walk, so that once the server says it is done every item no page listed is swept (an
 *   interrupted walk sweeps nothing). The index is kept until the walk has finished. A walk, forced or not, has no page
 *   cap (it reads until the server is done or its cursor stops moving); forced walks are paced at one in 30 minutes.
 *   Still no baseline means still no walk, and no report (`submit_verify_action`) is sent afterwards.
 * - **`correctCloudKey` and `auditLocalCloudQueue` are read and left.** The first asks a client to fetch the account's
 *   cloud key again, which this client never holds (D8); the second audits its local media against the store and
 *   reports to the server. Each is named in the log.
 *
 * **cmd 620 is one queue entry pushed live** (`CLOUD.PUSH`; its body is the entry itself: `noiseId`, `action`,
 * `actionType`, `cliTs`, `msgInfo`, `mediaInfo`, `encryptInfo`, `ts`). It is applied to the
 * store at once, as one page of the walk ({@link applyQueuePage}): an `add` is recorded, a `remove`
 * deletes the items it names, a `del_thread` deletes a conversation's older items, `temp` and `duplicate` change
 * nothing. Two more rules:
 *
 * - **A removal can overtake its add.** A `remove` naming an item the index does not hold is remembered for an hour,
 *   and an `add` of that item arriving in that hour is dropped.
 * - **`reset_cloud` walks the queue from the top**, as a forced notice does (a "reset" verify): it does not
 *   empty the index from one entry, and it follows the rules above (a baseline, the 30-minute pace, the stage lock).
 *
 * A push needs no baseline and takes no stage lock: it is one entry, written at once, and it never moves the walk's
 * saved place. The engine's other writes to `cloud_items` are the walks; a full walk keeps a pushed item (it is
 * stamped as seen when it arrives).
 *
 * `listen` and `mcp start` both build one (AGENTS.md §13: any asymmetry between them is a defect).
 */
import { getCloudItemByZKey, getSyncState, setSyncState } from "./db.js";
import { applyQueuePage, syncCloudIndex } from "./sync-v2/zcloud.js";
import { cloudKeyOf, ownIdOf, removalKeysOf, selfChatIdOf } from "../zalo/zcloud.js";

/** The server's "verify your cloud queue" push. */
export const CMD_MYCLOUD = 621;

/** One cloud-queue entry, pushed live (`CLOUD.PUSH`). */
export const CMD_CLOUD_PUSH = 620;

/** How long a removal that found nothing cancels the add it overtook (an hour). */
export const EARLY_REMOVE_MS = 60 * 60 * 1000;

/** Queue entry actions, as src/zalo/zcloud.js `ACTION` names them. */
const ADD = 1;
const REMOVE = 2;
const TEMP = 4;
const RESET_CLOUD = 5;
const DUPLICATE = 6;

/** A JSON text read as an object, or the value itself. */
function parsed(v) {
    if (typeof v !== "string") return v;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
}

/**
 * Read a cmd 620 frame: the queue entry it carries, as the frame's `data` (or, defensively, inside `data.data`).
 *
 * @param {{data?: object|string|null}} frame - a frame from the socket tap
 * @returns {object|null} the entry, or null for anything that is not one
 */
export function readCloudPush(frame) {
    let item = parsed(frame?.data);
    if (item && typeof item === "object" && item.noiseId === undefined && item.data !== undefined) {
        item = parsed(item.data);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    return item.noiseId !== undefined || item.action !== undefined ? item : null;
}

/** This event is acted on at most once per 30 minutes. */
export const THROTTLE_MS = 30 * 60 * 1000;

// No page cap: a walk, automatic or forced, reads until the server says it is done or its cursor stops moving
// (src/core/sync-v2/zcloud.js). What bounds the work is the 30-minute pace above.

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
 * Answer cmd 621 notices with a bounded, read-only walk of the cloud queue, and apply each cmd 620 entry pushed live.
 *
 * @param {object} args
 * @param {ReturnType<import("../zalo/listener/socket-tap.js").createSocketTap>} args.tap
 * @param {() => object} args.getApi - the logged-in api, or throws
 * @param {ReturnType<import("./daemon-channel.js").createStageLock>} args.lock
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {number} [args.throttleMs]
 * @param {typeof syncCloudIndex} [args.walk] - injected walker (tests)
 * @param {typeof applyQueuePage} [args.apply] - injected page writer (tests)
 * @param {typeof getCloudItemByZKey} [args.findByZKey] - injected index lookup (tests)
 * @returns {{stop: () => void, handle: (frame: object) => Promise<string>, handlePush: (frame: object) =>
 *   Promise<string>}} `handle` (cmd 621) and `handlePush` (cmd 620) are what the tap calls; each resolves to what it
 *   did (`"walked"`, `"added"`, `"removed"`, or why not), for tests
 */
export function createCloudVerifier({
    tap,
    getApi,
    lock,
    log = (line) => console.error(line),
    now = Date.now,
    throttleMs = THROTTLE_MS,
    walk = syncCloudIndex,
    apply = applyQueuePage,
    findByZKey = getCloudItemByZKey,
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

    /** Removals that found nothing in the index, by cloud key, with when: each cancels the add it overtook. */
    const earlyRemoves = new Map();

    async function handlePush(frame) {
        try {
            const item = readCloudPush(frame);
            if (!item) return "ignored";
            const action = item.action === undefined || item.action === null ? ADD : Number(item.action);
            if (action === RESET_CLOUD) {
                say("the server reset the cloud queue (cmd 620 reset_cloud): walking it from the top");
                const outcome = await handle({ data: { data: { mycloudMedia: { forceReset: 1 } } } });
                if (WHY[outcome]) say(`reset: ${WHY[outcome]}`);
                return `reset:${outcome}`;
            }
            if (action === TEMP || action === DUPLICATE) return "noop";
            let ownId = null;
            let selfChatId = null;
            try {
                const api = getApi();
                ownId = ownIdOf(api);
                selfChatId = selfChatIdOf(api, ownId);
            } catch {
                /* signed out or between sockets: a DM's conversation is then read without the account id */
            }
            const t = now();
            for (const [key, at] of earlyRemoves) if (t - at > EARLY_REMOVE_MS) earlyRemoves.delete(key);
            if (action === ADD) {
                const key = cloudKeyOf(item, ownId);
                if (key && earlyRemoves.has(key)) {
                    earlyRemoves.delete(key);
                    return "cancelled";
                }
            } else if (action === REMOVE) {
                for (const key of removalKeysOf(item, ownId)) if (!findByZKey(key)) earlyRemoves.set(key, t);
            }
            const out = apply([item], { ownId, selfChatId, seenAt: t });
            if (out.failures?.length) {
                say(`could not record a pushed cloud item (cmd 620): ${out.failures[0].reason}`);
                return "failed";
            }
            if (out.added) return "added";
            if (out.removed || out.threadsCleared) return "removed";
            return "unchanged";
        } catch (e) {
            say(`could not apply a pushed cloud item (cmd 620): ${e?.message || e}`);
            return "failed";
        }
    }
    const offPush = tap.on(CMD_CLOUD_PUSH, (frame) => {
        void handlePush(frame);
    });
    return {
        stop() {
            off();
            offPush();
        },
        handle,
        handlePush,
    };
}
