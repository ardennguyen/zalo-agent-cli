/**
 * Storage quotas and retention (at-rest phase 2, §5), the way zCloud treats a plan that ran out: the data is kept for a
 * grace period, and only then purged, oldest first.
 *
 * - **Usage** of an account: its message database (the pages in use), its media and its webhook outbox. Measured by
 *   the daemon on its timer and after a purge; `db usage`, `account status`, `zalo_profile` and the admin API's
 *   `/zalo/admin/usage` show it.
 * - **Limits**: `quota.account.limit`, and a tenant's `quota.tenant.limit` shared by the accounts its
 *   `quota.tenant.accounts` lists. On one host the engine sums only the accounts it runs: for a tenant spread over
 *   several hosts the console is the source of truth (it reads `/zalo/admin/usage` and the `storage_quota` events,
 *   and pushes per-account caps).
 * - **Over the limit, caching goes on.** The state turns `over` (with `overSince`) and `storage_quota` events go to the
 *   webhook: `warn` (at `quota.warnAt`), `over`, `grace_ending` (7 days and 1 day before the purge), `purged`, and `ok`
 *   when usage is back under the limit (a raised limit, a renewal), which clears the grace clock.
 * - **After `quota.graceDays`** the purge removes the oldest media first, then the oldest messages (their search entries
 *   and row MACs go with them, `secure_delete` zeroes the pages, the WAL is checkpointed) until usage is at or under
 *   the limit. For a tenant, each account gives up its share of the excess, in proportion to its usage.
 * - **Age rules** (optional): `retention.messages` / `retention.media` = `keep` | `<N>d`, and `retention.outboxDead`
 *   (dead webhook deliveries, 30 days). The same purge applies them on the same timer (`retention.purgeEvery`, 6h).
 * - **The floor.** A purge raises `sync_state.retentionFloor`; no writer stores a message at or before it again, so a
 *   sync or a history fetch cannot bring back what was purged (src/core/db.js).
 *
 * The purge is delete-only (plus the prune marker that keeps a purged media file from being fetched again), and runs
 * only in the process that holds the account's daemon.lock: the daemon's timer, or `db purge` (through the daemon's
 * channel when one runs, else under the lock itself).
 *
 * Settings, lowest first: built-in defaults, `storage.json` (`quota`, `retention`, and `accounts.<ownId>` over them),
 * `ZALO_RETENTION_MESSAGES[_<ownId>]` / `ZALO_RETENTION_MEDIA[_<ownId>]`, then the runtime policy (./policy-store.js).
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountDir, resolveMediaRoot } from "./credentials.js";
import { readStorageFile } from "./keystore/config.js";
import { policyFor } from "./policy-layer.js";
import { parseBytes, parseDays } from "./policy-schema.js";
import { durationMs } from "./deploy-policy.js";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import * as cacheDb from "./db.js";
import { checkLock } from "./lock.js";
import { openDatabase } from "./sqlite.js";

const DAY_MS = 86_400_000;
/** The built-in defaults. */
export const QUOTA_DEFAULTS = Object.freeze({
    graceDays: 45,
    warnAt: 0.8,
    purgeOrder: "media-first",
    outboxDeadDays: 30,
    purgeEveryMs: 6 * 3_600_000,
});
/** The file a daemon keeps its quota state and last usage in (sizes and times only). */
export const QUOTA_STATE_FILE = "quota-state.json";

// ── Usage ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The size of a file, 0 when there is none. */
function fileSize(file) {
    try {
        return statSync(file).size;
    } catch {
        return 0;
    }
}

/** The bytes of every file under a folder (no links followed). */
export function folderSize(dir) {
    let total = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) total += folderSize(p);
        else if (e.isFile()) total += fileSize(p);
    }
    return total;
}

/** The bytes of a SQLite file with its WAL and shared-memory files. */
function sqliteSize(file) {
    return fileSize(file) + fileSize(`${file}-wal`) + fileSize(`${file}-shm`);
}

