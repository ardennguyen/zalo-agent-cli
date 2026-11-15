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
    decodeBundleItem,
    encodeGetBundle,
    encodeGetKeyId,
    encodeInitSession,
    encodeSubmitBundle,
    platformName,
    replyError,
} from "../zalo/e2ee/bundle-wire.js";
import { buildSubdeviceInit } from "../zalo/e2ee/subdevice-init.js";

/** The GET_BUNDLE device id that asks for every one of the account's registered devices at once. */
export const ALL_DEVICES = -1;

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
 * Whether the secret-free diagnostic mode is on (`ZALO_E2EE_DEBUG=1`), for tracing the registration round live.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function e2eeDebugEnabled(env = process.env) {
    const v = env.ZALO_E2EE_DEBUG;
    return Boolean(v) && v !== "0" && String(v).toLowerCase() !== "false";
}

/**
 * A secret-free description of a value: field names, numeric values (error/status codes, user_action, counts),
 * booleans, and string/array LENGTHS only — never a string's or buffer's contents. Used by {@link e2eeDebug}.
 *
 * @param {*} v
 * @param {number} [depth]
 * @returns {*}
 */
export function describeShape(v, depth = 3) {
    if (v === null || v === undefined) return v === null ? null : "undefined";
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") return `str(${v.length})`;
    if (Array.isArray(v)) {
        if (depth <= 0) return `arr(${v.length})`;
        return { _array: v.length, first: v.length ? describeShape(v[0], depth - 1) : undefined };
    }
    if (typeof v === "object") {
        if (depth <= 0) return `obj{${Object.keys(v).join(",")}}`;
        const out = {};
        for (const k of Object.keys(v)) out[k] = describeShape(v[k], depth - 1);
        return out;
    }
    return typeof v;
}

/**
 * Log, to stderr, the shape of a labeled value when {@link e2eeDebugEnabled}. Never logs key bytes, private keys,
 * encrypted payloads, tokens or cookies — only field names, numeric codes, booleans and lengths.
 *
 * @param {string} label
 * @param {*} value
 */
export function e2eeDebug(label, value) {
    if (!e2eeDebugEnabled()) return;
    try {
        console.error(`[e2ee-debug] ${label}: ${JSON.stringify(describeShape(value))}`);
    } catch {
        console.error(`[e2ee-debug] ${label}: <unprintable>`);
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
    debugLabel = null,
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
                    if (debugLabel) e2eeDebug(`${debugLabel} reply (cmd ${cmd})`, body);
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
                if (c.actType === "personal_cloud") {
                    // Surface the control's shape (user_action is a numeric code; encrypted_private_key shows only its
                    // length) so a live round shows an approval vs a refusal vs a malformed reply.
                    e2eeDebug(`pcloud control ${c.act}`, c.data);
                }
                handler({ actType: c.actType, act: c.act, data: c.data });
            }
        });
}

/**
 * Parse a GET_BUNDLE reply into the account's device bundles. The reply nests them as
 * `data.keys = [{uid, err, keys: [ {deviceId, registrationId, identityKey, signedPreKey, preKey}, … ]}]` — one outer
 * entry per uid, whose inner `keys` are the per-device bundles (the client's `_convertBundle` reads each inner entry).
 *
 * @param {object|null} reply - the decoded frame's `data` (`{reqId, data:{keys, errData}}`)
 * @param {string} ownUid
 * @returns {Array<ReturnType<typeof decodeBundleItem>>}
 */
export function parseBundleReply(reply, ownUid) {
    const payload = reply?.data ?? null;
    const outer = Array.isArray(payload?.keys) ? payload.keys : [];
    const forUid = outer.find((e) => String(e?.uid) === String(ownUid)) ?? (outer.length === 1 ? outer[0] : null);
    const inner = Array.isArray(forUid?.keys) ? forUid.keys : [];
    const out = [];
    for (const item of inner) {
        try {
            out.push(decodeBundleItem(item));
        } catch {
            /* a malformed per-device entry is skipped */
        }
    }
    return out;
}

/**
 * Fetch all of the account's registered device bundles in one GET_BUNDLE (deviceId -1), the way the client does for its
 * subdevice init. This doubles as the account's end-to-end-encryption device registry.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{bundles: Array<ReturnType<typeof decodeBundleItem>>, raw: object|null}>}
 */
export async function getAllBundlesLive({ send, tap, ownUid, timeoutMs }) {
    const reply = await sendSignalCommand({
        send,
        tap,
        frame: encodeGetBundle({ uid: ownUid, deviceId: ALL_DEVICES, reqId: randomUUID() }),
        timeoutMs,
        debugLabel: "GET_BUNDLE 541 (all devices)",
    });
    return { bundles: parseBundleReply(reply, ownUid), raw: reply?.data ?? null };
}

/**
 * List the account's end-to-end-encryption devices and which platform slots are occupied, from the device bundles
 * (GET_BUNDLE -1). This is the real device registry; cmd 563 returns chat sessions, not the device list.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{devices: Array<{deviceId: number, platform: string}>, occupiedSlots: number[]}>}
 */
