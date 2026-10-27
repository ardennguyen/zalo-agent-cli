/**
 * What a running daemon can say about itself: is the socket up, when did anything last arrive, how
 * far behind is the webhook, is it short of memory or blocked.
 *
 * `mcp start` and `listen` hold one account's one socket. Until this module the only outside view
 * was `GET /health`, which answered `ok` with an uptime and a thread count whether the socket had
 * been down for a minute or a week, so a fleet could not tell which accounts had gone quiet. Both
 * entry points now build one of these (AGENTS.md section 13: they must not differ) and expose it:
 *
 *   - `mcp start --http`: `GET /health` (liveness, unchanged shape plus the socket), `GET /ready`
 *     (200 only while the socket is up), and, behind the bearer token, `GET /status` (everything)
 *     and `GET /metrics` (Prometheus text).
 *   - both: `POST /status` on the loopback channel, which `listen --status` / `mcp start --status`
 *     print, so a `listen` daemon with no HTTP port is just as visible.
 *
 * Sources that only exist later in start-up (the webhook outbox, the message buffer, the stage
 * lock) are plugged in with `setSource`, so the HTTP server can take the health object before they
 * are built.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { EXPIRY_WARN_DAYS, describeSessionExpiry } from "./session-expiry.js";

/** The listener events whose arrival means the account is alive; their counts are exported. */
export const COUNTED_EVENTS = Object.freeze([
    "message",
    "reaction",
    "undo",
    "group_event",
    "friend_event",
    "seen_messages",
    "delivered_messages",
]);

/** A webhook backlog older than this is reported as a warning. */
const WEBHOOK_AGE_WARN_MS = 5 * 60 * 1000;
/** A socket that has been down this long is reported, beyond the state itself. */
const SOCKET_DOWN_WARN_MS = 2 * 60 * 1000;
/** The event-loop histogram is cleared this often so it describes recent behavior, not all of history. */
const LAG_WINDOW_MS = 5 * 60 * 1000;
/** A stall at least this long is a warning. */
const LAG_WARN_MS = 3000;

const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const ageSec = (since, now) => (typeof since === "number" ? Math.max(0, Math.round((now - since) / 1000)) : null);

/**
 * @param {object} options
 * @param {"mcp"|"listen"} options.kind - Which entry point this is
 * @param {string} options.accountId
 * @param {string} options.version - Package version
 * @param {() => number} [options.now]
 * @returns {{
 *   attach: (listener: object) => void,
 *   noteUp: () => void,
 *   noteDown: (code?: number|string|null) => void,
 *   noteStopping: () => void,
 *   noteSocketState: (state: string) => void,
 *   noteEvent: (kind: string, info?: {self?: boolean}) => void,
 *   setSource: (name: 'webhook'|'buffer'|'gaps'|'stage', fn: () => any) => void,
 *   snapshot: () => object,
 *   ready: () => {ready: boolean, socket: string},
 *   stop: () => void,
 * }}
 */