/**
 * One account's storage, by part.
 *
 * @param {string} ownId
 * @param {{mediaRoot?: string|null, dbBytes?: number|null}} [opts] - `dbBytes`: the database's used bytes when the
 *   caller holds it open (the pages in use, which a purge lowers at once; the file keeps its size until a VACUUM);
 *   otherwise the file sizes
 * @returns {{accountId: string, db: number, media: number, outbox: number, total: number, measuredAt: number}}
 */
export function measureUsage(ownId, { mediaRoot = null, dbBytes = null } = {}) {
    const dir = getAccountDir(String(ownId));
    const db = Number.isFinite(dbBytes) ? dbBytes : sqliteSize(join(dir, "zalo.db"));
    const media = folderSize(resolveMediaRoot(dir, mediaRoot));
    const outbox = sqliteSize(join(dir, "webhook-outbox.db"));
    return { accountId: String(ownId), db, media, outbox, total: db + media + outbox, measuredAt: Date.now() };
}

/**
 * The bytes in use of an account's database, read from a copy: a reader opening the database itself in WAL mode
 * creates its `-wal` / `-shm` files, which would be a write into the other account's folder. The copy (the file and
 * its WAL, still encrypted) goes into a private temporary folder, is opened read-only with the account's own keys
 * (same host, same provider), and is removed.
 *
 * @param {string} dir - the account's folder
 * @param {string} scratch - where the temporary folder goes
 * @returns {number}
 */
