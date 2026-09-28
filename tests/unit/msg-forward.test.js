/**
 * `msg forward` shipped calling zca-js with the wrong arity, so it threw
 * "Missing message content" on every invocation -- every message type, both
 * thread types -- before it ever reached the network. The zca-api-surface
 * test did not catch it: `forwardMessage` exists, only the call shape was
 * wrong. These guards are about the shape.
 *
 * Verified live 2026-09-28 after the fix: text to a group and text to a DM
 * both returned a msgId with an empty `fail` array; photo, file, sticker and
 * link were each refused locally with no network call.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const MSG_SRC = readFileSync(join(SRC_DIR, "commands", "msg.js"), "utf8");

/** Source with comments stripped: these guards must read code, not prose. */
const MSG_CODE = MSG_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The body of the `forward` command, bounded by the next `msg.command(`. */
function forwardBlock(src) {
    const begin = src.indexOf('msg.command("forward');
    assert.notEqual(begin, -1, "forward command not found — this guard has drifted");
    const next = src.indexOf("msg.command(", begin + 10);
    return src.slice(begin, next === -1 ? src.length : next);
}

describe("msg forward calls zca-js the way zca-js is declared", () => {
    it("passes a payload object, not the bare msgId", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(
            /forwardMessage\(\s*\{\s*message:/.test(block),
            "first argument must be `{ message: ... }` — a bare msgId trips `if (!payload.message) throw`",
        );
        assert.ok(!/forwardMessage\(\s*msgId\b/.test(block), "passing msgId as the payload is the original defect");
    });

    it("passes the thread list as an array", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(
            /forwardMessage\([^)]*,\s*\[\s*threadId\s*\]/.test(block),
            "second argument is `threadIds: string[]`; a bare string breaks `threadIds.map`",
        );
    });

    it("reads the message out of the local cache", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(/getMessageById\s*\(/.test(block), "the text to forward has to come from somewhere");
        assert.ok(/import\s*\{[^}]*getMessageById[^}]*\}\s*from\s*"\.\.\/core\/db\.js"/.test(MSG_CODE));
    });

    it("gates on the row's classified type, not on typeof text", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(/row\.type\s*!==\s*"text"/.test(block), "only text can ride in a string payload");
        // A synced photo/file/sticker stores a human placeholder ("[Hình ảnh]",
        // "[File] x.pdf") in the text column. A typeof check passes that
        // straight through and forwards the placeholder as if it were the media.
        assert.ok(
            !/typeof\s+(row\.text|text)\s*===\s*"string"/.test(block),
            "a typeof-string check would forward a placeholder and call it a photo",
        );
    });

    it("does not fabricate the forwarded-from reference", () => {
        const block = forwardBlock(MSG_CODE);
        // Real forwards carry an opaque 32-hex id plus logSrcType/fwLvl. That id
        // is not the numeric msgId and nothing in the cache holds it, so a
        // reference built from what we have would point at nothing.
        assert.ok(!/reference\s*:/.test(block), "omit `reference` rather than send a wrong one");
    });

    it("surfaces per-target rejections instead of reporting success", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(/\.fail\b/.test(block), "the API answers with { success: [], fail: [] } — fail must be read");
    });
});
