/**
 * Row MAC: tamper evidence for the message rows of `zalo.db` (at-rest phase 2, §3.4).
 *
 * SQLCipher keeps the file unreadable without the database key. The row MAC covers the case where someone holds that
 * key (a restored backup, a SQLCipher tool given the key): they can read the rows, but they cannot add or change a
 * message without it showing, because each row's MAC is keyed with `getDataKey(ownId, "row-mac")`, a key that is
 * never exported.
 *
 * - The MAC is HMAC-SHA256, cut to 16 bytes, over a version byte, the table name, and each of {@link ROW_MAC_FIELDS}
 *   with its kind and length (so NULL differs from '' and a number from its text). Derived and local columns
 *   (`text_norm`, `localPath`, `has_attachment`, `mediaPrunedAt`) are left out: they change without the message
 *   changing.
 * - It is kept in its own table, `message_macs (msgId, mac)`, not a column of `messages`: every `SELECT *` of a
 *   message would otherwise carry it into replies.
 * - SQL triggers write it, through the app function `zac_row_mac(...)` registered on the connection (as `vn_strip`
 *   is): after an insert, after an update of a covered column (a recall's tombstone included), and the row's MAC goes
 *   with a delete. So every writer (the listener, sync, `msg history`'s fetch) is covered without a hook of its own,
 *   and a connection without the function (a SQLCipher tool with the key) cannot write a message at all.
 * - Rows written before the MACs existed are sealed once by {@link installRowMac}, in chunks, and a marker in
 *   `sync_state` (itself a MAC, so it cannot be forged) records that it was done. After that a message without a MAC
 *   is a finding, never sealed again silently.
 * - Checked by the actions that act on one cached message (quote, forward, delete, recall, pin, media) through
 *   `getMessageForAction`, unless `rowMac.verifyOnRead` in storage.json is `off`; and on demand by `db verify`.
 *   Bulk reads (history, search) are not checked.
 *
 * Measured (win-x64, Node 24): about 16 µs more per inserted row, about 18 µs per verified row.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The covered columns of `messages`, in MAC order. */
export const ROW_MAC_FIELDS = Object.freeze([
    "msgId",
    "threadId",
    "senderId",
    "senderName",
    "timestamp",
    "type",
    "text",
    "raw_data",
    "msgStatus",
]);

/** Where the MACs live. */
export const ROW_MAC_TABLE = "message_macs";
/** The `sync_state` key of the seal marker. */
export const ROW_MAC_MARKER = "rowMac.seal";
/** The MAC length in bytes. */
export const ROW_MAC_BYTES = 16;
/** The values `rowMac.verifyOnRead` takes. */
export const VERIFY_MODES = Object.freeze(["actions", "off"]);

const VERSION = 1;
const TABLE = Buffer.from("messages", "utf8");
/** Rows per transaction when sealing or re-keying: a live writer waits at most one chunk. */
const CHUNK = 5000;

/** An action refused because the cached message failed its integrity check. */
export class RowIntegrityError extends Error {
    /**
     * @param {string} msgId
     * @param {"bad"|"missing"} state
     */
    constructor(msgId, state) {
        super(
            `Message ${msgId} failed its integrity check (${state === "missing" ? "it has no row MAC" : "its row MAC does not match"}): ` +
                "the cached row was changed outside zalo-agent, so it is not acted on. Run `zalo-agent db verify` to " +
                "list every such row.",
        );
        this.name = "RowIntegrityError";
        this.code = "ROW_MAC";
        this.msgId = msgId;
        this.state = state;
    }
}

/** Kind tags of an encoded value. */
const NULL_TAG = 0;
const TEXT_TAG = 1;
const NUMBER_TAG = 2;
const BLOB_TAG = 3;

/** One value as the MAC sees it: its kind, then its bytes (text for a number). */
function valueParts(v) {
    if (v === null || v === undefined) return [NULL_TAG, null];
    if (typeof v === "string") return [TEXT_TAG, v];
    if (typeof v === "number" || typeof v === "bigint") return [NUMBER_TAG, String(v)];
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return [BLOB_TAG, Buffer.from(v)];
    return [TEXT_TAG, String(v)];
}

const PREFIX = (() => {
    const b = Buffer.alloc(1 + 5 + TABLE.length);
    b[0] = VERSION;
    b[1] = TEXT_TAG;
    b.writeUInt32BE(TABLE.length, 2);
    TABLE.copy(b, 6);
    return b;
})();

