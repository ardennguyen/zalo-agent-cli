/**
 * src/core/group-history.js -- group history from Zalo's cloud-message store.
 *
 * Driven through a real zca-js session whose transport is
 * ./fake-zalo-session.js, so every assertion is about the request that
 * actually goes out (decrypted) or what the caller gets back.
 *
 * What the evidence does and does not establish (see the module's header):
 *   - the newest page (getrecentv2, globalMsgId 2^63, src 1) is captured;
 *   - the older-page loop -- next globalMsgId = the response's lastMsgId, and
 *     getoldv2 only when the response says isOld -- is Zalo Web's own code
 *     (getCloudMessage's client retry), and the src 3 "load more" request
 *     shape is captured, but no captured page ever carried messages or isOld.
 * These tests pin the client to that specification; they do not prove the
 * server pages that way. The live session does.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getGroupHistory, quoteUids } from "../../src/core/group-history.js";
import { FAKE, installFakeZalo, loginFake, serviceHost } from "./fake-zalo-session.js";

const GID = "7000000000000000001";
const MEMBER = "2000000000000000002";
const NEWEST = "9223372036854775808";
const BIG_UID = "1111111111111111111"; // JSON.parse turns this into 1111111111111111200

/** msgIds counting down from 8300000000999, i.e. newest first. */
const msgIdAt = (i) => String(8300000000999 - i);

function row(msgId, over = {}) {
    const n = Number(msgId.slice(-4));
    return {
        msgId,
        cliMsgId: String(1790000000000 + n),
        msgType: "webchat",
        uidFrom: MEMBER,
        idTo: GID,
        dName: "Member",
        ts: String(1790000000000 + n * 1000),
        content: `text ${msgId}`,
        ...over,
    };
}

/** `count` rows starting at index `from`, newest first. */
const rows = (from, count) => Array.from({ length: count }, (_, i) => row(msgIdAt(from + i)));

function page(groupMsgs, extra = {}) {
    return JSON.stringify({ error: 0, lastMsgId: "0", hasMore: 0, isOld: 0, groupMsgs, ...extra });
}

