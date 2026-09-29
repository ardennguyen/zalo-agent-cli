/**
 * Every zca-js send API that puts a client-generated id on the wire must
 * hand that id back.
 *
 * `msg undo` and `msg delete` both REQUIRE a cliMsgId, and nothing derives
 * one from a msgId — only the sender ever saw it. An API that generates the
 * id, posts it, and then returns only `{msgId}` produces a message that can
 * be sent and never recalled.
 *
 * This is not hypothetical and it was not caught by reading the code. A live
 * tier-4 run on 2026-09-29 recalled 41 of 44 messages and left three in the
 * group — a link, a sticker and a contact card — each refusing with
 * "cliMsgId is required to recall a message and is not in the local cache".
 * Attachments had already been fixed the same day after the same failure
 * stranded 24 of them, two in a real person's DM.
 *
 * `tests/unit/send-client-id.test.js` proves the behaviour properly for
 * `sendMessage`, by decrypting the request body and comparing. That approach
 * needs a bespoke transport harness per factory, so it does not scale to
 * every send API. This test takes the cheaper, broader angle instead: it
 * reads the shipped sources and asserts the shape of the fix is present in
 * each one. It cannot prove the stamped value is CORRECT — only that the
 * file still tries. The two tests are complements, not substitutes.
 *
 * What makes it worth having is that it generalises: a zca-js bump that
 * drops the patch, or a brand-new `sendFoo.js` that nobody thought to stamp,
 * fails here without anyone remembering to add a case.
 *
 * SCOPE: the ESM build (`dist/apis`), which is the tree this package
 * actually loads — we are `"type": "module"` and import zca-js by ESM
 * specifier everywhere, so Node resolves the `"default"` condition.
 *
 * zca-js also ships a parallel CJS tree at `dist/cjs/apis/*.cjs`, and its
 * exports map sends `require()` there. That tree was deliberately left
 * unpatched until 2026-09-29, on the reasoning that we can never load it.
 * It is now patched to parity instead: a library that ships two entry
 * points should not have one that works and one that silently lacks the
 * four methods and every client-id stamp. The last block below pins both
 * halves — that we still take the `default` condition, and that the CJS
 * tree really is patched rather than assumed to be.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(import.meta.dirname, "..", "..", "node_modules", "zca-js", "dist", "apis");

/**
 * Sends that carry no client-generated id, so there is nothing to give back.
 *
 * Keep this list SHORT and justified. A file belongs here only when it
 * genuinely has no id to return — never to silence a real gap.
 */
const NOT_A_RECALLABLE_MESSAGE = {
    // Not messages at all.
    "sendFriendRequest.js": "a friend request is not a message and has no cliMsgId",
    "sendReport.js": "a report is not a message",
    "sendTypingEvent.js": "a typing indicator is ephemeral and is never recalled",
    "createGroup.js": "creates a group; the system event it produces is not ours to recall",
    // These CONSUME somebody else's cliMsgId rather than minting one of ours.
    "sendDeliveredEvent.js": "acks another message; takes its cliMsgId as input",
    "sendSeenEvent.js": "acks another message; takes its cliMsgId as input",
    "deleteMessage.js": "this IS the removal path; it consumes a cliMsgId",
    "undo.js": "this IS the recall path; it consumes a cliMsgId",
    "addReaction.js": "a reaction is removed by re-reacting with none, not by undo",
    "addUnreadMark.js": "a read-state marker, not a message",
    "deleteChat.js": "removes a conversation; consumes a cliMsgId",
    // Avatar uploads. Their `clientId` is an upload dedup key built from a
    // uid and a formatted time (`g<groupId>17:05 29/09/2026`), not a message
    // id at all -- a group avatar change surfaces as a system event, which
    // is not ours to undo. Surfaced by widening this guard past `send*`.
    "changeAccountAvatar.js": "uploads an avatar; its clientId is an upload key, not a message id",
    "changeGroupAvatar.js": "uploads a group avatar; the result is a system event, not our message",
    // Sub-steps of sendMessage: the id that matters is stamped there.
    "uploadAttachment.js": "an upload step; sendMessage stamps the resulting message",
    "uploadProductPhoto.js": "an upload step, not a send",
};

/**
 * Every API file zca-js ships.
 *
 * Deliberately NOT just `send*.js`. forwardMessage.js produces a perfectly
 * ordinary message, mints a clientId for it and threw it away — and a
 * `send*` filter walked straight past it. The file was only found because a
 * forwarded message turned out to be unrecallable by hand.
 */
function apiFiles() {
    const files = readdirSync(API_DIR).filter((f) => f.endsWith(".js"));
    assert.ok(files.length >= 20, `expected zca-js to ship a set of APIs, found ${files.length}`);
    return files;
}

/**
 * Whether a file puts a client-generated id into its request params.
 *
 * Matches the key form (`clientId: …`) and the shorthand (`clientId,`),
 * because forwardMessage.js does `const clientId = timestamp.toString()`
 * and then uses shorthand — which a `= Date.now()` pattern misses entirely.
 * That miss is the whole reason this helper exists rather than a regex
 * inline at the call site.
 *
 * @param {string} src
 * @returns {boolean}
 */
function mintsClientId(src) {
    return /\b(?:clientId|cliMsgId)\s*[,:]/.test(src);
}

