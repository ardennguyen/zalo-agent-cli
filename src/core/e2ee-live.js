/**
 * The live socket side of the end-to-end-encryption key stack: send a numbered Signal command and await its reply, and
 * subscribe to the `personal_cloud` controls that carry the cloud key. These are the transports the gated `cloud key`
 * command supplies to the orchestration in cloud-key-transfer.js. They are reached ONLY when that command runs with the
 * owner present; nothing here is invoked on its own.
 *
 * The correlation primitives ({@link sendSignalCommand}, {@link subscribeCloudControls}) take an injected sender and tap
 * so they are unit-testable offline. {@link withLiveSocket} wraps the real listener lifecycle for the command; that
 * wrapper is LIVE and unverified (no capture of this traffic exists) — it is the owner's to run.
 *
 * One WebSocket per account (AGENTS.md §13): a running daemon holds the socket, so the command checks for one and does
 * not open a second. The decisive field shapes are the client's own, traced from its code, and UNVERIFIED on the wire.
 */
import { randomUUID } from "node:crypto";
import { createSocketTap } from "../zalo/listener/socket-tap.js";
import { readControls } from "../zalo/queues/control-queue.js";
import {
    decodeDeviceList,
    encodeGetKeyId,
    encodeListDevices,
    encodeSubmitBundle,
    replyError,
} from "../zalo/e2ee/bundle-wire.js";

/** The control push (cmd 601) that carries the `pcloud_info` reply. */
export const CMD_PUSH_CONTROLS = 601;
/** Default wait for a signal command's reply. */
export const SIGNAL_REPLY_TIMEOUT_MS = 30_000;

/** Raised when a live signal command gets no reply, or an error reply. */
export class SignalCommandError extends Error {
    /** @param {string} message @param {number|null} [code] */
    constructor(message, code = null) {
        super(message);
        this.name = "SignalCommandError";
        this.code = code;
    }
}

/**
 * Send one `{version, cmd, subCmd, data:{reqId, …}}` frame and await the reply of the same cmd whose `data.reqId`
 * matches. Pure over the injected sender and tap, so a fake pair drives it in tests.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send - the listener's `sendWs`
 * @param {{on: (cmd: number, fn: (frame: object) => void) => (() => void)}} args.tap
 * @param {object} args.frame - a frame from the bundle-wire encoders (carries `data.reqId`)
 * @param {number} [args.timeoutMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [args.timers]
 * @returns {Promise<object>} the reply's `data` object (`{reqId, data, err?}`)
 * @throws {SignalCommandError}
 */
export function sendSignalCommand({
    send,
    tap,
    frame,
    timeoutMs = SIGNAL_REPLY_TIMEOUT_MS,
    timers = { setTimeout, clearTimeout },
}) {
    const reqId = String(frame?.data?.reqId ?? "");
    const cmd = Number(frame?.cmd);
    return new Promise((resolve, reject) => {
        let settled = false;
        let off = () => {};
        let timer = null;
        const finish = (fn, v) => {
            if (settled) return;
            settled = true;
            if (timer) timers.clearTimeout(timer);
            try {
                off();
            } catch {
                /* an unsubscribe that throws must not mask the result */
            }
            fn(v);
        };
        try {
            off =
                tap.on(cmd, (replyFrame) => {
                    const body = replyFrame?.data;
                    if (!body || (reqId && String(body.reqId ?? "") !== reqId)) return;
                    const err = replyError(body);
                    if (err !== null) {
                        finish(reject, new SignalCommandError(`cmd ${cmd} replied error ${err}`, err));
                        return;
                    }
                    finish(resolve, body);
                }) || (() => {});
        } catch (e) {
            finish(reject, e);
            return;
        }
        timer = timers.setTimeout(
            () =>
                finish(
                    reject,
                    new SignalCommandError(`cmd ${cmd} got no reply within ${Math.round(timeoutMs / 1000)}s`),
                ),
            timeoutMs,
        );
        try {
            send(frame);
        } catch (e) {
            finish(reject, e);
        }
    });
}

