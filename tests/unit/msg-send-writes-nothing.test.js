/**
 * `msg send` writes nothing to zalo.db.
 *
 * Arden, 2026-09-30: "the msg send should not write anything, the data will
 * come from live listener or sync." The one write `msg send` still made was a
 * convenience: when a mention named someone the cache could not name, the name
 * `getGroupMembersInfo` returned was saved to `contacts` so the next send could
 * skip the lookup. The name is still looked up and still used for the send it
 * was looked up for; it is just no longer written.
 *
 * Runs the real CLI against the offline session (./support/offline-cli.js): the
 * member lookup is answered with a profile, and the sandbox's zalo.db is read
 * back afterwards.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getDisplayName } from "../../src/core/db.js";
import { seedAccount, seedThread, runOffline, requestsTo } from "./support/offline-cli.js";

const GROUP = "200000000000000071";
/** Has never posted in the group, so the cache has no name for them. */
const MEMBER = "300000000000000071";
const NAME = "Thành Viên Mới";

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(GROUP, "group");
});

describe("msg send writes nothing to zalo.db", () => {
    it("a mention of an uncached member uses the looked-up name and caches nothing", async () => {
        assert.equal(getDisplayName(MEMBER), null, "precondition: the cache cannot name the member");

        const r = await runOffline(["msg", "send", GROUP, `chào @[${MEMBER}]`, "-t", "1"], {
            responses: { "/api/social/group/members": { profiles: { [`${MEMBER}_0`]: { displayName: NAME } } } },
        });
        assert.equal(r.code, 0, r.all);

        // The lookup still happens, and still feeds this send.
        assert.equal(requestsTo(r.requests, "/api/social/group/members").length, 1, r.all);
        const sent = requestsTo(r.requests, "/api/group/mention");
        assert.equal(sent.length, 1, `expected one group/mention request\n${r.all}`);
        assert.ok(
            sent[0].params.message.includes(`@${NAME}`),
            `the mention must carry the looked-up name, got: ${sent[0].params.message}`,
        );

        // Red if msg send writes the name back to contacts, which it did until
        // 2026-09-30, or writes any row the name could be read from.
        assert.equal(getDisplayName(MEMBER), null, "msg send must not write the looked-up name to zalo.db");
    });
});
