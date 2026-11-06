/**
 * The session context: the one object a login fills in and every call reads.
 *
 * Its field names are the ones the engine has read since it ran on zca-js (spec-kernel 2.3), so the 40-odd
 * `api.getContext()` call sites did not change: `API_TYPE`, `API_VERSION`, `imei`, `cookie` (a tough-cookie jar),
 * `userAgent`, `language`, `secretKey` (`zpw_enk`), `uid`, `settings`, `extraVer`, `loginInfo`, `kickout`,
 * `options.polyfill` (the fetch every request goes through), `options.logging`, `options.selfListen`,
 * `options.agent` (the WebSocket's proxy agent only; fetch takes its proxy through `polyfill`), and
 * `uploadCallbacks` (the upload settlement registry below).
 *
 * The context is the same object for a session's whole life: caches are keyed by it.
 */
import { EventEmitter } from "node:events";

/** How long an upload settlement waiter (or a zca-js-style callback) is kept before it is dropped. */
export const UPLOAD_ENTRY_TTL_MS = 5 * 60 * 1000;

/** How long a settlement that arrived before anyone waited for it is kept. */
export const EARLY_SETTLE_TTL_MS = 60 * 1000;

/**
 * A new session context. Nothing is logged in yet: `secretKey` is null until a login sets it.
 *
 * @param {object} p
 * @param {number} p.apiType - the client type announced (30 for Web)
 * @param {number} p.apiVersion - the client version announced (from `src/zalo/profile.js`)
 * @param {string} [p.userAgent]
 * @param {string} [p.imei]
 * @param {string} [p.language]
 * @param {typeof fetch} [p.fetch] - the fetch every request goes through; `globalThis.fetch` at this moment
 *   otherwise (tests replace it before a login so the session captures their fake)
 * @param {object} [p.wsAgent] - a proxy agent for the WebSocket
 * @param {boolean} [p.selfListen] - deliver our own messages to the listener too
 * @param {Function} [p.imageMetadataGetter] - `(path) => {width, height, size}` for uploads
 * @returns {object} the context
 */
export function createSession({
    apiType,
    apiVersion,
    userAgent,
    imei,
    language,
    fetch: fetchFn,
    wsAgent,
    selfListen = false,
    imageMetadataGetter,
} = {}) {
    const ctx = {
        API_TYPE: apiType,
        API_VERSION: apiVersion,
        uploadCallbacks: createUploadRegistry(),
        options: {
            selfListen,
            logging: false,
            polyfill: fetchFn ?? globalThis.fetch,
        },
        secretKey: null,
    };
    if (wsAgent) ctx.options.agent = wsAgent;
    if (imageMetadataGetter) ctx.options.imageMetadataGetter = imageMetadataGetter;
    if (userAgent !== undefined) ctx.userAgent = userAgent;
    if (imei !== undefined) ctx.imei = imei;
    if (language !== undefined) ctx.language = language;
    return ctx;
}

/**
 * @typedef {object} UploadSettlement
 * @property {string} fileId
 * @property {string|null} url - the file's URL when the control carries one (`file_done`, `video_done`)
 * @property {string|null} kind - the control's `act_type`: "file_done", "video_done", "photo_success", ...
 * @property {unknown} data - what the listener handed over: our listener passes the whole control object (its
 *   `content` holds `act_type`, `fileId` and `data`); a settlement that came through zca-js's listener carries the
 *   `{fileUrl, fileId}` that listener builds
 */

/** The keys {@link UploadRegistry#settle} takes. */
const SETTLE_KEYS = new Set(["url", "kind", "data"]);

/** Marks the entry a waiter registers so that zca-js's listener, which only calls Map entries, reaches it too. */
const BRIDGE = Symbol("upload-settle-bridge");

/**
 * The registry an upload waits on for the socket's word that the server has the file (the 601 control).
 *
 * It is a `Map` (`get`, `set`, `delete`, `has`), with each entry dropped after {@link UPLOAD_ENTRY_TTL_MS}, so an
 * upload and a listener written against zca-js's `ctx.uploadCallbacks` keep working on it. On top of that:
 *
 * - `waitFor(fileId, {timeoutMs, signal})` resolves with the settlement when it comes;
 * - `settle(fileId, data)` hands a settlement to its waiter, or, when nobody waits yet, keeps it for
 *   {@link EARLY_SETTLE_TTL_MS} so a `waitFor` that comes a moment later still gets it (zca-js loses such a 601).
 *
 * Timers never keep the process alive.
 */
export class UploadRegistry extends Map {
    constructor() {
        super();
        /** @type {Map<string, {settlement: UploadSettlement, timer: NodeJS.Timeout}>} */
        this.early = new Map();
        /** @type {Map<string, NodeJS.Timeout>} */
        this.timers = new Map();
        this.events = new EventEmitter();
        this.events.setMaxListeners(0);
    }

    /**
     * Register an entry (a zca-js-style callback, or anything an upload keeps), dropped after `ttl`.
     *
     * @param {string} key
     * @param {unknown} value
     * @param {number} [ttl]
     * @returns {this}
     */
    set(key, value, ttl = UPLOAD_ENTRY_TTL_MS) {
        const id = String(key);
        clearTimeout(this.timers?.get(id));
        if (this.timers) {
            const timer = setTimeout(() => {
                this.timers.delete(id);
                super.delete(id);
            }, ttl);
            timer.unref?.();
            this.timers.set(id, timer);
        }
        return super.set(id, value);
    }

