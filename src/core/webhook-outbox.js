/**
 * Durable webhook delivery: an on-disk outbox and the dispatcher that drains it.
 *
 * `mcp start -w` and `listen -w` used to POST once, with a 5 second timeout, and forget: a receiver
 * that was down, restarting or slow lost that message with nothing to show for it. Both now write
 * the event here first, then deliver from this queue, so a receiver outage becomes a backlog that is
 * visible (`mcp webhook status`, /health, /metrics) and drains by itself when the receiver returns.
 *
 * Guarantees, and what they are not:
 *  - **At least once.** A row is deleted only after a 2xx. A crash between the receiver's reply and
 *    the delete re-sends it, so a receiver de-duplicates on the event's message id.
 *  - **In order.** Rows go out oldest first, and the head's retry backoff holds the whole queue, so a
 *    later message never overtakes an earlier one. A payload the receiver rejects for being malformed
 *    (400, 413, 422) is dead-lettered instead, or one poison event would block everything behind it.
 *  - **Bounded.** A row older than `maxAgeMs` is dead-lettered (kept, never silently dropped) so a
 *    receiver that never returns cannot grow the file without end unnoticed.
 *  - Not exactly once, and not shared between processes: one daemon per account owns the dispatcher.
 *
 * The file is `accounts/<ownId>/webhook-outbox.db`, separate from `zalo.db`: it holds no message rows
 * (AGENTS.md section 13 limits those to three writers) and a damaged outbox can be deleted without
 * touching the cache.
 */

import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const OUTBOX_FILE = "webhook-outbox.db";
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
/** A receiver saying "this payload is malformed" will say it again; retrying only blocks the queue. */
const PAYLOAD_REJECTED = new Set([400, 413, 422]);

/**
 * @param {string} accountDir - `accounts/<ownId>`
 * @returns {string}
 */
export function outboxPath(accountDir) {
    return join(accountDir, OUTBOX_FILE);
}

/**
 * Sign a webhook body the way every webhook sender here does: `Authorization: Bearer <secret>` and
 * `X-Zalo-Signature: sha256=<hex HMAC of the exact bytes sent>`.
 *
 * @param {string} body
 * @param {string|null} secret
 * @returns {Record<string, string>}
 */
export function webhookHeaders(body, secret) {
    const headers = { "Content-Type": "application/json" };
    if (typeof secret === "string" && secret.trim()) {
        const s = secret.trim();
        headers["Authorization"] = `Bearer ${s}`;
        headers["X-Zalo-Signature"] = `sha256=${createHmac("sha256", s).update(body).digest("hex")}`;
    }
    return headers;
}

/**
 * Open (creating if needed) the outbox of one account.
 *
 * @param {string} accountDir - `accounts/<ownId>`
 * @param {{ now?: () => number, readonly?: boolean }} [options] - `readonly` for status commands: never creates the file
 * @returns {object} Outbox handle
 */
