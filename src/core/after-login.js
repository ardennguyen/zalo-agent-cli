/**
 * What a QR login left for the account's daemon to finish: the phone's "sync messages" offer and the zCloud key.
 *
 * A person's `zalo-agent login` does both itself, on a socket of its own (src/commands/login.js). A login that ends
 * at the saved session (`login --session-only`, as `fleet serve`'s QR add runs it) opens no socket, because the
 * account's daemon starts right after and holds the account's one socket. So the login writes what the person chose
 * into `<account dir>/after-login.json` (0600):
 *
 *     {"v": 1, "at": <login time, ms>, "newDevice": bool,
 *      "offer": {"restore": bool, "days": number|null},   // present while the offer is still to be read
 *      "cloudKey": true}                                   // present while the key is still to be fetched
 *
 * `restore` is false only for `--no-sync` (report, do not restore). Nothing in it is a secret: the offer's key is
 * read by the daemon from the account's control queue, never written here.
 *
 * The daemon (`listen` and `mcp start` alike, AGENTS.md section 13) runs the steps on its handshake, each under the
 * stage lock, the offer first because its key is short-lived:
 *
 * - **offer**: read the control queues as the login would ({@link readLoginOffer}). Ticked, with a key fresh enough
 *   that the phone does not ask again: restore through the daemon's own `messages` stage with that key (no tap: the
 *   tick was the person's consent at the login). Ticked but too old, or a key for another client, or not ticked: the
 *   daemon starts nothing and logs the `sync` to run (the daemon never starts a phone prompt on its own).
 * - **cloudKey**: when the account keeps files in zCloud and no key is stored, register this engine's device and fetch
 *   the key over the daemon's socket, as the login would; zCloud files open at once.
 *
 * A step that finished (whatever it found) is removed from the file, and the file goes with the last one; a step that
 * failed (no answer from a queue, the restore or the key request threw) stays for the next handshake. A step is never
 * run twice: one run at a time, and a removed step is gone. A person's own login (without `--session-only`) removes
 * the file, since it does both steps itself.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { classifyLoginOffer, collectControls, readLoginOffer } from "./sync-v2/auto-sync.js";
import { CMD_AUTHEN } from "../zalo/listener/socket-tap.js";

/** The file, in the account folder. */
export const AFTER_LOGIN_FILE = "after-login.json";

/** @param {string} accountDir */
export const afterLoginPath = (accountDir) => join(accountDir, AFTER_LOGIN_FILE);

/**
 * Leave the offer check and the key fetch to the daemon.
 *
 * @param {string} accountDir
 * @param {{at: number, newDevice?: boolean, restore?: boolean, days?: number|null, cloudKey?: boolean}} o -
 *   `restore` false: `--no-sync`; `cloudKey` false: `--no-cloud-key` (then no key step)
 * @returns {object} what was written
 */
