/**
 * One way to read a JSON argument or option, for every `oa` and `zbs` command that takes JSON.
 *
 * Accepted forms:
 * - inline JSON: the value starts with `{` or `[`;
 * - `@path`: the JSON is read from that file;
 * - anything else is taken as the path of a JSON file.
 *
 * A UTF-8 byte-order mark (as some Windows editors save) is dropped before parsing.
 */

import fs from "node:fs";
import { resolve } from "node:path";

/**
 * Read a JSON value given inline, as `@file`, or as a file path.
 *
 * @param {string} value - the argument or option as typed
 * @param {string} [what] - what it is, for the error message (e.g. "template_data", "--data")
 * @returns {any} the parsed JSON
 * @throws {Error} when the file cannot be read or the text is not JSON; the message names `what` and the source
 */
export function readJsonInput(value, what = "JSON") {
    const s = String(value ?? "").trim();
    let text = s;
    let source = "inline";
    if (!s.startsWith("{") && !s.startsWith("[")) {
        const path = s.startsWith("@") ? s.slice(1) : s;
        try {
            text = fs.readFileSync(resolve(path), "utf8");
            source = path;
        } catch {
            throw new Error(`${what}: not inline JSON and no such file: ${path}`);
        }
    }
    try {
        return JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
        throw new Error(`${what} (${source}) is not valid JSON: ${e.message}`);
    }
}