export function openOutbox(accountDir, { now = Date.now, readonly = false } = {}) {
    if (!readonly) mkdirSync(accountDir, { recursive: true });
    const db = new Database(outboxPath(accountDir), readonly ? { readonly: true, fileMustExist: true } : {});
    db.pragma("busy_timeout = 5000");
    if (!readonly) {
        db.pragma("journal_mode = WAL");
        db.exec(`
            CREATE TABLE IF NOT EXISTS outbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT UNIQUE,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                last_error TEXT,
                last_attempt_at INTEGER,
                dead_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS outbox_status_seq ON outbox (status, seq);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        `);
    }

    const stmt = (sql) => db.prepare(sql);
    const insert = readonly
        ? null
        : stmt("INSERT OR IGNORE INTO outbox (event_key, body, created_at) VALUES (?, ?, ?)");
    const getMeta = stmt("SELECT value FROM meta WHERE key = ?");
    const setMeta = readonly
        ? null
        : stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const meta = (key) => getMeta.get(key)?.value ?? null;
    const inList = (seqs) => seqs.map(() => "?").join(",");

    return {
        path: outboxPath(accountDir),

        /**
         * Persist one event before anything tries to send it.
         * @param {string|null} eventKey - Dedupes while the event is still queued; null never dedupes
         * @param {string} body - The exact JSON text a receiver will be sent
         * @returns {{ queued: boolean, seq: number|null }} `queued: false` when the same key is already waiting
         */
        enqueue(eventKey, body) {
            const r = insert.run(eventKey ?? null, body, now());
            return r.changes ? { queued: true, seq: Number(r.lastInsertRowid) } : { queued: false, seq: null };
        },

        /**
         * @param {number} limit
         * @returns {Array<{seq:number,body:string,created_at:number,attempts:number}>} Oldest pending rows
         */
        head(limit) {
            return stmt(
                "SELECT seq, body, created_at, attempts FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT ?",
            ).all(Math.max(1, limit));
        },

        /** @param {number[]} seqs */
        markDelivered(seqs) {
            if (!seqs.length) return;
            db.transaction(() => {
                db.prepare(`DELETE FROM outbox WHERE seq IN (${inList(seqs)})`).run(...seqs);
                const total = Number(meta("delivered_total") || 0) + seqs.length;
                setMeta.run("delivered_total", String(total));
                setMeta.run("last_success_at", String(now()));
                setMeta.run("last_error", "");
            })();
        },

        /**
         * @param {number[]} seqs
         * @param {{ error: string, status?: number|null }} failure
         */
        markFailed(seqs, { error, status = null }) {
            if (!seqs.length) return;
            db.transaction(() => {
                db.prepare(
                    `UPDATE outbox SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE status = 'pending' AND seq IN (${inList(seqs)})`,
                ).run(error, now(), ...seqs);
                setMeta.run("last_error", error);
                setMeta.run("last_error_at", String(now()));
                setMeta.run("last_status", status === null ? "" : String(status));
            })();
        },

        /**
         * Park rows that will not be retried on their own. They stay until `retryDead` or `purgeDead`.
         * @param {number[]} seqs
         * @param {string} reason
         */
        markDead(seqs, reason) {
            if (!seqs.length) return;
            db.prepare(
                `UPDATE outbox SET status = 'dead', last_error = ?, dead_at = ? WHERE seq IN (${inList(seqs)})`,
            ).run(reason, now(), ...seqs);
        },

        /**
         * Dead-letter every pending row created before `cutoff`.
         * @param {number} cutoff - Epoch ms
         * @returns {number} Rows moved
         */
        expireOlderThan(cutoff) {
            const r = db
                .prepare(
                    "UPDATE outbox SET status = 'dead', last_error = 'expired: not delivered within the retention window', dead_at = ? WHERE status = 'pending' AND created_at < ?",
                )
                .run(now(), cutoff);
            return r.changes;
        },

        /**
         * Put dead rows back in the queue with a fresh clock, in their original order.
         * @param {{ seq?: number }} [filter]
         * @returns {number} Rows requeued
         */
        retryDead({ seq } = {}) {
            const r = seq
                ? db
                      .prepare(
                          "UPDATE outbox SET status = 'pending', attempts = 0, created_at = ?, dead_at = NULL WHERE status = 'dead' AND seq = ?",
                      )
                      .run(now(), seq)
                : db
                      .prepare(
                          "UPDATE outbox SET status = 'pending', attempts = 0, created_at = ?, dead_at = NULL WHERE status = 'dead'",
                      )
                      .run(now());
            return r.changes;
        },

        /**
         * Delete dead rows for good.
         * @param {{ seq?: number }} [filter]
         * @returns {number} Rows removed
         */
        purgeDead({ seq } = {}) {
            const r = seq
                ? db.prepare("DELETE FROM outbox WHERE status = 'dead' AND seq = ?").run(seq)
                : db.prepare("DELETE FROM outbox WHERE status = 'dead'").run();
            return r.changes;
        },

        /**
         * @param {{ status?: 'pending'|'dead', limit?: number }} [filter]
         * @returns {Array<object>} Rows, oldest first; `body` is the JSON text
         */
        list({ status, limit = 50 } = {}) {
            const where = status ? "WHERE status = ?" : "";
            const args = status ? [status, limit] : [limit];
            return stmt(
                `SELECT seq, status, attempts, created_at, last_attempt_at, last_error, dead_at, body FROM outbox ${where} ORDER BY seq LIMIT ?`,
            ).all(...args);
        },

        /**
         * @returns {{ pending:number, dead:number, oldestPendingAt:number|null, deliveredTotal:number, lastSuccessAt:number|null, lastError:string|null, lastErrorAt:number|null, lastStatus:number|null }}
         */
        stats() {
            const c = stmt("SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox GROUP BY status").all();
            const by = Object.fromEntries(c.map((r) => [r.status, r]));
            const num = (k) => (meta(k) ? Number(meta(k)) : null);
            return {
                pending: by.pending?.n ?? 0,
                dead: by.dead?.n ?? 0,
                oldestPendingAt: by.pending?.oldest ?? null,
                deliveredTotal: Number(meta("delivered_total") || 0),
                lastSuccessAt: num("last_success_at"),
                lastError: meta("last_error") || null,
                lastErrorAt: num("last_error_at"),
                lastStatus: num("last_status"),
            };
        },

        close() {
            try {
                db.close();
            } catch {
                /* already closed */
            }
        },
    };
}

