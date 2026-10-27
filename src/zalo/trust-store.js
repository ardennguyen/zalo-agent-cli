/**
 * The trusted-device identity of an account, kept between logins (see ./trust-wasm.js and ./qr-login.js).
 *
 * A QR login on an account that has a trusted device makes this client a companion device: it holds an Ed25519
 * identity, and the phone signs the list that names it. The identity is what lets a later login say "same device
 * as before" (a relink) instead of adding another companion each time, so it is kept, per account, next to the
 * other account data, at 0600. It is a secret: nothing here is logged, and it goes with the account when the
 * account's data is removed.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";

/** The file inside an account directory. */
export const TRUST_FILE = "trusted-device.json";

const toBytes = (text) => new Uint8Array(Buffer.from(String(text), "base64"));
const toText = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * A store of one account's trusted-device identity, in `dirOf(uid)`.
 *
 * @param {(uid: string) => string} dirOf - the directory of an account's data
 * @returns {{
 *   load: (uid: string, masterId?: string) => (object|null),
 *   save: (record: object) => boolean,
 *   clear: (uid: string) => boolean,
 * }}
 */
export function createTrustStore(dirOf) {
    const fileOf = (uid) => join(dirOf(uid), TRUST_FILE);
    return {
        /**
         * The saved identity of an account, as bytes; null when there is none, it is unreadable, or it was made
         * for another master (the phone side was reset since).
         */
        load(uid, masterId) {
            try {
                const saved = JSON.parse(readFileSync(fileOf(uid), "utf8"));
                if (saved?.version !== 1 || String(saved.uid) !== String(uid)) return null;
                if (masterId && saved.masterId !== masterId) return null;
                return {
                    ...saved,
                    publicKey: toBytes(saved.publicKey),
                    privateKey: toBytes(saved.privateKey),
                    linkingSecret: toBytes(saved.linkingSecret),
                    primaryPublicIdentityKey: toBytes(saved.primaryPublicIdentityKey),
                };
            } catch {
                return null;
            }
        },
        /**
         * @param {object} record - bytes as Uint8Array, everything else as plain values
         * @returns {boolean} whether it was written
         */
        save(record) {
            try {
                writeFileAtomic(
                    fileOf(record.uid),
                    JSON.stringify({
                        version: 1,
                        uid: String(record.uid),
                        masterId: record.masterId,
                        companionId: record.companionId,
                        linkId: record.linkId,
                        linkingTimestamp: record.linkingTimestamp,
                        publicKey: toText(record.publicKey),
                        privateKey: toText(record.privateKey),
                        linkingSecret: toText(record.linkingSecret),
                        primaryPublicIdentityKey: toText(record.primaryPublicIdentityKey),
                        devices: record.devices ?? null,
                        savedAt: Date.now(),
                    }),
                    { mode: 0o600 },
                );
                return true;
            } catch {
                return false;
            }
        },
        /** Forget the identity (the phone refused it): the next login links as a new device. */
        clear(uid) {
            try {
                if (!existsSync(fileOf(uid))) return false;
                unlinkSync(fileOf(uid));
                return true;
            } catch {
                return false;
            }
        },
    };
}
