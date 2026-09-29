/**
 * The `zalo-agent sync` socket stages, as a running daemon performs them.
 *
 * `listen` and `mcp start` hold the account's one permitted WebSocket. These
 * are the bodies they expose over the loopback channel so `sync` can use that
 * socket instead of opening a second one and evicting them. See the "same
 * hand-off, for `zalo-agent sync`" section of src/core/daemon-channel.js for
 * why, and for the streaming protocol these `onEvent` calls travel over.
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
 * Build the stage runners for `startDaemonChannel({ runners })`.
 *
 * @param {object} args
 * @param {() => object} args.getApi - resolves the daemon's CURRENT zca-js api
 * @param {string} args.accountName - ownId; picks the account data dir
 * @returns {Record<string, (params: object, onEvent: (e: object) => void) => Promise<object>>}
 */
export function createSyncRunners({ getApi, accountName }) {
    /** The live api, or a refusal the CLI can print. */
    const liveApi = (what) => {
        const api = getApi();
        if (!api?.listener) throw new Error(`this daemon has no listener to run the ${what} on`);
        return api;
    };

    return {
        /**
         * transfer-sync-v2 message restore (socket cmd 590/591).
         *
         * Still prompts the owner's phone exactly once — routing through the
         * daemon removes the second WebSocket, not the confirmation. The
         * daemon never calls this on its own; only a `zalo-agent sync` the
         * owner typed reaches it.
         *
         * @param {{days?: number|null, from?: string|number, waitMs?: number,
         *   shardSize?: number, waveSize?: number}} params
         * @param {(e: {phase: string, detail?: string}) => void} onEvent
         * @returns {Promise<object>} SyncV2.restore() result, as-is
         */
        async messages(params = {}, onEvent = () => {}) {
            const api = liveApi("restore");
            return new SyncV2(api, accountName).restore({
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
                // Deliberately NO `reconnect`. The CLI passes one because it
                // owns the socket's lifecycle for the length of the run; here
                // the daemon does, and it reconnects on its own terms --
                // `listen`/`mcp` answer a close by re-logging-in and rebuilding
                // the api. A stage tearing the socket down underneath that
                // would race it. A socket lost mid-stage therefore ends as a
                // partial restore and the daemon recovers the session.
                onStatus: onEvent,
            });
        },

        /**
         * Page the global old-message stream on the daemon's OWN socket.
         *
         * `msg history` used to open its own WebSocket for this (DM, or any
         * group whose REST call threw). Zalo permits one web session per
         * account, so that evicted the running daemon with code 3000, the
         * daemon silently retried and evicted `msg history` back, and messages
         * arriving in the flap were lost with no gap recorded. It is the same
         * failure the `/send-attachments` hand-off was built to remove; the
         * read path just never got the same guard.
         *
         * Frames cross the wire rather than being written here, because unlike
         * the reaction drain the caller genuinely needs them: it maps, prints
         * and may store them under its own rules.
         *
         * @param {{threadId: string, threadType: number, limit?: number,
         *   scanLimit?: number, timeoutMs?: number, fromMsgId?: string|null}} params
         * @param {(p: object) => void} onEvent
         * @returns {Promise<{frames: Array<object>, rawScanned: number}>}
         */
        async history(params = {}, onEvent = () => {}) {
            const api = liveApi("history scan");
            const threadId = String(params.threadId || "");
            const threadType = Number(params.threadType) || 0;
            const limit = Number(params.limit) || 50;
            const scanLimit = Number(params.scanLimit) || 2000;
            const timeoutMs = Number(params.timeoutMs) || 10_000;

            const frames = [];
            let lastMsgId = params.fromMsgId || null;
            let rawScanned = 0;
            let done = false;

            while (!done && rawScanned < scanLimit) {
                const page = await new Promise((resolve) => {
                    const handler = (messages) => {
                        clearTimeout(timer);
                        api.listener.removeListener("old_messages", handler);
                        resolve(messages);
                    };
                    const timer = setTimeout(() => {
                        api.listener.removeListener("old_messages", handler);
                        resolve([]);
                    }, timeoutMs);
                    api.listener.on("old_messages", handler);
                    api.listener.requestOldMessages(threadType, lastMsgId);
                });
                if (!page || page.length === 0) break;
                rawScanned += page.length;
                onEvent({ phase: "history", detail: `scanned ${rawScanned}` });

                for (const msg of page) {
                    if (String(msg.threadId || "") !== threadId) continue;
                    frames.push({ threadId: msg.threadId, type: threadType, data: msg.data });
                    if (frames.length >= limit) {
                        done = true;
                        break;
                    }
                }

                const last = page[page.length - 1];
                const nextId = last?.data?.actionId || last?.data?.msgId;
                if (!nextId || nextId === lastMsgId) done = true;
                lastMsgId = nextId;
            }
            return { frames, rawScanned };
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
}
