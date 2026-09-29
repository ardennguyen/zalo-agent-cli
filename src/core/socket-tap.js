/**
 * A raw reader on the listener's WebSocket that keeps what zca-js throws away.
 *
 * zca-js decodes each frame and emits typed events built from one or two of
 * its arrays -- the 501 handler reads only `msgs`, the 521 handler only
 * `groupMsgs`, the 510/511 `old_messages` handler only the message arrays --
 * and keeps nothing of the handshake (cmd 1) but its cipher `key`. Everything
 * else in the envelope is gone before our handlers run:
 *
 *   queueStatus {"<queue>": {ids, lastId, evict}}   the per-queue cursors
 *   lastActionId, more                               offline-queue paging
 *   resetLastActionId                                "start the cursor over"
 *   clearUnreads, pageMsgs, delivereds, seens        read state, page messages
 *   qCmds, ctrl_qCmds, bk_cmds (cmd 1)               which queues to drain
 *
 * Zalo Web reads all of it (bundle 1.e0ef5e98…: `processSuccessData` →
 * `queueIds.addLastActionIds(o.queueStatus, …)` @~11109700, `onAuthenticated`
 * reads `data.qCmds` @~11118700). So does this: it listens beside zca-js on the
 * same raw `ws`, decodes each frame with the repo's own mirror of zca-js's
 * decoder, and hands `{cmd, subCmd, body, data}` to whoever subscribed to that
 * cmd. The reaction backlog drain has done this privately since 2026-09-28
 * (./sync-v2/reactions.js); this is the same technique, shared, for everything
 * that needs a field zca-js drops -- the offline-queue catch-up first
 * (./self-heal.js), read-state sync and pageMsgs after it.
 *
 * It reads and routes; it never writes, never sends, and never needs a zca-js
 * patch. `listen` and `mcp start` both attach it (AGENTS.md §13).
 */
import { decodeFrame } from "./sync-v2/index.js";

/** The handshake: its answer carries the cipher key and the queue lists. */
export const CMD_AUTHEN = 1;

/**
 * Read one raw socket frame: zca-js's 4-byte header, then its JSON body.
 *
 * The header is `[version, cmd as uint16 LE, subCmd]` (zca-js `getHeader`).
 * A body of `{encrypt, data: <string>}` is decoded with the session's cipher
 * key -- the handshake frame carries its own `key`, which zca-js adopts at the
 * same moment -- and any other body is taken as it is.
 *
 * @param {Buffer} buf
 * @param {string} [cipherKey]
 * @returns {{version: number, cmd: number, subCmd: number, body: object, data: object|null}|null}
 *   null for anything that is not a readable frame
 */
export function readFrame(buf, cipherKey) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    const version = buf[0];
    const cmd = buf.readUInt16LE(1);
    const subCmd = buf[3];
    let parsed;
    try {
        parsed = JSON.parse(buf.subarray(4).toString("utf8"));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    let body = parsed;
    if (typeof parsed.data === "string" && typeof parsed.encrypt === "number") {
        try {
            body = decodeFrame(parsed, parsed.key || cipherKey);
        } catch {
            return null;
        }
    }
    const data = body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : null;
    return { version, cmd, subCmd, body, data };
}

/**
 * Build the tap. One per daemon: it outlives each socket and each re-login.
 *
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.log] - where a failing subscriber is reported
 * @returns {{
 *   attach: (listener: object) => void,
 *   on: (cmd: number, fn: (frame: object, listener: object) => void) => () => void,
 *   auth: () => object|null,
 * }} `attach` taps the listener's current socket and every one it opens after;
 *   `on` subscribes to one cmd and returns the unsubscribe; `auth` is the last
 *   handshake's `data` (qCmds, ctrl_qCmds, bk_cmds), or null before the first
 */
export function createSocketTap({ log = (line) => console.error(line) } = {}) {
    /** @type {Map<number, Set<Function>>} */
    const subscribers = new Map();
    /** Sockets already tapped: a re-login attaches again, and a frame must arrive once. */
    const tapped = new WeakSet();
    /** Listeners already watched for new sockets. */
    const watched = new WeakSet();
    let lastAuth = null;

    function deliver(frame, listener) {
        if (frame.cmd === CMD_AUTHEN && frame.data) lastAuth = frame.data;
        const fns = subscribers.get(frame.cmd);
        if (!fns) return;
        for (const fn of [...fns]) {
            try {
                fn(frame, listener);
            } catch (e) {
                try {
                    log(`socket tap: a cmd ${frame.cmd} handler failed: ${e?.message || e}`);
                } catch {
                    /* a broken logger must not break the socket either */
                }
            }
        }
    }

    function tapSocket(listener) {
        const ws = listener?.ws;
        if (!ws || typeof ws.on !== "function" || tapped.has(ws)) return;
        tapped.add(ws);
        ws.on("message", (buf) => {
            // Only cmds someone asked for are decoded, so a quiet tap costs
            // one header read per frame; the handshake is always kept.
            if (!Buffer.isBuffer(buf) || buf.length < 4) return;
            const cmd = buf.readUInt16LE(1);
            if (cmd !== CMD_AUTHEN && !subscribers.has(cmd)) return;
            const frame = readFrame(buf, listener.cipherKey);
            if (frame) deliver(frame, listener);
        });
    }

    return {
        attach(listener) {
            if (!listener) return;
            tapSocket(listener);
            // zca-js opens a NEW ws on every retry and announces it with
            // `connected` from its onopen, before any frame can arrive -- so
            // re-arming there never misses the handshake.
            if (!watched.has(listener) && typeof listener.on === "function") {
                watched.add(listener);
                listener.on("connected", () => tapSocket(listener));
            }
        },

        on(cmd, fn) {
            const key = Number(cmd);
            if (!subscribers.has(key)) subscribers.set(key, new Set());
            subscribers.get(key).add(fn);
            return () => {
                const set = subscribers.get(key);
                if (!set) return;
                set.delete(fn);
                if (set.size === 0) subscribers.delete(key);
            };
        },

        auth() {
            return lastAuth;
        },
    };
}
