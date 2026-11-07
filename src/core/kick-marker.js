/**
 * What is left behind when another session takes the account.
 *
 * A kicked daemon exits at once (exit code 3) and never reconnects, so the `kicked` state its health reported was
 * gone with it: `fleet status` showed `stopped`, and nothing said that a kick, not an operator, ended it. The socket
 * host writes this marker as the daemon ends on a kick and removes it on the next connect; `fleet status` reads it.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";

/**
 * The marker's path for one account.
 * @param {string} accountDir
 * @returns {string}
 */
export function kickFile(accountDir) {
    return join(accountDir, "kicked.json");
}

/**
 * Record a kick. Best effort: a daemon on its way out must not fail on this.
 * @param {string} file
 * @param {{ via: string, reason?: unknown, at?: number }} kick
 * @returns {boolean} whether it was written
 */
export function writeKickMarker(file, { via, reason = null, at = Date.now() }) {
    try {
        writeFileAtomic(file, JSON.stringify({ at, via, reason: reason ?? null }), { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

/**
 * The recorded kick, or null when there is none (or it cannot be read).
 * @param {string} file
 * @returns {{ at: number, via: string, reason: unknown }|null}
 */
export function readKickMarker(file) {
    try {
        const k = JSON.parse(readFileSync(file, "utf8"));
        return k && typeof k === "object" && typeof k.via === "string" ? k : null;
    } catch {
        return null;
    }
}

/**
 * Forget a kick: the account is connected again.
 * @param {string} file
 */
export function clearKickMarker(file) {
    try {
        rmSync(file, { force: true });
    } catch {
        /* nothing to forget, or not ours to remove */
    }
}
