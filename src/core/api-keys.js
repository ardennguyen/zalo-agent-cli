/**
 * Named API keys of one account: bearer credentials for its MCP HTTP server beside the single deploy token
 * (`ZALO_MCP_AUTH_TOKEN[_<ownId>]`, which keeps working as the legacy key).
 *
 * - **At rest only a hash.** `<accountDir>/api-keys.json`, sealed under the boot key (the controller and the daemon
 *   read it without a login), holds per key its id, label, SHA-256, when it was made and when it ends. The key itself
 *   (`zak_<id>_<secret>`) is returned once, by {@link createApiKey}, and never again.
 * - **Live.** A daemon checks a presented key against the file as it is now (re-read when it changes), so a key made
 *   or revoked through the fleet controller counts at once, without a restart.
 * - **Revoke** removes the record: the key stops working at the next request. An expired key is refused and listed as
 *   `expired` until it is revoked.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSealedJson, scopeOfDir, writeSealedJson } from "./keystore/index.js";

/** The file in the account folder. */
export const API_KEYS_FILE = "api-keys.json";
/** The most keys one account keeps. */
export const MAX_API_KEYS = 50;
const SPEC = Object.freeze({ kind: "api-keys", use: "boot" });
const KEY_SHAPE = /^zak_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const LABEL_MAX = 64;

const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

/** A refused key operation: `code` is API_KEY_INVALID, API_KEY_NOT_FOUND or API_KEY_LIMIT. */
export class ApiKeyError extends Error {
    /**
     * @param {string} message
     * @param {string} code
     */
    constructor(message, code) {
        super(message);
        this.name = "ApiKeyError";
        this.code = code;
    }
}

/** @param {string} accountDir @returns {string} */
export function apiKeysFile(accountDir) {
    return join(accountDir, API_KEYS_FILE);
}

function readKeys(accountDir) {
    const file = apiKeysFile(accountDir);
    if (!existsSync(file)) return [];
    const doc = readSealedJson(file, scopeOfDir(accountDir), SPEC);
    return Array.isArray(doc?.keys) ? doc.keys : [];
}

function writeKeys(accountDir, keys) {
    writeSealedJson(apiKeysFile(accountDir), scopeOfDir(accountDir), SPEC, { v: 1, keys });
}

/** One record as it is shown: never the hash. */
function view(k, now) {
    return {
        keyId: k.id,
        label: k.label,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt ?? null,
        expired: Boolean(k.expiresAt && Date.parse(k.expiresAt) <= now),
    };
}

/**
 * The account's keys, oldest first (ids, labels and dates only).
 *
 * @param {string} accountDir
 * @param {{now?: number}} [opts]
 * @returns {Array<{keyId: string, label: string, createdAt: string, expiresAt: string|null, expired: boolean}>}
 */
export function listApiKeys(accountDir, { now = Date.now() } = {}) {
    return readKeys(accountDir).map((k) => view(k, now));
}

/**
 * Make a key. The key is in the answer once; only its SHA-256 is kept.
 *
 * @param {string} accountDir
 * @param {{label?: unknown, expiresAt?: unknown, now?: number}} [opts] - `expiresAt`: an ISO time in the future, or null
 * @returns {{keyId: string, label: string, createdAt: string, expiresAt: string|null, expired: false, key: string}}
 * @throws {ApiKeyError}
 */
export function createApiKey(accountDir, { label = "", expiresAt = null, now = Date.now() } = {}) {
    const name = String(label ?? "").trim();
    if (!name || name.length > LABEL_MAX || [...name].some((c) => c.charCodeAt(0) < 32))
        throw new ApiKeyError(`label must be 1 to ${LABEL_MAX} printable characters`, "API_KEY_INVALID");
    let ends = null;
    if (expiresAt !== null && expiresAt !== undefined && expiresAt !== "") {
        const t = Date.parse(String(expiresAt));
        if (!Number.isFinite(t) || t <= now)
            throw new ApiKeyError("expiresAt must be an ISO time in the future", "API_KEY_INVALID");
        ends = new Date(t).toISOString();
    }
    const keys = readKeys(accountDir);
    if (keys.length >= MAX_API_KEYS)
        throw new ApiKeyError(`an account keeps at most ${MAX_API_KEYS} API keys: revoke one first`, "API_KEY_LIMIT");
    const id = randomBytes(6).toString("hex");
    const key = `zak_${id}_${randomBytes(32).toString("base64url")}`;
    const rec = { id, label: name, sha256: sha256(key), createdAt: new Date(now).toISOString(), expiresAt: ends };
    writeKeys(accountDir, [...keys, rec]);
    return { ...view(rec, now), expired: false, key };
}

/**
 * Revoke a key: it stops working at the next request.
 *
 * @param {string} accountDir
 * @param {string} keyId
 * @returns {{keyId: string, revoked: true}}
 * @throws {ApiKeyError} API_KEY_NOT_FOUND
 */
export function revokeApiKey(accountDir, keyId) {
    const keys = readKeys(accountDir);
    const left = keys.filter((k) => k.id !== keyId);
    if (left.length === keys.length) throw new ApiKeyError(`no API key ${keyId} on this account`, "API_KEY_NOT_FOUND");
    writeKeys(accountDir, left);
    return { keyId, revoked: true };
}

/**
 * Revoke every key of the account.
 *
 * @param {string} accountDir
 * @returns {number} how many there were
 */
export function revokeAllApiKeys(accountDir) {
    const keys = readKeys(accountDir);
    if (keys.length) writeKeys(accountDir, []);
    return keys.length;
}

/**
 * A checker for one account's server: whether a bearer token is one of its live keys. The file is re-read when it
 * changes (size or time), so a key made or revoked elsewhere counts at the next request. A file that cannot be read
 * admits no key.
 *
 * @param {string|null} accountDir
 * @param {{now?: () => number, log?: (line: string) => void}} [opts]
 * @returns {{verify: (token: string) => boolean, identify: (token: string) => {keyId: string, label: string}|null,
 *   any: () => boolean}}
 */
export function createApiKeyChecker(accountDir, { now = Date.now, log = (l) => console.error(l) } = {}) {
    let seen = null;
    let keys = [];
    const load = () => {
        if (!accountDir) return [];
        let st = null;
        try {
            st = statSync(apiKeysFile(accountDir));
        } catch {
            seen = null;
            keys = [];
            return keys;
        }
        const mark = `${st.mtimeMs}:${st.size}`;
        if (mark !== seen) {
            try {
                keys = readKeys(accountDir);
            } catch (e) {
                log(`[api-keys] ${apiKeysFile(accountDir)} cannot be read (${e.message}); no API key is accepted`);
                keys = [];
            }
            seen = mark;
        }
        return keys;
    };
    /** The live key a token is (its id and label), or null. */
    const identify = (token) => {
        const m = KEY_SHAPE.exec(String(token ?? ""));
        if (!m) return null;
        const rec = load().find((k) => k.id === m[1]);
        if (!rec) return null;
        if (rec.expiresAt && Date.parse(rec.expiresAt) <= now()) return null;
        const a = Buffer.from(sha256(token), "hex");
        const b = Buffer.from(String(rec.sha256), "hex");
        return a.length === b.length && timingSafeEqual(a, b) ? { keyId: rec.id, label: rec.label } : null;
    };
    return {
        verify(token) {
            return identify(token) !== null;
        },
        identify,
        any: () => load().some((k) => !k.expiresAt || Date.parse(k.expiresAt) > now()),
    };
}
