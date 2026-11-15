/**
 * Request the account's zCloud cloud key from the phone, wait for the reply, and hand back the key material.
 *
 * The request is small: a GET to `.../personalcloud_key/req_cloud_key` carrying `{device_name, session_id}`. The
 * phone shows the owner a prompt; when they approve, the reply arrives on the chat socket as a `601`
 * `personal_cloud` control with act `pcloud_info`, matched on the same `session_id` and `device_name`. On approval
 * (`user_action` 1) the control carries `{key_version, public_key, encrypted_private_key}`; on refusal
 * (`user_action` 0) the phone rejected it.
 *
 * Opening `encrypted_private_key` needs this engine to be a registered end-to-end-encryption device on the account: the
 * reply is a libsignal message the phone (device 0) encrypts to our device's Signal identity. That identity is built and
 * sealed by src/core/e2ee-device.js (keys from the protocol layer, src/zalo/e2ee); when one exists, {@link
 * makeCloudKeyUnwrapper} opens the reply with it and {@link receiveCloudKeyFromPhone} seals the resulting key
 * (src/core/cloud-key-store.js) for reuse. When no device is registered, {@link setupCloudKeyFromPhone} refuses with
 * {@link CloudKeyUnsupportedError} before anything is sent to the phone, and the account's cloud key is supplied at run
 * time instead (`cloud get --key-stdin` / `--key-prompt`).
 *
 * The orchestration in {@link requestCloudKey} is written over injected transports so it runs offline in tests and so
 * the live send (the socket, or the daemon channel when a daemon holds it) is supplied only by the explicit `cloud key
 * setup` command — never by a code path that runs on its own. Registering the device and requesting the key are LIVE,
 * owner-present steps; nothing here taps the phone unless that command is run.
 *
 * SECRETS: no key byte is logged, printed or put in `--json`. A returned/stored key is written only sealed, or held in
 * the caller's memory.
 */
import { randomUUID } from "node:crypto";
import { cloudKeyRequestShape } from "../zalo/zcloud-e2ee.js";
import { decryptCloudKeyReply } from "../zalo/e2ee/cloud-key-decrypt.js";
import { hasE2eeDevice, loadE2eeDevice, saveE2eeDevice } from "./e2ee-device.js";
import { saveCloudKey } from "./cloud-key-store.js";

/** Lower bound on the wait for the phone's reply (the owner may be away from the phone). */
export const CLOUD_KEY_WAIT_FLOOR_MS = 600_000;
/** Hard upper bound so a forgotten request cannot wait forever. */
export const CLOUD_KEY_WAIT_HARD_CAP_MS = 1_800_000;
/** How many times the request itself is re-sent while waiting. */
export const CLOUD_KEY_MAX_RETRY = 3;
/** The gap between those re-sends. */
export const CLOUD_KEY_RETRY_GAP_MS = 5_000;
/** The control family and act that carries the phone's reply. */
export const PCLOUD_CONTROL_ACT_TYPE = "personal_cloud";
export const PCLOUD_INFO_ACT = "pcloud_info";
/** `user_action` on the reply: the owner approved, or refused, the request. */
export const PCLOUD_ACTION_APPROVED = 1;
export const PCLOUD_ACTION_REFUSED = 0;

/** Base class for the errors this module raises. */
export class CloudKeyError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyError";
    }
}

/** The key cannot be fetched from the phone because this engine has no end-to-end-encryption device. */
export class CloudKeyUnsupportedError extends CloudKeyError {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyUnsupportedError";
    }
}

/** The owner refused the request on the phone. */
export class CloudKeyRefusedError extends CloudKeyError {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyRefusedError";
    }
}

/** The phone did not answer within the bounded wait. */
export class CloudKeyTimeoutError extends CloudKeyError {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyTimeoutError";
    }
}

/**
 * A fresh key-transfer session: a device label plus a one-time id both sides match the reply on.
 *
 * @param {string} deviceName - a label for this device, shown on the phone's prompt
 * @returns {{deviceName: string, sessionId: string}}
 */
export function newCloudKeySession(deviceName) {
    return { deviceName: String(deviceName ?? ""), sessionId: randomUUID() };
}

