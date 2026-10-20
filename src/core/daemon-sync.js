/**
 * The `zalo-agent sync` socket stages, and `msg history`'s fetch, as a running
 * daemon performs them.
 *
 * `listen` and `mcp start` hold the account's one permitted WebSocket, and are
 * its one db writer while they run. These are the bodies they expose over the
 * loopback channel so `sync` and `msg history` can use that socket instead of
 * opening a second one and evicting them. See the "same hand-off, for
 * `zalo-agent sync`" section of src/core/daemon-channel.js for why, and for the
 * streaming protocol these `onEvent` calls travel over.
 *
 * Kept out of daemon-channel.js on purpose. That module is the transport, and
 * `msg send` imports it for `sendViaDaemon` -- pulling SyncV2's decrypt stack,
 * its CDN asset fetcher and its db writes into every message send to serve a
 * path `msg` never takes would be a poor trade. The daemons import this; the
 * channel only ever sees functions.
 *
 * Two rules these runners exist to enforce, both of which read as ordinary
 * option-passing and are neither:
 *
 *  1. `liveStore: false`. The daemon's own handlers already store every live
 *     message, reaction and receipt. SyncV2's built-in tap is for a CLI that
 *     owns the socket alone; here it would write everything a second time.
 *  2. `getApi()` per call, never a captured api. A daemon that hits a
 *     duplicate-session close re-logs-in and builds a new api object, and a
 *     stage bound to the old one would tap a socket zca-js has already
 *     nulled. This is the same lesson `/send-attachments` learned when it
 *     captured the api instead of a getter.
 */
import { SyncV2 } from "./sync-v2/index.js";
import { drainReactions, placeUnresolvedReactions } from "./sync-v2/reactions.js";
import { fetchAndCacheHistory } from "./history-fetch.js";
import { createStageLogger } from "./daemon-log.js";

/**
 * True while the listener's socket is connecting or open.
 *
 * Mirrors `socketAlive()` in src/commands/sync.js, because the caller needs
 * the same fact and cannot see this socket: an empty reaction drain means "the
 * queue is caught up" on a live socket and "we lost the connection" on a dead
 * one, and those need opposite advice.
 *
 * @param {object} api
 * @returns {boolean}
 */
function socketAlive(api) {
    const ws = api?.listener?.ws;
    return Boolean(ws) && ws.readyState <= 1;
}

/**
 * Wait for the daemon's own recovery to put a live socket back.
 *
 * A stage that loses its socket must not open one itself: `listen` and `mcp`
 * answer a close by logging in again and rebuilding the api, and a stage
 * tearing the old socket down or starting a new one would race that. So this
 * only WATCHES `getApi()` -- it never starts, stops or logs in anything -- and
 * returns once the daemon's api has an OPEN socket that is not the one the
 * stage lost.
 *
 * @param {object} args
 * @param {() => object} args.getApi - the daemon's current api
 * @param {object|null} args.lostWs - the socket object the stage was using
 * @param {object|null} args.lostApi - the api object the stage was using
 * @param {number} [args.timeoutMs]
 * @param {number} [args.pollMs]
 * @param {(message: string) => void} [args.log]
 * @param {(ms: number) => Promise<void>} [args.sleep] - test seam
 * @param {() => number} [args.now] - test seam
 * @returns {Promise<{api: object}|null>} the api to continue on, or null when none came back in time
 */
export async function waitForDaemonSocket({
    getApi,
    lostWs,
    lostApi,
    timeoutMs = 120000,
    pollMs = 500,
    log = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
}) {
    const startedAt = now();
    log(`the socket was lost mid-stage; waiting up to ${Math.round(timeoutMs / 1000)}s for the daemon to reconnect`);
    for (;;) {
        let api = null;
        try {
            api = getApi();
        } catch {
            /* the daemon is between sessions */
        }
        const ws = api?.listener?.ws;
        if (ws && ws.readyState === 1 && (api !== lostApi || ws !== lostWs)) {
            log(`the daemon reconnected after ${((now() - startedAt) / 1000).toFixed(1)}s; resuming the stage`);
            return { api };
        }
        if (now() - startedAt >= timeoutMs) {
            log(
                `the daemon did not reconnect within ${Math.round(timeoutMs / 1000)}s; the stage ends with what it has`,
            );
            return null;
        }
        await sleep(pollMs);
    }
}