export function createDaemonHealth({ kind, accountId, version, now = Date.now }) {
    const startedAt = now();
    let socketState = "starting";
    let socketSince = startedAt;
    let everUp = false;
    let reconnects = 0;
    let lastClose = null;
    let lastEventAt = null;
    let lastMessageAt = null;
    const counts = Object.fromEntries(COUNTED_EVENTS.map((k) => [k, 0]));
    let incoming = 0;
    const sources = {};

    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    const lagReset = setInterval(() => lag.reset(), LAG_WINDOW_MS);
    lagReset.unref?.();

    /** A source that throws must not take the status route down with it. */
    const read = (name) => {
        try {
            return sources[name]?.() ?? null;
        } catch {
            return null;
        }
    };

    const setState = (state) => {
        if (socketState === state) return;
        socketState = state;
        socketSince = now();
    };

    const api = {
        noteUp() {
            if (socketState === "stopping") return;
            if (everUp) reconnects++;
            everUp = true;
            setState("up");
        },
        noteDown(code = null) {
            if (socketState === "stopping") return;
            lastClose = { code: code ?? null, at: now() };
            setState("down");
        },
        noteStopping() {
            setState("stopping");
        },
        /**
         * What the socket supervisor says it is doing (src/zalo/socket.js). Up and down are still decided by
         * the listener's own events; this adds the states a person must be able to see from outside:
         * Zalo in maintenance, the account taken by another session, and a login being redone.
         *
         * @param {string} state - a supervisor state
         */
        noteSocketState(state) {
            if (socketState === "stopping") return;
            const named = { maintenance: "maintenance", kicked: "kicked", "session-invalid": "relogin" }[state];
            if (named) return setState(named);
            // Any other supervisor state ends a hold, but leaves up and down to the listener's events.
            if (["maintenance", "kicked", "relogin"].includes(socketState)) setState("down");
        },
        noteEvent(eventKind, { self = false } = {}) {
            lastEventAt = now();
            if (eventKind in counts) counts[eventKind]++;
            if (eventKind === "message") {
                lastMessageAt = lastEventAt;
                if (!self) incoming++;
            }
        },
        setSource(name, fn) {
            sources[name] = fn;
        },

        /**
         * Subscribe to a listener. Call again with the new listener after a re-login.
         * Never subscribes to `cipher_key`, which carries the session's key material.
         *
         * @param {object} listener - zca-js listener
         */
        attach(listener) {
            listener.on("connected", () => api.noteUp());
            listener.on("disconnected", (code) => api.noteDown(code));
            listener.on("closed", (code) => api.noteDown(code));
            for (const k of COUNTED_EVENTS) {
                listener.on(k, (payload) => api.noteEvent(k, { self: k === "message" && Boolean(payload?.isSelf) }));
            }
        },

        /** @returns {{ready: boolean, socket: string}} */
        ready() {
            return { ready: socketState === "up", socket: socketState };
        },

        /** @returns {object} Everything, JSON-safe */
        snapshot() {
            const t = now();
            const rawWebhook = read("webhook");
            const webhook = rawWebhook && {
                ...rawWebhook,
                lastSuccessAgeSec: ageSec(rawWebhook.lastSuccessAt, t),
            };
            const buffer = read("buffer");
            const gaps = read("gaps");
            const stage = read("stage");
            const session = read("session");
            const mem = process.memoryUsage();
            const p99Ms = lag.count ? lag.percentile(99) / 1e6 : 0;
            const maxMs = lag.count ? lag.max / 1e6 : 0;

            const warnings = [];
            if (socketState === "down" && t - socketSince >= SOCKET_DOWN_WARN_MS) {
                warnings.push(
                    `socket down for ${ageSec(socketSince, t)}s (last close code ${lastClose?.code ?? "unknown"})`,
                );
            }
            if (socketState === "maintenance") warnings.push("Zalo is in maintenance; the daemon is waiting for it");
            if (socketState === "kicked")
                warnings.push("another Zalo session took this account; the daemon does not reconnect");
            if (socketState === "relogin") warnings.push("Zalo refused the session; the daemon is logging in again");
            if (webhook && webhook.pending && webhook.oldestPendingAgeMs >= WEBHOOK_AGE_WARN_MS) {
                warnings.push(
                    `webhook backlog: ${webhook.pending} queued, oldest ${Math.round(webhook.oldestPendingAgeMs / 1000)}s` +
                        (webhook.lastError ? ` (${webhook.lastError})` : ""),
                );
            }
            if (webhook?.dead) warnings.push(`webhook: ${webhook.dead} dead-lettered event(s)`);
            if (gaps) warnings.push(`coverage: ${gaps} gap(s) not yet recovered`);
            if (session && (session.expired || session.daysLeft <= EXPIRY_WARN_DAYS)) {
                warnings.push(describeSessionExpiry(session).replace(/\.$/, ""));
            }
            if (maxMs >= LAG_WARN_MS)
                warnings.push(`event loop was blocked for ${(maxMs / 1000).toFixed(1)}s recently`);

            return {
                kind,
                accountId,
                version,
                pid: process.pid,
                startedAt: iso(startedAt),
                uptimeSec: Math.round((t - startedAt) / 1000),
                status: warnings.length ? "degraded" : "ok",
                ready: socketState === "up",
                warnings,
                socket: {
                    state: socketState,
                    since: iso(socketSince),
                    forSec: ageSec(socketSince, t),
                    reconnects,
                    lastClose: lastClose && {
                        code: lastClose.code,
                        at: iso(lastClose.at),
                        ageSec: ageSec(lastClose.at, t),
                    },
                },
                events: {
                    lastEventAt: iso(lastEventAt),
                    lastEventAgeSec: ageSec(lastEventAt, t),
                    lastMessageAt: iso(lastMessageAt),
                    lastMessageAgeSec: ageSec(lastMessageAt, t),
                    incomingMessages: incoming,
                    byKind: { ...counts },
                },
                coverage: { pendingGaps: gaps ?? 0 },
                session,
                stage: stage ? { running: stage.stage, forSec: ageSec(stage.startedAt, t) } : null,
                webhook,
                buffer,
                process: {
                    rssBytes: mem.rss,
                    heapUsedBytes: mem.heapUsed,
                    eventLoopLagP99Ms: Math.round(p99Ms * 10) / 10,
                    eventLoopLagMaxMs: Math.round(maxMs * 10) / 10,
                },
            };
        },

        stop() {
            lag.disable();
            clearInterval(lagReset);
        },
    };
    return api;
}

