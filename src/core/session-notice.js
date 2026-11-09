/**
 * Telling whoever runs a daemon, in good time, that the account's saved login is about to end.
 *
 * Nothing renews the chat session cookie (./session-expiry.js): a login made today stops working by itself about 90
 * days later, and the renewal is a QR scan by a person. A date in `--status` reaches nobody who is not looking, so a
 * daemon also sends a `session_expiring` event, to the same places as its other system events (the log, the webhook,
 * `listen`'s output and JSONL, the MCP live buffer), once for each threshold the session crosses: 14, 7, 3 and 1 days
 * left, and once more when it has ended (`account_state signed_out` follows when Zalo refuses it).
 *
 * "Once" survives a restart: the last threshold sent is kept, with the session end it was for, in
 * `session-notice.json` in the account folder. A new QR login moves the end, so the thresholds count again for it.
 * The check reads the saved cookie jar: no Zalo traffic, cheap enough to run hourly.
 *
 * The event carries ids and dates only, never a name or a cookie value.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { sessionExpiryFor } from "./session-expiry.js";

/** The days left at which a `session_expiring` event goes out (and 0: the session has ended). */
export const SESSION_NOTICE_DAYS = Object.freeze([14, 7, 3, 1]);

/** How often a daemon looks at the saved session's end. */
export const SESSION_CHECK_EVERY_MS = 3_600_000;

/** The file in the account folder that remembers the last threshold sent. */
export const SESSION_NOTICE_FILE = "session-notice.json";

/**
 * The threshold a session is at: the smallest of {@link SESSION_NOTICE_DAYS} at or above its days left, 0 once it has
 * ended, null while it has more than 14 days (or no readable end).
 *
 * @param {{daysLeft: number, expired: boolean}|null} expiry
 * @returns {number|null}
 */
export function sessionThreshold(expiry) {
    if (!expiry) return null;
    if (expiry.expired) return 0;
    for (const t of [...SESSION_NOTICE_DAYS].sort((a, b) => a - b)) if (expiry.daysLeft <= t) return t;
    return null;
}

/**
 * The command that renews the login: a QR login for this account (it keeps the device id, so the offline queue
 * survives), then a restart of its daemon.
 *
 * @param {string} accountId
 * @returns {string}
 */
export function reloginCommand(accountId) {
    return `zalo-agent --account ${accountId} login`;
}

/**
 * The `session_expiring` event.
 *
 * @param {string} accountId
 * @param {{expiresAt: string, daysLeft: number, expired: boolean}} expiry
 * @param {number} [at] - milliseconds
 * @returns {{event: "session_expiring", accountId: string, expiresAt: string, daysLeft: number, expired: boolean,
 *   threshold: number, command: string, at: string}}
 */
export function sessionExpiringEvent(accountId, expiry, at = Date.now()) {
    return {
        event: "session_expiring",
        accountId: String(accountId),
        expiresAt: expiry.expiresAt,
        daysLeft: expiry.daysLeft,
        expired: Boolean(expiry.expired),
        threshold: sessionThreshold(expiry),
        command: reloginCommand(accountId),
        at: new Date(at).toISOString(),
    };
}

/**
 * One line for a person.
 *
 * @param {{accountId: string, expiresAt: string, daysLeft: number, expired?: boolean}} e
 * @returns {string}
 */
export function describeSessionExpiring(e) {
    const date = String(e.expiresAt).slice(0, 10);
    const how =
        `a QR login (\`${reloginCommand(e.accountId)}\`, \`za --account ${e.accountId} login\` on a server, or the ` +
        "fleet controller's QR add), then a restart of the daemon; the login keeps the device id";
    if (e.expired) return `account ${e.accountId}: the saved session ended on ${date}; log in again with ${how}`;
    return (
        `account ${e.accountId}: the saved session ends on ${date} (${e.daysLeft} day(s) left); log in again ` +
        `before then with ${how}`
    );
}

/**
 * One `session_expiring` event as the MCP buffer carries it (a system event, as `account_state`).
 *
 * @param {object} e
 * @returns {object}
 */
export function sessionExpiringSystemEvent(e) {
    const rest = { ...e };
    delete rest.event;
    return { type: "session_expiring", ...rest, text: describeSessionExpiring(e) };
}