/**
 * Wrap each runner so it writes to the daemon's log.
 *
 * Here, rather than in the channel route or the MCP job tracker, because both
 * of those call the same runners: the channel streams events to the CLI that
 * asked and the job tracker keeps the last twenty, and neither wrote anything
 * to daemon.log. Wrapping the runners covers `zalo-agent sync`, `msg history`
 * and the `zalo_sync` tool alike.
 *
 * @param {Record<string, Function>} runners
 * @param {{log: (message: string) => void, monitor: object|null}} deps
 * @returns {Record<string, Function>}
 */
function traceRunners(runners, { log, monitor }) {
    return Object.fromEntries(
        Object.entries(runners).map(([stage, run]) => [
            stage,
            async (params = {}, onEvent = () => {}) => {
                const trace = createStageLogger({ stage, log, monitor });
                trace.start(params);
                try {
                    const result = await run(params, (event) => {
                        try {
                            trace.event(event);
                        } catch {
                            /* a logging problem never reaches the stage */
                        }
                        onEvent(event);
                    });
                    trace.finish(result);
                    return result;
                } catch (error) {
                    trace.fail(error);
                    throw error;
                } finally {
                    trace.stop();
                }
            },
        ]),
    );
}

/**
 * Build the stage runners for `startDaemonChannel({ runners })`.
 *
 * @param {object} args
 * @param {() => object} args.getApi - resolves the daemon's CURRENT zca-js api
 * @param {string} args.accountName - ownId; picks the account data dir
 * @param {(res: object) => void|Promise<void>} [args.onMessagesRestored] - optional hook after messages restore
 * @param {(name: string) => void|Promise<void>} [args.onSelfName] - optional hook when active account's profile name is refreshed
 * @param {(message: string) => void} [args.log] - where each stage writes its parameters, every progress
 *   phase, a periodic "still running" line and its result or failure (daemon.log); silent without it
 * @param {{takeMax: () => number}} [args.monitor] - event-loop monitor; its worst stall is added to the
 *   "still running" lines
 * @returns {Record<string, (params: object, onEvent: (e: object) => void) => Promise<object>>}
 */
