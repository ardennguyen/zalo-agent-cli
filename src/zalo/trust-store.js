/**
 * The trusted-device identity of an account, kept between logins (see ./trust-wasm.js and ./qr-login.js).
 *
 * A QR login on an account that has a trusted device makes this client a companion device: it holds an Ed25519
 * identity, and the phone signs the list that names it. The identity is what lets a later login say "same device
 * as before" (a relink) instead of adding another companion each time, so it is kept, per account, next to the
 * other account data, at 0600. It is a secret: nothing here is logged, and it goes with the account when the
 * account's data is removed. It is read and written through the secret-file codec (./kernel/secret-file.js), so an
 * application that seals its files at rest seals this one too.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { secretFileCodec } from "./kernel/secret-file.js";

/** The file inside an account directory. */
export const TRUST_FILE = "trusted-device.json";

const toBytes = (text) => new Uint8Array(Buffer.from(String(text), "base64"));
const toText = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * A store of one account's trusted-device identity, in `dirOf(uid)`.
 *
 * @param {(uid: string) => string} dirOf - the directory of an account's data
 * @param {{codec?: {read: Function, write: Function}}} [opts] - the codec for the file; the installed one by default
 * @returns {{
 *   load: (uid: string, masterId?: string) => (object|null),
 *   save: (record: object) => boolean,
 *   clear: (uid: string) => boolean,
 * }}
 */
export function createTrustStore(dirOf, { codec = null } = {}) {
    const fileOf = (uid) => join(dirOf(uid), TRUST_FILE);
    const metaOf = (uid) => ({ kind: "trusted-device", use: "boot", account: String(uid), dir: dirOf(uid) });
    const io = () => codec ?? secretFileCodec();
    return {
        /**
         * The saved identity of an account, as bytes; null when there is none, it is unreadable, or it was made
         * for another master (the phone side was reset since).
         */
        load(uid, masterId) {
            try {
                const text = io().read(fileOf(uid), metaOf(uid));
                if (text === null) return null;
                const saved = JSON.parse(text);
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
                io().write(
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
                    metaOf(record.uid),
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
