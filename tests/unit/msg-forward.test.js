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
 *
 * Text no longer goes through zca-js's forwardMessage at all: it now carries
 * the reference Zalo Web sends, which forwardMessage cannot serialize
 * correctly (it hardcodes the decorLog's `st`), so it is a custom call in
 * src/core/forward.js. The guards that pinned forwardMessage's call shape --
 * and the one that insisted the reference be omitted -- are replaced by
 * tests/unit/msg-forward-reference.test.js, which asserts the decrypted
 * request itself: the message, the target list, the reference and decorLog.
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

describe("msg forward reads the cache and dispatches by kind", () => {
    it("reads the message out of the local cache", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(/getMessageById\s*\(/.test(block), "the text to forward has to come from somewhere");
        assert.ok(/import\s*\{[^}]*getMessageById[^}]*\}\s*from\s*"\.\.\/core\/db\.js"/.test(MSG_CODE));
    });

    it("dispatches on the row's classified type, not on typeof text", () => {
        const block = forwardBlock(MSG_CODE);
        // Only text rides the mforward API; every other kind is re-sent as a
        // message of its own type, the way the app does it.
        assert.ok(/kind\s*!==\s*"text"/.test(block), "non-text kinds take the re-send path, not mforward");
        assert.ok(/forwarders\s*\[/.test(block) || /const forwarders/.test(block), "there is a per-kind dispatch");
        // A synced photo/file/sticker stores a human placeholder ("[Hình ảnh]",
        // "[File] x.pdf") in the text column. A typeof check passes that
        // straight through and forwards the placeholder as if it were the media.
        assert.ok(
            !/typeof\s+(row\.text|text)\s*===\s*"string"/.test(block),
            "a typeof-string check would forward a placeholder and call it a photo",
        );
    });

    it("covers the kinds that have a re-send path, and refuses the rest", () => {
        const block = forwardBlock(MSG_CODE);
        // Verified live 2026-09-28, one message per kind into a disposable group.
        for (const kind of ["card", "sticker", "link", "video", "voice", "photo", "file", "gif", "doodle"]) {
            assert.ok(new RegExp(`\\b${kind}\\s*:`).test(block), `no forwarder for "${kind}"`);
        }
        // A shared contact arrives classified as a link; only its action says
        // otherwise, so the dispatch has to read the action.
        assert.ok(/recommened\.user/.test(block), "a shared contact must route to sendCard, not sendLink");
        // Location has no send API in zca-js, so it must refuse rather than
        // pretend. The generic "no send path" branch covers it.
        assert.ok(/no send path reproduces it/.test(MSG_SRC), "unsupported kinds must say so");
    });

    it("uploads through the daemon rather than its own socket", () => {
        const block = forwardBlock(MSG_CODE);
        // api.sendMessage with attachments parks the send in ctx.uploadCallbacks
        // and only a listener settles it. With a daemon holding the account's one
        // socket, a direct call hangs forever — measured at four minutes, no
        // result, no error. sendAttachments hands it to the daemon first.
        assert.ok(/sendAttachments\s*\(/.test(block), "attachment re-sends go through sendAttachments");
        assert.ok(
            !/api\.sendMessage\(\s*\{\s*msg:\s*""\s*,\s*attachments/.test(block),
            "a direct sendMessage upload hangs when a daemon holds the socket",
        );
    });

    it("surfaces per-target rejections instead of reporting success", () => {
        const block = forwardBlock(MSG_CODE);
        assert.ok(/\.fail\b/.test(block), "the API answers with { success: [], fail: [] } — fail must be read");
    });
});
