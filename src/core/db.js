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
      sync_timestamp INTEGER DEFAULT 0,
      respondedByMe INTEGER,
      lastGlobalId TEXT,
      lastClientId TEXT
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

    -- Board items: notes ("Ghi chú"), pinned messages and polls. These are NOT
    -- in the transfer-sync message stream at all — Zalo keeps them behind
    -- /api/board/list, one call per thread — so they are synced separately and
    -- stored here. boardType mirrors zca-js BoardType: 1=Note, 2=PinnedMessage,
    -- 3=Poll. The id column is scoped by thread because item ids repeat across
    -- threads. (No backticks anywhere in this SQL: it sits inside a JS template
    -- literal, so one would close it and break the whole module.)
    CREATE TABLE IF NOT EXISTS board_items (
      id TEXT PRIMARY KEY,
      threadId TEXT,
      threadType TEXT,
      boardType INTEGER,
      itemId TEXT,
      title TEXT,
      creatorId TEXT,
      createTime INTEGER,
      editTime INTEGER,
      startTime INTEGER,
      duration INTEGER,
      repeat INTEGER,
      emoji TEXT,
      color INTEGER,
      raw_data TEXT,
      sync_timestamp INTEGER
    );

    -- Reminders ("Nhắc hẹn"). Also out-of-stream: /api/board/oneone/list for
    -- DMs, /api/board/listReminder for groups. The conversation *events* that
    -- announce them do arrive as messages (msgType 24), but the reminder
    -- objects themselves only exist here.
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      reminderId TEXT,
      threadId TEXT,
      threadType TEXT,
      title TEXT,
      creatorId TEXT,
      createTime INTEGER,
      editTime INTEGER,
      startTime INTEGER,
      duration INTEGER,
      repeatMode INTEGER,
      emoji TEXT,
      color INTEGER,
      eventType INTEGER,
      raw_data TEXT,
      sync_timestamp INTEGER
    );

    -- zCloud / "Cloud cua toi" media index. Populated from the cloud verify
    -- queue (cmd 621 -> /cloudmedia/queue/pc/verify) and from the per-thread
    -- media store, and keyed by Zalo's noiseId. Each row records where the
    -- backup lives and the per-item encryptKey; the blob itself stays on
    -- Zalo's side until something fetches and decrypts it.
    CREATE TABLE IF NOT EXISTS cloud_items (
      noiseId TEXT PRIMARY KEY,
      threadId TEXT,
      msgId TEXT,
      msgType INTEGER,
      mediaType INTEGER,
      cloudUrl TEXT,
      encryptKey TEXT,
      checksum TEXT,
      mediaSize INTEGER,
      timestamp INTEGER,
      localPath TEXT,
      raw_data TEXT,
      sync_timestamp INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_thread ON cloud_items(threadId);
    CREATE INDEX IF NOT EXISTS idx_cloud_msg ON cloud_items(msgId);
    CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(threadId, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_attach ON messages(has_attachment) WHERE has_attachment = 1;
    CREATE INDEX IF NOT EXISTS idx_board_thread ON board_items(threadId, boardType);
    CREATE INDEX IF NOT EXISTS idx_reminders_thread ON reminders(threadId);
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
    // Conversation-round fields from the mobile sync. Nullable: the listener
    // never learns them, so only a transfer sync fills them in.
    try {
        db.exec("ALTER TABLE threads ADD COLUMN respondedByMe INTEGER");
    } catch {}
    try {
        db.exec("ALTER TABLE threads ADD COLUMN lastGlobalId TEXT");
    } catch {}
    try {
        db.exec("ALTER TABLE threads ADD COLUMN lastClientId TEXT");
    } catch {}

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

/**
 * Run `fn` inside a single SQLite transaction.
 *
 * Bulk restores insert tens of thousands of rows; without this each statement
 * is its own transaction and pays a WAL commit, which is both slow and -- worse
 * for the mobile sync -- blocks the event loop long enough that the Zalo socket
 * keepalive ping is missed and the connection is dropped mid-run.
 *
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function runInTransaction(fn) {
    if (!db) throw new Error("Database not initialized");
    return db.transaction(fn)();
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
    INSERT INTO threads (threadId, type, name, lastUpdate, sync_timestamp, respondedByMe, lastGlobalId, lastClientId)
    VALUES (@threadId, @type, @name, @lastUpdate, @sync_timestamp, @respondedByMe, @lastGlobalId, @lastClientId)
    ON CONFLICT(threadId) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      lastUpdate = excluded.lastUpdate,
      sync_timestamp = COALESCE(excluded.sync_timestamp, threads.sync_timestamp),
      respondedByMe = COALESCE(excluded.respondedByMe, threads.respondedByMe),
      lastGlobalId = COALESCE(excluded.lastGlobalId, threads.lastGlobalId),
      lastClientId = COALESCE(excluded.lastClientId, threads.lastClientId)
  `);

    return stmt.run({
        threadId: thread.threadId,
        type: thread.type,
        name: thread.name,
        lastUpdate: thread.lastUpdate,
        sync_timestamp: thread.sync_timestamp || null,
        // Only a mobile sync knows these; a listener write leaves them alone.
        respondedByMe: thread.respondedByMe === undefined ? null : thread.respondedByMe ? 1 : 0,
        lastGlobalId: thread.lastGlobalId === undefined ? null : String(thread.lastGlobalId),
        lastClientId: thread.lastClientId === undefined ? null : String(thread.lastClientId),
    });
}

/**
 * Messages carrying at least one downloadable attachment, newest first.
 *
 * Reads the `has_attachment` flag rather than scanning `raw_data`, which is
 * why the sync path must set it — a JSON scan over a six-figure message table
 * is not something a CLI command can afford to do per run.
 *
 * @param {object} [opts]
 * @param {string} [opts.threadId] - restrict to one thread
 * @param {number} [opts.since] - only messages at/after this epoch ms
 * @param {number} [opts.until] - only messages at/before this epoch ms
 * @param {boolean} [opts.onlyMissing=true] - skip rows already downloaded
 * @param {number} [opts.limit=500]
 */
export function getAttachmentMessages(opts = {}) {
    if (!db) throw new Error("Database not initialized");
    const { threadId, since, until, onlyMissing = true, limit = 500 } = opts;
    const where = ["has_attachment = 1"];
    const params = [];
    if (onlyMissing) where.push("localPath IS NULL");
    if (threadId) (where.push("threadId = ?"), params.push(String(threadId)));
    if (Number.isFinite(since)) (where.push("timestamp >= ?"), params.push(since));
    if (Number.isFinite(until)) (where.push("timestamp <= ?"), params.push(until));
    params.push(limit);
    return db
        .prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`)
        .all(...params);
}

/**
 * Links shared in conversations, newest first — the local equivalent of the
 * "Link" tab in Zalo's media store, which is a third media kind alongside
 * images and files rather than something separate.
 *
 * Kept as a query over `raw_data` rather than its own table: a link has no
 * bytes to download and no lifecycle of its own, so the message row is already
 * the record. One row per link, so a message carrying several yields several.
 *
 * @param {object} [opts]
 * @param {string} [opts.threadId]
 * @param {number} [opts.limit=200]
 * @returns {Array<{msgId: string, threadId: string, timestamp: number, url: string, title: string|null, description: string|null, thumbUrl: string|null}>}
 */
export function getLinkMessages(opts = {}) {
    if (!db) throw new Error("Database not initialized");
    const { threadId, limit = 200 } = opts;
    const where = ["json_extract(a.value, '$.kind') = 'link'", "json_extract(a.value, '$.url') IS NOT NULL"];
    const params = [];
    if (threadId) {
        where.push("m.threadId = ?");
        params.push(String(threadId));
    }
    params.push(limit);
    return db
        .prepare(
            `SELECT m.msgId, m.threadId, m.senderId, m.timestamp,
              json_extract(a.value, '$.url') AS url,
              json_extract(a.value, '$.title') AS title,
              json_extract(a.value, '$.description') AS description,
              json_extract(a.value, '$.thumbUrl') AS thumbUrl
       FROM messages m, json_each(json_extract(m.raw_data, '$.attachments')) a
       WHERE ${where.join(" AND ")}
       ORDER BY m.timestamp DESC LIMIT ?`,
        )
        .all(...params);
}

/**
 * Downloaded attachments older than `before`, for pruning.
 *
 * Returns the rows rather than deleting anything: the caller has to see what it
 * is about to remove from disk, and a dry run has to be possible.
 *
 * @param {number} before - epoch ms; rows with an older timestamp are returned
 * @param {string} [threadId] - restrict to one thread
 * @returns {Array<{msgId: string, threadId: string, timestamp: number, localPath: string}>}
 */
export function getDownloadedMediaBefore(before, threadId = null) {
    if (!db) throw new Error("Database not initialized");
    const sql =
        "SELECT msgId, threadId, timestamp, localPath FROM messages " +
        "WHERE localPath IS NOT NULL AND timestamp < ?" +
        (threadId ? " AND threadId = ?" : "") +
        " ORDER BY timestamp ASC";
    return threadId ? db.prepare(sql).all(before, String(threadId)) : db.prepare(sql).all(before);
}

/**
 * Forget where an attachment was stored, after its file has been removed.
 *
 * Clearing `localPath` is what puts the row back in the download queue, so a
 * pruned message can be fetched again later if its link is still alive.
 */
export function clearMessageLocalPath(msgId) {
    if (!db) throw new Error("Database not initialized");
    return db.prepare("UPDATE messages SET localPath = NULL WHERE msgId = ?").run(String(msgId));
}

/** Record where an attachment was written to disk. */
export function setMessageLocalPath(msgId, localPath) {
    if (!db) throw new Error("Database not initialized");
    return db.prepare("UPDATE messages SET localPath = ? WHERE msgId = ?").run(localPath, String(msgId));
}

/** How many attachment-bearing messages are still undownloaded. */
export function countPendingAttachments(threadId = null) {
    if (!db) throw new Error("Database not initialized");
    const sql =
        "SELECT count(*) AS n FROM messages WHERE has_attachment = 1 AND localPath IS NULL" +
        (threadId ? " AND threadId = ?" : "");
    return (threadId ? db.prepare(sql).get(String(threadId)) : db.prepare(sql).get()).n;
}

export function upsertBoardItem(item) {
    if (!db) throw new Error("Database not initialized");
    return db
        .prepare(
            `INSERT INTO board_items
       (id, threadId, threadType, boardType, itemId, title, creatorId, createTime, editTime,
        startTime, duration, repeat, emoji, color, raw_data, sync_timestamp)
     VALUES (@id, @threadId, @threadType, @boardType, @itemId, @title, @creatorId, @createTime, @editTime,
             @startTime, @duration, @repeat, @emoji, @color, @raw_data, @sync_timestamp)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, editTime = excluded.editTime, startTime = excluded.startTime,
       duration = excluded.duration, repeat = excluded.repeat, emoji = excluded.emoji,
       color = excluded.color, raw_data = excluded.raw_data, sync_timestamp = excluded.sync_timestamp`,
        )
        .run({
            id: `${item.threadId}:${item.boardType}:${item.itemId}`,
            threadId: String(item.threadId),
            threadType: item.threadType || null,
            boardType: Number(item.boardType) || 0,
            itemId: String(item.itemId),
            title: item.title ?? null,
            creatorId: item.creatorId ?? null,
            createTime: Number(item.createTime) || null,
            editTime: Number(item.editTime) || null,
            startTime: Number(item.startTime) || null,
            duration: Number(item.duration) || null,
            repeat: Number(item.repeat) || null,
            emoji: item.emoji ?? null,
            color: Number(item.color) || null,
            raw_data: typeof item.raw_data === "object" ? JSON.stringify(item.raw_data) : (item.raw_data ?? null),
            sync_timestamp: item.sync_timestamp || Date.now(),
        });
}

/** Board items for a thread (or all threads), optionally one boardType. */
export function getBoardItems(threadId = null, boardType = null) {
    if (!db) throw new Error("Database not initialized");
    const where = [];
    const params = [];
    if (threadId) (where.push("threadId = ?"), params.push(String(threadId)));
    if (boardType) (where.push("boardType = ?"), params.push(Number(boardType)));
    const sql = `SELECT * FROM board_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createTime DESC`;
    return db.prepare(sql).all(...params);
}

export function upsertReminder(r) {
    if (!db) throw new Error("Database not initialized");
    return db
        .prepare(
            `INSERT INTO reminders
       (id, reminderId, threadId, threadType, title, creatorId, createTime, editTime,
        startTime, duration, repeatMode, emoji, color, eventType, raw_data, sync_timestamp)
     VALUES (@id, @reminderId, @threadId, @threadType, @title, @creatorId, @createTime, @editTime,
             @startTime, @duration, @repeatMode, @emoji, @color, @eventType, @raw_data, @sync_timestamp)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, editTime = excluded.editTime, startTime = excluded.startTime,
       duration = excluded.duration, repeatMode = excluded.repeatMode, emoji = excluded.emoji,
       color = excluded.color, eventType = excluded.eventType, raw_data = excluded.raw_data,
       sync_timestamp = excluded.sync_timestamp`,
        )
        .run({
            id: `${r.threadId}:${r.reminderId}`,
            reminderId: String(r.reminderId),
            threadId: String(r.threadId),
            threadType: r.threadType || null,
            title: r.title ?? null,
            creatorId: r.creatorId ?? null,
            createTime: Number(r.createTime) || null,
            editTime: Number(r.editTime) || null,
            startTime: Number(r.startTime) || null,
            duration: Number(r.duration) || null,
            repeatMode: Number(r.repeatMode) || 0,
            emoji: r.emoji ?? null,
            color: Number(r.color) || null,
            eventType: Number(r.eventType) || null,
            raw_data: typeof r.raw_data === "object" ? JSON.stringify(r.raw_data) : (r.raw_data ?? null),
            sync_timestamp: r.sync_timestamp || Date.now(),
        });
}

/** Reminders for a thread, or all of them, soonest start first. */
export function getReminders(threadId = null) {
    if (!db) throw new Error("Database not initialized");
    return threadId
        ? db.prepare("SELECT * FROM reminders WHERE threadId = ? ORDER BY startTime ASC").all(String(threadId))
        : db.prepare("SELECT * FROM reminders ORDER BY startTime ASC").all();
}

/**
 * Record a zCloud media item. Keyed by Zalo's `noiseId`, which is the id the
 * cloud queue and the download endpoint both speak.
 */
export function upsertCloudItem(item) {
    if (!db) throw new Error("Database not initialized");
    return db
        .prepare(
            `INSERT INTO cloud_items
       (noiseId, threadId, msgId, msgType, mediaType, cloudUrl, encryptKey, checksum,
        mediaSize, timestamp, localPath, raw_data, sync_timestamp)
     VALUES (@noiseId, @threadId, @msgId, @msgType, @mediaType, @cloudUrl, @encryptKey, @checksum,
             @mediaSize, @timestamp, @localPath, @raw_data, @sync_timestamp)
     ON CONFLICT(noiseId) DO UPDATE SET
       threadId = COALESCE(excluded.threadId, cloud_items.threadId),
       msgId = COALESCE(excluded.msgId, cloud_items.msgId),
       cloudUrl = excluded.cloudUrl,
       encryptKey = COALESCE(excluded.encryptKey, cloud_items.encryptKey),
       checksum = COALESCE(excluded.checksum, cloud_items.checksum),
       mediaSize = COALESCE(excluded.mediaSize, cloud_items.mediaSize),
       localPath = COALESCE(excluded.localPath, cloud_items.localPath),
       raw_data = excluded.raw_data,
       sync_timestamp = excluded.sync_timestamp`,
        )
        .run({
            noiseId: String(item.noiseId),
            threadId: item.threadId === undefined || item.threadId === null ? null : String(item.threadId),
            msgId: item.msgId === undefined || item.msgId === null ? null : String(item.msgId),
            msgType: Number(item.msgType) || null,
            mediaType: Number(item.mediaType) || null,
            cloudUrl: item.cloudUrl ?? null,
            encryptKey: item.encryptKey ?? null,
            checksum: item.checksum ?? null,
            mediaSize: Number(item.mediaSize) || null,
            timestamp: Number(item.timestamp) || null,
            localPath: item.localPath ?? null,
            raw_data: typeof item.raw_data === "object" ? JSON.stringify(item.raw_data) : (item.raw_data ?? null),
            sync_timestamp: item.sync_timestamp || Date.now(),
        });
}

/** zCloud items, newest first; optionally one thread's. */
export function getCloudItems(threadId = null, limit = 500) {
    if (!db) throw new Error("Database not initialized");
    return threadId
        ? db
              .prepare("SELECT * FROM cloud_items WHERE threadId = ? ORDER BY timestamp DESC LIMIT ?")
              .all(String(threadId), limit)
        : db.prepare("SELECT * FROM cloud_items ORDER BY timestamp DESC LIMIT ?").all(limit);
}

/** The zCloud backup for one message, if the cloud queue has told us about it. */
export function getCloudItemByMsgId(msgId) {
    if (!db) throw new Error("Database not initialized");
    return db.prepare("SELECT * FROM cloud_items WHERE msgId = ? LIMIT 1").get(String(msgId)) || null;
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
