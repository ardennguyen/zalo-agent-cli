/**
 * Reading every page of a server-paged list when the caller asked for no page (src/zalo/paging.js and the readers in
 * src/core/list-all.js): every page is fetched, one at a time, and the walk ends where the server says the list ends,
 * at an empty page, or at a cursor that stops advancing; never at a fixed page count. Zalo's 221 keeps what was read.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { readAllPages } from "../../src/zalo/paging.js";
import { ZaloApiError } from "../../src/zalo/errors.js";
import {
    allAliases,
    allBankAccounts,
    allBoardItems,
    allGroupBlocked,
    allProducts,
    allReminders,
    groupLinkInfoAll,
} from "../../src/core/list-all.js";
import { callReadAll } from "../../src/zalo/reads.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const ids = (from, n) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));

describe("readAllPages", () => {
    it("fetches all three pages, one at a time, and stops on the empty page after them", async () => {
        const pages = [ids(1, 20), ids(21, 20), ids(41, 5), []];
        const asked = [];
        let inFlight = 0;
        const r = await readAllPages({
            fetch: async (page) => {
                assert.equal(++inFlight, 1, "one request at a time");
                asked.push(page);
                await new Promise((res) => setImmediate(res));
                inFlight--;
                return { items: pages[page - 1] ?? [] };
            },
            items: (reply) => reply.items,
        });
        assert.deepEqual(asked, [1, 2, 3, 4], "past the old single page, and on to the empty one");
        assert.equal(r.items.length, 45);
        assert.deepEqual([r.pages, r.complete, r.stoppedBy, r.note], [4, true, "empty", null]);
    });

    it("stops when the page says there is no more, without asking again", async () => {
        const asked = [];
        const r = await readAllPages({
            fetch: async (page) => (asked.push(page), { items: ids(page * 10, 10), more: page < 3 }),
            items: (reply) => reply.items,
            more: (reply) => reply.more,
        });
        assert.deepEqual(asked, [1, 2, 3]);
        assert.deepEqual([r.items.length, r.stoppedBy], [30, "end"]);
    });

    it("stops, and says so, when the server's cursor stops advancing", async () => {
        // A cursor-paged list whose server answers page 3 with the cursor it was asked with.
        const asked = [];
        const r = await readAllPages({
            fetch: async (_page, cursor) => {
                asked.push(cursor);
                return { items: ids(Number(cursor) + 1, 5), next: cursor >= 10 ? cursor : cursor + 5 };
            },
            items: (reply) => reply.items,
            next: (reply) => reply.next,
            firstCursor: 0,
        });
        assert.deepEqual(asked, [0, 5, 10], "the stalled cursor is not asked again");
        assert.equal(r.items.length, 15);
        assert.equal(r.stoppedBy, "cursor");
        assert.match(r.note, /cursor stopped advancing after page 3/);
    });

    it("stops when a server that ignores the page number answers the same page again", async () => {
        const asked = [];
        const r = await readAllPages({
            fetch: async (page) => (asked.push(page), { items: ids(1, 20) }),
            items: (reply) => reply.items,
            key: (it) => it.id,
        });
        assert.deepEqual(asked, [1, 2]);
        assert.deepEqual([r.items.length, r.stoppedBy], [20, "cursor"]);
    });

    it("keeps what was read when Zalo answers 221, and says so; any other error is thrown", async () => {
        const r = await readAllPages({
            fetch: async (page) => {
                if (page === 3) throw new ZaloApiError("Quá giới hạn", 221);
                return { items: ids(page * 10, 10) };
            },
            items: (reply) => reply.items,
        });
        assert.deepEqual([r.items.length, r.pages, r.complete, r.stoppedBy], [20, 2, false, "rateLimited"]);
        assert.match(r.note, /221/);
        await assert.rejects(
            readAllPages({
                fetch: async () => {
                    throw new ZaloApiError("nope", 114);
                },
                items: (reply) => reply.items,
            }),
            /nope/,
        );
    });
});

describe("the list readers", () => {
    it("allGroupBlocked: every page while has_more is 1, in Zalo's reply shape", async () => {
        const asked = [];
        const api = {
            getGroupBlockedMember: async ({ page, count }) => {
                asked.push([page, count]);
                return { blocked_members: ids(page * 100, page < 3 ? 50 : 7), has_more: page < 3 ? 1 : 0 };
            },
        };
        const r = await allGroupBlocked(api, "g1");
        assert.deepEqual(asked, [
            [1, 50],
            [2, 50],
            [3, 50],
        ]);
        assert.deepEqual([r.blocked_members.length, r.has_more, r.paging.complete], [107, 0, true]);
    });

    it("allBoardItems: each page carries the cursor of the page before, and an empty page ends it", async () => {
        const asked = [];
        const item = (id) => ({ boardType: 1, data: { id } });
        const pages = [[item(30), item(29)], [item(20)], []];
        const api = {
            getListBoard: async (args) => (asked.push(args), { items: pages[args.page - 1] }),
        };
        const r = await allBoardItems(api, "g1");
        assert.deepEqual(
            asked.map((a) => [a.page, a.lastId]),
            [
                [1, 0],
                [2, 29],
                [3, 20],
            ],
        );
        assert.equal(r.items.length, 3);
    });

    it("allReminders: a group's pages go by lastId and on past a short page until an empty one", async () => {
        const page = (list, lastId, size = list.length) =>
            Object.defineProperty(list, "page", { value: { lastId, size } });
        const replies = [page([{ reminderId: "r1" }], "r1", 20), page([{ reminderId: "r2" }], "r2", 3), page([], 0, 0)];
        const asked = [];
        const api = {
            getListReminder: async (o, _t, type) => (asked.push([o.page, o.lastId, type]), replies[o.page - 1]),
        };
        const r = await allReminders(api, "g1", 1);
        assert.deepEqual(asked, [
            [1, 0, 1],
            [2, "r1", 1],
            [3, "r2", 1],
        ]);
        assert.deepEqual(
            r.reminders.map((x) => x.reminderId),
            ["r1", "r2"],
        );
    });

    it("allProducts: later pages carry the first product id of the page before", async () => {
        const asked = [];
        const api = {
            getProductCatalogList: async (o) => {
                asked.push([o.page, o.lastProductId]);
                return o.page === 0
                    ? { items: [{ product_id: "p9" }, { product_id: "p8" }], has_more: 1 }
                    : { items: [{ product_id: "p7" }], has_more: 0 };
            },
        };
        const r = await allProducts(api, "c1");
        assert.deepEqual(asked, [
            [0, -1],
            [1, "p9"],
        ]);
        assert.deepEqual([r.items.length, r.has_more], [3, 0]);
    });

    it("groupLinkInfoAll joins the member pages while hasMoreMember", async () => {
        const api = {
            getGroupLinkInfo: async ({ memberPage }) => ({
                groupId: "g1",
                currentMems: ids(memberPage * 10, 2),
                hasMoreMember: memberPage < 2 ? 1 : 0,
            }),
        };
        const r = await groupLinkInfoAll(api, "https://zalo.me/g/x");
        assert.deepEqual([r.groupId, r.currentMems.length, r.hasMoreMember], ["g1", 4, 0]);
    });

    it("allBankAccounts and allAliases keep the pages read before a 221, with a note", async () => {
        const bank = {
            getListBankAccount: async (page) => {
                if (page === 1) throw new ZaloApiError("Quá giới hạn", 221);
                return { myBanks: [{ id: 1 }], total: 3, hasMore: true };
            },
        };
        const b = await allBankAccounts(bank);
        assert.deepEqual([b.myBanks.length, b.hasMore, b.paging.stoppedBy], [1, true, "rateLimited"]);
        const alias = {
            getAliasList: async (count, page) => {
                if (page === 2) throw new ZaloApiError("Quá giới hạn", 221);
                return { items: ids(1, count).map((x) => ({ userId: x.id, alias: "a" })) };
            },
        };
        const a = await allAliases(alias);
        assert.equal(a.items.length, 100);
        assert.equal(a.paging.complete, false);
        assert.match(a.paging.note, /221/);
    });
});

describe("read run with no page reads a paged read to its end", () => {
    it("blocklist: every page while has_more; a page asked is that page alone", async () => {
        const asked = [];
        // The fake answers the read's request at the web-call layer: page and count ride in the body.
        const reads = {
            blocklist: (body) => (asked.push(body.page), { profiles: ids(body.page, 1), has_more: body.page < 3 }),
        };
        const fakeCall = async (_api, name, args) => reads[name]({ page: args.page, count: args.count });
        const { READ_PAGERS } = await import("../../src/zalo/reads.js");
        const walked = await READ_PAGERS.blocklist.walk((extra) => fakeCall(null, "blocklist", extra));
        assert.deepEqual(asked, [1, 2, 3]);
        assert.deepEqual([walked.data.profiles.length, walked.data.has_more], [3, 0]);
        // A read with no pager, or a page chosen, is one request: callReadAll hands it to callRead unchanged.
        await assert.rejects(callReadAll({}, "no-such-read", {}), /unknown read/);
    });
});
