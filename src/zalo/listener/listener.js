/**
 * The chat socket listener: opens the WebSocket the way Zalo Web's socket manager does, reads the handshake key,
 * keeps the ping going for short sessions, and turns the pushes into the typed events the engine subscribes to.
 *
 * Its public surface is the one the engine has always read (agent/docs/zca-replace/spec-listener.md 1): an
 * EventEmitter with the own properties `ws` (the real `ws` socket, or null), `cipherKey`, `urls`, `wsURL`
 * (writable; read at every `start()`) and `pingInterval`, the methods `start()`, `stop()`, `sendWs(payload)`,
 * `requestOldMessages(threadType, lastId)`, `requestOldReactions(threadType, lastId)`, and these events:
 *
 *   connected ()                       the socket opened (not yet authenticated); before any frame of it
 *   cipher_key (key)                   the handshake gave the session key
 *   disconnected (code, reason)        the socket closed; `ws` is already null
 *   closed (code, reason)              right after `disconnected`, for every close
 *   error (err)                        a socket error, or a frame (or one item of it) that could not be read
 *   message, undo, reaction, old_messages, old_reactions, group_event, friend_event, typing, upload_attachment,
 *   delivered_messages, seen_messages, alias_change, profile_change  see ./dispatch.js
 *
 * What it does as Web does, where the previous engine did otherwise (each pinned by tests/unit/wire-listener.test.js
 * and its golden records):
 *  - the upgrade headers are a browser's (`Pragma`, not a misspelled `prgama`), and the `Cookie` is computed
 *    from the jar at every `start()`, for the socket's own host;
 *  - text frames are ignored by the `isBinary` flag (Web reads array buffers only);
 *  - frames that come before the handshake are held and read after it, and sends other than pings wait for it
 *    (Web's `_pendingReceive` and its send queue); pings are never queued;
 *  - a frame whose top-level `error_code` is not 0 is reported, not decoded;
 *  - ids under Web's per-family key lists are kept lossless as strings (../kernel/json-ids.js);
 *  - every chat push is read for every message and receipt list, controls and reactions are read item by item.
 *
 * Order guarantees the engine depends on (spec-listener 14): the handshake key is set synchronously while the frame
 * is delivered, before any raw `message` tap registered later sees that frame; typed events are emitted after every
 * raw tap has seen their frame; `connected` fires from the socket's `open`, before its first frame; `ws` is null
 * before `disconnected`; `stop()` nulls `ws` before it returns.
 *
 * The supervisor (../socket.js) owns retry, rotation, the immediate ping after the key and the pong watch. This
 * listener's own interval pings only while no ping is outstanding (Web's guard), for the short sessions that run
 * without a supervisor. Nothing here writes to stdout or logs; the key, the cookie and ids never leave it except
 * as the events above.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildPull } from "../pulls.js";
import { buildUrl, ACCEPT_LANGUAGE } from "../kernel/http.js";
import { cookieHeader } from "../kernel/cookies.js";
import {
    CMD_AUTH,
    CMD_PING,
    HEADER_BYTES,
    decodeFrame,
    encodeFrame,
    idKeysForCmd,
    readAuthFrame,
    readHeader,
} from "./frames.js";
import { dispatchFrame, isDispatched } from "./dispatch.js";

/** Where Zalo Web's page lives: the `Origin` of the upgrade. */
export const CHAT_ORIGIN = "https://chat.zalo.me";

/** The kick: another session took the account (Web's MAX_CONNECTION). */
export const CMD_KICK = 3000;

/** The close code a kick ends this socket with; the engine reads it as "duplicate session". */
export const CLOSE_DUPLICATE = 3000;

/** The close code of a deliberate `stop()`. */
export const CLOSE_NORMAL = 1000;

/** How long a ping counts as outstanding without its echo (Web's pong timer). */
export const PONG_WAIT_MS = 5000;

/** At most this many frames are held before the handshake, and this many sends; the oldest beyond are dropped. */
export const MAX_PENDING = 1000;

/** The pull a thread type asks for: 1-1 (0) or group (anything else). */
const THREAD_USER = 0;

/**
 * The upgrade headers of a browser opening the chat socket, in the order Chromium sends them (the `ws` library adds
 * `Host`, `Connection`, `Upgrade`, `Sec-WebSocket-Version`, `Sec-WebSocket-Key` and the permessage-deflate offer
 * itself).
 *
 * @param {{userAgent: string, cookie: string}} p
 * @returns {Record<string, string>}
 */