/**
 * Backoff for the Nth consecutive failed attempt: 1 s, 2 s, 4 s ... capped at 5 minutes, +/-20%.
 *
 * @param {number} attempts - Attempts so far (>= 1)
 * @param {() => number} [random]
 * @returns {number} Milliseconds
 */
export function backoffMs(attempts, random = Math.random) {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
    return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Keep a URL's origin and path for status output; its query string can carry a token.
 * @param {string} url
 * @returns {string}
 */
export function describeWebhookUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return "(invalid URL)";
    }
}

/**
 * Drain an outbox to one receiver.
 *
 * @param {object} options
 * @param {ReturnType<typeof openOutbox>} options.outbox
 * @param {string} options.url
 * @param {string|null} [options.secret]
 * @param {string} [options.accountId]
 * @param {number} [options.batchSize=1] - Events per POST. 1 sends each event exactly as before; more sends `{event:"batch", events:[...]}`
 * @param {number} [options.maxAgeMs] - A queued event older than this is dead-lettered
 * @param {number} [options.timeoutMs=10000]
 * @param {number} [options.batchWindowMs=250] - With batching on, how long a new event waits for company
 * @param {number} [options.pollMs=30000] - Look at the queue this often even when nothing was enqueued: rows another process put back (`mcp webhook retry`) have no one to wake the dispatcher
 * @param {(line: string) => void} [options.log]
 * @param {Function} [options.fetchFn]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @returns {{ start: () => void, notify: () => void, stop: (o?: {graceMs?: number}) => Promise<void>, status: () => object, drain: () => Promise<void> }}
 */
