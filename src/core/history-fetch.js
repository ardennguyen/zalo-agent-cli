/**
 * `msg history`'s fetch and its cache write -- one code path, run by
 * whichever process holds the account.
 *
 * AGENTS.md §13: one WebSocket per account, and one db writer per account.
 * The socket scan below needs the first, and `msg history`'s fetch is one of
 * the three paths that write message rows (the listener, sync, and this), so
 * it runs only where both belong:
 *
 *   - no daemon running: in `msg history` itself, which opens the socket for
 *     the scan and closes it afterwards (`connect`);
 *   - a `listen`/`mcp` daemon running: in that daemon, as its `history` stage
 *     (./daemon-sync.js), on the socket it already holds and through the db
 *     connection it already writes with. The CLI asks for it over the loopback
 *     channel (./daemon-channel.js) and only displays what comes back.
 *
 * Both run this function, so the two cannot drift apart. They had: the
 * daemon's stage was a second copy of the socket scan that wrote nothing and
 * handed its frames to the CLI to write, and a group's cloud-message store
 * fetch never reached the daemon at all -- the CLI fetched and wrote it beside
 * the running daemon. Two writers for one account.
 *
 * The fetch, in Zalo Web's order:
 *
 *   1. a group: Zalo's cloud-message store (getrecentv2, ./group-history.js),
 *      what Zalo Web reads when a group is opened;
 *   2. a DM, or a group whose store failed or came back empty: the socket's
 *      old-message stream, paged account-wide and filtered to this thread.
 *
 * Every frame found then goes through storeHistoryMessage (./live-store.js):
 * insert-if-absent, as Zalo Web writes the history it fetches, so a message
 * zalo.db already holds is left exactly as it is.
 */
import { storeHistoryMessage } from "./live-store.js";

/** zca-js ThreadType.Group */
const THREAD_GROUP = 1;

/**
 * Page the account-wide old-message stream, keeping this thread's frames.
 *
 * @param {object} api - zca-js API whose listener is running, or which `connect` starts
 * @param {string} threadId
 * @param {number} threadType
 * @param {{limit: number, scanLimit: number, timeoutMs: number, fromMsgId: string|null,
 *   connect?: () => Promise<() => void>}} opts
 * @returns {Promise<{frames: Array<object>, rawScanned: number}>}
 */
async function scanOldMessages(api, threadId, threadType, { limit, scanLimit, timeoutMs, fromMsgId, connect }) {
    const disconnect = connect ? await connect() : null;
    const frames = [];
    let rawScanned = 0;
    try {
        const listener = api?.listener;
        if (!listener) throw new Error("there is no listener to scan the old-message stream on");
        let lastMsgId = fromMsgId || null;
        let done = false;
        while (!done && rawScanned < scanLimit) {
            const page = await new Promise((resolve, reject) => {
                const settle = (fn, value) => {
                    clearTimeout(timer);
                    listener.removeListener("old_messages", onPage);
                    fn(value);
                };
                const onPage = (messages) => settle(resolve, messages);
                const timer = setTimeout(() => settle(resolve, []), timeoutMs);
                listener.on("old_messages", onPage);
                try {
                    listener.requestOldMessages(threadType, lastMsgId);
                } catch (e) {
                    settle(reject, e);
                }
            });
            if (!page || page.length === 0) break;
            rawScanned += page.length;

            for (const msg of page) {
                if (String(msg.threadId || "") !== threadId) continue;
                frames.push({ threadId: msg.threadId, type: threadType, data: msg.data });
                if (frames.length >= limit) {
                    done = true;
                    break;
                }
            }

            // The cursor is the global actionId of the last raw message.
            const last = page[page.length - 1];
            const nextId = last?.data?.actionId || last?.data?.msgId;
            if (!nextId || nextId === lastMsgId) done = true;
            lastMsgId = nextId;
        }
    } finally {
        disconnect?.();
    }
    return { frames, rawScanned };
}