export function upgradeHeaders({ userAgent, cookie }) {
    const headers = {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "User-Agent": userAgent,
        Origin: CHAT_ORIGIN,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": ACCEPT_LANGUAGE,
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
}

/**
 * The URL whose cookies a browser sends on the upgrade: the socket's own host over https. Zalo's socket hosts are
 * under zalo.me; a socket elsewhere (a local test server) gets the chat page's cookies, which is what the jar holds.
 *
 * @param {string} wsURL
 * @returns {string}
 */
export function cookieUrlOf(wsURL) {
    try {
        const host = new URL(wsURL).hostname;
        if (host === "zalo.me" || host.endsWith(".zalo.me")) return `https://${host}/`;
    } catch {
        /* an unreadable URL falls through to the page's cookies */
    }
    return `${CHAT_ORIGIN}/`;
}

/** The socket URL with a fresh `t` stamp, every other query pair kept in place. */
function stamped(wsURL, now) {
    const url = new URL(wsURL);
    url.searchParams.set("t", String(now));
    return url.toString();
}

/**
 * A failure's reason fit for a log line: the message of our own and the crypto and zlib errors, but only the kind of
 * a JSON parse error, whose message quotes the text it failed on (which can hold ids).
 *
 * @param {unknown} e
 * @returns {string}
 */
function safeReason(e) {
    if (e instanceof SyntaxError) return "not JSON (SyntaxError)";
    return String(e?.message ?? e);
}

/** True for a ping frame (`2/1`). */
const isPing = (payload) => payload?.cmd === CMD_PING && payload?.subCmd === 1;

/**
 * The chat socket listener (see the module comment).
 */
export class Listener extends EventEmitter {
    /** @type {object} */
    #ctx;
    /** @type {typeof WebSocket} */
    #WebSocket;
    /** @type {() => number} */
    #now;
    /** The decoded handshake data (`{qCmds, ctrl_qCmds, bk_cmds}`) of the current socket. */
    #auth = null;
    /** Frames of the current socket that came before its handshake. */
    #pendingIn = [];
    /** Sends made before the handshake. */
    #pendingOut = [];
    /** When the outstanding ping went out, or 0. */
    #pingSentAt = 0;

    /**
     * @param {object} ctx - the logged-in context (`cookie` jar, `userAgent`, `uid`, `settings`, `options.agent`,
     *   `uploadCallbacks`)
     * @param {string[]} urls - the login's `zpw_ws`
     * @param {object} [opts]
     * @param {typeof WebSocket} [opts.WebSocket] - the socket class (tests)
     * @param {() => number} [opts.now] - the clock
     */
    constructor(ctx, urls, { WebSocket: Socket = WebSocket, now = Date.now } = {}) {
        super();
        this.#ctx = ctx;
        this.#WebSocket = Socket;
        this.#now = now;
        /** @type {string[]} */
        this.urls = Array.isArray(urls) ? urls : [];
        /** @type {string|undefined} */
        this.wsURL = this.urls[0] ? buildUrl(ctx, this.urls[0], { t: now() }) : undefined;
        /** @type {import("ws").WebSocket|null} */
        this.ws = null;
        /** @type {string|undefined} */
        this.cipherKey = undefined;
        /** @type {NodeJS.Timeout|null} */
        this.pingInterval = null;
    }

    /**
     * Open the socket. The `Cookie` is read from the jar now, and `wsURL` gets a fresh `t`.
     *
     * @param {object} [_opts] - `{retryOnClose}` is accepted and ignored: the supervisor owns retry
     * @throws {Error} while a socket is open ("Already started"), or when the context has no jar or user agent
     */
    start(_opts = {}) {
        if (this.ws) throw new Error("Already started");
        const ctx = this.#ctx;
        if (!ctx?.cookie) throw new Error("Cookie is not available");
        if (!ctx.userAgent) throw new Error("User agent is not available");
        if (!this.wsURL) throw new Error("No socket URL");
        this.wsURL = stamped(this.wsURL, this.#now());
        const cookie = cookieHeader(ctx.cookie, cookieUrlOf(this.wsURL));
        const options = { headers: upgradeHeaders({ userAgent: ctx.userAgent, cookie }) };
        if (ctx.options?.agent) options.agent = ctx.options.agent;

        this.#resetSocketState();
        const ws = new this.#WebSocket(this.wsURL, options);
        this.ws = ws;
        // Registered before anything else can tap this socket, so the key is set before a later tap sees its frame.
        ws.on("message", (data, isBinary) => this.#onMessage(ws, data, isBinary));
        ws.on("open", () => {
            if (this.ws === ws) this.emit("connected");
        });
        ws.on("error", (err) => this.#report(err));
        ws.on("close", (code, reason) => {
            if (this.ws === ws) this.#reset();
            const why = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? "");
            this.emit("disconnected", code, why);
            this.emit("closed", code, why);
        });
    }

    /** Close the socket (code 1000). `ws` is null when this returns; `disconnected` and `closed` follow. */
    stop() {
        const ws = this.ws;
        if (!ws) return;
        this.#reset();
        try {
            ws.close(CLOSE_NORMAL);
        } catch {
            /* a socket that is already going away */
        }
    }

    /**
     * Send one frame: `{version, cmd, subCmd, data}`, the header then the JSON of `data`, as it is: a request that
     * needs an id carries its own `reqId` in `data`, as Web's do. Without a socket it does nothing. Before the
     * handshake a ping is dropped and anything else waits for it, in order.
     *
     * @param {{version?: number, cmd: number, subCmd: number, data?: object}} payload
     * @throws {TypeError} for a header field out of range (see ./frames.js `encodeFrame`)
     */
    sendWs(payload) {
        const ws = this.ws;
        if (!ws) return;
        const frame = encodeFrame(payload);
        if (ws.readyState !== WebSocket.OPEN || !this.cipherKey) {
            if (isPing(payload)) return;
            this.#pendingOut.push(frame);
            if (this.#pendingOut.length > MAX_PENDING) this.#pendingOut.shift();
            return;
        }
        if (isPing(payload)) this.#pingSentAt = this.#now();
        ws.send(frame);
    }

    /**
     * Ask for the old messages of one thread type (510 1-1, 511 group), the Web way.
     *
     * @param {number} threadType - 0 for 1-1, 1 for groups
     * @param {string|null} [lastId]
     */
    requestOldMessages(threadType, lastId = null) {
        this.sendWs(buildPull(threadType === THREAD_USER ? 510 : 511, 1, { lastId }));
    }

    /**
     * Ask for the old reactions of one thread type (610 1-1, 611 group), the Web way.
     *
     * @param {number} threadType - 0 for 1-1, 1 for groups
     * @param {string|null} [lastId]
     */
    requestOldReactions(threadType, lastId = null) {
        this.sendWs(buildPull(threadType === THREAD_USER ? 610 : 611, 1, { lastId }));
    }

    // ---- internals -----------------------------------------------------------------------------------------

    /** Emit `error`, unless nobody listens (an EventEmitter throws on an unheard error). */
    #report(err) {
        if (this.listenerCount("error") > 0) this.emit("error", err);
    }

    #resetSocketState() {
        this.#auth = null;
        this.#pendingIn = [];
        this.#pendingOut = [];
        this.#pingSentAt = 0;
    }

    /** The socket is gone: no socket, no key, no ping, nothing pending. */
    #reset() {
        this.ws = null;
        this.cipherKey = undefined;
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.#resetSocketState();
    }

    /**
     * One frame off the socket. The handshake, the ping echo and the kick are handled here, synchronously; a frame
     * this listener turns into events is read after the current delivery, so every raw tap sees it first.
     */
    #onMessage(ws, data, isBinary) {
        if (!isBinary || this.ws !== ws) return;
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        const head = readHeader(buf);
        if (!head) return;
        const { version, cmd, subCmd } = head;

        // Any echo of a ping clears the guard, a bare header included: it needs no body to say the server answered.
        if (cmd === CMD_PING) {
            this.#pingSentAt = 0;
            return;
        }
        if (buf.length === HEADER_BYTES) return;
        if (cmd === CMD_KICK && version === 1 && subCmd === 0) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try {
                    ws.close(CLOSE_DUPLICATE);
                } catch {
                    /* already closing */
                }
            }
            return;
        }
        const isAuth = cmd === CMD_AUTH && version === 1 && subCmd === 1;
        if (!isAuth && !isDispatched(cmd, subCmd)) return;

        let envelope;
        try {
            envelope = JSON.parse(buf.subarray(HEADER_BYTES).toString("utf8"));
        } catch {
            this.#report(new Error(`cmd ${cmd}: frame body is not JSON`));
            return;
        }
        if (!envelope || typeof envelope !== "object") return;

        if (isAuth && Object.hasOwn(envelope, "key")) {
            this.#onAuth(envelope);
            return;
        }
        if (isAuth) return;
        if (!this.cipherKey) {
            this.#pendingIn.push({ head, envelope });
            if (this.#pendingIn.length > MAX_PENDING) this.#pendingIn.shift();
            return;
        }
        this.#later(head, envelope);
    }

    /** The handshake: take the key, then everything that waited for it. */
    #onAuth(envelope) {
        let read;
        try {
            read = readAuthFrame(envelope);
        } catch (e) {
            this.#report(new Error(`handshake not accepted: ${safeReason(e)}`, { cause: e }));
            return;
        }
        this.cipherKey = read.key;
        this.#auth = read.auth;
        try {
            this.emit("cipher_key", read.key);
        } catch (e) {
            this.#report(e);
        }
        this.#startPinging();
        const held = this.#pendingIn;
        this.#pendingIn = [];
        for (const { head, envelope: env } of held) this.#later(head, env);
        const sends = this.#pendingOut;
        this.#pendingOut = [];
        for (const frame of sends) {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
        }
    }

    /** Read a frame once the current delivery is over (microtasks run in order, so frames keep theirs). */
    #later(head, envelope) {
        const key = this.cipherKey;
        const auth = this.#auth;
        queueMicrotask(() => this.#dispatch(head, envelope, key, auth));
    }

    /** Decode one frame and carry out its steps. */
    #dispatch(head, envelope, key, auth) {
        const { cmd } = head;
        const code = envelope.error_code;
        if (code !== undefined && code !== null && Number(code) !== 0) {
            const err = new Error(`cmd ${cmd}: the server answered error_code ${code}`);
            err.code = Number(code);
            this.#report(err);
            return;
        }
        let payload;
        try {
            payload = decodeFrame(envelope, key, { idKeys: idKeysForCmd(cmd, auth) });
        } catch (e) {
            this.#report(new Error(`cmd ${cmd}: frame not readable: ${safeReason(e)}`, { cause: e }));
            return;
        }
        let steps;
        try {
            steps = dispatchFrame(String(this.#ctx?.uid ?? ""), head, payload?.data);
        } catch (e) {
            this.#report(new Error(`cmd ${cmd}: ${safeReason(e)}`, { cause: e }));
            return;
        }
        for (const step of steps) {
            try {
                if (step.error) this.#report(step.error);
                else if (step.settle) this.#settle(step.settle);
                else this.emit(step.emit, ...step.args);
            } catch (e) {
                this.#report(e);
            }
        }
    }

    /**
     * An upload the server finished: one `settle(fileId, {url, kind, data})` with the whole control as `data`. The
     * registry (src/zalo/kernel/session.js) calls a callback registered as a plain entry with `{fileUrl, fileId}`
     * and hands the waiters the settlement. A plain Map (no `settle`) only gets its callback called and removed.
     */
    #settle({ fileId, url, kind, control }) {
        const registry = this.#ctx?.uploadCallbacks;
        if (!registry || fileId === undefined || fileId === null) return;
        if (typeof registry.settle === "function") {
            registry.settle(fileId, { url, kind, data: control });
            return;
        }
        const id = String(fileId);
        const callback = registry.get?.(id);
        if (typeof callback !== "function") return;
        registry.delete(id);
        try {
            callback({ fileUrl: url, fileId });
        } catch {
            /* the callback's failure is its own */
        }
    }

    /** The interval ping for sessions without a supervisor; skipped while one is outstanding. */
    #startPinging() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
        const every = Number(this.#ctx?.settings?.features?.socket?.ping_interval);
        if (!Number.isFinite(every) || every <= 0) return;
        // A ping counts as outstanding for Web's pong wait, or for one interval when the interval is shorter: a
        // ping older than that has missed its echo, which the supervisor's pong watch acts on; this only keeps the
        // cadence without sending a second ping on top of one still in flight (the supervisor's own, after the key).
        const outstandingMs = Math.min(PONG_WAIT_MS, every);
        this.pingInterval = setInterval(() => {
            const sentAt = this.#pingSentAt;
            if (sentAt && this.#now() - sentAt < outstandingMs) return;
            try {
                this.sendWs({ version: 1, cmd: CMD_PING, subCmd: 1, data: { eventId: this.#now() } });
            } catch {
                /* a send on a closing socket */
            }
        }, every);
        this.pingInterval.unref?.();
    }
}

/**
 * Build the session's listener.
 *
 * @param {object} ctx - the logged-in context
 * @param {string[]} wsUrls - the login's `zpw_ws`
 * @param {{WebSocket?: typeof WebSocket, now?: () => number}} [opts]
 * @returns {Listener}
 */
export function createListener(ctx, wsUrls, opts = {}) {
    return new Listener(ctx, wsUrls, opts);
}