export function createWebhookDispatcher({
    outbox,
    url,
    secret = null,
    accountId = null,
    batchSize = 1,
    maxAgeMs = DAY_MS,
    timeoutMs = 10_000,
    batchWindowMs = 250,
    pollMs = 30_000,
    log = () => {},
    fetchFn = fetch,
    now = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    const size = Math.max(1, Math.floor(batchSize) || 1);
    let timer = null;
    let poller = null;
    let timerAt = 0;
    let running = null;
    let stopped = false;
    let aborter = null;
    let backoffUntil = 0;
    let failures = 0;
    let lastFailureLogAt = 0;
    let sentSinceRecovery = 0;

    function schedule(delay) {
        if (stopped) return;
        const at = now() + delay;
        if (timer && timerAt <= at) return;
        if (timer) clearTimer(timer);
        timerAt = at;
        timer = setTimer(() => {
            timer = null;
            // A pump already draining picks up whatever was enqueued meanwhile on its next pass.
            if (running) return;
            running = pump().finally(() => {
                running = null;
            });
        }, delay);
        timer.unref?.();
    }

    /** One POST. Never throws. */
    async function post(rows) {
        const events = rows.map((r) => JSON.parse(r.body));
        const body =
            rows.length === 1
                ? rows[0].body
                : JSON.stringify({ event: "batch", accountId, count: rows.length, events });
        const headers = {
            ...webhookHeaders(body, secret),
            "X-Zalo-Delivery": `${rows[0].seq}-${rows[rows.length - 1].seq}`,
            "X-Zalo-Attempt": String(Math.max(...rows.map((r) => r.attempts)) + 1),
        };
        aborter = new AbortController();
        const timeout = setTimer(() => aborter?.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        timeout.unref?.();
        try {
            const res = await fetchFn(url, { method: "POST", headers, body, signal: aborter.signal });
            // The receiver's reply body is not read: draining it would let a slow body hold the queue.
            res.body?.cancel?.().catch?.(() => {});
            return res.status >= 200 && res.status < 300
                ? { ok: true, status: res.status }
                : { ok: false, status: res.status, error: `HTTP ${res.status}` };
        } catch (e) {
            const cause = aborter?.signal?.reason;
            return {
                ok: false,
                status: null,
                error: (cause?.message || e?.cause?.code || e?.message || String(e)).slice(0, 300),
            };
        } finally {
            clearTimer(timeout);
            aborter = null;
        }
    }

    function logFailure(error, queued, delay, attempt) {
        const t = now();
        if (failures > 1 && t - lastFailureLogAt < 60_000) return;
        lastFailureLogAt = t;
        log(
            `Webhook delivery failed (${error}); ${queued} queued, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})`,
        );
    }

    /** Send one event alone after a batch it was part of was refused as malformed. */
    async function sendEach(rows) {
        for (const row of rows) {
            const r = await post([row]);
            if (r.ok) {
                outbox.markDelivered([row.seq]);
                sentSinceRecovery++;
            } else if (r.status !== null && PAYLOAD_REJECTED.has(r.status)) {
                outbox.markDead([row.seq], `rejected by the receiver: ${r.error}`);
                log(`Webhook event ${row.seq} dead-lettered (${r.error}); see: zalo-agent mcp webhook list --dead`);
            } else {
                return r;
            }
        }
        return { ok: true };
    }

    async function pump() {
        if (stopped) return;
        try {
            while (!stopped) {
                const expired = outbox.expireOlderThan(now() - maxAgeMs);
                if (expired)
                    log(
                        `${expired} undelivered webhook event(s) older than ${Math.round(maxAgeMs / 3600000)}h dead-lettered`,
                    );
                const rows = outbox.head(size);
                if (!rows.length) return;
                if (now() < backoffUntil) {
                    schedule(backoffUntil - now());
                    return;
                }
                let r = await post(rows);
                if (!r.ok && rows.length > 1 && r.status !== null && PAYLOAD_REJECTED.has(r.status))
                    r = await sendEach(rows);
                else if (r.ok) {
                    outbox.markDelivered(rows.map((x) => x.seq));
                    sentSinceRecovery += rows.length;
                } else if (r.status !== null && PAYLOAD_REJECTED.has(r.status)) {
                    outbox.markDead(
                        rows.map((x) => x.seq),
                        `rejected by the receiver: ${r.error}`,
                    );
                    log(
                        `Webhook event ${rows[0].seq} dead-lettered (${r.error}); see: zalo-agent mcp webhook list --dead`,
                    );
                    r = { ok: true };
                }
                if (stopped) return;
                if (r.ok) {
                    if (failures > 0) {
                        const left = outbox.stats().pending;
                        log(`Webhook receiver is back: ${sentSinceRecovery} delivered, ${left} still queued`);
                    }
                    failures = 0;
                    backoffUntil = 0;
                    if (outbox.stats().pending === 0) sentSinceRecovery = 0;
                    continue;
                }
                failures++;
                outbox.markFailed(
                    rows.map((x) => x.seq),
                    { error: r.error, status: r.status },
                );
                const attempt = Math.max(failures, ...rows.map((x) => x.attempts + 1));
                const delay = backoffMs(attempt, random);
                backoffUntil = now() + delay;
                logFailure(r.error, outbox.stats().pending, delay, attempt);
                schedule(delay);
                return;
            }
        } catch (e) {
            // A broken outbox must not take the daemon with it; try again shortly.
            log(`Webhook outbox error: ${e.message}`);
            schedule(30_000);
        }
    }

    return {
        /** Resume whatever a previous run left queued. */
        start() {
            const s = outbox.stats();
            if (s.pending || s.dead) {
                log(`Webhook outbox: ${s.pending} queued, ${s.dead} dead-lettered from before this start`);
            }
            schedule(0);
            if (!poller && pollMs > 0) {
                poller = setInterval(() => schedule(0), pollMs);
                poller.unref?.();
            }
        },
        /** An event was just enqueued. */
        notify() {
            schedule(size > 1 ? batchWindowMs : 0);
        },
        /** Resolve once the queue is empty or delivery is waiting out a backoff (tests, shutdown). */
        async drain() {
            if (timer) {
                clearTimer(timer);
                timer = null;
            }
            if (running) await running;
            running = pump().finally(() => {
                running = null;
            });
            await running;
        },
        /**
         * @param {{ graceMs?: number }} [o] - How long an in-flight POST may finish before it is cut
         */
        async stop({ graceMs = 2000 } = {}) {
            stopped = true;
            if (poller) clearInterval(poller);
            poller = null;
            if (timer) clearTimer(timer);
            timer = null;
            if (!running) return;
            const cut = setTimer(() => aborter?.abort(new Error("shutdown")), graceMs);
            cut.unref?.();
            await running;
            clearTimer(cut);
        },
        status() {
            const s = outbox.stats();
            return {
                url: describeWebhookUrl(url),
                signed: Boolean(secret),
                batchSize: size,
                ...s,
                consecutiveFailures: failures,
                nextAttemptAt: backoffUntil > now() ? backoffUntil : null,
                oldestPendingAgeMs: s.oldestPendingAt ? Math.max(0, now() - s.oldestPendingAt) : 0,
            };
        },
    };
}

/**
 * What `mcp start` and `listen` call: open the account's outbox, resume whatever an earlier run left
 * queued, and hand back the one function an event handler needs.
 *
 * @param {object} options
 * @param {string} options.accountDir
 * @param {string} options.accountId
 * @param {string} options.url
 * @param {string|null} [options.secret]
 * @param {number} [options.batchSize]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.pollMs]
 * @param {(line: string) => void} options.log
 * @returns {{ enqueue: (eventKey: string|null, payload: object) => void, status: () => object, stop: () => void }}
 */
export function startWebhookDelivery({
    accountDir,
    accountId,
    url,
    secret = null,
    batchSize = 1,
    maxAgeMs,
    pollMs,
    log,
}) {
    const outbox = openOutbox(accountDir);
    const dispatcher = createWebhookDispatcher({ outbox, url, secret, accountId, batchSize, maxAgeMs, pollMs, log });
    dispatcher.start();
    return {
        /**
         * Persist an event and wake the dispatcher. Never throws into the listener loop.
         * @param {string|null} eventKey - Dedupes while queued; null for events with no stable id
         * @param {object} payload
         */
        enqueue(eventKey, payload) {
            try {
                if (outbox.enqueue(eventKey, JSON.stringify(payload)).queued) dispatcher.notify();
            } catch (e) {
                log(`Webhook event could not be queued: ${e.message}`);
            }
        },
        status: () => dispatcher.status(),
        /** Stop sending and release the file. Queued events stay for the next start. */
        stop() {
            dispatcher.stop({ graceMs: 0 }).finally(() => outbox.close());
        },
    };
}
