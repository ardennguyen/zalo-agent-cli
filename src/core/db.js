/**
 * Local SQLite caching layer — zalo.db
 *
 * Isolated per account at: ~/.zalo-agent-cli/accounts/<ownId>/zalo.db
 * Uses WAL mode for concurrent reads while the listener daemon writes.
 * FTS5 virtual table powers instant offline full-text search on messages.
 */

import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./credentials.js";

/** Open database instances keyed by ownId */
const _dbs = new Map();

/**
 * Return the directory for a given account's data.
 * @param {string} ownId
 * @returns {string}
 */
export function accountDir(ownId) {
    return join(CONFIG_DIR, "accounts", ownId);
}

/**
 * Open (or return cached) the SQLite database for a given account.
 * Creates the schema on first use.
 * @param {string} ownId
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(ownId) {
    if (_dbs.has(ownId)) return _dbs.get(ownId);

    const dir = accountDir(ownId);
    mkdirSync(dir, { recursive: true });
    // Owner-only directory permissions (best-effort on Windows)
    try { chmodSync(dir, 0o700); } catch { /* ignore on Windows */ }

    const dbPath = join(dir, "zalo.db");
    const db = new Database(dbPath);

    // Owner-only file permissions (best-effort on Windows)
    try { chmodSync(dbPath, 0o600); } catch { /* ignore on Windows */ }

    // Performance + concurrency settings
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("cache_size = -8000"); // 8 MB page cache

    _migrate(db);

    _dbs.set(ownId, db);
    return db;
}

/**
 * Close a database connection for a given account.
 * @param {string} ownId
 */