describe("zca-js APIs return the id needed to recall the message", () => {
    it("reads the shipped API directory at all", () => {
        // Guards the guard: if the path drifts, every assertion below would
        // vacuously pass over an empty list.
        assert.ok(apiFiles().includes("sendMessage.js"));
        assert.ok(apiFiles().includes("forwardMessage.js"), "the file a send-only filter used to miss");
    });

    for (const file of apiFiles()) {
        const why = NOT_A_RECALLABLE_MESSAGE[file];
        const mints = mintsClientId(readFileSync(join(API_DIR, file), "utf8"));

        // Only files that actually mint an id have anything to prove. The
        // rest -- getters, group admin, settings -- are silently fine.
        if (!mints && !why) continue;

        it(`${file} ${why ? "is exempt, and stays exempt for the stated reason" : "gives the client id back"}`, () => {
            const src = readFileSync(join(API_DIR, file), "utf8");

            if (why) {
                // Nothing to assert about an exempt file's stamping, but DO
                // keep the list honest: an entry for a file that no longer
                // exists is dead weight that hides a rename.
                assert.ok(
                    existsSync(join(API_DIR, file)),
                    `${file} is on the exemption list but zca-js no longer ships it`,
                );
                return;
            }

            // Check the CALL, not the definition. `stampClientId`'s body is
            // literally `response.cliMsgId = String(clientId)`, so matching
            // that against the whole file passes on a file whose helper is
            // present but never invoked -- exactly the state a half-applied
            // patch leaves behind. Verified by deleting a call site: the
            // naive version of this assertion stayed green.
            const withoutHelper = src.replace(/function stampClientId[\s\S]*?\n}\n/, "");
            assert.match(
                withoutHelper,
                /\bstampClientId\s*\(/,
                `${file} puts a client-generated id on the wire and never returns it, so a message ` +
                    `sent through it cannot be recalled -- see patches/zca-js+2.2.0.patch. If it does ` +
                    `not produce a recallable message, add it to NOT_A_RECALLABLE_MESSAGE with a reason.`,
            );
        });
    }
});

describe("the ESM-only scope of that guard is still justified", () => {
    const PKG_ROOT = join(import.meta.dirname, "..", "..");

    it("this package is ESM, so `require` never resolves", () => {
        const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
        assert.equal(
            pkg.type,
            "module",
            'this package stopped being "type": "module", so zca-js may now resolve through its ' +
                "CJS build — which carries none of patches/zca-js+2.2.0.patch",
        );
    });

    it("nothing in src/ reaches zca-js through require()", () => {
        // zca-js's exports map is {"require": "./dist/cjs/index.cjs",
        // "default": "./dist/index.js"}. A single require() anywhere in the
        // shipped code pulls in the UNPATCHED tree, where every send API
        // still swallows the client id and the four methods `logout` and
        // `account remove` depend on do not exist at all.
        const offenders = [];
        const walk = (dir) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(js|cjs|mjs)$/.test(e.name)) {
                    if (/require\(\s*["'`]zca-js/.test(readFileSync(p, "utf8"))) offenders.push(p);
                }
            }
        };
        walk(join(PKG_ROOT, "src"));
        assert.deepEqual(offenders, [], "these files would load the unpatched CJS build of zca-js");
    });

    it("the CJS tree is patched to parity, not left behind", () => {
        // The inverse of what this asserted until 2026-09-29, exactly as the
        // note here anticipated. zca-js's exports map sends require() to the
        // CJS build, so anything that reaches it must get the same stamping
        // the ESM tree has. If a zca-js bump drops the CJS half of
        // patches/zca-js+2.2.0.patch, the two trees diverge and this fails.
        const esmDir = join(PKG_ROOT, "node_modules", "zca-js", "dist", "apis");
        const cjsDir = join(esmDir, "..", "cjs", "apis");
        if (!existsSync(cjsDir)) return; // upstream dropped the dual build

        // "Patched" means the helper is DEFINED *and* CALLED. Matching only
        // `response.cliMsgId =` would match the helper's own body, so a file
        // whose call site was deleted would still look patched — mutation
        // testing caught exactly that. The definition contributes one
        // occurrence, so a real call means two or more.
        const stamped = (dir, ext) =>
            readdirSync(dir)
                .filter((f) => {
                    if (!f.endsWith(ext)) return false;
                    const src = readFileSync(join(dir, f), "utf8");
                    return (src.match(/stampClientId\(/g) || []).length >= 2;
                })
                .map((f) => f.slice(0, -ext.length))
                .sort();

        const cjsStamped = stamped(cjsDir, ".cjs");
        const missing = stamped(esmDir, ".js").filter((n) => !cjsStamped.includes(n));
        assert.deepEqual(missing, [], "these APIs stamp the client id in the ESM build but not the CJS one");
    });
    it("both builds expose the same API surface, so a require() caller is not missing methods", () => {
        // The call-shape half. Patching the CJS files is not enough on its
        // own: the added factories must also be wired onto the API class in
        // the CJS barrel, or require("zca-js") returns an object that
        // silently lacks logoutV2 and the rest while every file looks patched.
        const dist = join(PKG_ROOT, "node_modules", "zca-js", "dist");
        if (!existsSync(join(dist, "cjs", "apis.cjs"))) return; // upstream dropped the dual build
        const surface = (f) => [...readFileSync(f, "utf8").matchAll(/^\s*this\.(\w+) = /gm)].map((m) => m[1]).sort();
        const esm = surface(join(dist, "apis.js"));
        const cjs = surface(join(dist, "cjs", "apis.cjs"));
        assert.ok(esm.length > 100, "the ESM barrel stopped looking like an API class -- has zca-js restructured?");
        assert.deepEqual(
            esm.filter((n) => !cjs.includes(n)),
            [],
            "require('zca-js') would hand back an API object missing these methods",
        );
        assert.deepEqual(
            cjs.filter((n) => !esm.includes(n)),
            [],
            "the CJS build exposes methods the ESM build does not -- the two have drifted",
        );
    });
});
