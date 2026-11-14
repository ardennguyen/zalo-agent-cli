/**
 * A second connection to an account's zalo.db, keyed like initDb's and with the row-MAC function registered, for a
 * test that writes rows the way an older version did. Without the function the MAC triggers refuse every message
 * write (src/core/row-mac.js), which is the point of them, so a test that means to bypass the app's writers but not
 * the tamper evidence opens its connection here.
 */
import { dirname, resolve } from "node:path";
import { deriveDataKey, scopeOfDir } from "../../../src/core/keystore/keyring.js";
import { registerRowMacFunction } from "../../../src/core/row-mac.js";
import { openDatabase } from "../../../src/core/sqlite.js";

/**
 * @param {string} file - `accounts/<ownId>/zalo.db`
 * @returns {import("better-sqlite3-multiple-ciphers").Database}
 */
export function openRawWriter(file) {
    const db = openDatabase(file);
    registerRowMacFunction(db, deriveDataKey(scopeOfDir(dirname(resolve(file))), "row-mac").key);
    return db;
}
