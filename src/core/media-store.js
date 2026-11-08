/**
 * An account's downloaded media at rest (at-rest phase 2): where it lives, how much of it is still plaintext, the
 * migration that seals it in place, and the rekey that re-wraps every file's key. The container itself is
 * ./keystore/media-seal.js.
 *
 * Roots: the account's own `accounts/<ownId>/media/`, plus the overrides (`--media-dir` / `ZALO_MEDIA_DIR`, and
 * `media.downloadDir` from `mcp-config.json`, the account's `accounts.<ownId>` block or its own `mcp-config.json`).
 * An override root may be shared by several accounts, so there only the files this account can prove are its own are
 * touched: a sealed file whose header names the account, and a plaintext file a message row of this account points
 * at (`localPath`). Its own root is the account's alone: every file there is sealed.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MEDIA_DIR, getAccountDbPath, getAccountDir } from "./credentials.js";
import { KeystoreError, SealError } from "./keystore/container.js";
import {
    isSealLeftover,
    leftoverTarget,
    mediaFileState,
    readMediaHeader,
    recoverMediaFile,
    rewrapMediaFile,
    sealMediaFileInPlaceSteps,
} from "./keystore/media-seal.js";
import { readKeyring, scopeOfDir } from "./keystore/keyring.js";
import { dbFileState, openDatabase } from "./sqlite.js";
import { loadMCPConfig, resolveAccountMCPConfig } from "../mcp/mcp-config.js";

/** The conversation index beside the thread folders: sealed JSON, never media. */
export const MEDIA_INDEX_FILE = "_conversations.json";
/** Above this many files, `account security status` stops counting and says so. */
const STATUS_CAP = 50_000;

/** The account's scope (its folder holds the keyring). */
const scopeOfAccount = (ownId) => scopeOfDir(getAccountDir(String(ownId)));

/**
 * Every media root of an account, its own first.
 *
 * @param {string} ownId
 * @returns {Array<{dir: string, own: boolean}>}
 */
export function mediaRoots(ownId) {
    const accountDir = getAccountDir(String(ownId));
    const own = resolve(accountDir, "media");
    const roots = [{ dir: own, own: true }];
    const extra = [MEDIA_DIR];
    try {
        const { config } = resolveAccountMCPConfig(loadMCPConfig(), { accountId: String(ownId), accountDir });
        extra.push(config.media?.downloadDir);
    } catch {
        /* no MCP config: no override from it */
    }
    for (const d of extra) {
        if (!d) continue;
        const dir = resolve(String(d));
        if (!roots.some((r) => r.dir === dir)) roots.push({ dir, own: false });
    }
    return roots;
}

/**
 * Every file under a root, the conversation index and temporary files left out. An in-place seal's leftovers are
 * recovered on the way (and their target listed once).
 *
 * @param {string} root
 * @returns {Generator<string>}
 */
export function* walkMedia(root) {
    if (!existsSync(root)) return;
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        const names = new Set(entries.map((e) => e.name));
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!e.isFile()) continue;
            if (dir === root && e.name.startsWith(MEDIA_INDEX_FILE)) continue;
            if (e.name.endsWith(".tmp")) continue;
            if (isSealLeftover(e.name)) {
                const target = leftoverTarget(e.name);
                try {
                    recoverMediaFile(join(dir, target));
                } catch {
                    /* left for the next pass */
                }
                if (!names.has(target) && existsSync(join(dir, target))) yield join(dir, target);
                continue;
            }
            yield full;
        }
    }
}

/** The rows that point at a file; answered from db.js's partial index `idx_messages_localpath`, not a table walk. */
export const REFERENCED_MEDIA_SQL = "SELECT msgId, localPath FROM messages WHERE localPath IS NOT NULL";

/**
 * The files this account's message rows point at (`localPath` → `msgId`), read-only. Empty when there is no database
 * yet, or it is still plaintext (a migration encrypts it first).
 *
 * @param {string} ownId
 * @returns {Map<string, string>}
 */
export function referencedMedia(ownId) {
    const file = getAccountDbPath(String(ownId));
    const map = new Map();
    if (dbFileState(file) !== "encrypted") return map;
    const db = openDatabase(file, { readonly: true });
    try {
        const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'localPath'").get();
        if (!hasColumn) return map; // no message table yet: no row points at a file
        for (const r of db.prepare(REFERENCED_MEDIA_SQL).iterate()) {
            map.set(resolve(r.localPath), String(r.msgId));
        }
    } finally {
        db.close();
    }
    return map;
}

/**
 * The account's media files that belong to it: everything under its own root, and in an override root the sealed
 * files that name it plus the plaintext files its rows point at.
 *
 * @param {string} ownId
 * @param {Map<string, string>} refs - {@link referencedMedia}
 * @returns {Generator<{file: string, state: "sealed"|"plaintext", own: boolean}>}
 */