export function createSyncRunners({
    getApi,
    accountName,
    onMessagesRestored,
    onSelfName,
    log = () => {},
    monitor = null,
}) {
    /** The live api, or a refusal the CLI can print. */
    const liveApi = (what) => {
        const api = getApi();
        if (!api?.listener) throw new Error(`this daemon has no listener to run the ${what} on`);
        return api;
    };

    const runners = {
        /**
         * transfer-sync-v2 message restore (socket cmd 590/591).
         *
         * Still prompts the owner's phone exactly once — routing through the
         * daemon removes the second WebSocket, not the confirmation. The
         * daemon never calls this on its own; an explicit CLI sync or MCP
         * sync request authorized by the owner reaches it.
         *
         * @param {{days?: number|null, from?: string|number, waitMs?: number,
         *   shardSize?: number, waveSize?: number}} params
         * @param {(e: {phase: string, detail?: string}) => void} onEvent
         * @returns {Promise<object>} SyncV2.restore() result, as-is
         */
        async messages(params = {}, onEvent = () => {}) {
            const api = liveApi("restore");
            // The api and socket the stage is on, kept current across reconnects.
            let current = { api, ws: api.listener?.ws ?? null };
            const res = await new SyncV2(api, accountName).restore({
                days: params.days ?? null,
                from: params.from,
                waitMs: Number(params.waitMs) || undefined,
                shardSize: Number(params.shardSize) || undefined,
                waveSize: Number(params.waveSize) || undefined,
                // See rule 1 in this file's header: the daemon is the tap.
                liveStore: false,
                // Explicit, not left to the default: a CLI that owns the
                // socket runs one heartbeat across its whole window and turns
                // this off, but a daemon has no such window -- zca-js pings on
                // the server's own 180s interval, which is the entire width of
                // the phone wait. So the restore keeps its own.
                keepAlive: true,
                // A `reconnect` that only WAITS. The CLI passes one that opens the
                // socket itself, because it owns the socket's lifecycle for the
                // length of the run; here the daemon does, and it reconnects on
                // its own terms -- `listen`/`mcp` answer a close by re-logging-in
                // and rebuilding the api, and a stage tearing the socket down or
                // starting one would race that. So this never touches the
                // listener: it watches `getApi()` until the daemon's recovery has
                // an open socket, then hands that api back and the restore
                // re-requests the batches that never arrived. Before this, any
                // lost socket (close 1006, which Zalo does not offer to retry) ended
                // a long restore as partial and the next one asked the phone again.
                // A long restore on a busy account can lose its socket more than once, so a daemon allows
                // three resumes (the CLI's default is one); `params.maxResumes` overrides.
                maxResumes: Number.isInteger(params.maxResumes) ? params.maxResumes : 3,
                reconnect: async () => {
                    const back = await waitForDaemonSocket({
                        getApi,
                        lostWs: current.ws,
                        lostApi: current.api,
                        timeoutMs: Number(params.reconnectWaitMs) || undefined,
                        log: (m) => log(`[sync:messages] ${m}`),
                    });
                    if (back) current = { api: back.api, ws: back.api.listener?.ws ?? null };
                    return back;
                },
                onStatus: onEvent,
                onSelfName,
            });
            if (typeof onMessagesRestored === "function") {
                try {
                    await onMessagesRestored(res);
                } catch {
                    /* best-effort cache refresh */
                }
            }
            return res;
        },

        /**
         * `msg history`'s fetch AND its cache write, on this daemon.
         *
         * `msg history` used to open its own WebSocket for the socket scan,
         * which evicted the running daemon with code 3000; the daemon retried
         * and evicted it back, and messages arriving in the flap were lost with
         * no gap recorded. Then this stage paged the stream on the daemon's
         * socket but wrote nothing: the CLI wrote the frames it returned, and a
         * group's cloud-message store fetch never came here at all, so with a
         * daemon up the account had two db writers.
         *
         * Now the daemon does the whole job, through the same
         * fetchAndCacheHistory the CLI runs when no daemon is up: a group's
         * cloud-message store first, then the old-message stream on THIS
         * listener, then the insert-if-absent write through this process's
         * connection -- the account's one writer, under daemon.lock. The frames
         * still cross the wire, because the CLI prints them; it writes none.
         *
         * No `connect`: the listener is already running, and a stage never
         * opens or closes it.
         *
         * @param {{threadId: string, threadType: number, limit?: number,
         *   scanLimit?: number, timeoutMs?: number, fromMsgId?: string|null}} params
         * @param {(p: object) => void} onEvent - fetchAndCacheHistory's progress lines
         * @returns {Promise<{frames: Array<object>, source: string, rawScanned: number,
         *   cached: boolean, added: number, untouched: number}>}
         */
        async history(params = {}, onEvent = () => {}) {
            const api = liveApi("history fetch");
            return fetchAndCacheHistory(api, params.threadId, params.threadType, {
                limit: params.limit,
                scanLimit: params.scanLimit,
                timeoutMs: params.timeoutMs,
                fromMsgId: params.fromMsgId || null,
                onProgress: onEvent,
            });
        },

        /**
         * Reaction backlog drain (socket cmd 610/611), plus the retry pass.
         *
         * The retry has to happen HERE rather than in the invoking CLI.
         * `drainReactions` hands back the reactions whose target message was
         * not in the cache when they arrived, and placing them is a WRITE —
         * the daemon holds `daemon.lock` and is the account's one db writer.
         * Sending the raw reaction objects back over the wire for the CLI to
         * write would put message content on a pipe for no reason and write to
         * a db this process owns. So: place them here, return counts.
         *
         * @param {{waitMs?: number, maxPages?: number, applyRemovals?: boolean}} params
         * @param {(p: object) => void} onEvent
         * @returns {Promise<object>} drainReactions stats, with `unresolved`
         *   replaced by the counts `placed` and `unresolvedLeft`
         */
        async reactions(params = {}, onEvent = () => {}) {
            const api = liveApi("reaction drain");
            const stats = await drainReactions({
                listener: api.listener,
                timeoutMs: Number(params.waitMs) || undefined,
                maxPages: Number(params.maxPages) || undefined,
                applyRemovals: params.applyRemovals !== false,
                onProgress: onEvent,
            });
            const placed = placeUnresolvedReactions(stats.unresolved);
            return {
                ...stats,
                // The array does not cross the wire; its size does.
                unresolved: undefined,
                placed,
                unresolvedLeft: (stats.unresolved?.length || 0) - placed,
                socketAlive: socketAlive(api),
            };
        },
    };

    return traceRunners(runners, { log, monitor });
}