function usedBytesFromCopy(dir, scratch) {
    const tmp = mkdtempSync(join(scratch, ".usage-"));
    try {
        const copy = join(tmp, "zalo.db");
        copyFileSync(join(dir, "zalo.db"), copy);
        if (existsSync(join(dir, "zalo.db-wal"))) copyFileSync(join(dir, "zalo.db-wal"), `${copy}-wal`);
        const db = openDatabase(copy, { readonly: true, accountDir: dir });
        try {
            const pages = Number(db.pragma("page_count", { simple: true })) || 0;
            const free = Number(db.pragma("freelist_count", { simple: true })) || 0;
            return Math.max(0, pages - free) * (Number(db.pragma("page_size", { simple: true })) || 0);
        } finally {
            db.close();
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * The usage of another account of a tenant, on this host, for the tenant's sum.
 *
 * - Its daemon runs (it holds daemon.lock) and published a measurement: that (`method: "daemon"`).
 * - Otherwise its last `quota-state.json` may be days old, so it is measured now the way a daemon measures: the pages
 *   in use of its `zalo.db`, opened read-only with its own keys (from a copy, {@link usedBytesFromCopy}), plus its
 *   media and outbox (`method: "db"`). When that fails (no key here, `IN_USE`, a plaintext or damaged file), the file
 *   sizes (`method: "files"`, with `error`).
 *
 * Nothing in the other account's folder is written, created or removed.
 *
 * @param {string} id
 * @param {{log?: (line: string) => void, context?: string, scratch?: string}} [opts] - `context` names the caller in
 *   the log line; `scratch` is where the temporary copy goes (the caller's own account folder; else the OS temp folder)
 * @returns {{accountId: string, db: number, media: number, outbox: number, total: number, measuredAt: number,
 *   method: "daemon"|"db"|"files", error?: string}}
 */
export function memberUsage(id, { log = () => {}, context = "", scratch = tmpdir() } = {}) {
    const dir = getAccountDir(String(id));
    const state = readQuotaState(dir);
    if (checkLock(dir).locked && Number.isFinite(state.usage?.total)) return { ...state.usage, method: "daemon" };
    const who = `${context ? `${context}: ` : ""}account ${id}`;
    let dbBytes;
    try {
        dbBytes = usedBytesFromCopy(dir, scratch);
    } catch (e) {
        const error = e?.code || e?.message || String(e);
        log(`[storage] ${who}: its daemon is not running and its database did not open (${error}); counted file sizes`);
        return { ...measureUsage(id), method: "files", error };
    }
    log(`[storage] ${who}: its daemon is not running; measured its database read-only and its media folder`);
    return { ...measureUsage(id, { dbBytes }), method: "db" };
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** storage.json's settings for one account (`accounts.<ownId>` over the top level); {} when it cannot be read. */
function storageSettings(ownId) {
    let file = {};
    try {
        file = readStorageFile();
    } catch {
        return {};
    }
    const own = file.accounts?.[String(ownId)] ?? {};
    return {
        quota: { ...(file.quota ?? {}), ...(own.quota ?? {}) },
        retention: { ...(file.retention ?? {}), ...(own.retention ?? {}) },
    };
}

const pick = (...layers) => {
    for (const [value, source] of layers)
        if (value !== undefined && value !== null && value !== "") return [value, source];
    return [undefined, "default"];
};
const limitOf = (value) => {
    const b = parseBytes(value);
    return b === "unlimited" || b === null ? null : b;
};

/**
 * The quota of one account, and its tenants' (on this host).
 *
 * @param {string} ownId
 * @param {{policy?: object|null}} [opts] - `policy`: pin the live policy (tests); null for none
 * @returns {{accountLimit: number|null, source: string, graceDays: number, warnAt: number, purgeOrder: string,
 *   tenants: Array<{id: string, limit: number|null, accounts: string[]}>}}
 */
export function resolveQuota(ownId, { policy } = {}) {
    const live = policy === undefined ? policyFor(ownId) : policy;
    const file = storageSettings(ownId).quota ?? {};
    const lq = live?.quota ?? {};
    const [limit, source] = pick([lq.account?.limit, "policy"], [file.account?.limit, "storage.json"]);
    const [grace] = pick([lq.graceDays, "policy"], [file.graceDays, "storage.json"]);
    const [warn] = pick([lq.warnAt, "policy"], [file.warnAt, "storage.json"]);
    const graceDays = Number.isInteger(Number(grace)) && Number(grace) >= 0 ? Number(grace) : QUOTA_DEFAULTS.graceDays;
    const warnAt = Number(warn) > 0 && Number(warn) <= 1 ? Number(warn) : QUOTA_DEFAULTS.warnAt;
    return {
        accountLimit: limitOf(limit),
        source,
        graceDays,
        warnAt,
        purgeOrder: "media-first",
        tenants: tenantQuotas(ownId),
    };
}

/** The tenants (from the policy store) that list this account and set a limit. Loaded lazily to keep imports light. */
let tenantLookup = () => [];
/**
 * Install the lookup of an account's tenants (the policy store does, when loaded).
 *
 * @param {(ownId: string) => Array<{id: string, policy: object}>} fn
 */
export function setTenantLookup(fn) {
    tenantLookup = typeof fn === "function" ? fn : () => [];
}
function tenantQuotas(ownId) {
    return tenantLookup(String(ownId))
        .map((t) => ({
            id: t.id,
            limit: limitOf(t.policy?.quota?.tenant?.limit),
            // The tenant's whole membership: its users' accounts (quota counts toward the owner) and the legacy list.
            accounts: (t.accounts ?? t.policy?.quota?.tenant?.accounts ?? []).map(String),
        }))
        .filter((t) => t.limit !== null);
}

/**
 * The retention rules of one account.
 *
 * @param {string} ownId
 * @param {{env?: NodeJS.ProcessEnv, policy?: object|null}} [opts]
 * @returns {{messagesDays: number|null, mediaDays: number|null, outboxDeadDays: number, purgeEveryMs: number,
 *   sources: Record<string, string>}} `null` days: keep
 */
export function resolveRetention(ownId, { env = process.env, policy } = {}) {
    const live = policy === undefined ? policyFor(ownId) : policy;
    const lr = live?.retention ?? {};
    const file = storageSettings(ownId).retention ?? {};
    const id = String(ownId);
    const envOf = (name) => [
        [env?.[`${name}_${id}`], `${name}_${id}`],
        [env?.[name], name],
    ];
    const keepOr = (value) => (String(value).trim().toLowerCase() === "keep" ? null : parseDays(value));
    const sources = {};
    const rule = (key, envName) => {
        const [v, src] = pick([lr[key], "policy"], ...(envName ? envOf(envName) : []), [file[key], "storage.json"]);
        sources[key] = src;
        if (v === undefined) return undefined;
        const r = keepOr(v);
        if (r === null && String(v).trim().toLowerCase() !== "keep") {
            console.error(`[retention] ${src} retention.${key} "${v}" is not "keep" or <N>d; keeping everything`);
        }
        return r;
    };
    const messagesDays = rule("messages", "ZALO_RETENTION_MESSAGES") ?? null;
    const mediaDays = rule("media", "ZALO_RETENTION_MEDIA") ?? null;
    const outbox = rule("outboxDead");
    const [every, everySrc] = pick([lr.purgeEvery, "policy"], [file.purgeEvery, "storage.json"]);
    sources.purgeEvery = everySrc;
    const everyMs = durationMs(every);
    return {
        messagesDays,
        mediaDays,
        outboxDeadDays: outbox ?? QUOTA_DEFAULTS.outboxDeadDays,
        purgeEveryMs: everyMs && everyMs >= 60_000 ? everyMs : QUOTA_DEFAULTS.purgeEveryMs,
        sources,
    };
}

// ── State and events ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The quota state a daemon left (its last usage and level), or an empty one.
 *
 * @param {string} accountDir
 * @returns {{usage: object|null, account: object, tenants: Record<string, object>, lastPurge: object|null,
 *   lastPass: {at: string}|null}} `lastPass`: the last pass that ran (`fleet purge` asks a daemon whose timer is behind)
 */
export function readQuotaState(accountDir) {
    try {
        const s = JSON.parse(readFileSync(join(accountDir, QUOTA_STATE_FILE), "utf8"));
        return {
            usage: s.usage ?? null,
            account: s.account ?? {},
            tenants: s.tenants ?? {},
            lastPurge: s.lastPurge ?? null,
            lastPass: s.lastPass ?? null,
        };
    } catch {
        return { usage: null, account: {}, tenants: {}, lastPurge: null, lastPass: null };
    }
}

function writeQuotaState(accountDir, state) {
    writeFileAtomic(join(accountDir, QUOTA_STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Step one scope's quota clock (pure): its level now, and the events it owes.
 *
 * @param {object} args
 * @param {{level?: string, overSince?: number|null, notified?: string[]}} args.prev
 * @param {number} args.used
 * @param {number|null} args.limit
 * @param {number} args.graceDays
 * @param {number} args.warnAt
 * @param {number} args.now
 * @returns {{next: {level: string, overSince: number|null, notified: string[], purgeAt: number|null},
 *   events: Array<{level: string, daysLeft?: number}>, purgeDue: boolean}}
 */
export function stepQuota({ prev = {}, used, limit, graceDays, warnAt, now }) {
    const notified = new Set(prev.notified ?? []);
    const events = [];
    if (!limit) {
        const was = prev.level && prev.level !== "ok";
        return {
            next: { level: "ok", overSince: null, notified: [], purgeAt: null },
            events: was ? [{ level: "ok" }] : [],
            purgeDue: false,
        };
    }
    if (used <= limit) {
        const level = used >= warnAt * limit ? "warn" : "ok";
        if (prev.level === "over") {
            // Back under the limit (a raise, a renewal, a purge): the grace clock is cleared.
            events.push({ level: "ok" });
            notified.clear();
        }
        if (level === "warn" && !notified.has("warn")) {
            events.push({ level: "warn" });
            notified.add("warn");
        }
        if (level === "ok" && prev.level === "warn") {
            events.push({ level: "ok" });
            notified.clear();
        }
        return { next: { level, overSince: null, notified: [...notified], purgeAt: null }, events, purgeDue: false };
    }
    const overSince = prev.level === "over" && prev.overSince ? prev.overSince : now;
    const purgeAt = overSince + graceDays * DAY_MS;
    if (!notified.has("over")) {
        events.push({ level: "over" });
        notified.add("over");
    }
    for (const days of [7, 1]) {
        const key = `grace${days}`;
        if (purgeAt - now <= days * DAY_MS && now < purgeAt && !notified.has(key) && graceDays > days) {
            events.push({ level: "grace_ending", daysLeft: days });
            notified.add(key);
        }
    }
    return {
        next: { level: "over", overSince, notified: [...notified], purgeAt },
        events,
        purgeDue: now >= purgeAt,
    };
}

// ── The purge ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Remove downloaded media files, oldest first, until `wanted` bytes are freed (or all of them, `wanted` Infinity), or
 * every file of a message older than `before`. Each file's message keeps its row; the prune marker keeps it from being
 * fetched again.
 */
function purgeMedia(db, { before = null, wanted = Infinity, dryRun, now }) {
    const out = { files: 0, bytes: 0 };
    const rows = db.getDownloadedMediaBefore(before);
    for (const row of rows) {
        if (out.bytes >= wanted) break;
        const size = fileSize(row.localPath);
        if (!dryRun) {
            try {
                rmSync(row.localPath, { force: true });
                db.clearMessageLocalPath(row.msgId, now);
            } catch {
                continue;
            }
        }
        out.files++;
        out.bytes += size;
    }
    return out;
}

/** Delete message files after their rows went. */
function removeFiles(files) {
    let bytes = 0;
    for (const f of files) {
        bytes += fileSize(f);
        try {
            rmSync(f, { force: true });
        } catch {
            /* gone already */
        }
    }
    return bytes;
}

/**
 * Remove the oldest messages, a chunk of whole timestamps at a time, until `wanted` bytes of the database are freed.
 */
function purgeOldestMessages(db, { wanted, dryRun, chunk = 2000 }) {
    const out = { rows: 0, mediaFiles: 0, floor: db.getRetentionFloor() };
    if (dryRun) {
        // Estimate with the average row: count the oldest rows that would cover `wanted`.
        const total = Number(db.countMessagesThrough(Number.MAX_SAFE_INTEGER).rows) || 0;
        if (!total) return out;
        const perRow = Math.max(1, db.dbUsedBytes() / total);
        const n = Math.min(total, Math.ceil(wanted / perRow));
        const cutoff = db.nthOldestMessageTimestamp(n);
        if (cutoff === null) return out;
        const c = db.countMessagesThrough(cutoff);
        return { rows: c.rows, mediaFiles: c.files, floor: cutoff, estimated: true };
    }
    const start = db.dbUsedBytes();
    while (start - db.dbUsedBytes() < wanted) {
        const total = Number(db.countMessagesThrough(Number.MAX_SAFE_INTEGER).rows) || 0;
        if (!total) break;
        // About as many rows as the bytes still wanted take, at the average row's size (at most `chunk`): a step
        // never removes much more than needed, and a live writer waits for one short transaction at a time.
        const used = db.dbUsedBytes();
        const left = wanted - (start - used);
        const rows = Math.max(1, Math.min(chunk, total, Math.ceil(left / Math.max(1, used / total))));
        const r = db.purgeMessagesThrough(db.nthOldestMessageTimestamp(rows));
        if (!r.rows) break;
        out.rows += r.rows;
        out.mediaFiles += r.files.length;
        removeFiles(r.files);
        out.floor = r.floor;
    }
    return out;
}

/**
 * Run the quota and retention purge for one account, in the process that holds its daemon.lock and its open database.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {object} [args.db] - the db module's functions (src/core/db.js), on the open database
 * @param {string|null} [args.mediaRoot]
 * @param {boolean} [args.dryRun] - count only
 * @param {number} [args.now]
 * @param {(event: object) => void} [args.emit] - a `storage_quota` event (webhook, listener)
 * @param {(line: string) => void} [args.log]
 * @param {(cutoff: number) => number} [args.purgeOutboxDead] - delete dead deliveries older than the cutoff
 * @param {object|null} [args.policy] - pin the live policy (tests)
 * @returns {object} the report
 */
export function runStoragePass({
    ownId,
    db = cacheDb,
    mediaRoot = null,
    dryRun = false,
    now = Date.now(),
    emit = () => {},
    log = () => {},
    purgeOutboxDead = null,
    policy,
}) {
    const accountDir = getAccountDir(String(ownId));
    const retention = resolveRetention(ownId, { policy });
    const quota = resolveQuota(ownId, { policy });
    const measure = () => measureUsage(ownId, { mediaRoot, dbBytes: db.dbUsedBytes() });
    const before = measure();
    const report = {
        accountId: String(ownId),
        dryRun,
        usageBefore: before,
        retention: { media: { files: 0, bytes: 0 }, messages: { rows: 0, mediaFiles: 0 }, outboxDead: 0 },
        quota: { media: { files: 0, bytes: 0 }, messages: { rows: 0, mediaFiles: 0 } },
        events: [],
    };

    // 1. Age rules.
    if (retention.mediaDays) {
        report.retention.media = purgeMedia(db, { before: now - retention.mediaDays * DAY_MS, dryRun, now });
    }
    if (retention.messagesDays) {
        const cutoff = now - retention.messagesDays * DAY_MS;
        if (dryRun) {
            const c = db.countMessagesThrough(cutoff);
            report.retention.messages = { rows: c.rows, mediaFiles: c.files };
        } else {
            const r = db.purgeMessagesThrough(cutoff);
            removeFiles(r.files);
            report.retention.messages = { rows: r.rows, mediaFiles: r.files.length, floor: r.floor };
        }
    }
    if (purgeOutboxDead && !dryRun)
        report.retention.outboxDead = purgeOutboxDead(now - retention.outboxDeadDays * DAY_MS);

    // 2. Quotas: the clock of the account and of each tenant it is in.
    const state = readQuotaState(accountDir);
    let usage = dryRun ? before : measure();
    const scopes = [];
    if (quota.accountLimit)
        scopes.push({ key: "account", scope: "account", limit: quota.accountLimit, used: () => usage.total });
    // The other members' usage, measured once per pass (memberUsage: the daemon's figure, or a read-only count).
    const peers = new Map();
    const peerTotal = (id, tenantId) => {
        if (!peers.has(id)) peers.set(id, memberUsage(id, { log, context: `tenant ${tenantId}`, scratch: accountDir }));
        return peers.get(id).total;
    };
    for (const t of quota.tenants) {
        const members = t.accounts.filter((id) => id === String(ownId) || existsSync(getAccountDir(id)));
        const others = () =>
            members.filter((id) => id !== String(ownId)).reduce((sum, id) => sum + peerTotal(id, t.id), 0);
        scopes.push({
            key: `tenant:${t.id}`,
            scope: "tenant",
            tenantId: t.id,
            limit: t.limit,
            used: () => usage.total + others(),
            others,
        });
    }
    const nextState = {
        usage: null,
        account: {},
        tenants: {},
        lastPurge: state.lastPurge,
        lastPass: dryRun ? state.lastPass : { at: new Date(now).toISOString() },
    };
    let target = Infinity;
    const prevOf = (s) => (s.scope === "account" ? state.account : state.tenants[s.tenantId]) ?? {};
    const steps = scopes.map((s) => {
        const step = stepQuota({
            prev: prevOf(s),
            used: s.used(),
            limit: s.limit,
            graceDays: quota.graceDays,
            warnAt: quota.warnAt,
            now,
        });
        if (step.purgeDue) {
            // This account's own cap: the account limit, or for a tenant its share of the excess.
            if (s.scope === "account") target = Math.min(target, s.limit);
            else {
                const total = s.used();
                const excess = total - s.limit;
                const share = total > 0 ? Math.ceil((excess * usage.total) / total) : excess;
                target = Math.min(target, Math.max(0, usage.total - share));
            }
        }
        return { s, step };
    });
    // A scope that has no limit any more was cleared: announce it once.
    for (const [key, prev] of [
        ["account", state.account],
        ...Object.entries(state.tenants).map(([id, v]) => [`tenant:${id}`, v]),
    ]) {
        if (prev?.level && prev.level !== "ok" && !scopes.some((s) => s.key === key)) {
            report.events.push({
                level: "ok",
                scope: key === "account" ? "account" : "tenant",
                ...(key !== "account" ? { tenantId: key.slice(7) } : {}),
            });
        }
    }

    // 3. The purge itself, once a grace period has run out: media first, then message content.
    if (Number.isFinite(target) && usage.total > target) {
        const want = usage.total - target;
        report.quota.media = purgeMedia(db, { wanted: want, dryRun, now });
        if (!dryRun) usage = measure();
        const left = dryRun ? want - report.quota.media.bytes : usage.total - target;
        if (left > 0) report.quota.messages = purgeOldestMessages(db, { wanted: left, dryRun });
    }
    const freed =
        report.retention.media.files +
        report.retention.messages.rows +
        report.quota.media.files +
        report.quota.messages.rows;
    if (!dryRun && freed) {
        db.checkpointDb();
        usage = measure();
    }
    report.usageAfter = usage;

    // 4. The clocks again, on the usage after the purge, and the events they owe.
    for (const { s, step } of steps) {
        let next = step.next;
        let events = step.events;
        if (!dryRun && Number.isFinite(target) && (report.quota.media.files || report.quota.messages.rows)) {
            events = [...events, { level: "purged" }];
            const again = stepQuota({
                prev: next,
                used: s.used(),
                limit: s.limit,
                graceDays: quota.graceDays,
                warnAt: quota.warnAt,
                now,
            });
            next = again.next;
            events = [...events, ...again.events.filter((e) => e.level === "ok")];
        }
        if (s.scope === "account") nextState.account = next;
        else nextState.tenants[s.tenantId] = next;
        for (const e of events) {
            report.events.push({
                ...e,
                scope: s.scope,
                ...(s.tenantId ? { tenantId: s.tenantId } : {}),
                usedBytes: s.used(),
                limitBytes: s.limit,
                overSince: next.overSince ? new Date(next.overSince).toISOString() : null,
                purgeAt: next.purgeAt ? new Date(next.purgeAt).toISOString() : null,
            });
        }
    }
    if (!dryRun) {
        nextState.usage = usage;
        if (freed)
            nextState.lastPurge = {
                at: new Date(now).toISOString(),
                freedBytes: Math.max(0, before.total - usage.total),
            };
        writeQuotaState(accountDir, nextState);
        for (const e of report.events) {
            const event = { event: "storage_quota", accountId: String(ownId), ...e };
            if (e.level === "purged")
                Object.assign(event, {
                    freedBytes: Math.max(0, before.total - usage.total),
                    media: report.quota.media.files,
                    messages: report.quota.messages.rows,
                });
            emit(event);
        }
        if (freed)
            log(
                `[storage] purged ${report.retention.media.files + report.quota.media.files} media file(s) and ` +
                    `${report.retention.messages.rows + report.quota.messages.rows} message(s); ` +
                    `${Math.round((before.total - usage.total) / 1024)} KiB freed, floor ${new Date(db.getRetentionFloor()).toISOString()}`,
            );
    }
    report.state = dryRun ? state : nextState;
    return report;
}

/**
 * What `db usage`, `account status` and `zalo_profile` show: the last usage a daemon measured (or the file sizes now),
 * the limits and rules in effect, and the quota level.
 *
 * @param {string} ownId
 * @param {{mediaRoot?: string|null, dbBytes?: number|null}} [opts]
 * @returns {object}
 */
export function describeStorage(ownId, { mediaRoot = null, dbBytes = null } = {}) {
    const dir = getAccountDir(String(ownId));
    const state = readQuotaState(dir);
    const usage = Number.isFinite(dbBytes) || !state.usage ? measureUsage(ownId, { mediaRoot, dbBytes }) : state.usage;
    const quota = resolveQuota(ownId);
    const retention = resolveRetention(ownId);
    return {
        usage,
        quota: {
            accountLimit: quota.accountLimit,
            percent: quota.accountLimit ? Math.round((usage.total / quota.accountLimit) * 1000) / 10 : null,
            level: state.account?.level ?? (quota.accountLimit ? null : "ok"),
            overSince: state.account?.overSince ? new Date(state.account.overSince).toISOString() : null,
            purgeAt: state.account?.purgeAt ? new Date(state.account.purgeAt).toISOString() : null,
            graceDays: quota.graceDays,
            warnAt: quota.warnAt,
            tenants: quota.tenants.map((t) => ({
                id: t.id,
                limit: t.limit,
                level: state.tenants?.[t.id]?.level ?? null,
                overSince: state.tenants?.[t.id]?.overSince
                    ? new Date(state.tenants[t.id].overSince).toISOString()
                    : null,
            })),
        },
        retention: {
            messages: retention.messagesDays ? `${retention.messagesDays}d` : "keep",
            media: retention.mediaDays ? `${retention.mediaDays}d` : "keep",
            outboxDead: `${retention.outboxDeadDays}d`,
            purgeEvery: `${Math.round(retention.purgeEveryMs / 60_000)}m`,
        },
        lastPurge: state.lastPurge,
    };
}

/**
 * The daemon's timer: one pass shortly after start, then every `retention.purgeEvery`; `reschedule()` after a policy
 * change, `runNow()` for `db purge` over the daemon channel.
 *
 * @param {object} args - as {@link runStoragePass}, without `dryRun` and `now`
 * @param {number} [args.firstDelayMs]
 * @returns {{runNow: (o?: {dryRun?: boolean}) => object, reschedule: () => void, stop: () => void}}
 */
export function startStorageJobs({ firstDelayMs = 60_000, ...args }) {
    let timer = null;
    let stopped = false;
    const pass = ({ dryRun = false } = {}) => runStoragePass({ ...args, dryRun });
    const tick = () => {
        try {
            pass();
        } catch (e) {
            args.log?.(`[storage] the quota/retention pass failed: ${e.message}`);
        }
        schedule(resolveRetention(args.ownId).purgeEveryMs);
    };
    const schedule = (ms) => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(tick, ms);
        timer.unref?.();
    };
    schedule(firstDelayMs);
    return {
        runNow: (o) => pass(o),
        // A changed quota is checked at once; a changed interval counts from now.
        reschedule: () => schedule(1000),
        stop() {
            stopped = true;
            clearTimeout(timer);
        },
    };
}

const mib = (n) => `${(Number(n) / 1024 / 1024).toFixed(1)} MiB`;

/**
 * One `storage_quota` event as the MCP server's live buffer carries it to `zalo_get_messages` /
 * `zalo_wait_for_message` (and GET /events/wait): the event's fields, `type: "storage_quota"` and the line a person
 * reads as `text`. Sizes, levels and dates only: no content.
 *
 * @param {object} e - the event `runStoragePass` emits
 * @returns {object}
 */
export function quotaSystemEvent(e) {
    return { type: "storage_quota", ...e, text: describeQuotaEvent(e) };
}

/**
 * One `storage_quota` event as a line for a person (the daemon's log, `listen`'s output).
 *
 * @param {object} e
 * @returns {string}
 */
export function describeQuotaEvent(e) {
    const who = e.scope === "tenant" ? `tenant ${e.tenantId}` : `account ${e.accountId}`;
    const use = e.limitBytes ? `${mib(e.usedBytes)} of ${mib(e.limitBytes)}` : "";
    switch (e.level) {
        case "warn":
            return `Storage: ${who} is near its limit (${use})`;
        case "over":
            return `Storage: ${who} is over its limit (${use}); caching goes on, and the oldest data is purged at ${e.purgeAt}`;
        case "grace_ending":
            return `Storage: ${who} is still over its limit (${use}); the purge starts in ${e.daysLeft} day(s), at ${e.purgeAt}`;
        case "purged":
            return `Storage: purged ${e.media ?? 0} media file(s) and ${e.messages ?? 0} message(s) of ${who} (${mib(e.freedBytes ?? 0)} freed)`;
        default:
            return `Storage: ${who} is within its limit again${use ? ` (${use})` : ""}`;
    }
}
