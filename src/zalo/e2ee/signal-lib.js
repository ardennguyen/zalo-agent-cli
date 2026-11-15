/**
 * The one place the off-the-shelf Signal library is loaded.
 *
 * It is a pure-JS implementation of the X3DH + Double Ratchet protocol (Curve25519, message version 3) that
 * interoperates with the standard Signal wire format. It is loaded lazily, with a dynamic import, so that nothing of it
 * is pulled in unless the end-to-end-encryption device feature is actually exercised: the rest of the CLI never pays
 * for it, and a build without the optional dependency still runs every other command.
 *
 * It lives behind this module (and the rest of this folder) so the protocol layer has a single, swappable seam over the
 * library, and so {@link loadSignalLib} can give a clear message if the dependency is missing.
 */

import { createRequire } from "node:module";

/** Raised when the Signal library cannot be loaded (e.g. the optional dependency was not installed). */
export class SignalLibMissingError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "SignalLibMissingError";
    }
}

/** @type {Promise<object>|null} */
let cached = null;

/**
 * Load the Signal library once.
 *
 * @returns {Promise<object>} the library's exports (KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress, …)
 * @throws {SignalLibMissingError} when the dependency is not available
 */
export function loadSignalLib() {
    if (!cached) {
        cached = import("@privacyresearch/libsignal-protocol-typescript")
            .then((lib) => {
                useZaloKdfLabels();
                return lib;
            })
            .catch((e) => {
                cached = null;
                throw new SignalLibMissingError(
                    "the end-to-end-encryption library is not available: install the optional dependency " +
                        `@privacyresearch/libsignal-protocol-typescript (${e?.message || e})`,
                );
            });
    }
    return cached;
}

/**
 * The key-derivation labels of Zalo's 1-to-1 Signal variant. It is the standard X3DH + Double Ratchet, but every HKDF
 * runs under its own info label in place of the standard one; with the standard labels every derived key differs and
 * each message fails its MAC check.
 */
export const ZALO_KDF_LABELS = Object.freeze({
    WhisperText: "ZaloText",
    WhisperRatchet: "ZaloRatchet",
    WhisperMessageKeys: "ZaloMessageKeys",
});

let kdfPatched = false;

/**
 * Make the library derive under Zalo's labels. Its session builder and cipher look the HKDF up on the shared internal
 * crypto module at each call, so wrapping that one export once covers both. Idempotent.
 */
function useZaloKdfLabels() {
    if (kdfPatched) return;
    const require = createRequire(import.meta.url);
    const internal = require("@privacyresearch/libsignal-protocol-typescript/lib/internal/crypto.js");
    const standard = internal.HKDF;
    if (typeof standard !== "function") throw new Error("the Signal library's HKDF was not found");
    internal.HKDF = (input, salt, info) => standard(input, salt, ZALO_KDF_LABELS[info] ?? info);
    kdfPatched = true;
}
