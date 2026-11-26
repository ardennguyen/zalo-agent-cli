/**
 * Where a QR-added account's data lives on a fleet host (`fleet serve --accounts-dir`, or ZALO_FLEET_ACCOUNTS_DIR).
 *
 * A fleet places each account's data in a folder of its own (`<accounts dir>/<ownId>`), outside the controller's
 * config dir: that folder is what the host backs up, and what any engine that runs the account mounts. An account added
 * by QR while the controller runs gets the same layout:
 *
 * - its data folder is `<accounts dir>/<ownId>`;
 * - `<DATA_DIR>/<ownId>` (normally `<home>/.zalo-agent-cli/accounts/<ownId>`) is a link to it, so every command that
 *   looks there (the controller's probes, the purge, check and backup timers, `za`) finds the same files;
 * - its env file names the folder's parent (`ZALO_DATA_DIR`), so its daemon opens the folder itself.
 *
 * The accounts dir must already exist: it is a mount the host made. A missing one is never created (on a container's
 * own disk the data would vanish with the container); the account then stays in the config dir, as before.
 */
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

/** The environment variable that names the accounts dir when `--accounts-dir` is not given. */
export const ACCOUNTS_DIR_ENV = "ZALO_FLEET_ACCOUNTS_DIR";

/**
 * The accounts dir in force: the flag, else the environment, else null (the account's data stays in DATA_DIR).
 * @param {string|null|undefined} flag
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function accountsDirOf(flag, env = process.env) {
    const v = String(flag ?? env[ACCOUNTS_DIR_ENV] ?? "").trim();
    return v ? resolve(v) : null;
}

/** Every file under `dir` as "relative path:size" (links as "relative path:link"), sorted. */
function inventory(dir) {
    const out = [];
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            const st = lstatSync(p);
            if (st.isDirectory()) walk(p);
            else out.push(`${relative(dir, p)}:${st.isSymbolicLink() ? "link" : st.size}`);
        }
    };
    walk(dir);
    return out.sort();
}

/**
 * Move a folder's contents to `to` (which must not exist): a rename on one file system; across file systems a copy,
 * checked file by file (names and sizes) before the original is removed. A copy that does not match is removed and
 * the original kept.
 * @param {string} from
 * @param {string} to
 */
function moveFolder(from, to) {
    try {
        renameSync(from, to);
        return "renamed";
    } catch (e) {
        if (e.code !== "EXDEV") throw e;
    }
    const partial = `${to}.partial`;
    rmSync(partial, { recursive: true, force: true });
    cpSync(from, partial, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true });
    const a = inventory(from);
    const b = inventory(partial);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
        rmSync(partial, { recursive: true, force: true });
        throw Object.assign(new Error("the copy of the account's data does not match its original; original kept"), {
            code: "ACCOUNT_DATA_COPY_MISMATCH",
        });
    }
    renameSync(partial, to);
    rmSync(from, { recursive: true, force: true });
    return "copied";
}

/**
 * Put one account's data folder under the accounts dir and link `<dataDir>/<ownId>` to it. Idempotent: a link that
 * already points there is left as it is. Data already in `<dataDir>/<ownId>` (the login wrote it there) is moved over
 * first. Nothing is ever overwritten: when both places hold files, or the link points elsewhere, nothing changes and
 * the reason is returned.
 *
 * @param {object} o
 * @param {string} o.ownId
 * @param {string} o.accountsDir - the host's accounts mount (must exist)
 * @param {string} o.dataDir - DATA_DIR (where commands look for `<ownId>`)
 * @returns {{placed: true, dataDir: string, moved?: "renamed"|"copied"} | {placed: false, reason: string}}
 */
export function placeAccountData({ ownId, accountsDir, dataDir }) {
    const root = resolve(accountsDir);
    let rootStat = null;
    try {
        rootStat = statSync(root);
    } catch {
        /* missing */
    }
    if (!rootStat?.isDirectory()) return { placed: false, reason: "ACCOUNTS_DIR_MISSING" };
    if (resolve(dataDir) === root) return { placed: true, dataDir: root };
    const target = join(root, String(ownId));
    const home = join(resolve(dataDir), String(ownId));
    let st = null;
    try {
        st = lstatSync(home);
    } catch {
        /* nothing there yet */
    }
    const targetFull = existsSync(target) && readdirSync(target).length > 0;
    if (st?.isSymbolicLink()) {
        let real = null;
        try {
            real = realpathSync(home);
        } catch {
            /* a dangling link */
        }
        return real && existsSync(target) && real === realpathSync(target)
            ? { placed: true, dataDir: root }
            : { placed: false, reason: "LINKED_ELSEWHERE" };
    }
    let moved;
    if (st?.isDirectory()) {
        if (readdirSync(home).length > 0) {
            if (targetFull) return { placed: false, reason: "BOTH_HAVE_DATA" };
            if (existsSync(target)) rmSync(target, { recursive: true }); // empty
            moved = moveFolder(home, target);
        } else {
            rmSync(home, { recursive: true });
        }
    } else if (st) {
        return { placed: false, reason: "NOT_A_FOLDER" };
    }
    if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    symlinkSync(target, home, "dir");
    return { placed: true, dataDir: root, ...(moved ? { moved } : {}) };
}