/**
 * Which thresholds were already sent, per key (an account id), behind a load/save pair.
 *
 * `due` says whether this session end, at its current threshold, still needs an event, and records it when it does:
 * a threshold is sent once per session end, a later (closer) one is sent again, and a new end (a new login) starts over.
 * The record also keeps the current end while no threshold is due, so `fleet status` can read it without a key.
 *
 * @param {{load: (key: string) => {expiresAt?: string, threshold?: number|null}|null,
 *   save: (key: string, value: {expiresAt: string, threshold: number|null}) => void}} store
 * @returns {{due: (key: string, expiry: {expiresAt: string, daysLeft: number, expired: boolean}|null) => boolean}}
 */
export function createSessionNotices({ load, save }) {
    return {
        due(key, expiry) {
            if (!expiry?.expiresAt) return false;
            const threshold = sessionThreshold(expiry);
            let prev = null;
            try {
                prev = load(key);
            } catch {
                prev = null;
            }
            const same = prev?.expiresAt === expiry.expiresAt;
            const sent = same && Number.isFinite(prev.threshold) ? prev.threshold : null;
            const due = threshold !== null && (sent === null || threshold < sent);
            if (due || !same) {
                try {
                    save(key, { expiresAt: expiry.expiresAt, threshold: due ? threshold : sent });
                } catch {
                    // Unwritable: the event still goes out; it may go out again after a restart.
                }
            }
            return due;
        },
    };
}

/**
 * The saved session's end as the account folder's marker records it (written by the account's daemon): no key and
 * no credentials file needed, so `fleet status` can show it for an account whose daemon is stopped.
 *
 * @param {string} accountDir
 * @param {() => number} [now]
 * @returns {{expiresAt: string, daysLeft: number, expired: boolean}|null}
 */
export function sessionExpiryFromMarker(accountDir, now = Date.now) {
    try {
        const { expiresAt } = JSON.parse(readFileSync(join(accountDir, SESSION_NOTICE_FILE), "utf8")) ?? {};
        const end = Date.parse(expiresAt);
        if (!Number.isFinite(end)) return null;
        return {
            expiresAt: new Date(end).toISOString(),
            daysLeft: Math.floor((end - now()) / 86_400_000),
            expired: end <= now(),
        };
    } catch {
        return null;
    }
}

/**
 * The marker of one account folder as a store for {@link createSessionNotices}.
 *
 * @param {string} accountDir
 * @returns {{load: () => object|null, save: (key: string, value: object) => void}}
 */
export function accountNoticeStore(accountDir) {
    const file = join(accountDir, SESSION_NOTICE_FILE);
    return {
        load: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null),
        save: (_key, value) => writeFileAtomic(file, JSON.stringify(value) + "\n", { mode: 0o600 }),
    };
}

/**
 * One file holding the markers of many accounts, keyed by account id (the fleet controller's).
 *
 * @param {string} file
 * @returns {{load: (key: string) => object|null, save: (key: string, value: object) => void}}
 */
export function fileNoticeStore(file) {
    const all = () => {
        try {
            const data = JSON.parse(readFileSync(file, "utf8"));
            return data && typeof data === "object" && !Array.isArray(data) ? data : {};
        } catch {
            return {};
        }
    };
    return {
        load: (key) => all()[key] ?? null,
        save: (key, value) => writeFileAtomic(file, JSON.stringify({ ...all(), [key]: value }, null, 2) + "\n"),
    };
}

/**
 * A daemon's watch: look now and every `everyMs`, and emit a `session_expiring` event when a threshold is crossed.
 * Both `listen` and `mcp start` run one (AGENTS.md section 13: any asymmetry between them is a defect).
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {string} args.accountDir
 * @param {(event: object) => void} args.emit
 * @param {() => ({expiresAt: string, daysLeft: number, expired: boolean}|null)} [args.read] - the saved session's end
 * @param {() => number} [args.now]
 * @param {number} [args.everyMs]
 * @returns {{check: () => object|null, stop: () => void}} `check` returns the event it sent, or null
 */
export function startSessionExpiryWatch({
    ownId,
    accountDir,
    emit,
    read = () => sessionExpiryFor(ownId),
    now = Date.now,
    everyMs = SESSION_CHECK_EVERY_MS,
}) {
    const notices = createSessionNotices(accountNoticeStore(accountDir));
    const check = () => {
        let expiry = null;
        try {
            expiry = read();
        } catch {
            expiry = null;
        }
        if (!notices.due(ownId, expiry)) return null;
        const event = sessionExpiringEvent(ownId, expiry, now());
        try {
            emit(event);
        } catch {
            // A failing sink must not stop the watch.
        }
        return event;
    };
    check();
    const timer = everyMs > 0 ? setInterval(check, everyMs) : null;
    timer?.unref?.();
    return {
        check,
        stop() {
            if (timer) clearInterval(timer);
        },
    };
}
