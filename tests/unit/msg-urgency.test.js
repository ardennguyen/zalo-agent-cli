/**
 * `msg send --urgency important|urgent` marks a message the way the apps do.
 *
 * Zalo sends "Important" and "Urgent" as `metaData: {urgency: 1}` and
 * `metaData: {urgency: 2}` on the ordinary text endpoints, group and 1-1 alike
 * (captures group.A15_important_msg, group.A15b_urgent_msg, dm.D15, dm.D18).
 * The send already builds exactly that object
 * from `sendMessage({msg, urgency})` (`handleUrgency`); the CLI had no way to
 * ask for it.
 *
 * Each test drives the real CLI offline (in the in-process worker, re-run as a real
 * child when a check fails: support/offline-cli.js `checkOffline`) and reads the
 * decrypted request.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { seedAccount, seedThread, checkOffline, requestsTo } from "./support/offline-cli.js";

const GROUP = "200000000000000031";
const PEER = "300000000000000031";

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(GROUP, "group");
    seedThread(PEER, "dm");
});

/** The single request to `suffix`. */
function only(r, suffix) {
    const hits = requestsTo(r.requests, suffix);
    assert.equal(hits.length, 1, `expected one ${suffix} request, got ${hits.length}\n${r.all}`);
    return hits[0];
}

describe("msg send --urgency", () => {
    it("urgent in a group: metaData {urgency: 2} on group/sendmsg", async () => {
        await checkOffline(["msg", "send", GROUP, "offline urgent", "-t", "1", "--urgency", "urgent"], {}, (r) => {
            const q = only(r, "/api/group/sendmsg");
            // Red if the flag is dropped, mapped to the wrong level, or sent as a
            // bare number instead of the object Zalo expects.
            assert.deepEqual(q.params.metaData, { urgency: 2 });
            assert.equal(q.params.message, "offline urgent");
        });
    });

    it("important in a 1-1: metaData {urgency: 1} on message/sms", async () => {
        await checkOffline(["msg", "send", PEER, "offline important", "--urgency", "important"], {}, (r) => {
            const q = only(r, "/api/message/sms");
            assert.deepEqual(q.params.metaData, { urgency: 1 });
            assert.equal(q.params.toid, PEER);
        });
    });

    it("rides along with a mention, which switches the group endpoint", async () => {
        const argv = ["msg", "send", GROUP, "@[-1] offline urgent all", "-t", "1", "--urgency", "urgent"];
        await checkOffline(argv, {}, (r) => {
            assert.deepEqual(only(r, "/api/group/mention").params.metaData, { urgency: 2 });
        });
    });

    it("accepts the level in any case", async () => {
        await checkOffline(["msg", "send", PEER, "offline mixed case", "--urgency", "Urgent"], {}, (r) => {
            assert.deepEqual(only(r, "/api/message/sms").params.metaData, { urgency: 2 });
        });
    });

    it("sends no metaData at all without the flag", async () => {
        await checkOffline(["msg", "send", PEER, "offline plain"], {}, (r) => {
            assert.equal("metaData" in only(r, "/api/message/sms").params, false);
        });
    });

    it("rejects any other value before anything is sent, and lists the valid ones", async () => {
        // "constructor" and "__proto__" are what every object inherits: red if the
        // lookup reaches past the table's own keys.
        for (const bad of ["high", "1", "0", "", "constructor", "__proto__"]) {
            await checkOffline(["msg", "send", PEER, "offline bad urgency", "--urgency", bad], {}, (r) => {
                assert.deepEqual(r.requests, [], `--urgency ${JSON.stringify(bad)} must not send:\n${r.all}`);
                assert.notEqual(r.code, 0);
                assert.match(r.all, /important/);
                assert.match(r.all, /urgent/);
            });
        }
    });
});
