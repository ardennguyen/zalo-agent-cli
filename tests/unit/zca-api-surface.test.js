/**
 * Every `getApi().<method>()` in src/ must name a method zca-js actually has.
 *
 * `conv unread` called `getApi().markAsUnread(...)` for its whole life. zca-js
 * has never had that method -- it is `addUnreadMark`, paired with
 * `removeUnreadMark` and `getUnreadMark` -- so the command died on "is not a
 * function" before reaching the network, every time.
 *
 * Nothing caught it, and nothing could: the offline suite never builds a real
 * API object, and the live suite only exercises the commands someone thought
 * to include. A typo'd or renamed method is invisible until a person runs that
 * one command against a real session.
 *
 * So check it statically instead. zca-js assembles its surface in
 * `dist/apis.js` as a flat list of `this.<name> = <name>Factory(ctx, this)`,
 * which is exactly the set of names a caller may use. Upgrading zca-js and
 * losing a method now fails the build rather than one command at runtime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const APIS = join(ROOT, "node_modules", "zca-js", "dist", "apis.js");

/** Every method name the zca-js API object exposes. */
function zcaMethods() {
    const src = readFileSync(APIS, "utf8");
    const names = new Set();
    for (const m of src.matchAll(/^\s*this\.(\w+)\s*=/gm)) names.add(m[1]);
    // Set directly rather than through a factory, so the regex above finds them.
    names.add("listener");
    return names;
}

/** Every `getApi().<name>(` this repo performs, with where it is. */
function callSites() {
    const found = [];
    for (const dir of ["commands", "core", "mcp", "utils"]) {
        const base = join(ROOT, "src", dir);
        let entries = [];
        try {
            entries = readdirSync(base).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
        } catch {
            continue; // directory may not exist in a trimmed checkout
        }
        for (const f of entries) {
            const text = readFileSync(join(base, f), "utf8");
            text.split("\n").forEach((line, i) => {
                for (const m of line.matchAll(/getApi\(\)\s*\.\s*(\w+)/g)) {
                    found.push({ name: m[1], where: `src/${dir}/${f}:${i + 1}` });
                }
            });
        }
    }
    return found;
}

describe("zca-js API surface", () => {
    it("exposes a surface this test can actually read", () => {
        const methods = zcaMethods();
        // A parse that silently found nothing would make every assertion below
        // vacuously pass, which is the one failure mode that matters here.
        assert.ok(methods.size > 100, `expected zca-js to expose many methods, parsed ${methods.size}`);
        assert.ok(methods.has("addUnreadMark"), "sanity: the method conv unread should have been calling");
        assert.ok(methods.has("sendMessage"), "sanity: sendMessage");
    });

    it("finds the call sites it is meant to police", () => {
        const calls = callSites();
        assert.ok(calls.length > 20, `expected many getApi() call sites, found ${calls.length}`);
    });

    it("calls no method zca-js does not have", () => {
        const methods = zcaMethods();
        const bad = callSites().filter((c) => !methods.has(c.name));
        assert.deepEqual(
            bad,
            [],
            "these call a method zca-js does not expose:\n" + bad.map((b) => `  ${b.where} -> ${b.name}()`).join("\n"),
        );
    });

    it("does not call markAsUnread, which never existed", () => {
        // Named explicitly so the regression reads as itself in a failure.
        const bad = callSites().filter((c) => c.name === "markAsUnread");
        assert.deepEqual(bad, []);
    });
});
