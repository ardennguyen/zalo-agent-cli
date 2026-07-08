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
      raw_data TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      threadId TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      lastUpdate INTEGER
    );

    CREATE TABLE IF NOT EXISTS contacts (
      userId TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT
    );
  `);

    return db;
}

export function insertMessage(msg) {
    if (!db) throw new Error("Database not initialized");

    const stmt = db.prepare(`
    INSERT INTO messages (msgId, threadId, senderId, senderName, text, timestamp, type, raw_data)
    VALUES (@msgId, @threadId, @senderId, @senderName, @text, @timestamp, @type, @raw_data)
    ON CONFLICT(msgId) DO UPDATE SET
      text = excluded.text,
      timestamp = excluded.timestamp,
      type = excluded.type,
      raw_data = excluded.raw_data
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

export function getRecentThreads(limit = 20) {
    if (!db) throw new Error("Database not initialized");
    return db.prepare("SELECT * FROM threads ORDER BY lastUpdate DESC LIMIT ?").all(limit);
}

export function upsertThread(thread) {
    if (!db) throw new Error("Database not initialized");

    const stmt = db.prepare(`
    INSERT INTO threads (threadId, type, name, lastUpdate)
    VALUES (@threadId, @type, @name, @lastUpdate)
    ON CONFLICT(threadId) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      lastUpdate = excluded.lastUpdate
  `);

    return stmt.run({
        threadId: thread.threadId,
        type: thread.type,
        name: thread.name,
        lastUpdate: thread.lastUpdate,
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
