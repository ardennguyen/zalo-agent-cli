/**
 * The retry engine's week of error history, kept in a file so a restart does
 * not forget it (see `createAnomalyHistory` in ./retry.js).
 *
 * A damaged or missing file is not an error: the history just starts over. The
 * write is atomic, so a crash leaves the old history rather than half of a new
 * one, and nothing here contains an identity or a credential: only error codes
 * and times.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic-file.js";

/**
 * Read the saved history.
 *
 * @param {string} file
 * @returns {{firstInstall?: number, errors?: Array<{code: string|number, time: number}>}|undefined}
 *   undefined when there is no usable file
 */
export function loadAnomalyState(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object") return undefined;
        const errors = Array.isArray(parsed.errors)
            ? parsed.errors.filter(
                  (e) => e && (typeof e.code === "number" || typeof e.code === "string") && Number.isFinite(e.time),
              )
            : [];
        return { firstInstall: Number.isFinite(parsed.firstInstall) ? parsed.firstInstall : undefined, errors };
    } catch {
        return undefined;
    }
}

/**
 * Save the history. Failing to save is reported to the caller and is never fatal.
 *
 * @param {string} file
 * @param {object} state - `{firstInstall, errors}`
 * @returns {boolean} whether it was written
 */
export function saveAnomalyState(file, state) {
    try {
        writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}
