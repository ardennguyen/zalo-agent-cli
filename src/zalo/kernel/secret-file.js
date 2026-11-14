/**
 * How the layer's stores read and write a file that holds a secret (the trusted-device identity, the phone sessions of
 * a transfer sync).
 *
 * The layer itself only knows plain files at 0600. An application that protects its data at rest installs a codec
 * once ({@link setSecretFileCodec}), or hands one to a store, and every such file then goes through it: the layer
 * never learns how the bytes are protected, and never imports the application.
 *
 * A codec: `read(file, meta)` returns the text, or null when there is no file, and throws when the file exists but
 * cannot be opened; `write(file, text, meta)` replaces the file atomically and throws when it cannot. `meta` says what
 * the file is: `{kind, use, account?, dir?}` (`use` is `boot` for what a login needs, `data` for everything else).
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";

/** The plain codec: the file as it is, written at 0600. */
export const plainCodec = Object.freeze({
    read(file) {
        try {
            return readFileSync(file, "utf8");
        } catch (e) {
            if (e.code === "ENOENT") return null;
            throw e;
        }
    },
    write(file, text) {
        writeFileAtomic(file, text, { mode: 0o600 });
    },
});

let installed = plainCodec;

/**
 * Install the codec every store uses unless it was handed its own; null restores the plain one.
 *
 * @param {{read: Function, write: Function}|null} codec
 */
export function setSecretFileCodec(codec) {
    installed = codec ?? plainCodec;
}

/** @returns {{read: Function, write: Function}} the codec in use */
export function secretFileCodec() {
    return installed;
}
