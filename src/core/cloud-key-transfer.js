/**
 * Request the account's zCloud cloud key from the phone, wait for the reply, and hand back the key material.
 *
 * The request is small: a GET to `.../personalcloud_key/req_cloud_key` carrying `{device_name, session_id}`. The
 * phone shows the owner a prompt; when they approve, the reply arrives on the chat socket as a `601`
 * `personal_cloud` control with act `pcloud_info`, matched on the same `session_id` and `device_name`. On approval
 * (`user_action` 1) the control carries `{key_version, public_key, encrypted_private_key}`; on refusal
 * (`user_action` 0) the phone rejected it.
 *
 * The part this engine cannot do is open `encrypted_private_key`: it is a libsignal (end-to-end-encryption) message
 * addressed to a device identity registered on the account (the account itself, device 0 = the phone, is the sender).
 * Opening it needs a full end-to-end-encryption device on the account — an identity key, a registration id, published
 * pre-keys and a session store kept across runs — which is a product-sized effort (decision D-D) that also changes the
 * account's device set. This engine registers no such device, so {@link setupCloudKeyFromPhone} refuses with
 * {@link CloudKeyUnsupportedError} before anything is sent to the phone.
 *
 * The orchestration in {@link requestCloudKey} is written over injected transports so it runs offline in tests and is
 * ready to wire the day that device stack exists; it is never connected to tap the phone while the key it would return
 * cannot be opened. Until then the account's cloud key is supplied at run time (`cloud get --key-stdin` /
 * `--key-prompt`) and never fetched from the phone.
 *
 * SECRETS: no key byte is logged, printed or stored by this module. A returned private key is held in memory by the
 * caller only.
 */
import { randomUUID } from "node:crypto";
import { cloudKeyRequestShape } from "../zalo/zcloud-e2ee.js";

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

        const onControl = (control) => {
            if (settled) return;
            let info;
            try {
                info = readPcloudInfo(control);
            } catch {
                return;
            }
            if (!info || !matchesCloudKeySession(control, session)) return;
            if (info.userAction === PCLOUD_ACTION_REFUSED) {
                finish(reject, new CloudKeyRefusedError("the phone refused the cloud-key request"));
                return;
            }
            if (info.userAction !== PCLOUD_ACTION_APPROVED) return;
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
                await sendRequest(session);
                if (attempt === 1) onPrompt();
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
 * the cloud key to. This engine registers none, so this is always false today; it is the single switch the day the
 * device stack (decision D-D) is built.
 *
 * @returns {boolean}
 */
export function isE2eeDeviceRegistered() {
    return false;
}

/**
 * The live entry a command would call to fetch the cloud key from the phone. It refuses before tapping the phone,
 * because the reply would be a libsignal message this engine cannot open.
 *
 * @param {object} [_opts] - reserved for the live wiring (account dir, device name, wait, daemon routing)
 * @returns {Promise<never>}
 * @throws {CloudKeyUnsupportedError} always, today
 */
export async function setupCloudKeyFromPhone(_opts = {}) {
    if (!isE2eeDeviceRegistered()) {
        throw new CloudKeyUnsupportedError(
            "Fetching the cloud key from the phone needs a registered end-to-end-encryption device on the account, " +
                "which this engine does not have: the phone encrypts the key to that device's identity, so the reply " +
                "cannot be opened here. Supply the cloud key at run time instead (`cloud get --key-stdin` or " +
                "`--key-prompt`).",
        );
    }
    // Unreachable today. The live request + bounded wait (routed through the daemon channel when a daemon holds the
    // one socket for this account) would be wired here once such a device exists.
    throw new CloudKeyUnsupportedError("cloud-key transfer from the phone is not wired");
}