/**
 * The request parameters for one session (built, not sent here). The live send would issue
 * {@link cloudKeyRequestShape} with these.
 *
 * @param {{deviceName: string, sessionId: string}} session
 * @returns {ReturnType<typeof cloudKeyRequestShape>}
 */
export function cloudKeyRequest(session) {
    return cloudKeyRequestShape({ deviceName: session.deviceName, sessionId: session.sessionId });
}

/**
 * Whether a control belongs to the open session. A reply is ours only when both ids match.
 *
 * @param {{actType?: string, act?: string, data?: object|null}|null} control
 * @param {{deviceName: string, sessionId: string}} session
 * @returns {boolean}
 */
export function matchesCloudKeySession(control, session) {
    const d = control?.data;
    if (!d || typeof d !== "object") return false;
    return (
        String(d.session_id ?? "") === String(session.sessionId) &&
        String(d.device_name ?? "") === String(session.deviceName)
    );
}

/**
 * Read a `pcloud_info` control, or `null` when the control is not one.
 *
 * @param {{actType?: string, act?: string, data?: object|null}|null} control
 * @returns {{userAction: number, keyVersion: *, publicKey: *, encryptedPrivateKey: *}|null}
 */
export function readPcloudInfo(control) {
    if (!control || control.actType !== PCLOUD_CONTROL_ACT_TYPE || control.act !== PCLOUD_INFO_ACT) return null;
    const d = control.data && typeof control.data === "object" ? control.data : {};
    return {
        userAction: Number(d.user_action),
        keyVersion: d.key_version,
        publicKey: d.public_key,
        encryptedPrivateKey: d.encrypted_private_key,
    };
}

/**
 * Read key material from the request's own HTTP reply, which may carry it directly (the server can release the key to a
 * registered device without a separate control). Looks at the object and its `data` / `data.data` nestings for
 * `encrypted_private_key`; returns null when none is present (then the key arrives as a 601 control instead).
 *
 * @param {*} reply - the session-decoded reply body
 * @returns {{userAction: number, keyVersion: *, publicKey: *, encryptedPrivateKey: *}|null}
 */
export function readPcloudReply(reply) {
    for (const d of [reply, reply?.data, reply?.data?.data]) {
        if (d && typeof d === "object" && d.encrypted_private_key) {
            return {
                userAction: d.user_action === undefined ? PCLOUD_ACTION_APPROVED : Number(d.user_action),
                keyVersion: d.key_version,
                publicKey: d.public_key,
                encryptedPrivateKey: d.encrypted_private_key,
            };
        }
    }
    return null;
}

/**
 * Request the key from the phone and wait, bounded, for the reply. Pure orchestration over injected transports; the
 * live entry {@link setupCloudKeyFromPhone} refuses before this is reached. The request is (re-)sent up to `maxRetry`
 * times, `retryGapMs` apart, while a single bounded wait runs for the reply control.
 *
 * @param {object} deps
 * @param {{deviceName: string, sessionId: string}} deps.session
 * @param {(session: object) => (void|Promise<void>)} deps.sendRequest - issues the request to the phone
 * @param {(handler: (control: object) => void) => (void|(() => void))} deps.subscribe - delivers reply controls;
 *   returns an unsubscribe when it offers one
 * @param {(encryptedPrivateKey: *) => (string|Promise<string>)} deps.unwrapPrivateKey - opens
 *   `encrypted_private_key` into base64 PKCS#8; the live one throws {@link CloudKeyUnsupportedError}
 * @param {() => void} [deps.onPrompt] - called once after the first send (e.g. to print "approve on your phone")
 * @param {number} [deps.waitMs] - the overall wait, clamped to {@link CLOUD_KEY_WAIT_HARD_CAP_MS}
 * @param {number} [deps.maxRetry]
 * @param {number} [deps.retryGapMs]
 * @param {number} [deps.hardCapMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] - injectable for tests
 * @returns {Promise<{privateKeyPkcs8Base64: string, keyVersion: *, publicKey: *}>}
 */