export function closeDb(ownId) {
    if (_dbs.has(ownId)) {
        try { _dbs.get(ownId).close(); } catch { /* ignore */ }
        _dbs.delete(ownId);
    }
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

function _migrate(db) {
    db.exec(`
        -- Contacts (friends + self)
        CREATE TABLE IF NOT EXISTS contacts (
            uid          TEXT PRIMARY KEY,
            display_name TEXT,
            zalo_name    TEXT,
            phone        TEXT,
            avatar_url   TEXT,
            is_friend    INTEGER NOT NULL DEFAULT 1,
            last_action  INTEGER NOT NULL DEFAULT 0,
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Groups
        CREATE TABLE IF NOT EXISTS groups (
            gid          TEXT PRIMARY KEY,
            name         TEXT,
            member_count INTEGER NOT NULL DEFAULT 0,
            avatar_url   TEXT,
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Group participant roster
        CREATE TABLE IF NOT EXISTS group_participants (
            gid  TEXT NOT NULL REFERENCES groups(gid) ON DELETE CASCADE,
            uid  TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            PRIMARY KEY (gid, uid)
        );

        -- Chats (per-thread state)
        CREATE TABLE IF NOT EXISTS chats (
            thread_id    TEXT NOT NULL,
            thread_type  INTEGER NOT NULL,  -- 0=DM, 1=Group
            name         TEXT,
            unread_count INTEGER NOT NULL DEFAULT 0,
            is_pinned    INTEGER NOT NULL DEFAULT 0,
            is_archived  INTEGER NOT NULL DEFAULT 0,
            last_msg_id  TEXT,
            last_active  INTEGER NOT NULL DEFAULT 0,
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (thread_id, thread_type)
        );

        -- Messages
        CREATE TABLE IF NOT EXISTS messages (
            msg_id      TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL,
            thread_type INTEGER NOT NULL DEFAULT 0,
            uid_from    TEXT,
            is_self     INTEGER NOT NULL DEFAULT 0,
            msg_type    TEXT,
            content     TEXT,
            timestamp   INTEGER NOT NULL DEFAULT 0,
            saved_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- FTS5 full-text search index on message content
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='rowid',
            tokenize='unicode61'
        );

        -- Keep FTS5 in sync with messages table
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;

        -- Index for fast thread-based lookups
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_contacts_last_action ON contacts(last_action DESC);
    `);
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a message into the database.
 * @param {string} ownId
 * @param {object} msg - { msgId, threadId, threadType, uidFrom, isSelf, msgType, content, timestamp }
 */
export function upsertMessage(ownId, msg) {
    const db = openDb(ownId);
    db.prepare(`
        INSERT INTO messages (msg_id, thread_id, thread_type, uid_from, is_self, msg_type, content, timestamp)
        VALUES (@msgId, @threadId, @threadType, @uidFrom, @isSelf, @msgType, @content, @timestamp)
        ON CONFLICT(msg_id) DO UPDATE SET
            content   = excluded.content,
            timestamp = excluded.timestamp
    `).run({
        msgId:      msg.msgId ?? null,
        threadId:   msg.threadId ?? null,
        threadType: msg.threadType ?? 0,
        uidFrom:    msg.uidFrom ?? null,
        isSelf:     msg.isSelf ? 1 : 0,
        msgType:    msg.msgType ?? null,
        content:    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? null),
        timestamp:  msg.timestamp ?? 0,
    });
}

/**
 * Upsert a contact (friend or self).
 * @param {string} ownId
 * @param {object} contact - { uid, displayName, zaloName, phone, avatarUrl, isFriend, lastAction }
 */
export function upsertContact(ownId, contact) {
    const db = openDb(ownId);
    db.prepare(`
        INSERT INTO contacts (uid, display_name, zalo_name, phone, avatar_url, is_friend, last_action, updated_at)
        VALUES (@uid, @displayName, @zaloName, @phone, @avatarUrl, @isFriend, @lastAction, unixepoch())
        ON CONFLICT(uid) DO UPDATE SET
            display_name = excluded.display_name,
            zalo_name    = excluded.zalo_name,
            phone        = excluded.phone,
            avatar_url   = excluded.avatar_url,
            is_friend    = excluded.is_friend,
            last_action  = excluded.last_action,
            updated_at   = excluded.updated_at
    `).run({
        uid:         contact.uid ?? contact.userId ?? null,
        displayName: contact.displayName ?? null,
        zaloName:    contact.zaloName ?? null,
        phone:       contact.phone ?? null,
        avatarUrl:   contact.avatar ?? null,
        isFriend:    contact.isFriend !== false ? 1 : 0,
        lastAction:  contact.lastAction ?? contact.lastActionTime ?? 0,
    });
}

/**
 * Upsert a group.
 * @param {string} ownId
 * @param {object} group - { gid, name, memberCount, avatarUrl }
 */
export function upsertGroup(ownId, group) {
    const db = openDb(ownId);
    db.prepare(`
        INSERT INTO groups (gid, name, member_count, avatar_url, updated_at)
        VALUES (@gid, @name, @memberCount, @avatarUrl, unixepoch())
        ON CONFLICT(gid) DO UPDATE SET
            name         = excluded.name,
            member_count = excluded.member_count,
            avatar_url   = excluded.avatar_url,
            updated_at   = excluded.updated_at
    `).run({
        gid:         group.gid ?? group.groupId ?? null,
        name:        group.name ?? null,
        memberCount: group.memberCount ?? group.totalMember ?? 0,
        avatarUrl:   group.avatarUrl ?? null,
    });
}

/**
 * Upsert a chat thread state.
 * @param {string} ownId
 * @param {object} chat - { threadId, threadType, name, lastActive }
 */
export function upsertChat(ownId, chat) {
    const db = openDb(ownId);
    db.prepare(`
        INSERT INTO chats (thread_id, thread_type, name, last_active, updated_at)
        VALUES (@threadId, @threadType, @name, @lastActive, unixepoch())
        ON CONFLICT(thread_id, thread_type) DO UPDATE SET
            name        = COALESCE(excluded.name, name),
            last_active = MAX(excluded.last_active, last_active),
            updated_at  = excluded.updated_at
    `).run({
        threadId:   chat.threadId ?? null,
        threadType: chat.threadType ?? 0,
        name:       chat.name ?? null,
        lastActive: chat.lastActive ?? 0,
    });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get recent chats from local cache, sorted by last_active DESC.
 * @param {string} ownId
 * @param {object} opts - { limit, friendsOnly, groupsOnly }
 * @returns {Array}
 */
export function getCachedChats(ownId, opts = {}) {
    const db = openDb(ownId);
    const { limit = 50, friendsOnly = false, groupsOnly = false } = opts;
    let where = "";
    if (friendsOnly) where = "WHERE thread_type = 0";
    else if (groupsOnly) where = "WHERE thread_type = 1";
    return db.prepare(`
        SELECT thread_id, thread_type, name, last_active, unread_count
        FROM chats
        ${where}
        ORDER BY last_active DESC
        LIMIT ?
    `).all(limit);
}

/**
 * Get cached contacts (friends) sorted by last_action DESC.
 * @param {string} ownId
 * @param {object} opts - { limit }
 * @returns {Array}
 */
export function getCachedContacts(ownId, opts = {}) {
    const db = openDb(ownId);
    const { limit = 200 } = opts;
    return db.prepare(`
        SELECT uid, display_name, zalo_name, last_action
        FROM contacts
        WHERE is_friend = 1
        ORDER BY last_action DESC
        LIMIT ?
    `).all(limit);
}

/**
 * Get cached messages for a thread, newest first.
 * @param {string} ownId
 * @param {string} threadId
 * @param {object} opts - { limit, before } (before = max timestamp exclusive)
 * @returns {Array}
 */
export function getCachedMessages(ownId, threadId, opts = {}) {
    const db = openDb(ownId);
    const { limit = 20, before = null } = opts;
    if (before) {
        return db.prepare(`
            SELECT * FROM messages
            WHERE thread_id = ? AND timestamp < ?
            ORDER BY timestamp DESC LIMIT ?
        `).all(threadId, before, limit);
    }
    return db.prepare(`
        SELECT * FROM messages
        WHERE thread_id = ?
        ORDER BY timestamp DESC LIMIT ?
    `).all(threadId, limit);
}

/**
 * Full-text search across all cached messages.
 * @param {string} ownId
 * @param {string} query - FTS5 query string
 * @param {object} opts - { limit, threadId }
 * @returns {Array}
 */
export function searchMessages(ownId, query, opts = {}) {
    const db = openDb(ownId);
    const { limit = 20, threadId = null } = opts;
    if (threadId) {
        return db.prepare(`
            SELECT m.* FROM messages m
            JOIN messages_fts f ON m.rowid = f.rowid
            WHERE messages_fts MATCH ? AND m.thread_id = ?
            ORDER BY rank
            LIMIT ?
        `).all(query, threadId, limit);
    }
    return db.prepare(`
        SELECT m.* FROM messages m
        JOIN messages_fts f ON m.rowid = f.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
    `).all(query, limit);
}

/**
 * Return true if the database for this account already exists (i.e. has been seeded).
 * @param {string} ownId
 * @returns {boolean}
 */
export function dbExists(ownId) {
    return existsSync(join(accountDir(ownId), "zalo.db"));
}
