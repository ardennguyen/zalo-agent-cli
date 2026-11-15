/**
 * The socket-command shapes for the narrow end-to-end-encryption key stack: publish our bundle (register), fetch a
 * peer's bundle, ask which key id we hold, and list the account's devices. Pure functions: each takes plain inputs and
 * returns the `{version, cmd, subCmd, data}` frame to send (or reads a reply apart), so they are unit-testable without a
 * socket. Nothing here sends anything.
 *
 * The frame shapes are traced from the installed client (private notes in agent/docs); the field packing is the
 * client's own. They are UNVERIFIED on the wire — no capture of this traffic exists — so a live run is what confirms
 * them. Every key in a bundle is base64 (the generator in ./identity.js already produces base64).
 *
 * Protocol layer: no `src/core`, no `src/utils`.
 */

/** The numbered socket commands of the key stack. */
export const CMD_SUBMIT_BUNDLE = 540;
export const CMD_GET_BUNDLE = 541;
export const CMD_SUBMIT_PREKEYS = 542;
export const CMD_INIT_SESSION = 543;
export const CMD_GET_LIST_DEVICES = 563;
export const CMD_GET_KEY_ID = 564;

/** The platform slots a device can hold; the init step builds a session to each other one. */
export const LIST_SUBDEVICES = Object.freeze([0, 1, 2]);

/**
 * The per-platform Signal device id. A device claims the slot of its platform, and there is one bundle per slot: this
 * engine announces the web platform, so it would claim WEB (1) — the slot a real web-platform device (such as the
 * owner's browser session) uses. The collision risk is the owner's call; the slot the device claims is configurable for
 * that reason.
 */
export const DEVICE_IDS = Object.freeze({ MOBILE: 0, WEB: 1, PC: 2, SYSTEM: 3, UNKNOWN: 6 });

/** A platform name for a device id, for display. */
export function platformName(deviceId) {
    const n = Number(deviceId);
    for (const [name, id] of Object.entries(DEVICE_IDS)) if (id === n) return name;
    return `SLOT_${deviceId}`;
}

/**
 * SUBMIT_BUNDLE (540): publish this device's identity + registration id + signed pre-key(+signature) + one-time
 * pre-keys. This is registration — it makes the device addressable and account-visible.
 *
 * @param {object} args
 * @param {{registrationId: number, identityKey: string, signedPreKey: {keyId: number, publicKey: string,
 *   signature: string}, preKeys: Array<{keyId: number, publicKey: string}>}} args.bundle - from ./identity.js
 * @param {number} args.deviceId - the platform slot to claim (see {@link DEVICE_IDS})
 * @param {string|number} args.reqId
 * @param {boolean} [args.deleteExistingSessions=false] - the client's `delSS`: drop this slot's old sessions
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeSubmitBundle({ bundle, deviceId, reqId, deleteExistingSessions = false }) {
    return {
        version: 1,
        cmd: CMD_SUBMIT_BUNDLE,
        subCmd: 0,
        data: {
            reqId: String(reqId),
            data: {
                delSS: deleteExistingSessions ? 1 : 0,
                key: {
                    deviceId: Number(deviceId),
                    preKey: {
                        iKey: { id: bundle.registrationId, key: bundle.identityKey },
                        signature: bundle.signedPreKey.signature,
                        spKey: { id: bundle.signedPreKey.keyId, key: bundle.signedPreKey.publicKey },
                    },
                    opKeys: bundle.preKeys.map((k) => ({ id: k.keyId, key: k.publicKey })),
                },
            },
        },
    };
}

/**
 * SUBMIT_PREKEYS (542): replenish one-time pre-keys after some were consumed.
 *
 * @param {object} args
 * @param {Array<{keyId: number, publicKey: string}>} args.preKeys
 * @param {number} args.registrationId
 * @param {number} args.deviceId
 * @param {string|number} args.reqId
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeSubmitPreKeys({ preKeys, registrationId, deviceId, reqId }) {
    return {
        version: 1,
        cmd: CMD_SUBMIT_PREKEYS,
        subCmd: 0,
        data: {
            reqId: String(reqId),
            data: {
                deviceId: Number(deviceId),
                id: Number(registrationId),
                opKeys: preKeys.map((k) => ({ id: k.keyId, key: k.publicKey })),
            },
        },
    };
}

/**
 * INIT_SESSION (543): announce the sessions this device just built to the account's other devices. Part of the
 * INIT_SUBDEVICE phase of the connect-time init sequence; the server surfaces a device as live once it has run this.
 *
 * @param {object} args
 * @param {string} args.uidTo - the account's own id (sessions are to our own other devices)
 * @param {Array<{deviceId: number, initMsg: string}>} args.entries - one per subdevice: the type-tagged init message
 * @param {string|number} args.reqId
 * @param {boolean} [args.enable=true] - the client's `type` (1 = enable)
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeInitSession({ uidTo, entries, reqId, enable = true }) {
    return {
        version: 1,
        cmd: CMD_INIT_SESSION,
        subCmd: 0,
        data: {
            reqId: String(reqId),
            data: {
                type: enable ? 1 : 0,
                uidTo: String(uidTo),
                data: entries.map((e) => ({ deviceId: Number(e.deviceId), initMsg: e.initMsg })),
            },
        },
    };
}

/**
 * GET_BUNDLE (541): fetch a peer device's bundle (the sender side of X3DH).
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {number} args.deviceId
 * @param {string|number} args.reqId
 * @param {{isReinit?: boolean, msgInfoNoti?: boolean, isAutoUpgrade?: boolean}} [args.flags]
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeGetBundle({ uid, deviceId, reqId, flags = {} }) {
    return {
        version: 1,
        cmd: CMD_GET_BUNDLE,
        subCmd: 0,
        data: {
            reqId: String(reqId),
            data: {
                uids: [{ uid: String(uid), deviceId: Number(deviceId) }],
                isReInit: flags.isReinit ? 1 : 0,
                msgInfoNoti: flags.msgInfoNoti ? 1 : 0,
                isAutoUpgrade: flags.isAutoUpgrade ? 1 : 0,
            },
        },
    };
}

/**
 * GET_KEY_ID (564): which key id this platform slot currently holds on the account.
 *
 * @param {object} args
 * @param {number} args.deviceId - the platform slot
 * @param {string|number} args.reqId
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeGetKeyId({ deviceId, reqId }) {
    return {
        version: 1,
        cmd: CMD_GET_KEY_ID,
        subCmd: 0,
        data: { reqId: String(reqId), data: { platformType: Number(deviceId) } },
    };
}

/**
 * GET_LIST_USER_E2EE (563): list the account's end-to-end-encryption devices/users (read-only). The full-list form;
 * the client also has a paginated form keyed on `first`/`lastId`.
 *
 * @param {object} args
 * @param {string|number} args.reqId
 * @returns {{version: number, cmd: number, subCmd: number, data: object}}
 */