/**
 * The MAC of one row's covered values: HMAC-SHA256 over the version, the table name and each value as
 * `tag(1) ‖ u32be(length) ‖ bytes`, cut to 16 bytes. Built in one buffer: this runs once per row written.
 *
 * @param {Buffer} key - the `row-mac` data key
 * @param {Array<unknown>} values - in {@link ROW_MAC_FIELDS} order
 * @returns {Buffer} 16 bytes
 */
export function computeRowMac(key, values) {
    const parts = values.map(valueParts);
    let size = PREFIX.length;
    for (const [, b] of parts) size += 5 + (b === null ? 0 : typeof b === "string" ? Buffer.byteLength(b) : b.length);
    const buf = Buffer.allocUnsafe(size);
    let off = PREFIX.copy(buf, 0);
    for (const [tag, b] of parts) {
        buf[off] = tag;
        const len = b === null ? 0 : typeof b === "string" ? buf.write(b, off + 5, "utf8") : b.copy(buf, off + 5);
        buf.writeUInt32BE(len, off + 1);
        off += 5 + len;
    }
    return createHmac("sha256", key).update(buf).digest().subarray(0, ROW_MAC_BYTES);
}

/**
 * The MAC of a message row as read from the database.
 *
 * @param {Buffer} key
 * @param {object} row
 * @returns {Buffer}
 */
export function rowMacOf(key, row) {
    return computeRowMac(
        key,
        ROW_MAC_FIELDS.map((f) => row[f]),
    );
}

const sameMac = (a, b) => Buffer.isBuffer(a) && a.length === b.length && timingSafeEqual(a, b);

/** The marker's MAC: "the rows up to here were sealed" (`backfill:<rowid>`) or "all were" (`sealed`). */
function markerMac(key, what) {
    return createHmac("sha256", key).update(`zalo-agent-cli/row-mac/v${VERSION}/${what}`).digest("hex");
}

/**
 * A key for a database that belongs to no account (`:memory:`, tests): random, for this process only.
 *
 * @returns {{key: Buffer, keyId: string}}
 */
export function ephemeralRowMacKey() {
    return { key: randomBytes(32), keyId: "ephemeral" };
}

/**
 * Register `zac_row_mac` on a connection, keyed. Must come before any statement that fires a MAC trigger.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db
 * @param {Buffer} key
 */
export function registerRowMacFunction(db, key) {
    db.function("zac_row_mac", { deterministic: true, varargs: true }, (...values) => computeRowMac(key, values));
}

const NEW_VALUES = ROW_MAC_FIELDS.map((f) => `NEW.${f}`).join(", ");
const ROW_VALUES = ROW_MAC_FIELDS.join(", ");

/**
 * Create the MAC table and triggers (idempotent), and seal the rows that have no MAC yet if the database was never
 * sealed. The connection must have the function ({@link registerRowMacFunction}).
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db
 * @param {Buffer} key
 * @param {{log?: (line: string) => void}} [opts] - progress of a large first seal
 * @returns {{sealed: number}} rows sealed now (0 on every open after the first)
 */
export function installRowMac(db, key, { log } = {}) {
    // Delete, then insert, never INSERT OR REPLACE: an OR clause of the statement that fired a trigger (INSERT OR
    // IGNORE INTO messages) overrides the trigger's own, and would keep a stale MAC.
    db.exec(`
    CREATE TABLE IF NOT EXISTS ${ROW_MAC_TABLE} (msgId TEXT PRIMARY KEY, mac BLOB NOT NULL) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS messages_mac_ai AFTER INSERT ON messages WHEN NEW.msgId IS NOT NULL BEGIN
        DELETE FROM ${ROW_MAC_TABLE} WHERE msgId = NEW.msgId;
        INSERT INTO ${ROW_MAC_TABLE} (msgId, mac) VALUES (NEW.msgId, zac_row_mac(${NEW_VALUES}));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_mac_au AFTER UPDATE OF ${ROW_VALUES} ON messages BEGIN
        DELETE FROM ${ROW_MAC_TABLE} WHERE msgId = OLD.msgId OR msgId = NEW.msgId;
        INSERT INTO ${ROW_MAC_TABLE} (msgId, mac)
            SELECT NEW.msgId, zac_row_mac(${NEW_VALUES}) WHERE NEW.msgId IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_mac_ad AFTER DELETE ON messages BEGIN
        DELETE FROM ${ROW_MAC_TABLE} WHERE msgId = OLD.msgId;
    END;
  `);
    const state = markerState(db, key);
    if (state.sealed) return { sealed: 0 };
    let upTo = state.backfillUpTo;
    if (upTo === null) {
        // Absent (or forged) marker. A first seal only when no row has a MAC yet: otherwise the marker was removed,
        // and sealing again would bless whatever was written without the function. Such rows stay findings.
        if (db.prepare(`SELECT 1 FROM ${ROW_MAC_TABLE} LIMIT 1`).get()) return { sealed: 0 };
        upTo = Number(db.prepare("SELECT COALESCE(max(rowid), 0) AS n FROM messages").get().n);
        setMarker(db, `backfill:${upTo}`, key);
    }
    return { sealed: sealRows(db, upTo, key, { log }) };
}

