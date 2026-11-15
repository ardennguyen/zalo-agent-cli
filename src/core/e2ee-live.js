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
    LIST_SUBDEVICES,
    decodeBundleItem,
    encodeGetBundle,
    encodeGetKeyId,
    encodeInitSession,
    encodeSubmitBundle,
    platformName,
    replyError,
} from "../zalo/e2ee/bundle-wire.js";
import { buildSubdeviceInit } from "../zalo/e2ee/subdevice-init.js";

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
 * Parse a GET_BUNDLE reply into device bundles. The reply nests them as
 * `data.keys = [{uid, err, keys: [ {deviceId, registrationId, identityKey, signedPreKey, preKey}, … ]}]` — one outer
 * entry per uid, whose inner `keys` are the per-device bundles (the client's `_convertBundle` reads each inner entry).
 * A per-device request may omit the inner `deviceId`; `fallbackDeviceId` fills it in then.
 *
 * @param {object|null} reply - the decoded frame's `data` (`{reqId, data:{keys, errData}}`)
 * @param {string} ownUid
 * @param {number|null} [fallbackDeviceId]
 * @returns {Array<ReturnType<typeof decodeBundleItem>>}
 */
export function parseBundleReply(reply, ownUid, fallbackDeviceId = null) {
    const payload = reply?.data ?? null;
    const outer = Array.isArray(payload?.keys) ? payload.keys : [];
    const forUid = outer.find((e) => String(e?.uid) === String(ownUid)) ?? (outer.length === 1 ? outer[0] : null);
    const inner = Array.isArray(forUid?.keys) ? forUid.keys : [];
    const out = [];
    for (const item of inner) {
        const withId =
            item && (item.deviceId === undefined || item.deviceId === null) && fallbackDeviceId !== null
                ? { ...item, deviceId: fallbackDeviceId }
                : item;
        try {
            out.push(decodeBundleItem(withId));
        } catch {
            /* a malformed per-device entry is skipped */
        }
    }
    return out;
}

/**
 * Fetch one platform slot's device bundle (GET_BUNDLE for that deviceId), or null when the slot has none. Per-slot is
 * what reliably returns the account's other devices (the phone/pc); a deviceId -1 "all devices" call was observed to
 * return only the requesting device.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} args.deviceId
 * @param {number} [args.timeoutMs]
 * @returns {Promise<ReturnType<typeof decodeBundleItem>|null>}
 */
export async function getBundleForSlot({ send, tap, ownUid, deviceId, timeoutMs }) {
    let reply;
    try {
        reply = await sendSignalCommand({
            send,
            tap,
            frame: encodeGetBundle({ uid: ownUid, deviceId, reqId: randomUUID() }),
            timeoutMs,
        });
    } catch {
        // A slot with no device replies an error; that is "no bundle", not a failure.
        return null;
    }
    // Match the requested slot. parseBundleReply fills a missing deviceId with the slot, so a single per-slot bundle
    // matches; a multi-device reply only yields the entry for this slot (never a misattributed first item).
    const items = parseBundleReply(reply, ownUid, Number(deviceId));
    return items.find((i) => Number(i.deviceId) === Number(deviceId)) ?? null;
}

/**
 * List the account's end-to-end-encryption devices and which platform slots are occupied, by probing each platform slot
 * (GET_BUNDLE per slot). This is the real device registry; cmd 563 returns chat sessions, not the device list.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{devices: Array<{deviceId: number, platform: string}>, occupiedSlots: number[]}>}
 */
export async function listMyDevicesLive({ send, tap, ownUid, timeoutMs }) {
    const found = [];
    for (const slot of LIST_SUBDEVICES) {
        const b = await getBundleForSlot({ send, tap, ownUid, deviceId: slot, timeoutMs });
        if (b) found.push(slot);
    }
    const occupiedSlots = [...new Set(found)].sort((a, b) => a - b);
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
    });
}

/**
 * The INIT_SUBDEVICE phase: from the account's device bundles (GET_BUNDLE -1), build a Signal session to each device
 * other than ours and announce them with one INIT_SESSION (543). Mutates `store` (it gains the sessions); the caller
 * persists it. The phone answers the cloud-key request on the session this announcement sets up (a normal message on
 * it), so the announcement has to reach the phone in the clients' format. Never throws on a per-device miss.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} args.deviceId - our own slot
 * @param {import("../zalo/e2ee/signal-store.js").SignalProtocolStore} args.store
 * @param {Array<ReturnType<typeof decodeBundleItem>>} args.bundles - the account's other device bundles (per-slot)
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
        } catch {
            skipped.push(bundleItem.deviceId);
        }
    }
    let reply = null;
    if (entries.length) {
        reply = await sendSignalCommand({
            send,
            tap,
            frame: encodeInitSession({ uidTo: ownUid, entries, reqId: randomUUID(), enable: false }),
            timeoutMs,
        });
    }
    return { built, skipped, reply };
}

/**
 * The full connect-time registration sequence the client runs after the socket authenticates:
 * GET_KEY_ID(564) → SUBMIT_BUNDLE(540) → INIT_SUBDEVICE. Registration is confirmed by SUBMIT_BUNDLE's success
 * (`err:0`, which {@link sendSignalCommand} enforces, with its `iid` matching the GET_KEY_ID `keyId`) — NOT by cmd 563,
 * which lists chat sessions, not the device registry. After submitting, it probes each platform slot's bundle
 * (per-slot GET_BUNDLE): our slot should appear, and the others feed INIT_SUBDEVICE. The subdevice sessions are built
 * best-effort and never gate the result. LIVE and unverified.
 *
 * @param {object} args
 * @param {(payload: object) => void} args.send
 * @param {object} args.tap
 * @param {string} args.ownUid
 * @param {number} args.deviceId
 * @param {object} args.bundle - from bundleFromStore
 * @param {import("../zalo/e2ee/signal-store.js").SignalProtocolStore} args.store
 * @param {boolean} [args.deleteExistingSessions] - default true, as the client sends it (delSS=1): the server
 *   then tells the account's other devices to drop their sessions with this slot, so they fetch the new bundle instead
 *   of encrypting to one they cached
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
    deleteExistingSessions = true,
    timeoutMs,
}) {
    const keyIdReply = await getKeyIdLive({ send, tap, deviceId, timeoutMs });
    const keyId = keyIdReply?.data?.keyId ?? null;
    // SUBMIT_BUNDLE throwing (err !== 0) is the only failure; resolving means the server accepted the bundle.
    const submitReply = await submitBundleLive({ send, tap, bundle, deviceId, deleteExistingSessions, timeoutMs });
    const iid = submitReply?.data?.iid ?? null;
    // Probe each platform slot's bundle (the real device registry): our slot should appear, the others feed INIT_SUBDEVICE.
    const bundlesBySlot = {};
    for (const slot of LIST_SUBDEVICES) {
        const b = await getBundleForSlot({ send, tap, ownUid, deviceId: slot, timeoutMs });
        if (b) bundlesBySlot[slot] = b;
    }
    const occupiedSlots = Object.keys(bundlesBySlot)
        .map(Number)
        .sort((a, b) => a - b);
    const listedInBundles = occupiedSlots.includes(Number(deviceId));
    const peerBundles = occupiedSlots.filter((s) => s !== Number(deviceId)).map((s) => bundlesBySlot[s]);
    const subdevices = await initSubdevicesLive({
        send,
        tap,
        ownUid,
        deviceId,
        store,
        bundles: peerBundles,
        timeoutMs,
    });
    const keyMatches = keyId !== null && iid !== null && String(keyId) === String(iid);
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