describe("getGroupHistory", () => {
    let fake;
    let api;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
        api = await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    const storeCalls = () => fake.calls("/api/cm/");

    it("asks for the newest page exactly as Zalo Web opens a group", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 3)));

        const res = await getGroupHistory(api, GID, 3, { delayMs: 0 });

        assert.equal(storeCalls().length, 1);
        const [req] = storeCalls();
        assert.equal(req.method, "GET");
        assert.equal(req.host, serviceHost("group_cloud_message"));
        assert.equal(req.path, "/api/cm/getrecentv2");
        assert.equal(req.query.nretry, "0");
        assert.deepEqual(req.params, {
            groupId: GID,
            globalMsgId: NEWEST,
            count: 50,
            msgIds: [],
            imei: FAKE.imei,
            src: 1,
        });
        assert.equal(res.groupMsgs.length, 3);
    });

    it("strips the leading g that Zalo Web strips from a group id", async () => {
        fake.route("/api/cm/getrecentv2", () => page([]));
        await getGroupHistory(api, `g${GID}`, 1, { delayMs: 0 });
        assert.equal(storeCalls()[0].params.groupId, GID);
    });

    it("returns messages newest first, as zca-js GroupMessage objects", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            page([row(msgIdAt(2)), row(msgIdAt(0)), row(msgIdAt(1))], { hasMore: 0 }),
        );

        const res = await getGroupHistory(api, GID, 10, { delayMs: 0 });

        assert.deepEqual(
            res.groupMsgs.map((m) => m.data.msgId),
            [msgIdAt(0), msgIdAt(1), msgIdAt(2)],
        );
        assert.equal(res.groupMsgs[0].threadId, GID);
        assert.equal(res.groupMsgs[0].type, 1, "ThreadType.Group");
        assert.equal(res.more, 0);
    });

    it("stops at the requested count and reports that more exist", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 50), { hasMore: 1, lastMsgId: msgIdAt(49) }));

        const res = await getGroupHistory(api, GID, 2, { delayMs: 0 });

        assert.equal(storeCalls().length, 1, "two messages fit in the first page");
        assert.deepEqual(
            res.groupMsgs.map((m) => m.data.msgId),
            [msgIdAt(0), msgIdAt(1)],
        );
        assert.equal(res.more, 1);
    });

    // Measured live 2026-09-30: only messages since this device's login came
    // back; everything older read `isFiltered: 1`, 0 rows, `hasMore: 1`.
    it("stops at a page Zalo marks isFiltered, and reports older history withheld rather than more", async () => {
        fake.route("/api/cm/getrecentv2", () => page([], { hasMore: 1, isFiltered: 1, lastMsgId: msgIdAt(49) }));

        const res = await getGroupHistory(api, GID, 120, { delayMs: 0 });

        // Red if the loop goes back to walking empty pages and claiming more.
        assert.equal(storeCalls().length, 1, "no page past the filter is fetched");
        assert.equal(res.groupMsgs.length, 0);
        assert.equal(res.more, 0, "withheld is not retrievable");
        assert.equal(res.filtered, true);
    });

    it("keeps the rows of the page where the filter starts, and stops there", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 3), { hasMore: 1, isFiltered: 1, lastMsgId: msgIdAt(2) }));

        const res = await getGroupHistory(api, GID, 50, { delayMs: 0 });

        assert.equal(storeCalls().length, 1);
        assert.deepEqual(
            res.groupMsgs.map((m) => m.data.msgId),
            [msgIdAt(0), msgIdAt(1), msgIdAt(2)],
        );
        assert.equal(res.more, 0);
        assert.equal(res.filtered, true);
    });

    it("an unfiltered history reports filtered: false", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 4), { hasMore: 0, isFiltered: 0 }));

        const res = await getGroupHistory(api, GID, 10, { delayMs: 0 });

        assert.equal(res.filtered, false);
        assert.equal(res.groupMsgs.length, 4);
    });

    it("stops when the server says there is nothing older", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 10), { hasMore: 0, lastMsgId: msgIdAt(9) }));

        const res = await getGroupHistory(api, GID, 100, { delayMs: 0 });

        assert.equal(storeCalls().length, 1);
        assert.equal(res.groupMsgs.length, 10);
        assert.equal(res.more, 0);
    });

    it("pages older from the returned lastMsgId, on getoldv2 when the server says isOld", async () => {
        fake.route("/api/cm/getrecentv2", () => page(rows(0, 50), { hasMore: 1, isOld: 1, lastMsgId: msgIdAt(49) }));
        fake.route("/api/cm/getoldv2", () => page(rows(50, 20), { hasMore: 0, lastMsgId: msgIdAt(69) }));

        const res = await getGroupHistory(api, GID, 60, { delayMs: 0 });

        const calls = storeCalls();
        assert.deepEqual(
            calls.map((c) => c.path),
            ["/api/cm/getrecentv2", "/api/cm/getoldv2"],
        );
        assert.deepEqual(calls[1].params, {
            groupId: GID,
            globalMsgId: msgIdAt(49),
            count: 50,
            msgIds: [],
            imei: FAKE.imei,
            src: 3,
        });
        assert.equal(calls[1].host, serviceHost("group_cloud_message"));
        assert.equal(res.groupMsgs.length, 60);
        assert.equal(res.groupMsgs[59].data.msgId, msgIdAt(59));
        assert.equal(res.more, 1, "ten fetched messages were left out");
    });

    it("keeps paging on getrecentv2 while the server does not say isOld", async () => {
        let n = 0;
        fake.route("/api/cm/getrecentv2", () =>
            n++ === 0 ? page(rows(0, 50), { hasMore: 1, lastMsgId: msgIdAt(49) }) : page(rows(50, 5)),
        );

        const res = await getGroupHistory(api, GID, 80, { delayMs: 0 });

        assert.deepEqual(
            storeCalls().map((c) => [c.path, c.params.globalMsgId, c.params.src]),
            [
                ["/api/cm/getrecentv2", NEWEST, 1],
                ["/api/cm/getrecentv2", msgIdAt(49), 3],
            ],
        );
        assert.equal(res.groupMsgs.length, 55);
    });

    it("stops instead of looping when the cursor does not move older", async () => {
        let n = 0;
        fake.route("/api/cm/getrecentv2", () =>
            n++ === 0
                ? page(rows(0, 50), { hasMore: 1, lastMsgId: msgIdAt(49) })
                : page(rows(0, 50), { hasMore: 1, lastMsgId: msgIdAt(49) }),
        );

        const res = await getGroupHistory(api, GID, 500, { delayMs: 0 });

        assert.equal(storeCalls().length, 2, "a repeated cursor must end the walk");
        assert.equal(res.groupMsgs.length, 50, "the repeated page adds nothing");
        assert.equal(res.more, 1, "the server still says there is more");
    });

    it("keeps uids past 2^53 exact, as Zalo Web's preParse does", async () => {
        // The server may send these as bare numbers; JSON.parse would round them.
        const raw =
            '{"error":0,"lastMsgId":"0","hasMore":0,"isOld":0,"groupMsgs":[' +
            `{"msgId":"8300000000001","cliMsgId":"1790000000001","msgType":"webchat","uidFrom":${BIG_UID},` +
            `"idTo":"${GID}","ts":"1790000001000","content":"quoted reply",` +
            `"quote":{"ownerId":${BIG_UID},"globalMsgId":8300000000000,"msg":"original"}}]}`;
        fake.route("/api/cm/getrecentv2", () => raw);

        const res = await getGroupHistory(api, GID, 5, { delayMs: 0 });

        assert.equal(res.groupMsgs.length, 1);
        assert.equal(res.groupMsgs[0].data.uidFrom, BIG_UID);
        assert.equal(res.groupMsgs[0].data.quote.ownerId, BIG_UID);
    });

    it("quotes those uids in arrays and inside escaped JSON too, and leaves every other key alone", () => {
        const text =
            `{"uid":[${BIG_UID}, 2],"x":{"ownerId":-5},"params":"{\\"uidFrom\\":${BIG_UID}}",` +
            `"msgId":${BIG_UID},"ts":12.5}`;

        const out = JSON.parse(quoteUids(text));

        assert.deepEqual(out.uid, [BIG_UID, "2"]);
        assert.equal(out.x.ownerId, "-5");
        assert.equal(JSON.parse(out.params).uidFrom, BIG_UID);
        // Not one of Zalo Web's preParse keys, so not ours to touch.
        assert.equal(typeof out.msgId, "number");
        assert.equal(out.ts, 12.5);
    });

    it("drops recall and delete events, empty rows and duplicates, as Zalo Web does", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            page([
                row(msgIdAt(0), { msgType: "chat.undo", content: { globalMsgId: msgIdAt(1), deleteMsg: 0 } }),
                row(msgIdAt(1)),
                row(msgIdAt(2), { msgType: "chat.delete", content: { msgs: [] } }),
                row(msgIdAt(3), { content: "" }),
                row(msgIdAt(4)),
                row(msgIdAt(4)),
            ]),
        );

        const res = await getGroupHistory(api, GID, 10, { delayMs: 0 });

        assert.deepEqual(
            res.groupMsgs.map((m) => m.data.msgId),
            [msgIdAt(1), msgIdAt(4)],
        );
    });

    it("marks our own messages as self and names us as their sender", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            page([row(msgIdAt(0), { uidFrom: "0" }), row(msgIdAt(1), { uidFrom: FAKE.ownId }), row(msgIdAt(2))]),
        );

        const res = await getGroupHistory(api, GID, 10, { delayMs: 0 });

        assert.deepEqual(
            res.groupMsgs.map((m) => [m.isSelf, m.data.uidFrom]),
            [
                [true, FAKE.ownId],
                [true, FAKE.ownId],
                [false, MEMBER],
            ],
        );
    });

    it("reports a store error rather than an empty history", async () => {
        fake.route("/api/cm/getrecentv2", () => page([], { error: -7 }));
        await assert.rejects(getGroupHistory(api, GID, 5, { delayMs: 0 }), /-7/);
    });

    it("rejects a count that is not a whole number of at least 1, before any request", async () => {
        for (const bad of [0, -1, 2.5, Number.NaN]) {
            await assert.rejects(getGroupHistory(api, GID, bad, { delayMs: 0 }), /count/);
        }
        assert.equal(storeCalls().length, 0);
    });

    it("says so, before any request, when the session has no group_cloud_message host", async () => {
        const bare = installFakeZalo({ omit: ["group_cloud_message"] });
        try {
            const bareApi = await loginFake();
            await assert.rejects(getGroupHistory(bareApi, GID, 5, { delayMs: 0 }), /group_cloud_message/);
            assert.equal(bare.calls("/api/cm/").length, 0);
        } finally {
            bare.uninstall();
            api = await loginFake(); // back onto the full fake for any later test
        }
    });
});