/**
 * Fetch a conversation's recent history and cache what zalo.db does not hold.
 *
 * @param {object} api - a logged-in zca-js API. Its listener must already be
 *   running unless `opts.connect` is given; the store needs no socket at all.
 * @param {string} threadId
 * @param {number} threadType - 0 a DM, 1 a group
 * @param {object} [opts]
 * @param {number} [opts.limit=50] - most-recent messages wanted
 * @param {number} [opts.scanLimit=2000] - raw stream messages to scan, at most
 * @param {number} [opts.timeoutMs=15000] - wait for each stream page
 * @param {string|null} [opts.fromMsgId=null] - start the stream scan below this message
 * @param {boolean} [opts.cache=true] - write what was fetched; false only fetches
 * @param {() => Promise<() => void>} [opts.connect] - opens the socket for the
 *   scan and resolves the function that closes it again. Given by a process
 *   that owns the account's session for this one command; never by a daemon,
 *   whose listener is already running and must not be opened or closed here.
 * @param {(e: {phase: string, detail: string, level?: "warn"}) => void} [opts.onProgress] -
 *   one line per step, in the words `msg history` prints
 * @returns {Promise<{frames: Array<{threadId: string, type: number, data: object}>,
 *   source: "store"|"socket", rawScanned: number, cached: boolean, added: number, untouched: number,
 *   filtered: boolean}>}
 *   `frames` as fetched, for display; `added` rows were new and written;
 *   `untouched` were already stored, or not storable (a removal, no content);
 *   `filtered` is true when a group's store withheld older messages
 * @throws {Error} when there is no thread id, the socket cannot be opened, or the scan fails
 */
export async function fetchAndCacheHistory(api, threadId, threadType, opts = {}) {
    const thread = String(threadId ?? "");
    if (!thread) throw new Error("a thread id is required");
    const type = Number(threadType) === THREAD_GROUP ? THREAD_GROUP : 0;
    const limit = Number(opts.limit) || 50;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

    let frames = [];
    let source = "socket";
    let filtered = false;
    if (type === THREAD_GROUP) {
        try {
            // Loaded on demand: only a group needs it.
            const { getGroupHistory } = await import("./group-history.js");
            const history = await getGroupHistory(api, thread, limit);
            frames = history.groupMsgs.map((m) => ({ threadId: thread, type, data: m.data }));
            filtered = history.filtered === true;
            onProgress({
                phase: "store",
                detail: frames.length
                    ? "Fetched group history from Zalo's message store."
                    : "Zalo's message store had no messages. Falling back to WebSocket stream...",
            });
            if (filtered) {
                // Measured live 2026-09-30: the socket stream reaches no further
                // back, so only the phone-backed restore can bring these in.
                onProgress({
                    phase: "store",
                    detail:
                        "Zalo's message store serves only messages since this login; older ones are withheld. " +
                        "`zalo-agent sync` restores them from your phone (it asks for a tap).",
                });
            }
        } catch (e) {
            onProgress({
                phase: "store",
                level: "warn",
                detail: `REST API failed (${e.message}). Falling back to WebSocket stream...`,
            });
        }
        if (frames.length) source = "store";
    }

    let rawScanned = 0;
    if (source === "socket") {
        const scan = await scanOldMessages(api, thread, type, {
            limit,
            scanLimit: Number(opts.scanLimit) || 2000,
            timeoutMs: Number(opts.timeoutMs) || 15_000,
            fromMsgId: opts.fromMsgId || null,
            connect: opts.connect,
        });
        frames = scan.frames;
        rawScanned = scan.rawScanned;
        onProgress({
            phase: "scan",
            detail: `Scanned ${rawScanned} raw WS messages to find ${frames.length} target messages.`,
        });
    }

    // The one write-back, whichever fetch found them: only what zalo.db does
    // not have yet. A stored row keeps its localPath, receipt status, st/at/cmd
    // and tombstone; removals are never applied from here; nothing older than
    // a conversation's delete marker comes back (see storeHistoryMessage).
    const cache = opts.cache !== false;
    let added = 0;
    if (cache) {
        for (const f of frames) if (storeHistoryMessage(f).stored) added++;
    }
    return { frames, source, rawScanned, cached: cache, added, untouched: frames.length - added, filtered };
}
