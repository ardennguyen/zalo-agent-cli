/**
 * Get the account's zCloud key from the phone and seal it: the one routine behind `cloud key setup` and the step a QR
 * login runs on its own.
 *
 * On an authenticated socket it registers this engine as the account's end-to-end-encryption device for a platform
 * slot (GET_KEY_ID, SUBMIT_BUNDLE, the subdevice init), asks zCloud for the key, and waits for the phone's answer on
 * the session the init set up. The phone answers a registered device without a prompt. The key is decrypted and
 * sealed under the account's data key (src/core/cloud-key-store.js); it is never printed or logged.
 */
import { bundleFromStore, DEVICE_IDS } from "../zalo/e2ee/index.js";
import { getCloudQuota, requestCloudKeyFromPhone } from "../zalo/zcloud.js";
import {
    createE2eeDevice,
    hasE2eeDevice,
    loadE2eeDevice,
    markE2eeDeviceSubmitted,
    saveE2eeDevice,
} from "./e2ee-device.js";
import { getKeyIdLive, registerDeviceLive, subscribeCloudControls } from "./e2ee-live.js";
import { receiveCloudKeyFromPhone } from "./cloud-key-transfer.js";

/** The label the key request carries. */
export const CLOUD_KEY_DEVICE_NAME = "zalo-agent-cli";

/**
 * Whether this account has anything a cloud key opens: a zCloud plan (active or in its grace period), or files still
 * kept in zCloud after it lapsed. A free account that never used zCloud has none, and is not registered for nothing.
 *
 * @param {{planCode: number|null, usageBytes: number|null}} quota - from getCloudQuota()
 * @returns {boolean}
 */
export function cloudKeyWanted(quota) {
    if (!quota) return false;
    if (quota.planCode === 0 || quota.planCode === 100) return true;
    return Number(quota.usageBytes) > 0;
}

/**
 * Ask zCloud whether this account needs a cloud key ({@link cloudKeyWanted}). An unreadable answer counts as no.
 *
 * @param {object} api
 * @returns {Promise<boolean>}
 */
export async function accountWantsCloudKey(api) {
    try {
        return cloudKeyWanted(await getCloudQuota(api));
    } catch {
        return false;
    }
}

/**
 * Register the device and receive the cloud key, over a live socket the caller holds.
 *
 * The stored identity is reused only while the server still serves it for the slot (GET_KEY_ID names the registration
 * id it holds); otherwise a fresh identity is made, since the server keeps a bundle it already knows and does not take
 * the same identity back.
 *
 * @param {object} args
 * @param {object} args.api - the logged-in session
 * @param {string} args.ownId
 * @param {(payload: object) => void} args.send - the socket's sender
 * @param {object} args.tap - the socket's frame tap
 * @param {number} [args.slot] - the platform slot (default: web)
 * @param {number} [args.waitMs] - how long to wait for the phone's answer
 * @param {(reg: object) => void} [args.onRegistered] - after the device is registered, before the key request
 * @param {() => void} [args.onPrompt] - when the request is sent and the answer is awaited
 * @returns {Promise<{reg: object, keyVersion: number|null}>}
 */
export async function obtainCloudKey({ api, ownId, send, tap, slot = DEVICE_IDS.WEB, waitMs, onRegistered, onPrompt }) {
    const existing = hasE2eeDevice(ownId) && loadE2eeDevice(ownId);
    const served = (await getKeyIdLive({ send, tap, deviceId: slot }))?.data?.keyId ?? null;
    const reuse = existing && existing.deviceId === slot && Number(served) === Number(existing.registrationId);
    const device = reuse ? existing : (await createE2eeDevice(ownId, { deviceId: slot })).record;
    const reg = await registerDeviceLive({
        send,
        tap,
        ownUid: ownId,
        deviceId: slot,
        bundle: bundleFromStore(device.store),
        store: device.store,
    });
    saveE2eeDevice(ownId, device); // keep the sessions the subdevice init built: the key arrives on them
    markE2eeDeviceSubmitted(ownId);
    onRegistered?.(reg);
    const result = await receiveCloudKeyFromPhone({
        ownId,
        deviceName: CLOUD_KEY_DEVICE_NAME,
        sendRequest: (session) =>
            requestCloudKeyFromPhone(api, { deviceName: session.deviceName, sessionId: session.sessionId }),
        subscribe: subscribeCloudControls(tap),
        onPrompt,
        waitMs,
    });
    return { reg, keyVersion: result.keyVersion ?? null };
}
