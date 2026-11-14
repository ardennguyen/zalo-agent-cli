/**
 * The session context: the one object a login fills in and every call reads.
 *
 * Its field names are the ones the engine has always read (spec-kernel 2.3), so the 40-odd
 * `api.getContext()` call sites did not change: `API_TYPE`, `API_VERSION`, `imei`, `cookie` (a tough-cookie jar),
 * `userAgent`, `language`, `secretKey` (`zpw_enk`), `uid`, `settings`, `extraVer`, `loginInfo`, `kickout`,
 * `options.polyfill` (the fetch every request goes through), `options.logging`, `options.selfListen`,
 * `options.agent` (the WebSocket's proxy agent only; fetch takes its proxy through `polyfill`), and
 * `uploadCallbacks` (the upload settlement registry below).
 *
 * The context is the same object for a session's whole life: caches are keyed by it.
 */
import { EventEmitter } from "node:events";

/** How long an upload settlement waiter (or a plain callback entry) is kept before it is dropped. */
export const UPLOAD_ENTRY_TTL_MS = 5 * 60 * 1000;

/** How long a settlement that arrived before anyone waited for it is kept. */
export const EARLY_SETTLE_TTL_MS = 60 * 1000;

/**
 * A new session context. Nothing is logged in yet: `secretKey` is null until a login sets it.
 *
 * @param {object} p
 * @param {number} p.apiType - the client type announced (30)
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
 * @property {string|null} url
 * @property {string|null} kind - "file_done", "video_done", "photo_success", ...
 * @property {unknown} data - what the listener hands over: the whole 601 control
 */

/**
 * The registry an upload waits on for the socket's word that the server has the file (the 601 control).
 *
 * It is a `Map` (`get`, `set`, `delete`, `has`), with each entry dropped after {@link UPLOAD_ENTRY_TTL_MS}, so an
 * upload and a listener that use `ctx.uploadCallbacks` as a plain map keep working on it. On top of that:
 *
 * - `waitFor(fileId, {timeoutMs, signal})` resolves with the settlement when it comes;
 * - `settle(fileId, {url, kind, data})` is the one call a listener makes for a finished upload. A function entry
 *   under the id (the upload stands one there) is removed and called with `{fileUrl, fileId}`, the shape a Map-only
 *   listener hands it; every waiter gets the settlement. Only when neither took it is it kept for
 *   {@link EARLY_SETTLE_TTL_MS}, so a `waitFor` that comes a moment later still gets it (a plain map loses such a 601),
 *   and nothing is left behind once someone did.
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
     * Register an entry (a plain callback, or anything an upload keeps), dropped after `ttl`.
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
     * Hand a settlement to whoever waits for this file. A function entry registered as a plain callback is removed and
     * called with `{fileUrl: url, fileId}`; every waiter gets `{fileId, url, kind, data}`. With nobody to take it,
     * the settlement is kept for a short while.
     *
     * @param {string|number} fileId - as the control carries it (handed to a function entry unchanged)
     * @param {{url?: string|null, kind?: string|null, data?: unknown}} [info]
     * @returns {boolean} whether a waiter or a callback took it
     */
    settle(fileId, info = {}) {
        const id = String(fileId);
        const settlement = {
            fileId: id,
            url: info?.url ?? null,
            kind: info?.kind ?? null,
            data: info?.data ?? null,
        };
        let taken = false;
        const entry = super.get(id);
        if (typeof entry === "function") {
            this.delete(id);
            taken = true;
            try {
                entry({ fileUrl: settlement.url, fileId });
            } catch {
                /* a callback's own failure is its own */
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
            const done = () => {
                clearTimeout(timer);
                this.events.off(id, onSettle);
                signal?.removeEventListener("abort", onAbort);
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
 * same value twice and never going back. Two sends in one millisecond get two ids.
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