export function writeAfterLogin(accountDir, { at, newDevice = false, restore = true, days = null, cloudKey = true }) {
    const state = {
        v: 1,
        at,
        newDevice: Boolean(newDevice),
        offer: { restore: restore !== false, days: Number.isInteger(days) && days > 0 ? days : null },
        ...(cloudKey !== false ? { cloudKey: true } : {}),
    };
    writeFileAtomic(afterLoginPath(accountDir), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    return state;
}

/**
 * The steps still to do, or null when there are none (no file, or one that cannot be read).
 *
 * @param {string} accountDir
 * @returns {{at: number, newDevice: boolean, offer?: {restore: boolean, days: number|null}, cloudKey?: true}|null}
 */
export function readAfterLogin(accountDir) {
    try {
        const s = JSON.parse(readFileSync(afterLoginPath(accountDir), "utf8"));
        if (!s || typeof s !== "object" || (!s.offer && !s.cloudKey)) return null;
        return s;
    } catch {
        return null;
    }
}

/**
 * Remove one finished step; the file goes with the last.
 *
 * @param {string} accountDir
 * @param {"offer"|"cloudKey"} step
 */
export function clearAfterLoginStep(accountDir, step) {
    const s = readAfterLogin(accountDir);
    if (!s) return clearAfterLogin(accountDir);
    delete s[step];
    if (!s.offer && !s.cloudKey) return clearAfterLogin(accountDir);
    writeFileAtomic(afterLoginPath(accountDir), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

/** Remove the file (a person's own login does both steps itself). @param {string} accountDir */
export function clearAfterLogin(accountDir) {
    try {
        rmSync(afterLoginPath(accountDir), { force: true });
    } catch {
        /* gone */
    }
}

/** The saved cursor of a control queue, as `listen` keeps it (src/core/self-heal.js), or null. */
async function savedCursorOf() {
    const { getSyncState } = await import("./db.js");
    const { cursorKey } = await import("./self-heal.js");
    return (queueName) => {
        try {
            const saved = JSON.parse(getSyncState(cursorKey(queueName)) ?? "null");
            return /^\d+$/.test(String(saved?.id ?? "")) ? String(saved.id) : null;
        } catch {
            return null;
        }
    };
}

/** The key step's default parts: lazy, so a daemon with nothing to do loads none of the key stack. */
const defaultKeySteps = {
    stored: async (ownId) => (await import("./cloud-key-store.js")).cloudKeyStatus(ownId).stored,
    wanted: async (api) => (await import("./cloud-key-setup.js")).accountWantsCloudKey(api),
    obtain: async (o) => (await import("./cloud-key-setup.js")).obtainCloudKey(o),
};

/**
 * Run what a `login --session-only` left, on this daemon's socket, on every handshake while anything is left.
 *
 * @param {object} p
 * @param {{on: Function, auth?: Function}} p.tap - the daemon's socket tap
 * @param {() => object} p.getApi - the daemon's current api
 * @param {string} p.accountDir
 * @param {string} p.ownId
 * @param {{acquire: (stage: string) => Promise<() => void>}} p.lock - the daemon's stage lock
 * @param {(params: object, onEvent: Function, signal: undefined, internal: {tempKey: string}) => Promise<object>}
 *   p.restore - the daemon's `messages` stage (src/core/daemon-sync.js)
 * @param {(line: string) => void} [p.log]
 * @param {(ownId: string) => {ok: boolean, message?: string}} [p.checkRoom] - the disk/quota check before a restore
 * @param {(queueName: string) => string|null} [p.cursorOf] - default: the saved cursors in the account's cache
 * @param {{stored: Function, wanted: Function, obtain: Function}} [p.keySteps] - replaceable in a test
 * @param {object} [p.offerTiming] - `authWaitMs`, `pageTimeoutMs`, `pullWaitMs` for {@link readLoginOffer}
 * @param {number} [p.delayMs] - after a handshake, before the steps (the socket settles)
 * @param {() => number} [p.now]
 * @returns {{run: () => Promise<{offer?: string, cloudKey?: string}|null>}} `run` is what a handshake schedules
 */
export function attachAfterLogin({
    tap,
    getApi,
    accountDir,
    ownId,
    lock,
    restore,
    log = () => {},
    checkRoom = null,
    cursorOf = null,
    keySteps = defaultKeySteps,
    offerTiming = {},
    delayMs = 1000,
    now = () => Date.now(),
}) {
    const say = (m) => log(`[after-login] ${m}`);
    let running = null;
    // The controls the socket brings, from the first handshake on: the offer can arrive as a push, or in a page the
    // daemon's own catch-up reads, before this step reads the queues itself.
    let collector = readAfterLogin(accountDir)?.offer ? collectControls(tap) : null;

    /** @returns {Promise<{done: boolean, status: string}>} */
    async function offerStep(state, api) {
        collector ??= collectControls(tap);
        const { offer, pulls } = await readLoginOffer({
            listener: api.listener,
            tap,
            entries: collector.entries,
            cursorOf: cursorOf ?? (await savedCursorOf()),
            now,
            ...offerTiming,
        });
        if (offer.status !== "ticked") {
            // Not ticked is only known when the queues answered; a read that got no answer is tried again.
            const unread = pulls.length > 0 && pulls.every((p) => p.reason === "timeout" || p.reason === "error");
            if (offer.status === "none" && unread) {
                say("the control queues did not answer; the 'sync messages' check is tried again on the next start");
                return { done: false, status: "unread" };
            }
            say(
                {
                    none: "'sync messages' was not ticked at the login: nothing to restore (`zalo-agent sync` restores later, with a tap on the phone)",
                    late: "'sync messages' was ticked, but too long ago to restore without a tap; nothing was started (run `zalo-agent sync`)",
                    "other-client": "the phone's 'sync messages' offer was for another client; nothing was started",
                }[offer.status] ?? `offer: ${offer.status}`,
            );
            return { done: true, status: offer.status };
        }
        if (!state.offer.restore) {
            say("'sync messages' was ticked; not restored (the login said --no-sync)");
            return { done: true, status: "declined" };
        }
        const room = checkRoom?.(ownId);
        if (room && !room.ok) {
            say(
                `'sync messages' was ticked; not restored: ${room.message} (run \`zalo-agent sync\` once there is room)`,
            );
            return { done: true, status: "no-room" };
        }
        // Checked again right before the request: a key the phone no longer honors would make it ask, and this
        // daemon never starts a phone prompt on its own.
        const fresh = classifyLoginOffer(
            collector.entries.map((e) => e.control),
            { now: now() },
        );
        if (fresh.status !== "ticked") {
            say(
                "'sync messages' was ticked, but its key is too old now to restore without a tap; run `zalo-agent sync`",
            );
            return { done: true, status: "late" };
        }
        say(`'sync messages' was ticked ${Math.round(fresh.ageMs / 1000)} s ago: restoring with its key (no tap)`);
        const result = await restore({ days: state.offer.days ?? null }, (e) => e?.detail && say(e.detail), undefined, {
            tempKey: fresh.tempKey,
        });
        say(`restore: ${result?.reason ?? "done"}, ${result?.messagesSaved ?? 0} message(s) saved`);
        return { done: true, status: "restored" };
    }

    /** @returns {Promise<{done: boolean, status: string}>} */
    async function keyStep(api) {
        if (await keySteps.stored(ownId)) return { done: true, status: "stored-already" };
        if (!(await keySteps.wanted(api))) return { done: true, status: "not-wanted" };
        const { keyVersion } = await keySteps.obtain({
            api,
            ownId,
            send: (payload) => api.listener.sendWs(payload),
            tap,
        });
        say(`the zCloud key was fetched and sealed (version ${keyVersion ?? "?"}): zCloud files open now`);
        return { done: true, status: "fetched" };
    }

    async function runOnce() {
        const state = readAfterLogin(accountDir);
        if (!state) {
            collector?.stop();
            collector = null;
            return null;
        }
        const out = {};
        for (const [step, body] of [
            ["offer", (api) => offerStep(state, api)],
            ["cloudKey", (api) => keyStep(api)],
        ]) {
            if (!state[step]) continue;
            const api = getApi();
            if (!api?.listener) return out;
            const release = await lock.acquire(step === "offer" ? "after-login-sync" : "after-login-cloud-key");
            try {
                const r = await body(api);
                out[step] = r.status;
                if (r.done) clearAfterLoginStep(accountDir, step);
            } catch (e) {
                out[step] = "failed";
                say(
                    `${step === "offer" ? "the 'sync messages' step" : "the zCloud key"} failed: ${e?.message || e}; tried again on the next start`,
                );
            } finally {
                release();
            }
            if (step === "offer" && !readAfterLogin(accountDir)?.offer) {
                collector?.stop();
                collector = null;
            }
        }
        return out;
    }

    const run = () => {
        // One run at a time: a handshake while one runs joins it.
        running ??= runOnce().finally(() => {
            running = null;
        });
        return running;
    };

    tap.on(CMD_AUTHEN, () => {
        if (!existsSync(afterLoginPath(accountDir))) return;
        const t = setTimeout(() => void run(), delayMs);
        t.unref?.();
    });

    return { run };
}
