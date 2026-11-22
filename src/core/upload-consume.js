/**
 * When a sent upload may go: once its message is recorded where the engine keeps sent media. The listener stores the
 * echo of the account's own send like any message, and the daemon then fetches its attachment into the media store
 * (src/core/sync-v2/media.js, the one downloader). Nothing here writes a row or a media file.
 *
 * Recorded means: the message's row exists and either holds its downloaded file (`localPath`), carries no attachment,
 * or is of a kind this account does not keep (`media.store`).
 */

import { getMessageById } from "./db.js";
import { MEDIA_KINDS, resolveMediaStore } from "./deploy-policy.js";

/**
 * A check of one sent message, for the upload store's reaper (src/core/upload-store.js `reapSent`).
 *
 * @param {string|null} ownId - the account, for its `media.store` policy
 * @param {{getRow?: (msgId: string) => object|null}} [opts] - the cache read (tests)
 * @returns {(msgId: string) => boolean}
 */
export function sentMessageRecorded(ownId, { getRow = getMessageById } = {}) {
    return (msgId) => {
        let row = null;
        try {
            row = getRow(String(msgId));
        } catch {
            return false; // no cache open here: not known to be recorded
        }
        if (!row) return false;
        if (row.localPath) return true;
        if (!row.has_attachment) return true;
        const kind = MEDIA_KINDS.includes(String(row.type)) ? String(row.type) : "file";
        return !resolveMediaStore(ownId).kinds.has(kind);
    };
}
