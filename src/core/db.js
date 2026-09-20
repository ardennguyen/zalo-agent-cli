import Database from "better-sqlite3";

let db;

export function initDb(dbPath) {
    db = new Database(dbPath);

    // Enable WAL mode for better performance
    db.pragma("journal_mode = WAL");

    // Create tables
    db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msgId TEXT PRIMARY KEY,
      threadId TEXT,
      senderId TEXT,
      senderName TEXT,
      text TEXT,
      timestamp INTEGER,
      type TEXT,
      raw_data TEXT,
      localPath TEXT,
      has_attachment INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS threads (
      threadId TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      lastUpdate INTEGER,
      sync_timestamp INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contacts (
      userId TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT
    );

    -- Small key/value store for sync bookkeeping: lastConnectedAt,
    -- lastDisconnectedAt, lastFullSyncAt, etc. One row per key, per-account
    -- (this whole DB file is already per-account under accounts/<ownId>/zalo.db).
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Tracks time windows where we know (or suspect) messages may have been
    -- missed — mirrors Zalo Web's own client-side "MissingMessageRange" table
    -- (confirmed live via its IndexedDB schema: id/convId/fromTs/toTs/reason/status)
    -- but kept account-wide rather than per-conversation, since pullMobileMsg/
    -- getCrossDB operate on the whole account, not a single thread.
    CREATE TABLE IF NOT EXISTS sync_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromTs INTEGER,
      toTs INTEGER,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      createdAt INTEGER,
      resolvedAt INTEGER
    );
  `);

    // Migration for existing DBs
    try {
        db.exec("ALTER TABLE messages ADD COLUMN localPath TEXT");
    } catch (e) {
        // column probably already exists
    }
    try {
        db.exec("ALTER TABLE messages ADD COLUMN has_attachment INTEGER DEFAULT 0");
    } catch (e) {}
    try {
        db.exec("ALTER TABLE threads ADD COLUMN sync_timestamp INTEGER DEFAULT 0");
    } catch (e) {}

    return db;
}

/** Get a bookkeeping value (e.g. "lastConnectedAt"). Returns null if unset. */
export function getSyncState(key) {
    if (!db) throw new Error("Database not initialized");
    const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key);
    return row ? row.value : null;
}

/** Set a bookkeeping value. Value is stringified on write, so callers get
 * strings back from getSyncState() and should Number()/JSON.parse() as needed. */
export function setSyncState(key, value) {
    if (!db) throw new Error("Database not initialized");
    db.prepare(
        `
    INSERT INTO sync_state (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
    ).run({ key, value: String(value) });
}

/** Record a window of time we may have missed messages in (reason: e.g.
 * "startup-gap", "reconnect-gap", "manual"). Returns the new gap's id. */
export function recordSyncGap(fromTs, toTs, reason) {
    if (!db) throw new Error("Database not initialized");
    const stmt = db.prepare(`
    INSERT INTO sync_gaps (fromTs, toTs, reason, status, createdAt)
    VALUES (@fromTs, @toTs, @reason, 'pending', @createdAt)
  `);
    const info = stmt.run({ fromTs, toTs, reason, createdAt: Date.now() });
    return info.lastInsertRowid;
}

/** All gaps not yet confirmed synced, oldest first. */
export function getPendingSyncGaps() {
    if (!db) throw new Error("Database not initialized");
    return db.prepare("SELECT * FROM sync_gaps WHERE status = 'pending' ORDER BY fromTs ASC").all();
}

/** Mark a gap resolved after a sync round-trip has actually covered it. */
export function resolveSyncGap(id) {
    if (!db) throw new Error("Database not initialized");
    db.prepare("UPDATE sync_gaps SET status = 'resolved', resolvedAt = ? WHERE id = ?").run(Date.now(), id);
}

/** Mark every currently-pending gap resolved (used after a full sync cycle
 * completes successfully — we don't currently track gaps per-thread, so a
 * successful round-trip is treated as covering everything outstanding). */
export function resolveAllPendingSyncGaps() {
    if (!db) throw new Error("Database not initialized");
    db.prepare("UPDATE sync_gaps SET status = 'resolved', resolvedAt = ? WHERE status = 'pending'").run(Date.now());
}

export function insertMessage(msg) {
    if (!db) throw new Error("Database not initialized");

    const stmt = db.prepare(`
    INSERT INTO messages (msgId, threadId, senderId, senderName, text, timestamp, type, raw_data, localPath, has_attachment)
    VALUES (@msgId, @threadId, @senderId, @senderName, @text, @timestamp, @type, @raw_data, @localPath, @has_attachment)
    ON CONFLICT(msgId) DO UPDATE SET
      text = excluded.text,
      timestamp = excluded.timestamp,
      type = excluded.type,
      raw_data = excluded.raw_data,
      localPath = COALESCE(excluded.localPath, messages.localPath),
      has_attachment = excluded.has_attachment
  `);

    const raw_data =
        typeof msg.raw_data === "object" && msg.raw_data !== null ? JSON.stringify(msg.raw_data) : msg.raw_data;

    return stmt.run({
        msgId: msg.msgId,
        threadId: msg.threadId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        timestamp: msg.timestamp,
        type: msg.type,
        raw_data: raw_data,
        localPath: msg.localPath || null,
        has_attachment: msg.has_attachment ? 1 : 0,
    });
}

export function getMessages(threadId, limit = 50, fromTimestamp = null) {
    if (!db) throw new Error("Database not initialized");

    let query = "SELECT * FROM messages WHERE threadId = ?";
    const params = [threadId];

    if (fromTimestamp) {
        query += " AND timestamp < ?";
        params.push(fromTimestamp);
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    return db.prepare(query).all(...params);
}

/**
 * Most recently active threads, newest first.
 *
 * `type` filters in SQL rather than after the fact. That distinction is the
 * whole point: `getRecentThreads(5)` followed by a JS filter returns the
 * groups *among the newest five threads of any kind* — frequently none —
 * whereas asking for 5 groups should return the 5 newest groups.
 *
 * @param {number} [limit=20]
 * @param {"dm"|"group"|null} [type=null] - null means both
 */
export function getRecentThreads(limit = 20, type = null) {
    if (!db) throw new Error("Database not initialized");
    if (type) {
        return db.prepare("SELECT * FROM threads WHERE type = ? ORDER BY lastUpdate DESC LIMIT ?").all(type, limit);
    }
    return db.prepare("SELECT * FROM threads ORDER BY lastUpdate DESC LIMIT ?").all(limit);
}

export function upsertThread(thread) {
    if (!db) throw new Error("Database not initialized");

    const stmt = db.prepare(`
    INSERT INTO threads (threadId, type, name, lastUpdate, sync_timestamp)
    VALUES (@threadId, @type, @name, @lastUpdate, @sync_timestamp)
    ON CONFLICT(threadId) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      lastUpdate = excluded.lastUpdate,
      sync_timestamp = COALESCE(excluded.sync_timestamp, threads.sync_timestamp)
  `);

    return stmt.run({
        threadId: thread.threadId,
        type: thread.type,
        name: thread.name,
        lastUpdate: thread.lastUpdate,
        sync_timestamp: thread.sync_timestamp || null,
    });
}

export function upsertContact(contact) {
    if (!db) throw new Error("Database not initialized");

    const stmt = db.prepare(`
    INSERT INTO contacts (userId, name, phone)
    VALUES (@userId, @name, @phone)
    ON CONFLICT(userId) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone
  `);

    return stmt.run({
        userId: contact.userId,
        name: contact.name,
        phone: contact.phone,
    });
}