export function encodeListDevices({ reqId }) {
    return {
        version: 1,
        cmd: CMD_GET_LIST_DEVICES,
        subCmd: 0,
        data: { reqId: String(reqId), data: { reqIid: 1 } },
    };
}

/**
 * The server error on a reply's `data.data.err`, or null when the reply is clean. The client treats a non-empty,
 * non-`-1` `err` as a failure.
 *
 * @param {object|null} reply - the decoded frame's parsed body
 * @returns {number|null}
 */
export function replyError(reply) {
    const err = reply?.data?.err;
    return err === undefined || err === null || err === 0 ? null : Number(err);
}

/**
 * Read a GET_BUNDLE reply item into the shape a session builder needs (the client's `_convertBundle`): base64 kept as
 * base64, so a caller decodes with its own helpers.
 *
 * @param {object} item - one device's bundle from the reply
 * @returns {{deviceId: number, registrationId: number, identityKey: string,
 *   signedPreKey: {keyId: number, publicKey: string, signature: string},
 *   preKey: {keyId: number, publicKey: string}|null}}
 */
export function decodeBundleItem(item) {
    if (!item || item.deviceId === undefined || item.deviceId === null) throw new Error("bundle item has no deviceId");
    return {
        deviceId: Number(item.deviceId),
        registrationId: Number(item.registrationId),
        identityKey: item.identityKey,
        signedPreKey: {
            keyId: Number(item.signedPreKey.keyId),
            publicKey: item.signedPreKey.publicKey,
            signature: item.signedPreKey.signature,
        },
        preKey: item.preKey ? { keyId: Number(item.preKey.keyId), publicKey: item.preKey.publicKey } : null,
    };
}

/**
 * Read a GET_LIST_USER_E2EE (563) reply into the account's own devices and which platform slots are occupied. The
 * reply's `data.data` carries `uids` (per-user device lists); this picks the entry for `ownUid` and summarizes its
 * devices. The exact field names are the client's and UNVERIFIED on the wire, so it reads defensively.
 *
 * @param {object|null} reply - the decoded frame's parsed body (the `data` object, i.e. `{reqId, data:{...}}`)
 * @param {string} ownUid
 * @returns {{devices: Array<{deviceId: number, platform: string}>, occupiedSlots: number[], raw: object|null}}
 */
export function decodeDeviceList(reply, ownUid) {
    const payload = reply?.data ?? null;
    const uids = Array.isArray(payload?.uids) ? payload.uids : [];
    const mine = uids.find((u) => String(u?.uid) === String(ownUid)) ?? null;
    const deviceList = Array.isArray(mine?.devices)
        ? mine.devices
        : Array.isArray(mine?.keys)
          ? mine.keys
          : Array.isArray(payload?.devices)
            ? payload.devices
            : [];
    const devices = deviceList
        .map((d) => {
            const id = d?.deviceId ?? d?.platformType ?? d?.device_id;
            return id === undefined || id === null ? null : { deviceId: Number(id), platform: platformName(id) };
        })
        .filter(Boolean);
    const occupiedSlots = [...new Set(devices.map((d) => d.deviceId))].sort((a, b) => a - b);
    return { devices, occupiedSlots, raw: payload };
}
