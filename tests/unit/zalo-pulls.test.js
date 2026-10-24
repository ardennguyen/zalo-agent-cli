/**
 * The Web-shaped socket requests (src/zalo/pulls.js, src/zalo/req-id.js; plan items X5, X6, Y7): the shared request
 * counter, the queue pulls with `reqId`, the connect-time request builders, and the paged action list.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assertConforms, diffBody } from "../helpers/replay/replay.js";
import { WEB_FRAMES } from "../helpers/replay/shapes.js";
import { nextReqId, resetReqIdsForTests } from "../../src/zalo/req-id.js";
import {
    CONNECT_PULLS,
    buildActionListRequest,
    buildConversationStateRequest,
    buildKeyIdRequest,
    buildPull,
    installOfficialPulls,
    pageActionList,
} from "../../src/zalo/pulls.js";

beforeEach(() => resetReqIdsForTests());

describe("the request counter", () => {
    it("counts req_1, req_2, ... and never repeats", () => {
        assert.deepEqual([nextReqId(), nextReqId(), nextReqId()], ["req_1", "req_2", "req_3"]);
    });

    it("starts over only when a test asks it to", () => {
        nextReqId();
        resetReqIdsForTests();
        assert.equal(nextReqId(), "req_1");
    });
});

describe("a queue pull", () => {
    it("has the official shape: first, reqId, lastId and preIds, with a reqId from the shared counter", () => {
        const pull = buildPull(603, 1, { lastId: "42" });
        assert.deepEqual(pull, {
            version: 1,
            cmd: 603,
            subCmd: 1,
            data: { first: true, reqId: "req_1", lastId: "42", preIds: [] },
        });
        assertConforms(diffBody(pull.data, WEB_FRAMES.pull, "603"), "the 603 pull");
    });

    it("asks for a following page with first false", () => {
        assert.equal(buildPull(510, 1, { lastId: "9", first: false }).data.first, false);
    });

    it("lists the connect-time pulls in the captured client's order", () => {
        assert.deepEqual(CONNECT_PULLS, [
            [510, 1],
            [511, 1],
            [610, 1],
            [611, 1],
            [603, 1],
            [515, 0],
            [517, 0],
            [518, 0],
        ]);
    });
});

describe("the connect-time requests", () => {
    it("the key-id request (564) asks for the Web platform", () => {
        const r = buildKeyIdRequest();
        assert.equal(r.cmd, 564);
        assertConforms(diffBody(r.data, WEB_FRAMES["564"], "564"), "the 564 request");
    });

    it("the conversation-state request (577) carries both lists", () => {
        const r = buildConversationStateRequest();
        assert.equal(r.cmd, 577);
        assert.deepEqual(r.data, { oneone: [], group: [] });
        assertConforms(diffBody(r.data, WEB_FRAMES["577"], "577"), "the 577 request");
    });

    it("the action-list request (537) carries a cursor and a page size", () => {
        const r = buildActionListRequest({ lastId: "7", maxItem: 50 });
        assert.equal(r.cmd, 537);
        assert.deepEqual(r.data, { lastId: "7", maxItem: 50 });
        assertConforms(diffBody(r.data, WEB_FRAMES["537"], "537"), "the 537 request");
    });
});

describe("paging the action list (537)", () => {
    const page = (ids, hasMore) => ({ hasMore, actions: ids.map((actionId) => ({ actionId })) });

    it("asks again from the last action while the answer says hasMore, then stops", async () => {
        const asked = [];
        const answers = [page(["1", "2"], true), page(["3", "4"], true), page(["5"], false)];
        const out = await pageActionList(async (req) => {
            asked.push(req.data.lastId);
            return answers.shift();
        });
        assert.deepEqual(asked, [0, "2", "4"]);
        assert.equal(out.complete, true);
        assert.equal(out.reason, "drained");
        assert.equal(out.pages, 3);
        assert.deepEqual(
            out.actions.map((a) => a.actionId),
            ["1", "2", "3", "4", "5"],
        );
    });

    it("is drained after one page when there is no more", async () => {
        const out = await pageActionList(async () => page([], false));
        assert.equal(out.complete, true);
        assert.equal(out.pages, 1);
    });

    it("stops, and says so, when the cursor does not move", async () => {
        const out = await pageActionList(async () => ({ hasMore: true, actions: [{ actionId: 0 }] }));
        assert.equal(out.complete, false);
        assert.equal(out.reason, "stalled");
    });

    it("stops when a page brings nothing to continue from", async () => {
        const out = await pageActionList(async () => ({ hasMore: true, actions: [] }));
        assert.equal(out.reason, "stalled");
    });

    it("stops when no answer comes", async () => {
        const out = await pageActionList(async () => null);
        assert.equal(out.complete, false);
        assert.equal(out.reason, "no-answer");
        assert.equal(out.pages, 0);
    });

    it("stops at the page cap against a server that never finishes", async () => {
        let n = 0;
        const out = await pageActionList(async () => page([String(++n)], true), { maxPages: 3 });
        assert.equal(out.reason, "page-cap");
        assert.equal(out.pages, 3);
    });
});

describe("installOfficialPulls", () => {
    const fakeListener = () => {
        const sent = [];
        return { sent, sendWs: (payload, requireId) => sent.push({ payload, requireId }) };
    };

    it("sends the old-message pulls with reqId, and never lets sendWs add zca-js's req_id", () => {
        const l = installOfficialPulls(fakeListener());
        l.requestOldMessages(0, "11");
        l.requestOldMessages(1);
        assert.deepEqual(
            l.sent.map((s) => [s.payload.cmd, s.payload.subCmd, s.payload.data.lastId, s.requireId]),
            [
                [510, 1, "11", false],
                [511, 1, null, false],
            ],
        );
        assert.deepEqual(
            l.sent.map((s) => s.payload.data.reqId),
            ["req_1", "req_2"],
        );
    });

    it("sends the old-reaction pulls the same way", () => {
        const l = installOfficialPulls(fakeListener());
        l.requestOldReactions(0);
        l.requestOldReactions(1);
        assert.deepEqual(
            l.sent.map((s) => s.payload.cmd),
            [610, 611],
        );
        assert.ok(l.sent.every((s) => s.requireId === false && /^req_\d+$/.test(s.payload.data.reqId)));
    });

    it("is safe to call twice and on nothing", () => {
        const l = fakeListener();
        installOfficialPulls(l);
        const first = l.requestOldMessages;
        installOfficialPulls(l);
        assert.equal(l.requestOldMessages, first);
        assert.equal(installOfficialPulls(null), null);
    });
});
