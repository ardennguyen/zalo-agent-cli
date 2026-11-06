/**
 * Intended differences between zca-js and our engine for the models area: one row per difference, each also recorded
 * in golden/models.js. Owned by package L1; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 */

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function}>} */
export default [];
