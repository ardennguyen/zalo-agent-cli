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
        cached = import("@privacyresearch/libsignal-protocol-typescript").catch((e) => {
            cached = null;
            throw new SignalLibMissingError(
                "the end-to-end-encryption library is not available: install the optional dependency " +
                    `@privacyresearch/libsignal-protocol-typescript (${e?.message || e})`,
            );
        });
    }
    return cached;
}
