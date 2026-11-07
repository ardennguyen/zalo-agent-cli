/**
 * The one SQLite driver of the app: `better-sqlite3-multiple-ciphers`, a fork of `better-sqlite3` with the same API
 * (it adds `key` / `rekey`) and the SQLite3MultipleCiphers build of SQLite, so a database can be encrypted at rest.
 *
 * Every module and test that opens a SQLite file imports the driver from here, never the package by name, so the
 * driver and the way a database is opened change in one place.
 */
import Database from "better-sqlite3-multiple-ciphers";

export { Database };
export default Database;
