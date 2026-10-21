/**
 * Start-up spreading inside the daemon: a random delay before it logs in, and a cap on how many daemons on
 * this machine are logging in and loading their lists at the same moment.
 *
 * Every start logs in and loads the account's friend and group lists, and a fleet that restarts together (a
 * reboot, a deploy, a crash loop) does all of that at once: the heaviest moment of each daemon's life, all
 * against Zalo from one address. The systemd unit spreads it with `sleep $((RANDOM % 30))` and `fleet start`
 * with batches, but both are the supervisor's doing and neither exists for a daemon started by hand, by a
 * container, or by another supervisor. These settings put the same protection in the engine, off by default
 * (one account loses nothing by starting at once).
 *
 *  - `ZALO_START_JITTER` (seconds, default 0): wait a random time up to this long before logging in.
 *  - `ZALO_LOGIN_SLOTS` (default 0, no cap): at most this many daemons on the machine between "about to log
 *    in" and "lists loaded". A daemon over the cap waits for a slot, up to `ZALO_LOGIN_SLOT_WAIT` seconds
 *    (default 900), then goes ahead anyway: a stuck slot must not keep an account offline.
 *
 * A slot is a file in `<config dir>/login-slots/` holding the owner's pid; a slot whose owner died, or that
 * has been held for `holdSec`, is reclaimed. Both settings take an `_<ownId>` form.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SLOT_WAIT_SEC = 900;
/** A slot held this long is a stuck daemon, not a slow one: a start-up is seconds. */
export const DEFAULT_SLOT_HOLD_SEC = 300;
export const MAX_JITTER_SEC = 600;
export const MAX_SLOTS = 64;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} pid */
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM";
    }
}

/**
 * The start-up settings of one account: `NAME_<ownId>`, then `NAME`, then the defaults. A value that cannot be
 * used is reported and replaced by the default.
 *
 * @param {{ env?: NodeJS.ProcessEnv, ownId?: string|null }} [args]
 * @returns {{ jitterSec: number, slots: number, waitSec: number, holdSec: number, warnings: string[] }}
 */
export function resolveStartupSettings({ env = process.env, ownId = null } = {}) {
    const warnings = [];
    const pick = (name) => {
        const scoped = ownId ? env[`${name}_${ownId}`] : undefined;
        const v = typeof scoped === "string" && scoped.trim() ? scoped : env[name];
        return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const whole = (name, label, min, max, fallback) => {
        const raw = pick(name);
        if (raw === null) return fallback;
        const n = Number(raw);
        if (Number.isInteger(n) && n >= min && n <= max) return n;
        warnings.push(`${name}="${raw}" is not a whole number from ${min} to ${max} (${label}); using ${fallback}`);
        return fallback;
    };
    return {
        jitterSec: whole("ZALO_START_JITTER", "seconds", 0, MAX_JITTER_SEC, 0),
        slots: whole("ZALO_LOGIN_SLOTS", "0 means no cap", 0, MAX_SLOTS, 0),
        waitSec: whole("ZALO_LOGIN_SLOT_WAIT", "seconds", 1, 86400, DEFAULT_SLOT_WAIT_SEC),
        holdSec: DEFAULT_SLOT_HOLD_SEC,
        warnings,
    };
}

/**
 * @param {object} args
 * @param {string} args.configDir - Slots live in `<configDir>/login-slots/`, shared by every daemon on the machine
 * @param {string} args.ownId
 * @param {ReturnType<typeof resolveStartupSettings>} args.settings
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.random]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 * @returns {{ enter: () => Promise<{ jitteredMs: number, waitedMs: number, slot: number|null, timedOut: boolean }>, leave: () => void, held: () => number|null }}
 */
export function createStartupGate({
    configDir,
    ownId,
    settings,
    log = () => {},
    random = Math.random,
    sleep = defaultSleep,
    now = Date.now,
}) {
    const dir = join(configDir, "login-slots");
    let mine = null; // { file, text }
    let exitHook = false;

    const slotFile = (i) => join(dir, `slot-${i}`);

    /** Remove slot files whose owner is gone or that have been held too long. */
    function reclaimStale() {
        let names = [];
        try {
            names = readdirSync(dir).filter((n) => /^slot-\d+$/.test(n));
        } catch {
            return;
        }
        for (const n of names) {
            const file = join(dir, n);
            try {
                const text = readFileSync(file, "utf8");
                const owner = JSON.parse(text)?.pid;
                const age = now() - statSync(file).mtimeMs;
                if ((Number.isInteger(owner) && !alive(owner)) || age > settings.holdSec * 1000) {
                    // Only what was judged stale: a slot freed and retaken meanwhile is a live one.
                    if (readFileSync(file, "utf8") === text) unlinkSync(file);
                }
            } catch {
                /* released meanwhile, or unreadable: the next try finds out */
            }
        }
    }

    function tryTake() {
        const text = JSON.stringify({ pid: process.pid, ownId, at: now() });
        for (let i = 0; i < settings.slots; i++) {
            try {
                const fd = openSync(slotFile(i), "wx", 0o600);
                try {
                    writeSync(fd, text);
                } finally {
                    closeSync(fd);
                }
                mine = { file: slotFile(i), text, index: i };
                return i;
            } catch (e) {
                if (e.code !== "EEXIST") throw e;
            }
        }
        return null;
    }

    function leave() {
        if (!mine) return;
        const { file, text } = mine;
        mine = null;
        try {
            // Never remove a slot another daemon took over while this one was stuck.
            if (readFileSync(file, "utf8") === text) unlinkSync(file);
        } catch {
            /* already gone */
        }
    }

    return {
        /**
         * Wait out the jitter, then wait for a slot. Resolves when this daemon may log in.
         * @returns {Promise<{ jitteredMs: number, waitedMs: number, slot: number|null, timedOut: boolean }>}
         */
        async enter() {
            let jitteredMs = 0;
            if (settings.jitterSec > 0) {
                jitteredMs = Math.round(random() * settings.jitterSec * 1000);
                log(
                    `start-up jitter: waiting ${(jitteredMs / 1000).toFixed(1)}s of up to ${settings.jitterSec}s before logging in`,
                );
                await sleep(jitteredMs);
            }
            if (settings.slots <= 0) return { jitteredMs, waitedMs: 0, slot: null, timedOut: false };

            mkdirSync(dir, { recursive: true });
            if (!exitHook) {
                exitHook = true;
                process.on("exit", leave);
            }
            const started = now();
            let announced = false;
            for (;;) {
                reclaimStale();
                const slot = tryTake();
                if (slot !== null) {
                    const waitedMs = now() - started;
                    if (announced)
                        log(`got login slot ${slot + 1} of ${settings.slots} after ${(waitedMs / 1000).toFixed(1)}s`);
                    return { jitteredMs, waitedMs, slot, timedOut: false };
                }
                const waitedMs = now() - started;
                if (waitedMs >= settings.waitSec * 1000) {
                    log(
                        `no login slot free after ${settings.waitSec}s (ZALO_LOGIN_SLOTS=${settings.slots}); logging in anyway: ` +
                            "a stuck slot must not keep an account offline",
                    );
                    return { jitteredMs, waitedMs, slot: null, timedOut: true };
                }
                if (!announced) {
                    announced = true;
                    log(`waiting for a login slot (ZALO_LOGIN_SLOTS=${settings.slots}): other daemons are logging in`);
                }
                await sleep(150 + Math.floor(random() * 350));
            }
        },
        /** Give the slot back. Safe to call twice, or without having entered. */
        leave,
        /** The slot this daemon holds, or null. */
        held: () => (mine ? mine.index : null),
    };
}
