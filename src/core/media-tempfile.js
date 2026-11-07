/**
 * Decrypted copies of sealed media for the callers that need a plaintext path: the OS viewer (`zalo_view_media`
 * `open`) and an upload (a forward re-sends the file by path).
 *
 * STOPGAP until work package 6 (`src/core/media-deliver.js`: delivery modes, tempfile TTL/sweep as configuration):
 * kept minimal. A copy lives in its own random folder under `<CONFIG_DIR>/tmp/media/` (folder 0700, file 0600), is
 * deleted after `ttlMs` by a timer that never keeps the process alive, on exit, or by the sweep at the next call once
 * it is older than the TTL (a crash leaves nothing behind for long).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import { decryptMediaToFile } from "./keystore/media-seal.js";

/** How long a decrypted copy lives by default. */
export const TEMPFILE_TTL_MS = 10 * 60_000;

const live = new Set();
let exitHooked = false;

/** The folder decrypted copies go to. */
export function mediaTempRoot() {
    return join(CONFIG_DIR, "tmp", "media");
}

function removeDir(dir) {
    live.delete(dir);
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* already gone, or held by a viewer (Windows): the sweep retries */
    }
}

/**
 * Delete decrypted copies older than the TTL (left by a crash, or still held open when their timer fired).
 *
 * @param {number} [ttlMs]
 * @param {number} [now]
 * @returns {number} folders removed
 */
export function sweepMediaTemp(ttlMs = TEMPFILE_TTL_MS, now = Date.now()) {
    let removed = 0;
    let names = [];
    try {
        names = readdirSync(mediaTempRoot());
    } catch {
        return 0;
    }
    for (const n of names) {
        const dir = join(mediaTempRoot(), n);
        try {
            if (now - statSync(dir).mtimeMs < ttlMs) continue;
        } catch {
            continue;
        }
        removeDir(dir);
        removed++;
    }
    return removed;
}

/**
 * Decrypt a sealed media file to a private temporary copy.
 *
 * @param {string} file - the sealed file (`localPath`)
 * @param {{id: string, dir: string}} scope - the account
 * @param {{msgId?: string|null, name?: string, ttlMs?: number}} [opts] - `name`: the copy's file name (default: the
 *   sealed file's own, so an upload keeps it); `ttlMs` 0 keeps it until {@link removeMediaTemp} or exit
 * @returns {{path: string, dir: string, expiresAt: number|null}}
 */
export function decryptToTempfile(file, scope, { msgId = null, name, ttlMs = TEMPFILE_TTL_MS } = {}) {
    sweepMediaTemp();
    mkdirSync(mediaTempRoot(), { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(mediaTempRoot(), "m-"));
    live.add(dir);
    if (!exitHooked) {
        exitHooked = true;
        process.once("exit", () => {
            for (const d of [...live]) removeDir(d);
        });
    }
    const path = join(dir, basename(name || file));
    try {
        decryptMediaToFile(file, path, scope, { msgId });
    } catch (e) {
        removeDir(dir);
        throw e;
    }
    let expiresAt = null;
    if (ttlMs > 0) {
        expiresAt = Date.now() + ttlMs;
        setTimeout(() => removeDir(dir), ttlMs).unref?.();
    }
    return { path, dir, expiresAt };
}

/**
 * Delete a decrypted copy now (an upload is done with it).
 *
 * @param {{dir: string}|null|undefined} copy
 */
export function removeMediaTemp(copy) {
    if (copy?.dir) removeDir(copy.dir);
}