export function requestCloudKey({
    session,
    sendRequest,
    subscribe,
    unwrapPrivateKey,
    onPrompt = () => {},
    waitMs = CLOUD_KEY_WAIT_FLOOR_MS,
    maxRetry = CLOUD_KEY_MAX_RETRY,
    retryGapMs = CLOUD_KEY_RETRY_GAP_MS,
    hardCapMs = CLOUD_KEY_WAIT_HARD_CAP_MS,
    timers = { setTimeout, clearTimeout },
}) {
    if (
        !session ||
        typeof sendRequest !== "function" ||
        typeof subscribe !== "function" ||
        typeof unwrapPrivateKey !== "function"
    ) {
        return Promise.reject(
            new CloudKeyError("requestCloudKey needs a session, sendRequest, subscribe and unwrapPrivateKey"),
        );
    }
    const deadlineMs = Math.min(Math.max(Number(waitMs) || 0, 1), hardCapMs);
    return new Promise((resolve, reject) => {
        let settled = false;
        let off = () => {};
        const pending = new Set();
        const cleanup = () => {
            for (const t of pending) timers.clearTimeout(t);
            pending.clear();
            try {
                off();
            } catch {
                /* an unsubscribe that throws must not mask the result */
            }
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        // Open the key material from a reply (a 601 control, or the key fields carried in the request's own HTTP reply).
        const settleFromInfo = (info) => {
            if (settled || !info) return;
            if (info.userAction === PCLOUD_ACTION_REFUSED) {
                finish(reject, new CloudKeyRefusedError("the phone refused the cloud-key request"));
                return;
            }
            if (info.userAction !== PCLOUD_ACTION_APPROVED) return;
            if (!info.encryptedPrivateKey) return;
            Promise.resolve()
                .then(() => unwrapPrivateKey(info.encryptedPrivateKey))
                .then((privateKeyPkcs8Base64) => {
                    if (!privateKeyPkcs8Base64) throw new CloudKeyError("the phone's reply held no key");
                    finish(resolve, {
                        privateKeyPkcs8Base64: String(privateKeyPkcs8Base64),
                        keyVersion: info.keyVersion,
                        publicKey: info.publicKey,
                    });
                })
                .catch((e) => finish(reject, e));
        };

        const onControl = (control) => {
            if (settled) return;
            let info;
            try {
                info = readPcloudInfo(control);
            } catch {
                return;
            }
            if (!info || !matchesCloudKeySession(control, session)) return;
            settleFromInfo(info);
        };

        try {
            off = subscribe(onControl) || (() => {});
        } catch (e) {
            finish(reject, e);
            return;
        }

        pending.add(
            timers.setTimeout(
                () =>
                    finish(
                        reject,
                        new CloudKeyTimeoutError(`no reply from the phone within ${Math.round(deadlineMs / 1000)}s`),
                    ),
                deadlineMs,
            ),
        );

        let attempt = 0;
        const sendOnce = async () => {
            if (settled) return;
            attempt += 1;
            try {
                // The request's own reply may already carry the key (the server can release it to a registered device
                // without a separate control); if so, settle from it. Otherwise it is an ack and the key arrives as a
                // 601 control handled by onControl.
                const reply = await sendRequest(session);
                if (attempt === 1) onPrompt();
                const info = readPcloudReply(reply);
                if (info) settleFromInfo(info);
            } catch (e) {
                if (settled) return;
                if (attempt >= maxRetry) {
                    finish(reject, e);
                    return;
                }
            }
            if (!settled && attempt < maxRetry) {
                pending.add(timers.setTimeout(() => void sendOnce(), retryGapMs));
            }
        };
        void sendOnce();
    });
}

/**
 * Whether this engine has a registered end-to-end-encryption device identity on the account for the phone to encrypt
 * the cloud key to. True once `cloud key setup` has sealed one (src/core/e2ee-device.js).
 *
 * @param {string} [ownId]
 * @returns {boolean}
 */
export function isE2eeDeviceRegistered(ownId) {
    return Boolean(ownId) && hasE2eeDevice(ownId);
}

/**
 * An `unwrapPrivateKey` bound to an account's sealed device: it opens `encrypted_private_key` with the device's Signal
 * identity and re-seals the device store (a pre-key reply consumes a one-time pre-key). Returned as a function so
 * {@link requestCloudKey} can stay a pure orchestration.
 *
 * @param {object} args
 * @param {string} args.ownId - the account id; it is also the sender (own uid, device 0 = the phone)
 * @returns {(encryptedPrivateKey: string) => Promise<string>} base64 PKCS#8
 * @throws {CloudKeyUnsupportedError} when no device is registered
 */
export function makeCloudKeyUnwrapper({ ownId }) {
    if (!isE2eeDeviceRegistered(ownId)) {
        throw new CloudKeyUnsupportedError(
            "no registered end-to-end-encryption device for this account; run `cloud key setup` first",
        );
    }
    return async (encryptedPrivateKey) => {
        const device = loadE2eeDevice(ownId);
        if (!device) throw new CloudKeyUnsupportedError("the device identity could not be loaded (locked?)");
        const pkcs8 = await decryptCloudKeyReply({ store: device.store, encryptedPrivateKey, ownUid: String(ownId) });
        // The store changed (a one-time pre-key was consumed); persist it so it is not reused.
        saveE2eeDevice(ownId, device);
        return pkcs8;
    };
}

/**
 * Receive the cloud key from the phone and seal it. The caller supplies the live transports (`sendRequest`,
 * `subscribe`) from the account's socket, or the daemon channel when a daemon holds it; this function is reached only by
 * the explicit `cloud key setup` command, never automatically. It requires a registered device.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {string} args.deviceName - label shown on the phone prompt
 * @param {(session: object) => (void|Promise<void>)} args.sendRequest
 * @param {(handler: (control: object) => void) => (void|(() => void))} args.subscribe
 * @param {() => void} [args.onPrompt]
 * @param {number} [args.waitMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [args.timers]
 * @returns {Promise<{stored: true, keyVersion: *, publicKey: *}>} never the key itself
 */
export async function receiveCloudKeyFromPhone({
    ownId,
    deviceName,
    sendRequest,
    subscribe,
    onPrompt,
    waitMs,
    timers,
}) {
    const unwrapPrivateKey = makeCloudKeyUnwrapper({ ownId });
    const session = newCloudKeySession(deviceName);
    const result = await requestCloudKey({
        session,
        sendRequest,
        subscribe,
        unwrapPrivateKey,
        onPrompt,
        waitMs,
        timers,
    });
    saveCloudKey(ownId, {
        privateKeyPkcs8Base64: result.privateKeyPkcs8Base64,
        keyVersion: result.keyVersion,
        publicKey: result.publicKey,
    });
    return { stored: true, keyVersion: result.keyVersion, publicKey: result.publicKey };
}

/**
 * The gated live entry `cloud key setup` reaches after it has registered the device. When no device is registered it
 * refuses before tapping the phone; otherwise it receives and seals the key via {@link receiveCloudKeyFromPhone}. It is
 * never invoked by a code path that runs on its own — only by the explicit command, with the owner present.
 *
 * @param {object} [opts]
 * @param {string} [opts.ownId]
 * @param {string} [opts.deviceName]
 * @param {(session: object) => (void|Promise<void>)} [opts.sendRequest]
 * @param {(handler: (control: object) => void) => (void|(() => void))} [opts.subscribe]
 * @param {() => void} [opts.onPrompt]
 * @param {number} [opts.waitMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @returns {Promise<{stored: true, keyVersion: *, publicKey: *}>}
 * @throws {CloudKeyUnsupportedError} when no device is registered, or the live transports were not supplied
 */
export async function setupCloudKeyFromPhone(opts = {}) {
    if (!isE2eeDeviceRegistered(opts.ownId)) {
        throw new CloudKeyUnsupportedError(
            "Fetching the cloud key from the phone needs a registered end-to-end-encryption device on the account, " +
                "which this engine does not have yet: register one with `cloud key setup`, or supply the cloud key at " +
                "run time instead (`cloud get --key-stdin` or `--key-prompt`).",
        );
    }
    if (typeof opts.sendRequest !== "function" || typeof opts.subscribe !== "function") {
        // The live socket transports are supplied only by the command; without them there is nothing to tap.
        throw new CloudKeyUnsupportedError("cloud-key transfer needs a live socket; run it from `cloud key setup`");
    }
    return receiveCloudKeyFromPhone(opts);
}
