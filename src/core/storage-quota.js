/**
 * Storage usage of an account: the message database, its media and its webhook outbox, as the files on disk hold them.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAccountDir, resolveMediaRoot } from "./credentials.js";

/** The size of a file, 0 when there is none. */
function fileSize(file) {
    try {
        return statSync(file).size;
    } catch {
        return 0;
    }
}

/** The bytes of every file under a folder (no links followed). */
export function folderSize(dir) {
    let total = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) total += folderSize(p);
        else if (e.isFile()) total += fileSize(p);
    }
    return total;
}

/** The bytes of a SQLite file with its WAL and shared-memory files. */
function sqliteSize(file) {
    return fileSize(file) + fileSize(`${file}-wal`) + fileSize(`${file}-shm`);
}

/**
 * One account's storage, by part, from the file sizes.
 *
 * @param {string} ownId
 * @param {{mediaRoot?: string|null, dbBytes?: number|null}} [opts] - `dbBytes`: the database's used bytes when the
 *   caller holds it open (the pages in use, which a purge lowers at once; the file keeps its size until a VACUUM)
 * @returns {{accountId: string, db: number, media: number, outbox: number, total: number, measuredAt: number}}
 */
export function measureUsage(ownId, { mediaRoot = null, dbBytes = null } = {}) {
    const dir = getAccountDir(String(ownId));
    const db = Number.isFinite(dbBytes) ? dbBytes : sqliteSize(join(dir, "zalo.db"));
    const media = folderSize(resolveMediaRoot(dir, mediaRoot));
    const outbox = sqliteSize(join(dir, "webhook-outbox.db"));
    return { accountId: String(ownId), db, media, outbox, total: db + media + outbox, measuredAt: Date.now() };
}
