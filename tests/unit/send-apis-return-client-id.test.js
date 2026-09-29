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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(import.meta.dirname, "..", "..", "node_modules", "zca-js", "dist", "apis");

/**
 * Sends that carry no client-generated id, so there is nothing to give back.
 *
 * Keep this list SHORT and justified. A file belongs here only when it
 * genuinely has no id to return — never to silence a real gap.
 */
const NO_CLIENT_ID = {
    "sendFriendRequest.js": "a friend request is not a message and has no cliMsgId",
    "sendReport.js": "a report is not a message",
    "sendTypingEvent.js": "a typing indicator is ephemeral and is never recalled",
    // These two ACK somebody else's message. They take a cliMsgId as INPUT
    // rather than generating one, so there is nothing of ours to return.
    "sendDeliveredEvent.js": "acks another message; takes its cliMsgId as input",
    "sendSeenEvent.js": "acks another message; takes its cliMsgId as input",
};

/** Every `send*.js` zca-js ships. */
function sendApiFiles() {
    const files = readdirSync(API_DIR).filter((f) => /^send.*\.js$/.test(f));
    assert.ok(files.length >= 10, `expected zca-js to ship a set of send APIs, found ${files.length}`);
    return files;
}

describe("zca-js send APIs return the id needed to recall the message", () => {
    it("reads the shipped API directory at all", () => {
        // Guards the guard: if the path drifts, every assertion below would
        // vacuously pass over an empty list.
        assert.ok(sendApiFiles().includes("sendMessage.js"));
    });

    for (const file of sendApiFiles()) {
        const why = NO_CLIENT_ID[file];

        it(`${file} ${why ? "is exempt, and stays exempt for the stated reason" : "gives the client id back"}`, () => {
            const src = readFileSync(join(API_DIR, file), "utf8");

            // The wire side: does this endpoint send an id it invented?
            // `clientId` is the usual spelling; sendBankCard.js calls the
            // same thing `cliMsgId` in its params. Match both the hoisted
            // form the patch introduces and the inline `Date.now()` upstream
            // uses, since a file can legitimately be in either state —
            // sendVideo.js hoists and then writes `String(clientId)`.
            const generates =
                /\b(?:const|let)\s+(?:clientId|cliMsgId)\s*=\s*Date\.now\(\)/.test(src) ||
                /\b(?:clientId|cliMsgId)\s*:\s*Date\.now\(\)/.test(src);

            if (why) {
                assert.equal(
                    generates,
                    false,
                    `${file} is on the exemption list (${why}) but now generates a client id — ` +
                        `remove it from NO_CLIENT_ID and make it stamp the response`,
                );
                return;
            }

            assert.ok(generates, `${file} was expected to put a client-generated id on the wire but does not`);

            // Check the CALL, not the definition. `stampClientId`'s body is
            // literally `response.cliMsgId = String(clientId)`, so matching
            // that against the whole file passes on a file whose helper is
            // present but never invoked — which is exactly the state a
            // half-applied patch leaves behind. Verified by deleting a call
            // site: the naive version of this assertion stayed green.
            const withoutHelper = src.replace(/function stampClientId[\s\S]*?\n}\n/, "");
            assert.match(
                withoutHelper,
                /\bstampClientId\s*\(/,
                `${file} generates a client id and never returns it, so a message sent through it ` +
                    `cannot be recalled — see patches/zca-js+2.2.0.patch`,
            );
        });
    }
});
