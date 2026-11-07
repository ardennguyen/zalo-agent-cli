/**
 * The account's hidden conversations, as Zalo Web keeps them: which threads are hidden, whether a PIN is set, and the
 * check of a PIN someone typed. Shared by the CLI and the MCP server, so both hide the same threads.
 *
 * - The set is filled from `hiddenconvers/get-all` (refresh) and kept current from the 601 `hidden_chat` controls
 *   (attachHiddenChatControls): `add_remove` refetches, `reset` clears it (Web's other devices only clear their local
 *   state; the device that reset deletes the conversations), `change_pin` takes the new hash.
 * - Zalo's get-all answer carries `pin`, the unsalted MD5 of the 4-digit PIN. It stays in this process's memory, in a
 *   private field, and is used only to check a PIN. It is never written, logged or returned.
 * - A mirror of the thread ids alone (`hidden-threads.json` in the account folder) lets a command that has no
 *   session (`msg search`) still leave hidden threads out.
 * - A wrong PIN counts toward a lockout, as Web's does: after 6 failures, each further try waits a growing back-off.
 *   The state file (`hidden-pin-lockout.json`) holds only counts and times.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readSealedJson, scopeOfDir, writeSealedJson } from "./keystore/index.js";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";

/** Failures before the back-off starts (Zalo Web's count). */
export const PIN_FREE_TRIES = 6;
/** The first back-off, doubled for each further failure, capped at PIN_MAX_BACKOFF_MS. */
export const PIN_BASE_BACKOFF_MS = 30_000;
export const PIN_MAX_BACKOFF_MS = 60 * 60_000;

const MIRROR_FILE = "hidden-threads.json";
const LOCKOUT_FILE = "hidden-pin-lockout.json";
const PIN_SHAPE = /^\d{4}$/;

/** A thread id as the set keeps it: digits only (a `g`/`u` prefix, as Zalo's lists carry it, is dropped). */
export function hiddenKey(id) {
    const text = String(id ?? "").trim();
    return /^[a-z]\d+$/i.test(text) ? text.slice(1) : text;
}

/**
 * The mirror says which chats are hidden, so it is sealed like the other account secrets (src/core/keystore), under
 * the boot key: a command that filters hidden chats offline must open it before any login brings the dkey. A key
 * error is not swallowed: reading the mirror as empty would show hidden chats.
 */
const MIRROR_SPEC = Object.freeze({ kind: "hidden-threads", use: "boot" });