export async function listMyDevicesLive({ send, tap, ownUid, timeoutMs }) {
    const { bundles } = await getAllBundlesLive({ send, tap, ownUid, timeoutMs });
    const occupiedSlots = [...new Set(bundles.map((b) => b.deviceId))].sort((a, b) => a - b);
    return { devices: occupiedSlots.map((id) => ({ deviceId: id, platform: platformName(id) })), occupiedSlots };
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
    return sendSignalCommand({
        send,
        tap,
        frame: encodeGetKeyId({ deviceId, reqId: randomUUID() }),
        timeoutMs,
        debugLabel: "GET_KEY_ID 564",
    });
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
        debugLabel: "SUBMIT_BUNDLE 540",
    });
}

/**
 * The INIT_SUBDEVICE phase: from the account's device bundles (GET_BUNDLE -1), build a Signal session to each device
 * other than ours and announce them with one INIT_SESSION (543). Mutates `store` (it gains the sessions); the caller
 * persists it. This builds OUTBOUND sessions for sending end-to-end messages; it is NOT needed to receive the cloud key
 * (that is a pre-key message addressed to our submitted bundle), so the caller does not block the key request on it.
 * Never throws on a per-device miss.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} args.deviceId - our own slot
 * @param {import("../zalo/e2ee/signal-store.js").SignalProtocolStore} args.store
 * @param {Array<ReturnType<typeof decodeBundleItem>>} args.bundles - the account's device bundles (GET_BUNDLE -1)
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{built: number[], skipped: number[], reply: object|null}>}
 */
export async function initSubdevicesLive({ send, tap, ownUid, deviceId, store, bundles, timeoutMs }) {
    const peers = (bundles ?? []).filter((b) => Number(b.deviceId) !== Number(deviceId));
    const entries = [];
    const built = [];
    const skipped = [];
    for (const bundleItem of peers) {
        try {
            const initMsg = await buildSubdeviceInit({ store, ownUid, deviceId: bundleItem.deviceId, bundleItem });
            entries.push({ deviceId: bundleItem.deviceId, initMsg });
            built.push(bundleItem.deviceId);
        } catch (e) {
            e2eeDebug(`INIT_SUBDEVICE slot ${bundleItem.deviceId}: build failed`, {
                message: `str(${String(e?.message ?? "").length})`,
            });
            skipped.push(bundleItem.deviceId);
        }
    }
    let reply = null;
    if (entries.length) {
        reply = await sendSignalCommand({
            send,
            tap,
            frame: encodeInitSession({ uidTo: ownUid, entries, reqId: randomUUID() }),
            timeoutMs,
            debugLabel: "INIT_SESSION 543",
        });
    } else {
        e2eeDebug("INIT_SUBDEVICE", { built: 0, skipped: skipped.length });
    }
    return { built, skipped, reply };
}

/**
 * The full connect-time registration sequence the client runs after the socket authenticates:
 * GET_KEY_ID(564) → SUBMIT_BUNDLE(540) → INIT_SUBDEVICE. Registration is confirmed by SUBMIT_BUNDLE's success
 * (`err:0`, which {@link sendSignalCommand} enforces, with its `iid` matching the GET_KEY_ID `keyId`) — NOT by cmd 563,
 * which lists chat sessions, not the device registry. After submitting, the account's device bundles (GET_BUNDLE -1)
 * should include our slot, which this also reports. The subdevice sessions are built best-effort and never gate the
 * result. LIVE and unverified.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} args.deviceId
 * @param {object} args.bundle - from bundleFromStore
 * @param {import("../zalo/e2ee/signal-store.js").SignalProtocolStore} args.store
 * @param {boolean} [args.deleteExistingSessions]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{registered: boolean, keyId: *, iid: *, keyMatches: boolean, listedInBundles: boolean,
 *   occupiedSlots: number[], devices: object[], subdevices: object}>}
 */
export async function registerDeviceLive({
    send,
    tap,
    ownUid,
    deviceId,
    bundle,
    store,
    deleteExistingSessions = false,
    timeoutMs,
}) {
    const keyIdReply = await getKeyIdLive({ send, tap, deviceId, timeoutMs });
    const keyId = keyIdReply?.data?.keyId ?? null;
    // SUBMIT_BUNDLE throwing (err !== 0) is the only failure; resolving means the server accepted the bundle.
    const submitReply = await submitBundleLive({ send, tap, bundle, deviceId, deleteExistingSessions, timeoutMs });
    const iid = submitReply?.data?.iid ?? null;
    // The account's device bundles now (GET_BUNDLE -1): our slot should appear, and the others feed INIT_SUBDEVICE.
    const { bundles } = await getAllBundlesLive({ send, tap, ownUid, timeoutMs });
    const listedInBundles = bundles.some((b) => Number(b.deviceId) === Number(deviceId));
    const subdevices = await initSubdevicesLive({ send, tap, ownUid, deviceId, store, bundles, timeoutMs });
    const occupiedSlots = [...new Set(bundles.map((b) => b.deviceId))].sort((a, b) => a - b);
    const keyMatches = keyId !== null && iid !== null && String(keyId) === String(iid);
    e2eeDebug("registerDeviceLive result", {
        slot: Number(deviceId),
        registered: true,
        keyMatches,
        listedInBundles,
        occupiedSlots,
        subdevicesBuilt: subdevices.built.length,
    });
    return {
        // SUBMIT_BUNDLE accepted (it did not throw) = registered. The bundle list and iid match are confirmations.
        registered: true,
        keyId,
        iid,
        keyMatches,
        listedInBundles,
        occupiedSlots,
        devices: occupiedSlots.map((id) => ({ deviceId: id, platform: platformName(id) })),
        subdevices,
    };
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
