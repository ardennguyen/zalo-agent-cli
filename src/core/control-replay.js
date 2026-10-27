/**
 * Replay the control events a daemon missed while it was away (plan items X4 to X6).
 *
 * A control is what Zalo pushes as a `601` frame: a group or friend event, an unread mark set on another device, the
 * text of a transcribed voice message, a sync status. They reach a connected client as pushes; while the client is
 * away the server keeps them in the control queues (`603_0` and `603_1` in this account's handshake, named by its
 * `ctrl_qCmds`) and serves them to the next connect, from the cursor the client holds, in pages of 50
 * (`{controls, queueStatus, more, lastActionId}`). Zalo Web asks for them on every connect and runs each one through
 * the same handler as a live push (bundle module `8RMw`, `processControl`: one path for `601`, `603`, `610` and `611`).
 *
 * So does this client now. Each page that comes back is handed to the listener as if it had arrived as a `601`: the
 * frame's command is rewritten and the bytes are given to the socket's own `message` handlers, so zca-js emits the
 * same `group_event` and `friend_event`, and everything that reads `601` here (the unread marks, the transcripts, the
 * unknown-action collector, the cursor keeper) sees it as it sees a push. Nothing is written by this module, nothing
 * is acknowledged (the Web client acknowledges controls with nothing at all: its cursor is the whole mechanism),
 * and the cursor only moves where `601` handling moves it: forward, from the answer's own `queueStatus`.
 *
 * What it does not do, on purpose:
 *  - it never asks without a saved cursor. A first-ever pull would ask from the start of the queue and replay every
 *    event the server still holds, years of stale sync statuses and group events among them; the first live control
 *    sets a cursor, and the next connect resumes from it;
 *  - it does not ask for `515`, `517` or `518`. Those are the Signal (end-to-end encryption) queues: their items are
 *    unreadable without a Signal stack, and `518` is deleted by an acknowledgement, so asking for them without
 *    handling them would only lose them (see docs/agent-notes.md, "connect-time pulls").
 */
import { drainOfflineQueue } from "./offline-queue.js";

/** The command a replayed page is presented as: the control push. */
export const CMD_CONTROL_PUSH = 601;

/**
 * Hand a control page to the listener as a `601` push.
 *
 * @param {object} listener - a zca-js Listener with an open socket
 * @param {Buffer} raw - the page's bytes as they came
 * @returns {boolean} false when there was nothing to hand it to
 */
export function replayAsPush(listener, raw) {
    const ws = listener?.ws;
    if (!ws || typeof ws.emit !== "function" || !Buffer.isBuffer(raw) || raw.length < 4) return false;
    const copy = Buffer.from(raw);
    copy.writeUInt16LE(CMD_CONTROL_PUSH, 1);
    copy[3] = 0;
    // `true`: a binary frame. zca-js reads the socket through `ws.onmessage`, which `ws` feeds the data as text unless
    // told it is binary, and zca-js ignores anything that is not a Buffer.
    ws.emit("message", copy, true);
    return true;
}

/**
 * Replay what the control queues held for this client.
 *
 * @param {object} args
 * @param {object} args.listener - a zca-js Listener whose socket is open and authenticated
 * @param {ReturnType<import("./socket-tap.js").createSocketTap>} args.tap
 * @param {Array<{cmd: number, subCmd: number, queueName: string}>} args.queues - see `controlQueuesFrom`
 * @param {(queueName: string) => ({id: string}|null)} args.cursorOf - the saved cursor of a queue
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxPages]
 * @returns {Promise<Array<{queue: object, cursor: object|null, replayed: number, pages: number, complete: boolean,
 *   reason: string, evicted: boolean, resetTo: string|null}>>}
 */
export async function replayControlQueues({ listener, tap, queues, cursorOf, timeoutMs, maxPages }) {
    const results = [];
    for (const queue of queues) {
        const cursor = cursorOf(queue.queueName);
        if (!cursor) {
            results.push({
                queue,
                cursor: null,
                replayed: 0,
                pages: 0,
                complete: false,
                reason: "no-cursor",
                evicted: false,
                resetTo: null,
            });
            continue;
        }
        const r = await drainOfflineQueue({
            listener,
            tap,
            queue,
            lastId: cursor.id,
            timeoutMs,
            maxPages,
            onPage: (frame) => replayAsPush(listener, frame.raw),
        });
        results.push({
            queue,
            cursor,
            replayed: r.rows.length,
            pages: r.pages,
            complete: r.complete,
            reason: r.reason,
            evicted: r.evicted,
            resetTo: r.resetTo,
        });
    }
    return results;
}