/** Escape a Prometheus label value. */
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/**
 * A snapshot in the Prometheus text exposition format (version 0.0.4).
 *
 * A sample that has no value yet (no event has arrived, no delivery has happened) is left out
 * rather than reported as 0, because 0 would read as "just now" for an age.
 *
 * @param {object} s - From `snapshot()`
 * @returns {string}
 */
export function renderPrometheus(s) {
    const lines = [];
    const account = `account="${esc(s.accountId)}"`;
    const metric = (name, type, help, samples) => {
        const present = samples.filter(([, v]) => v !== null && v !== undefined && Number.isFinite(v));
        if (!present.length) return;
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const [labels, v] of present) lines.push(`${name}{${account}${labels ? `,${labels}` : ""}} ${v}`);
    };
    const one = (v) => [["", v]];

    metric("zalo_info", "gauge", "Daemon build and kind; the value is always 1.", [
        [`kind="${esc(s.kind)}",version="${esc(s.version)}"`, 1],
    ]);
    metric("zalo_up", "gauge", "1 while the Zalo socket is connected, else 0.", one(s.ready ? 1 : 0));
    metric(
        "zalo_socket_state_age_seconds",
        "gauge",
        "Seconds the socket has been in its current state (see the state label).",
        [[`state="${esc(s.socket.state)}"`, s.socket.forSec]],
    );
    metric(
        "zalo_socket_reconnects_total",
        "counter",
        "Reconnections since the daemon started.",
        one(s.socket.reconnects),
    );
    metric("zalo_last_close_age_seconds", "gauge", "Seconds since the socket last closed.", [
        [`code="${esc(s.socket.lastClose?.code ?? "")}"`, s.socket.lastClose?.ageSec ?? null],
    ]);
    metric(
        "zalo_last_event_age_seconds",
        "gauge",
        "Seconds since any event arrived on the socket.",
        one(s.events.lastEventAgeSec),
    );
    metric(
        "zalo_last_message_age_seconds",
        "gauge",
        "Seconds since a message (sent or received) arrived on the socket.",
        one(s.events.lastMessageAgeSec),
    );
    metric(
        "zalo_incoming_messages_total",
        "counter",
        "Messages from other people since the daemon started.",
        one(s.events.incomingMessages),
    );
    metric(
        "zalo_events_total",
        "counter",
        "Listener events since the daemon started, by kind.",
        Object.entries(s.events.byKind).map(([k, v]) => [`kind="${esc(k)}"`, v]),
    );
    metric(
        "zalo_coverage_gaps_pending",
        "gauge",
        "Time windows whose messages are not yet recovered.",
        one(s.coverage.pendingGaps),
    );
    metric(
        "zalo_session_days_left",
        "gauge",
        "Days until the saved Zalo session ends and a new QR login is needed (negative once it has).",
        one(s.session?.daysLeft ?? null),
    );
    metric(
        "zalo_stage_running",
        "gauge",
        "1 while a sync stage runs on the socket (see the stage label).",
        s.stage ? [[`stage="${esc(s.stage.running)}"`, 1]] : one(0),
    );

    const w = s.webhook;
    metric("zalo_webhook_enabled", "gauge", "1 when a webhook receiver is configured.", one(w ? 1 : 0));
    if (w) {
        metric("zalo_webhook_pending", "gauge", "Events queued for the webhook receiver.", one(w.pending));
        metric(
            "zalo_webhook_dead",
            "gauge",
            "Events dead-lettered after the receiver refused them or they expired.",
            one(w.dead),
        );
        metric(
            "zalo_webhook_oldest_pending_age_seconds",
            "gauge",
            "How long the oldest queued webhook event has waited.",
            one(Math.round((w.oldestPendingAgeMs ?? 0) / 1000)),
        );
        metric(
            "zalo_webhook_delivered_total",
            "counter",
            "Webhook events delivered since the outbox was created.",
            one(w.deliveredTotal),
        );
        metric(
            "zalo_webhook_consecutive_failures",
            "gauge",
            "Failed delivery attempts in a row.",
            one(w.consecutiveFailures),
        );
        metric(
            "zalo_webhook_last_success_age_seconds",
            "gauge",
            "Seconds since a webhook delivery last succeeded.",
            one(w.lastSuccessAgeSec ?? null),
        );
    }

    if (s.buffer) {
        metric(
            "zalo_buffer_threads",
            "gauge",
            "Conversations with messages in the live buffer.",
            one(s.buffer.threads),
        );
        metric("zalo_buffer_messages", "gauge", "Messages in the live buffer.", one(s.buffer.messages));
    }

    metric("zalo_process_resident_memory_bytes", "gauge", "Resident set size.", one(s.process.rssBytes));
    metric("zalo_process_heap_used_bytes", "gauge", "V8 heap in use.", one(s.process.heapUsedBytes));
    metric("zalo_process_uptime_seconds", "gauge", "Seconds since the daemon started.", one(s.uptimeSec));
    metric(
        "zalo_eventloop_lag_p99_seconds",
        "gauge",
        "99th percentile event-loop delay over the last few minutes.",
        one(s.process.eventLoopLagP99Ms / 1000),
    );
    metric(
        "zalo_eventloop_lag_max_seconds",
        "gauge",
        "Worst event-loop delay over the last few minutes.",
        one(s.process.eventLoopLagMaxMs / 1000),
    );
    return lines.join("\n") + "\n";
}