function* accountFiles(ownId, refs) {
    const seen = new Set();
    const roots = mediaRoots(ownId);
    for (const root of roots) {
        for (const file of walkMedia(root.dir)) {
            const key = resolve(file);
            if (seen.has(key)) continue;
            seen.add(key);
            let state;
            try {
                state = mediaFileState(file);
            } catch {
                continue;
            }
            if (state === "absent") continue;
            if (!root.own && state === "plaintext" && !refs.has(key)) continue;
            yield { file: key, state, own: root.own };
        }
    }
    // Rows that point outside every root (a root changed since the download): theirs too.
    for (const key of refs.keys()) {
        if (seen.has(key)) continue;
        seen.add(key);
        const state = mediaFileState(key);
        if (state !== "absent") yield { file: key, state, own: false };
    }
}

/**
 * The media line of `account security status`, never key material: how many files are sealed, still plaintext, or
 * unreadable (sealed for this account but damaged), and how many sealed files are not yet under the current data key
 * (`staleKey`: a rekey that has not finished). Counted from the headers (no key needed), stopping at 50,000.
 *
 * @param {string} ownId
 * @returns {{kind: "media", key: "data", file: string, state: "absent"|"plaintext"|"sealed", sealed: number,
 *   plaintext: number, unreadable: number, staleKey: number, roots: string[], capped?: boolean, error?: string}}
 */
export function mediaStatus(ownId) {
    const roots = mediaRoots(ownId).map((r) => r.dir);
    const out = {
        kind: "media",
        key: "data",
        file: roots[0],
        roots,
        sealed: 0,
        plaintext: 0,
        unreadable: 0,
        staleKey: 0,
    };
    let currentKid = null;
    try {
        currentKid = readKeyring(getAccountDir(String(ownId)))?.keys?.find((k) => k.use === "data")?.id ?? null;
    } catch {
        /* a damaged keyring is reported by the status itself */
    }
    let refs = new Map();
    try {
        refs = referencedMedia(ownId);
    } catch (e) {
        out.error = `the message database could not be read (${e.message}): plaintext files in a shared media root are not counted`;
    }
    let n = 0;
    for (const f of accountFiles(ownId, refs)) {
        if (++n > STATUS_CAP) {
            out.capped = true;
            break;
        }
        if (f.state === "plaintext") out.plaintext++;
        else {
            let h = null;
            try {
                h = readMediaHeader(f.file);
            } catch {
                /* a damaged header */
            }
            if (h && String(h.meta.acct) === String(ownId)) {
                out.sealed++;
                if (currentKid && !h.kids.includes(currentKid)) out.staleKey++;
            } else if (!h && f.own) out.unreadable++;
        }
    }
    out.state = out.plaintext ? "plaintext" : out.sealed || out.unreadable ? "sealed" : "absent";
    return out;
}

/**
 * Seal the account's plaintext media in place (`account security migrate`, the daemon's background job, and a read).
 * Idempotent and resumable: each file is sealed on its own (written beside, verified, swapped, the plaintext shredded),
 * so a stop part way leaves sealed and plaintext files, every one readable, and the next run carries on.
 *
 * @param {string} ownId
 * @param {{limit?: number, log?: (line: string) => void}} [opts] - `limit`: seal at most this many files this run
 * @returns {{sealed: number, failed: number, more: boolean, errors: Array<{file: string, error: string}>, ms: number,
 *   bytes: number}}
 */
export function migrateMedia(ownId, { limit = Infinity, log } = {}) {
    const run = migrationRun(ownId, { limit });
    while (!run.steps.next().done) {
        /* every file at once: a command, which serves no socket */
    }
    return run.finish(log);
}

/**
 * {@link migrateMedia} for a daemon: the same run, handing the event loop back every `sliceMs` (and between any two
 * files that took longer). One batch of 50 photos sealed in one go MEASURED 3.3 s on the thread that serves the
 * socket (`event loop was blocked for 3.1s`, every 30 s while a 2.x install's media was sealed); sliced, the longest
 * stretch is a file's open, verify and flush, a 64 KiB chunk or the scan of the rows that point at files.
 *
 * @param {string} ownId
 * @param {{limit?: number, log?: (line: string) => void, sliceMs?: number, pause?: () => Promise<void>,
 *   stopped?: () => boolean}} [opts] - `pause`: how the loop is handed back (tests); `stopped`: end the run early
 * @returns {Promise<ReturnType<typeof migrateMedia>>}
 */
export async function migrateMediaSliced(
    ownId,
    { limit = Infinity, log, sliceMs = 25, pause = yieldToLoop, stopped = () => false } = {},
) {
    const run = migrationRun(ownId, { limit });
    let sliceStart = performance.now();
    for (let step = run.steps.next(); !step.done; step = run.steps.next()) {
        // A stop between two files only: a file part way through is finished first.
        if (step.value === FILE_DONE && stopped()) {
            run.res.more = true;
            break;
        }
        if (performance.now() - sliceStart < sliceMs) continue;
        await pause();
        sliceStart = performance.now();
    }
    return run.finish(log);
}