function readJson(file) {
    if (file.endsWith(MIRROR_FILE)) {
        try {
            return readSealedJson(file, scopeOfDir(dirname(file)), MIRROR_SPEC);
        } catch (e) {
            if (e?.code === "ENOENT" || e instanceof SyntaxError) return null;
            throw e;
        }
    }
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function writeJson(dir, name, value) {
    if (!dir) return;
    try {
        mkdirSync(dir, { recursive: true });
        if (name === MIRROR_FILE) writeSealedJson(join(dir, name), scopeOfDir(dir), MIRROR_SPEC, value);
        else writeFileAtomic(join(dir, name), JSON.stringify(value), { mode: 0o600 });
    } catch (e) {
        console.error(`[hidden-chats] could not write ${name}: ${e.message}`);
    }
}

/**
 * The back-off after `failures` wrong PINs, in ms (0 while fewer than PIN_FREE_TRIES).
 *
 * @param {number} failures
 * @returns {number}
 */
export function pinBackoffMs(failures) {
    if (failures < PIN_FREE_TRIES) return 0;
    return Math.min(PIN_MAX_BACKOFF_MS, PIN_BASE_BACKOFF_MS * 2 ** (failures - PIN_FREE_TRIES));
}

/** One account's hidden conversations, in this process. */
export class HiddenChats {
    #hash = null;

    /**
     * @param {object} [opts]
     * @param {string} [opts.accountId]
     * @param {string|null} [opts.stateDir] - the account folder, for the id mirror and the lockout file
     * @param {() => number} [opts.now]
     */
    constructor({ accountId = null, stateDir = null, now = Date.now } = {}) {
        this.accountId = accountId ? String(accountId) : null;
        this.stateDir = stateDir;
        this.now = now;
        /** @type {Set<string>} */
        this.ids = new Set();
        /** True once the set came from Zalo or the mirror; false means "not known". */
        this.known = false;
        this.hasPin = false;
        this.updatedAt = null;
        this.source = null;
        const mirror = stateDir ? readJson(join(stateDir, MIRROR_FILE)) : null;
        if (Array.isArray(mirror?.threadIds)) {
            for (const id of mirror.threadIds) this.ids.add(hiddenKey(id));
            this.hasPin = Boolean(mirror.hasPin);
            this.known = true;
            this.updatedAt = mirror.updatedAt ?? null;
            this.source = "mirror";
        }
    }

    /**
     * Take Zalo's get-all answer: the threads, and the PIN hash (kept in memory only).
     *
     * @param {object|null|undefined} raw
     * @returns {this}
     */
    setFromServer(raw) {
        const threads = Array.isArray(raw?.threads) ? raw.threads : [];
        this.ids = new Set(
            threads.map((t) => hiddenKey(typeof t === "object" && t ? (t.thread_id ?? t.threadId ?? t.id) : t)),
        );
        this.ids.delete("");
        this.#hash = typeof raw?.pin === "string" && raw.pin ? raw.pin.toLowerCase() : null;
        this.hasPin = Boolean(this.#hash);
        this.known = true;
        this.updatedAt = this.now();
        this.source = "zalo";
        this.#mirror();
        return this;
    }

    /** The hidden threads as Zalo listed them: `{threadId, isGroup}` (from the last get-all answer, or ids only). */
    threads(raw) {
        const list = Array.isArray(raw?.threads) ? raw.threads : null;
        if (!list) return [...this.ids].map((threadId) => ({ threadId, isGroup: null }));
        return list.map((t) => ({
            threadId: hiddenKey(t?.thread_id ?? t?.threadId ?? t?.id ?? t),
            isGroup: t?.is_group === undefined ? null : Number(t.is_group) === 1,
        }));
    }

    /**
     * Read the set from Zalo. A failure keeps what was known and is thrown to the caller.
     *
     * @param {{getHiddenConversations: () => Promise<object>}} api
     * @returns {Promise<object>} Zalo's raw answer (callers must never pass its `pin` on)
     */
    async refresh(api) {
        const raw = await api.getHiddenConversations();
        this.setFromServer(raw);
        return raw;
    }

    /**
     * Refresh when the set is not known yet; never throws (a failure is logged once per call site).
     *
     * @param {object} api
     * @returns {Promise<boolean>} whether the set is known afterwards
     */
    async ensure(api) {
        if (this.known && this.source === "zalo") return true;
        if (!api?.getHiddenConversations) return this.known;
        try {
            await this.refresh(api);
        } catch (e) {
            console.error(`[hidden-chats] could not read the hidden conversations: ${e.message}`);
        }
        return this.known;
    }

    /** Forget the hidden threads and the PIN (a `reset` control, or our own reset). */
    clear() {
        this.ids = new Set();
        this.#hash = null;
        this.hasPin = false;
        this.known = true;
        this.updatedAt = this.now();
        this.#mirror();
    }

    /** Take a new PIN hash (a `change_pin` control carries it). */
    setPinHash(hash) {
        this.#hash = typeof hash === "string" && hash ? hash.toLowerCase() : null;
        this.hasPin = Boolean(this.#hash);
        this.#mirror();
    }

    /** True for a hidden thread. */
    isHidden(threadId) {
        return this.ids.size > 0 && this.ids.has(hiddenKey(threadId));
    }

    #mirror() {
        writeJson(this.stateDir, MIRROR_FILE, {
            threadIds: [...this.ids],
            hasPin: this.hasPin,
            updatedAt: this.updatedAt,
        });
    }

    #lockout() {
        const s = this.stateDir ? readJson(join(this.stateDir, LOCKOUT_FILE)) : this._lockoutMem;
        return {
            failures: Number.isInteger(s?.failures) ? s.failures : 0,
            lastFailureAt: Number.isFinite(s?.lastFailureAt) ? s.lastFailureAt : 0,
        };
    }

    #saveLockout(state) {
        if (this.stateDir) writeJson(this.stateDir, LOCKOUT_FILE, state);
        else this._lockoutMem = state;
    }

    /** How long until a PIN may be tried again, in ms (0 = now), and the failures so far. */
    lockoutStatus() {
        const { failures, lastFailureAt } = this.#lockout();
        const wait = pinBackoffMs(failures);
        const retryAfterMs = Math.max(0, lastFailureAt + wait - this.now());
        return { failures, retryAfterMs, triesBeforeBackoff: Math.max(0, PIN_FREE_TRIES - failures) };
    }

    /**
     * Check a PIN against the hash Zalo gave, counting a wrong one toward the lockout. The PIN is not kept.
     *
     * @param {string} pin
     * @returns {{ok: true} | {ok: false, reason: "no-pin"|"shape"|"locked"|"wrong", retryAfterMs?: number, failures?: number}}
     */
    verifyPin(pin) {
        if (!this.#hash) return { ok: false, reason: "no-pin" };
        const status = this.lockoutStatus();
        if (status.retryAfterMs > 0) return { ok: false, reason: "locked", ...status };
        const text = String(pin ?? "");
        if (!PIN_SHAPE.test(text)) return { ok: false, reason: "shape" };
        const given = Buffer.from(createHash("md5").update(text).digest("hex"));
        const expected = Buffer.from(this.#hash);
        if (given.length === expected.length && timingSafeEqual(given, expected)) {
            if (status.failures) this.#saveLockout({ failures: 0, lastFailureAt: 0 });
            return { ok: true };
        }
        const failures = status.failures + 1;
        this.#saveLockout({ failures, lastFailureAt: this.now() });
        return { ok: false, reason: "wrong", failures, retryAfterMs: pinBackoffMs(failures) };
    }
}

/**
 * The sentence for a failed PIN check, with no secret in it.
 *
 * @param {{reason: string, retryAfterMs?: number, failures?: number}} r
 * @returns {string}
 */
export function pinFailureLine(r) {
    switch (r.reason) {
        case "no-pin":
            return "This account has no hidden-chat PIN set; set one first (on the phone, or with `conv hidden-pin`).";
        case "shape":
            return "The PIN is 4 digits.";
        case "locked":
            return `Too many wrong PINs: try again in ${Math.ceil((r.retryAfterMs ?? 0) / 1000)} s.`;
        default:
            return (
                `Wrong PIN (${r.failures} failed${r.failures === 1 ? "" : " in a row"}).` +
                (r.retryAfterMs ? ` Wait ${Math.ceil(r.retryAfterMs / 1000)} s before the next try.` : "")
            );
    }
}

/**
 * The conversation ids a raw read (`zalo_read`, `read run`) names in its args (`uid`, `groupId`, `threadId`, `tId`, and the id lists
 * `group`/`oneone`/`items`/`data`), so a hidden conversation can be refused before Zalo is asked.
 *
 * @param {object|undefined} args
 * @returns {string[]}
 */
export function readThreadIds(args) {
    const out = [];
    const take = (v) => {
        if (v === undefined || v === null) return;
        if (Array.isArray(v)) {
            v.forEach(take);
            return;
        }
        if (typeof v === "object") {
            for (const k of ["tId", "threadId", "id", "uid", "groupId", "toid"]) take(v[k]);
            return;
        }
        out.push(String(v));
    };
    for (const k of ["uid", "groupId", "threadId", "tId", "group", "oneone", "items", "data", "toid"]) take(args?.[k]);
    return out;
}

const registry = new Map();

/**
 * The process-wide hidden set of one account (one per process in the fleet, but `mcp start` and tests may hold more).
 *
 * @param {string} accountId
 * @param {{stateDir?: string|null}} [opts]
 * @returns {HiddenChats}
 */
export function hiddenChatsFor(accountId, { stateDir = null } = {}) {
    const key = String(accountId ?? "");
    let set = registry.get(key);
    if (!set) {
        set = new HiddenChats({ accountId: key || null, stateDir });
        registry.set(key, set);
    }
    return set;
}

/** Test seam: forget every account's set. */
export function resetHiddenChatsRegistry() {
    registry.clear();
}

/**
 * What a policy (src/core/deploy-policy.js) shows, given an unlock for this one call.
 *
 * @param {"exclude"|"contentless"|"include"} mode
 * @param {boolean} [unlocked]
 * @returns {"exclude"|"contentless"|"include"}
 */
export function effectiveHiddenMode(mode, unlocked = false) {
    return unlocked ? "include" : mode || "exclude";
}

/**
 * A list with the hidden threads left out (every mode but `include`: a list never shows a contentless row).
 *
 * @template T
 * @param {T[]} list
 * @param {HiddenChats|null|undefined} set
 * @param {string} mode
 * @param {(item: T) => unknown} [idOf]
 * @returns {T[]}
 */
export function withoutHidden(list, set, mode, idOf = (item) => item?.threadId) {
    if (!Array.isArray(list) || !set || mode === "include" || set.ids.size === 0) return list;
    return list.filter((item) => !set.isHidden(idOf(item)));
}

/**
 * An event as the policy passes it on: unchanged, null (left out), or `{event, hidden: true}` with no thread id and
 * no content (`contentless`, Web's unread dot).
 *
 * @param {object} event
 * @param {HiddenChats|null|undefined} set
 * @param {string} mode
 * @param {{name?: string, idOf?: (e: object) => unknown}} [opts]
 * @returns {object|null}
 */
export function hiddenEventView(event, set, mode, { name, idOf = (e) => e?.threadId } = {}) {
    if (!event || !set || mode === "include" || !set.isHidden(idOf(event))) return event;
    if (mode === "contentless") {
        return {
            event: name ?? event.event ?? event.type ?? "message",
            hidden: true,
            // The buffer's own position, so a reader's cursor still moves past it (no content, no ids).
            ...(event._cursor !== undefined && { _cursor: event._cursor }),
        };
    }
    return null;
}

/**
 * Keep a hidden set current from the 601 `hidden_chat` controls on the socket tap (src/zalo/listener/socket-tap.js):
 * `add_remove` refetches the list, `reset` clears it, `change_pin` takes the new hash. The tap outlives re-logins.
 *
 * @param {object} opts
 * @param {{on: Function}} opts.tap
 * @param {HiddenChats} opts.set
 * @param {() => object} opts.getApi
 * @param {(frameData: object) => object[]} opts.readControls - src/zalo/queues/control-queue.js readControls
 * @returns {() => void} unsubscribe (when the tap offers one)
 */
export function attachHiddenChatControls({ tap, set, getApi, readControls }) {
    const off = tap.on(601, (frame) => {
        let controls = [];
        try {
            controls = readControls(frame?.data) || [];
        } catch {
            return;
        }
        for (const c of controls) {
            if (c?.actType !== "hidden_chat") continue;
            if (c.act === "reset") set.clear();
            else if (c.act === "change_pin") set.setPinHash(c.data?.pin);
            if (c.act === "add_remove" || c.act === "change_pin" || c.act === "reset") {
                Promise.resolve()
                    .then(() => set.refresh(getApi()))
                    .catch((e) => console.error(`[hidden-chats] refresh after ${c.act} failed: ${e.message}`));
            }
        }
    });
    return typeof off === "function" ? off : () => {};
}