/**
 * The lines `listen --status` / `mcp start --status` print for a running daemon.
 *
 * @param {object} s - From `snapshot()`
 * @returns {string[]}
 */
export function describeHealth(s) {
    const out = [];
    out.push(
        `Socket: ${s.socket.state} for ${s.socket.forSec}s` +
            (s.socket.reconnects ? `, ${s.socket.reconnects} reconnect(s)` : "") +
            (s.socket.state !== "up" && s.socket.lastClose
                ? `, last close code ${s.socket.lastClose.code ?? "unknown"}`
                : ""),
    );
    out.push(
        s.events.lastEventAgeSec === null
            ? "Events: none yet since start"
            : `Last event ${s.events.lastEventAgeSec}s ago, last message ${s.events.lastMessageAgeSec === null ? "none yet" : `${s.events.lastMessageAgeSec}s ago`}; ${s.events.incomingMessages} incoming message(s) since start`,
    );
    out.push(`Coverage: ${s.coverage.pendingGaps} pending gap(s)`);
    if (s.stage) out.push(`Sync stage running: ${s.stage.running} for ${s.stage.forSec}s`);
    if (s.webhook) {
        out.push(
            `Webhook: ${s.webhook.pending} queued${s.webhook.pending ? ` (oldest ${Math.round(s.webhook.oldestPendingAgeMs / 1000)}s)` : ""}, ${s.webhook.dead} dead-lettered, ${s.webhook.deliveredTotal} delivered` +
                (s.webhook.consecutiveFailures ? `, failing x${s.webhook.consecutiveFailures}` : ""),
        );
    }
    if (s.buffer) out.push(`Buffer: ${s.buffer.messages} message(s) in ${s.buffer.threads} conversation(s)`);
    out.push(
        `Process: ${Math.round(s.process.rssBytes / 1048576)} MB resident, event-loop delay p99 ${s.process.eventLoopLagP99Ms} ms (max ${s.process.eventLoopLagMaxMs} ms), up ${s.uptimeSec}s`,
    );
    for (const w of s.warnings) out.push(`WARNING: ${w}`);
    return out;
}