/**
 * A `subscribe` for {@link import("./cloud-key-transfer.js").requestCloudKey}: taps cmd 601 and hands each
 * `personal_cloud` control (shape `{actType, act, data}`) to the handler. Returns the unsubscribe.
 *
 * @param {{on: (cmd: number, fn: (frame: object) => void) => (() => void)}} tap
 * @returns {(handler: (control: {actType: string, act: string, data: object|null}) => void) => (() => void)}
 */
export function subscribeCloudControls(tap) {
    return (handler) =>
        tap.on(CMD_PUSH_CONTROLS, (frame) => {
            for (const c of readControls(frame?.data)) {
                handler({ actType: c.actType, act: c.act, data: c.data });
            }
        });
}

/**
 * List the account's end-to-end-encryption devices and which platform slots are occupied (read-only; sends 563).
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{devices: Array<{deviceId: number, platform: string}>, occupiedSlots: number[], raw: object|null}>}
 */
export async function listDevicesLive({ send, tap, ownUid, timeoutMs }) {
    const reply = await sendSignalCommand({ send, tap, frame: encodeListDevices({ reqId: randomUUID() }), timeoutMs });
    return decodeDeviceList(reply, ownUid);
}

/**
 * Which key id this platform slot holds (sends 564).
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {number} args.deviceId
 * @param {number} [args.timeoutMs]
 * @returns {Promise<object>} the reply's `data`
 */
export async function getKeyIdLive({ send, tap, deviceId, timeoutMs }) {
    return sendSignalCommand({ send, tap, frame: encodeGetKeyId({ deviceId, reqId: randomUUID() }), timeoutMs });
}

/**
 * Publish a bundle (register the device; sends 540). This makes the device account-visible — the irreversible step the
 * `cloud key setup` command guards behind `--confirm`.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {object} args.bundle - from src/zalo/e2ee bundleFromStore
 * @param {number} args.deviceId
 * @param {boolean} [args.deleteExistingSessions]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<object>} the reply's `data`
 */
export async function submitBundleLive({ send, tap, bundle, deviceId, deleteExistingSessions = false, timeoutMs }) {
    return sendSignalCommand({
        send,
        tap,
        frame: encodeSubmitBundle({ bundle, deviceId, reqId: randomUUID(), deleteExistingSessions }),
        timeoutMs,
    });
}

/**
 * Run `fn({ send, tap })` over a one-off live socket for a logged-in account, then close it. LIVE and unverified; it
 * starts the listener, waits for the handshake's cipher key, attaches a socket tap, and tears everything down after.
 * The caller must have confirmed no daemon holds the socket (one WebSocket per account).
 *
 * @param {object} api - a logged-in api (has `.listener`)
 * @param {(io: {send: (payload: object) => void, tap: object}) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.handshakeTimeoutMs]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<any>}
 */
export async function withLiveSocket(api, fn, { handshakeTimeoutMs = 20_000, log = () => {} } = {}) {
    const listener = api?.listener;
    if (!listener) throw new SignalCommandError("no live socket is available (log in first)");
    const tap = createSocketTap({ log });
    tap.attach(listener);
    await new Promise((resolve, reject) => {
        let done = false;
        const settle = (fnx, v) => {
            if (done) return;
            done = true;
            listener.removeListener?.("cipher_key", onHello);
            listener.removeListener?.("error", onErr);
            clearTimeout(t);
            fnx(v);
        };
        const onHello = () => settle(resolve, undefined);
        const onErr = (e) => settle(reject, e instanceof Error ? e : new SignalCommandError(String(e)));
        const t = setTimeout(
            () => settle(reject, new SignalCommandError("the socket did not hand over its key in time")),
            handshakeTimeoutMs,
        );
        listener.on("cipher_key", onHello);
        listener.on("error", onErr);
        // The tap re-attaches on every new socket the listener opens (its `connected` event).
        listener.start({ retryOnClose: false });
    });
    try {
        return await fn({ send: (payload) => listener.sendWs(payload), tap });
    } finally {
        try {
            listener.stop();
        } catch {
            /* closing a socket that is already going away */
        }
    }
}