/** Let timers and socket reads run before the next slice (setImmediate: after the I/O that is waiting). */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** What a migration step yields between two files (inside one it yields nothing). */
const FILE_DONE = "file";

/** One migration run: `steps` yields after every file it looks at and every chunk it seals; `finish` logs. */
function migrationRun(ownId, { limit }) {
    const started = Date.now();
    const res = { sealed: 0, failed: 0, more: false, errors: [], ms: 0, bytes: 0 };
    function* steps() {
        const scope = scopeOfAccount(ownId);
        const refs = referencedMedia(ownId);
        yield FILE_DONE;
        const keys = new Map(); // derived keys, for this run only
        for (const f of accountFiles(ownId, refs)) {
            if (f.state !== "plaintext") {
                yield FILE_DONE;
                continue;
            }
            if (res.sealed + res.failed >= limit) {
                res.more = true;
                return;
            }
            try {
                // A step per chunk: a 100 MB video is not one stretch of the daemon's thread.
                const done = yield* sealMediaFileInPlaceSteps(
                    f.file,
                    scope,
                    { msgId: refs.get(f.file) ?? null },
                    { keys },
                );
                if (done === "sealed") {
                    res.sealed++;
                    res.bytes += readMediaHeader(f.file).meta.size;
                }
            } catch (e) {
                // A key that cannot be had stops the run: every other file would fail the same way.
                if (e instanceof KeystoreError) throw e;
                res.failed++;
                if (res.errors.length < 20) res.errors.push({ file: f.file, error: e.message });
            }
            yield FILE_DONE;
        }
    }
    return {
        res,
        steps: steps(),
        finish(log) {
            res.ms = Date.now() - started;
            if (log && res.sealed) {
                log(`[media] sealed ${res.sealed} file(s) (${(res.bytes / 1e6).toFixed(1)} MB) in ${res.ms} ms`);
            }
            return res;
        },
    };
}

/**
 * Re-wrap every sealed media file of the account under its current media key (the rekey handler's media part). A
 * file that does not open with any key of the account (damaged) is counted and skipped: it did not open before the
 * rekey either. Any other failure (I/O, a key that cannot be had) throws, which stops the rekey with the old keys
 * still in the keyring, so running it again finishes.
 *
 * @param {string} ownId
 * @returns {{rewrapped: number, current: number, unreadable: number}}
 */
export function rekeyMedia(ownId) {
    const scope = scopeOfAccount(ownId);
    const res = { rewrapped: 0, current: 0, unreadable: 0 };
    const keys = new Map(); // derived keys, for this run only
    for (const f of accountFiles(ownId, new Map())) {
        if (f.state !== "sealed") continue;
        let r;
        try {
            r = rewrapMediaFile(f.file, scope, { keys });
        } catch (e) {
            if (e instanceof SealError) {
                res.unreadable++;
                continue;
            }
            throw e;
        }
        if (r === "rewrapped") res.rewrapped++;
        else if (r === "current") res.current++;
    }
    return res;
}

/**
 * The daemon's background migration: seal `batch` plaintext files every `intervalMs` until none is left, at low
 * priority (the timer never keeps the process alive), in slices that hand the event loop back
 * ({@link migrateMediaSliced}): the daemon serves its socket on the same thread. A key that cannot be had, or anything
 * unexpected, stops it with one log line; the next daemon start tries again.
 *
 * @param {string} ownId
 * @param {{batch?: number, intervalMs?: number, firstDelayMs?: number, sliceMs?: number,
 *   log?: (line: string) => void}} [opts]
 * @returns {() => void} stop
 */
export function startMediaMigration(
    ownId,
    { batch = 50, intervalMs = 30_000, firstDelayMs = 60_000, sliceMs = 25, log } = {},
) {
    let timer = null;
    let stopped = false;
    let total = 0;
    const say = log ?? ((l) => console.error(l));
    const tick = async () => {
        timer = null;
        if (stopped) return;
        let res;
        try {
            res = await migrateMediaSliced(ownId, { limit: batch, sliceMs, stopped: () => stopped });
        } catch (e) {
            say(`[media] background sealing stopped: ${e.message}`);
            return;
        }
        total += res.sealed;
        if (res.failed) say(`[media] ${res.failed} file(s) could not be sealed (first: ${res.errors[0]?.error})`);
        if (stopped) return;
        if (res.more && res.sealed > 0) {
            timer = setTimeout(tick, intervalMs);
            timer.unref?.();
        } else if (total) {
            say(`[media] background sealing done: ${total} file(s) sealed`);
        }
    };
    timer = setTimeout(tick, firstDelayMs);
    timer.unref?.();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}