function setMarker(db, what, key) {
    db.prepare(
        "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(ROW_MAC_MARKER, `${what}:${markerMac(key, what)}`);
}

/**
 * What the seal marker says, under one key.
 *
 * @returns {{sealed: boolean, backfillUpTo: number|null, present: boolean}}
 */
function markerState(db, key) {
    const value = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(ROW_MAC_MARKER)?.value;
    if (typeof value !== "string") return { sealed: false, backfillUpTo: null, present: false };
    const at = value.lastIndexOf(":");
    const what = value.slice(0, at);
    const mac = value.slice(at + 1);
    const valid = at > 0 && mac === markerMac(key, what);
    if (!valid) return { sealed: false, backfillUpTo: null, present: true };
    if (what === "sealed") return { sealed: true, backfillUpTo: null, present: true };
    const m = /^backfill:(\d+)$/.exec(what);
    return { sealed: false, backfillUpTo: m ? Number(m[1]) : null, present: true };
}

/** Seal every row up to `upTo` (rowid) that has no MAC, in chunks, then mark the database sealed. */
function sealRows(db, upTo, key, { log } = {}) {
    const insert = db.prepare(
        `INSERT OR IGNORE INTO ${ROW_MAC_TABLE} (msgId, mac)
         SELECT msgId, zac_row_mac(${ROW_VALUES}) FROM messages
         WHERE rowid > ? AND rowid <= ? AND msgId IS NOT NULL`,
    );
    const total = upTo;
    const loud = total > 50_000 && log;
    if (loud) log(`[db] sealing the cached messages with their integrity MAC, once (${total} rows)…`);
    let sealed = 0;
    const started = Date.now();
    for (let from = 0; from < upTo; from += CHUNK) {
        sealed += db.transaction(() => insert.run(from, Math.min(from + CHUNK, upTo)).changes)();
        if (loud && from % (CHUNK * 20) === 0 && from) log(`[db] … ${from} / ${total}`);
    }
    setMarker(db, "sealed", key);
    if (loud) log(`[db] sealed ${sealed} messages (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return sealed;
}

/**
 * Check one message row read with `SELECT *`.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db
 * @param {Buffer[]} keys - the current `row-mac` key first, then retired ones (an unfinished rekey)
 * @param {object} row
 * @returns {"ok"|"bad"|"missing"}
 */
export function checkRow(db, keys, row) {
    const stored = db.prepare(`SELECT mac FROM ${ROW_MAC_TABLE} WHERE msgId = ?`).get(row.msgId)?.mac;
    if (!stored) return "missing";
    for (const key of keys) if (sameMac(stored, rowMacOf(key, row))) return "ok";
    return "bad";
}

/**
 * Check every message (or one thread's, or those since a time): `db verify`.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db
 * @param {Buffer[]} keys - current first
 * @param {object} [opts]
 * @param {string} [opts.threadId]
 * @param {number} [opts.since] - epoch ms
 * @param {number} [opts.listMax=50] - how many failing msgIds to list
 * @returns {{checked: number, ok: number, bad: number, missing: number, oldKey: number, orphanMacs: number,
 *   seal: "sealed"|"partial"|"absent"|"invalid", failures: Array<{msgId: string, threadId: string, state: string}>,
 *   ms: number}}
 */
export function verifyRows(db, keys, { threadId, since, listMax = 50 } = {}) {
    const started = Date.now();
    const where = [];
    const args = [];
    if (threadId !== undefined && threadId !== null && threadId !== "") {
        where.push("m.threadId = ?");
        args.push(String(threadId));
    }
    if (Number.isFinite(since)) {
        where.push("m.timestamp >= ?");
        args.push(since);
    }
    const sql =
        `SELECT ${ROW_MAC_FIELDS.map((f) => `m.${f}`).join(", ")}, x.mac AS _mac FROM messages m ` +
        `LEFT JOIN ${ROW_MAC_TABLE} x ON x.msgId = m.msgId${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
    const out = { checked: 0, ok: 0, bad: 0, missing: 0, oldKey: 0, failures: [] };
    for (const row of db.prepare(sql).iterate(...args)) {
        out.checked++;
        let state = "missing";
        if (row._mac) {
            state = "bad";
            for (const [i, key] of keys.entries()) {
                if (sameMac(row._mac, rowMacOf(key, row))) {
                    state = "ok";
                    if (i > 0) out.oldKey++;
                    break;
                }
            }
        }
        out[state]++;
        if (state !== "ok" && out.failures.length < listMax) {
            out.failures.push({ msgId: row.msgId, threadId: row.threadId, state });
        }
    }
    const filtered = where.length > 0;
    const orphanMacs = filtered
        ? 0
        : db
              .prepare(
                  `SELECT count(*) AS n FROM ${ROW_MAC_TABLE} x WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.msgId = x.msgId)`,
              )
              .get().n;
    const marker = markerState(db, keys[0]);
    const seal = marker.sealed
        ? "sealed"
        : marker.backfillUpTo !== null
          ? "partial"
          : marker.present
            ? "invalid"
            : "absent";
    return { ...out, orphanMacs, seal, ms: Date.now() - started };
}

/**
 * Re-key the MACs (a rekey's handler): every row whose MAC verifies under an older key is re-MACed under the current
 * one; a row that verifies under none is left as it is (still a finding). Idempotent.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db - opened with the current database key
 * @param {Buffer} current - the current `row-mac` key
 * @param {Buffer[]} older - retired `row-mac` keys
 * @returns {{rewritten: number, current: number, failed: number}}
 */
export function rekeyRowMacs(db, current, older) {
    const out = { rewritten: 0, current: 0, failed: 0 };
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ROW_MAC_TABLE)) return out;
    // The marker says what was sealed, not under which key: carry it over when an older key made it.
    const value = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(ROW_MAC_MARKER)?.value;
    const what = typeof value === "string" ? markerWhat(value, current) : null;
    if (typeof value === "string" && what === null) {
        for (const k of older) {
            const w = markerWhat(value, k);
            if (w !== null) {
                setMarker(db, w, current);
                break;
            }
        }
    }
    const update = db.prepare(`UPDATE ${ROW_MAC_TABLE} SET mac = ? WHERE msgId = ?`);
    const page = db.prepare(
        `SELECT m.rowid AS _rowid, ${ROW_MAC_FIELDS.map((f) => `m.${f}`).join(", ")}, x.mac AS _mac FROM messages m ` +
            `JOIN ${ROW_MAC_TABLE} x ON x.msgId = m.msgId WHERE m.rowid > ? ORDER BY m.rowid LIMIT ${CHUNK}`,
    );
    // A page at a time: the whole table would not fit in memory on a large cache.
    for (let after = -1; ;) {
        const rows = page.all(after);
        if (!rows.length) break;
        after = rows[rows.length - 1]._rowid;
        db.transaction(() => {
            for (const row of rows) {
                const now = rowMacOf(current, row);
                if (sameMac(row._mac, now)) {
                    out.current++;
                } else if (older.some((k) => sameMac(row._mac, rowMacOf(k, row)))) {
                    update.run(now, row.msgId);
                    out.rewritten++;
                } else out.failed++;
            }
        })();
    }
    return out;
}

/** The marker's claim (`sealed`, `backfill:<n>`) when it verifies under `key`, else null. */
function markerWhat(value, key) {
    const at = value.lastIndexOf(":");
    if (at <= 0) return null;
    const what = value.slice(0, at);
    return value.slice(at + 1) === markerMac(key, what) ? what : null;
}

/**
 * Whether the actions check the rows they act on (`rowMac.verifyOnRead` in storage.json; default `actions`).
 *
 * @param {object} file - storage.json's settings
 * @returns {"actions"|"off"}
 * @throws {Error} for a value that is not one of {@link VERIFY_MODES}
 */
export function verifyOnReadMode(file) {
    const v = file?.rowMac?.verifyOnRead;
    if (v === undefined || v === null) return "actions";
    if (!VERIFY_MODES.includes(v)) {
        throw new Error(
            `storage.json rowMac.verifyOnRead must be one of ${VERIFY_MODES.join(", ")}, not ${JSON.stringify(v)}`,
        );
    }
    return v;
}