    /**
     * @param {string} key
     * @returns {unknown}
     */
    get(key) {
        return super.get(String(key));
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return super.has(String(key));
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
        const id = String(key);
        clearTimeout(this.timers?.get(id));
        this.timers?.delete(id);
        return super.delete(id);
    }

    /**
     * Hand a settlement to whoever waits for this file: the listener's hook for the upload controls of a 601
     * (`file_done`, `video_done`, `photo_success`).
     *
     * `info` takes exactly three keys, each optional: `url` (the file's URL, `content.data.url` of a `file_done` or
     * `video_done`; null for a photo, whose URLs are in `data`), `kind` (the control's `act_type`) and `data` (what
     * the listener received: our listener passes the whole control object). Any other key is refused, so a caller
     * cannot hand over a zca-js-shaped `{fileUrl}` and have the URL silently dropped.
     *
     * A waiter ({@link UploadRegistry#waitFor}) gets the settlement. A function entry registered the zca-js way
     * (zca-js's own upload, while it still runs on this registry) is called with `{fileUrl, fileId}`, the argument
     * zca-js's listener gives it, and removed. With nobody waiting, the settlement is kept for
     * {@link EARLY_SETTLE_TTL_MS}.
     *
     * @param {string} fileId
     * @param {{url?: string|null, kind?: string|null, data?: unknown}} [info]
     * @returns {boolean} whether a waiter or a callback took it
     * @throws {TypeError} for an `info` that is not an object of those keys
     */
    settle(fileId, info = {}) {
        if (!info || typeof info !== "object" || Array.isArray(info)) {
            throw new TypeError("settle(fileId, info): info must be {url, kind, data}");
        }
        const extra = Object.keys(info).filter((k) => !SETTLE_KEYS.has(k));
        if (extra.length) throw new TypeError(`settle(fileId, info): unknown key ${extra.join(", ")}`);
        const id = String(fileId);
        const settlement = {
            fileId: id,
            url: typeof info.url === "string" ? info.url : null,
            kind: typeof info.kind === "string" ? info.kind : null,
            data: info.data ?? null,
        };
        let taken = false;
        const entry = super.get(id);
        if (typeof entry === "function") {
            this.delete(id);
            // A waiter's own bridge is not called: the waiter is reached below, with the whole settlement.
            if (!entry[BRIDGE]) {
                taken = true;
                try {
                    entry({ fileUrl: settlement.url, fileId: id });
                } catch {
                    /* a callback's own failure is its own */
                }
            }
        }
        if (this.events.listenerCount(id) > 0) {
            this.events.emit(id, settlement);
            taken = true;
        }
        if (!taken) {
            clearTimeout(this.early.get(id)?.timer);
            const timer = setTimeout(() => this.early.delete(id), EARLY_SETTLE_TTL_MS);
            timer.unref?.();
            this.early.set(id, { settlement, timer });
        }
        return taken;
    }

    /**
     * Wait for a file's settlement.
     *
     * While it waits, a function entry stands under the file's id (unless something else is registered there),
     * so zca-js's listener, which knows nothing of waiters and only calls the entry it finds, settles it too: the
     * `{fileUrl, fileId}` it passes arrives as `{url: fileUrl, kind: "file_done", data: {fileUrl, fileId}}`.
     * Either listener can therefore settle our uploads.
     *
     * @param {string} fileId
     * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts] - no timeout unless given
     * @returns {Promise<UploadSettlement>}
     * @throws {Error} with `.code` "UPLOAD_TIMEOUT" after `timeoutMs`, or the signal's reason when aborted
     */
    waitFor(fileId, { timeoutMs = 0, signal } = {}) {
        const id = String(fileId);
        const early = this.early.get(id);
        if (early) {
            clearTimeout(early.timer);
            this.early.delete(id);
            return Promise.resolve(early.settlement);
        }
        return new Promise((resolve, reject) => {
            let timer = null;
            let bridge = null;
            const done = () => {
                clearTimeout(timer);
                this.events.off(id, onSettle);
                signal?.removeEventListener("abort", onAbort);
                if (bridge && super.get(id) === bridge) this.delete(id);
            };
            const onSettle = (s) => {
                done();
                resolve(s);
            };
            const onAbort = () => {
                done();
                reject(signal.reason ?? new Error("aborted"));
            };
            if (signal?.aborted) return onAbort();
            this.events.on(id, onSettle);
            if (!super.has(id)) {
                bridge = (wsData) =>
                    this.settle(id, {
                        url: typeof wsData?.fileUrl === "string" ? wsData.fileUrl : null,
                        kind: "file_done",
                        data: wsData ?? null,
                    });
                bridge[BRIDGE] = true;
                this.set(id, bridge);
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    done();
                    const err = new Error(`The server did not confirm the upload within ${timeoutMs} ms`);
                    err.code = "UPLOAD_TIMEOUT";
                    reject(err);
                }, timeoutMs);
                timer.unref?.();
            }
        });
    }
}

/**
 * A new upload settlement registry (see {@link UploadRegistry}).
 *
 * @returns {UploadRegistry}
 */
export function createUploadRegistry() {
    return new UploadRegistry();
}

/**
 * A per-session source of client ids (`clientId`, echoed back as a message's `cliMsgId`): the clock, but never the
 * same value twice and never going back, as Zalo Web's generator does. Two sends in one millisecond get two ids.
 *
 * @param {() => number} [now]
 * @returns {() => number} each call returns `max(now(), last + 1)`
 */
export function createClientIds(now = Date.now) {
    let last = 0;
    return () => {
        const t = Math.floor(Number(now()));
        last = t > last ? t : last + 1;
        return last;
    };
}
