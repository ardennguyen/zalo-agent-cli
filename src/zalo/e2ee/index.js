/**
 * The narrow end-to-end-encryption device layer: generate and persist a Signal identity, build the key-stack socket
 * commands, and decrypt the cloud key the phone encrypts to this device. The crypto is this folder's own slice of the
 * Signal protocol (./signal-protocol.js, ./curve.js) under Zalo's key-derivation labels.
 *
 * Protocol layer (src/zalo): it imports no `src/core` and no `src/utils`. Persistence (sealing the store, sealing the
 * cloud key) is the account layer's job (src/core/e2ee-device.js, src/core/cloud-key-store.js).
 */
export { SignalProtocolStore, abToBase64, base64ToAb, SIGNAL_MESSAGE_VERSION } from "./signal-store.js";
export {
    generateDeviceIdentity,
    generateOneTimePreKeys,
    bundleFromStore,
    DEFAULT_ONE_TIME_PREKEY_COUNT,
    SIGNED_PREKEY_ID,
    FIRST_ONE_TIME_PREKEY_ID,
} from "./identity.js";
export {
    CMD_SUBMIT_BUNDLE,
    CMD_GET_BUNDLE,
    CMD_SUBMIT_PREKEYS,
    CMD_INIT_SESSION,
    CMD_GET_LIST_DEVICES,
    CMD_GET_KEY_ID,
    LIST_SUBDEVICES,
    DEVICE_IDS,
    platformName,
    encodeSubmitBundle,
    encodeSubmitPreKeys,
    encodeInitSession,
    encodeGetBundle,
    encodeGetKeyId,
    encodeListDevices,
    replyError,
    decodeBundleItem,
    decodeDeviceList,
} from "./bundle-wire.js";
export { buildSubdeviceInit, INIT_MESSAGE } from "./subdevice-init.js";
export {
    WHISPER_TYPE,
    PRE_KEY_TYPE,
    SENDER_KEY_TYPE,
    SENDER_KEY_DISTRIBUTION_TYPE,
    splitTypeAndMessage,
    concatTypeAndMessage,
} from "./transport-tag.js";
export { decryptCloudKeyReply, CloudKeyDecryptError } from "./cloud-key-decrypt.js";
export {
    ZALO_KDF_LABELS,
    MessageCounterError,
    encodeAddress,
    processPreKeyBundle,
    encryptMessage,
    decryptWhisperMessage,
    decryptPreKeyWhisperMessage,
    generateIdentityKeyPair,
    generateRegistrationId,
    generateSignedPreKey,
    generatePreKey,
} from "./signal-protocol.js";
export { xeddsaSign, xeddsaVerify, calculateAgreement, generateKeyPair } from "./curve.js";
