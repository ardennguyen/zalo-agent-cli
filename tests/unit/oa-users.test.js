/**
 * src/core/oa/users.js and src/commands/oa/users.js: `oa follower`, `oa userfield`, `oa tag`, `oa form`,
 * `oa purchase`.
 *
 * Every request is asserted against Zalo's OA docs ("Quản lý thông tin người dùng", "Quản lý trường thông tin
 * người dùng", "Quản lý form Zalo Ads", "Mua sản phẩm / dịch vụ OA"): method, URL, the `access_token` header,
 * the `data=<JSON>` query or JSON body, and the documented limits, which refuse before anything is sent. The
 * guarded commands (`follower delete-info`, `userfield delete`, `tag remove`, `purchase *`) are driven through
 * Commander with the same preAction guard src/index.js runs, and must send nothing without --yes.
 * globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { saveOACreds, OAError } from "../../src/core/oa/transport.js";
import {
    getFollowerInfo,
    getFollowers,
    getAllFollowers,
    updateFollowerInfo,
    buildFollowerUpdate,
    deleteFollowerInfo,
    getFollowerCustomInfo,
    updateFollowerCustomInfo,
    listUserFields,
    createUserField,
    updateUserField,
    deleteUserField,
    getTags,
    assignTag,
    removeFollowerFromTag,
    removeTag,
    getAdsForm,
    getAllAdsForm,
    adsFormQuery,
    createPurchaseOrder,
    confirmPurchaseOrder,
    normalizeInteractionPeriod,
} from "../../src/core/oa/users.js";
import { registerUsersCommands, describeFollower } from "../../src/commands/oa/users.js";
import { enforceCliGuard } from "../../src/core/confirm-guard.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const V2 = "https://openapi.zalo.me/v2.0";
const V3 = "https://openapi.zalo.me/v3.0";
const USER = "1000000000000000001"; // past 2^53, like real user ids
const PRODUCT = "1000000000000000002";

/** Replace fetch: `reply(url, init, n)` returns `{ json? }` (default success). Calls are recorded. */
function mockFetch(reply = () => ({})) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        return new Response(JSON.stringify(r.json ?? { error: 0, message: "Success" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

/** The `data` query parameter of a call, parsed. */
const dataOf = (c) => JSON.parse(new URL(c.url).searchParams.get("data"));
/** The path and plain query of a call, without `data`. */
const pathOf = (c) => {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}`;
};
const bodyOf = (c) => JSON.parse(c.init.body);

/** One doc-shaped POST: method, URL, token header, JSON content type, exact body text. */
function assertPost(c, url, rawBody) {
    assert.equal(c.init.method, "POST");
    assert.equal(c.url, url);
    assert.equal(c.init.headers.access_token, "tok-1");
    assert.equal(c.init.headers["Content-Type"], "application/json");
    assert.equal(c.init.body, rawBody);
}

/** One doc-shaped GET: method, path, token header, no body. */
function assertGet(c, url) {
    assert.equal(c.init.method, "GET");
    assert.equal(pathOf(c), url);
    assert.equal(c.init.headers.access_token, "tok-1");
    assert.equal(c.init.body, undefined);
    assert.doesNotMatch(c.url, /tok-1/);
}

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-1" });
});
afterEach(() => m?.restore());

// ─── Users ───────────────────────────────────────────────────────────

describe("oa follower: user list and details (v3.0/oa/user/*)", () => {
    it("info: GET v3.0/oa/user/detail?data={user_id}", async () => {
        m = mockFetch();
        await getFollowerInfo(USER);
        assertGet(m.calls[0], `${V3}/oa/user/detail`);
        assert.deepEqual(dataOf(m.calls[0]), { user_id: USER });
    });

    it("list: GET v3.0/oa/user/getlist?data={offset,count,tag_name,last_interaction_period,is_follower}", async () => {
        m = mockFetch();
        await getFollowers({ offset: "100", count: "15", tagName: "VIP", lastInteraction: "l7d", isFollower: true });
        await getFollowers();
        assertGet(m.calls[0], `${V3}/oa/user/getlist`);
        assert.deepEqual(dataOf(m.calls[0]), {
            offset: 100,
            count: 15,
            tag_name: "VIP",
            last_interaction_period: "L7D",
            is_follower: true,
        });
        assert.deepEqual(dataOf(m.calls[1]), { offset: 0, count: 50 });
    });

    it("list: count 1-50 and offset 0-9951 are the docs' limits, refused before sending", async () => {
        m = mockFetch();
        for (const bad of [{ count: 51 }, { count: 0 }, { offset: 9952 }, { offset: -1 }, { count: "x" }]) {
            await assert.rejects(getFollowers(bad), RangeError, JSON.stringify(bad));
        }
        await getFollowers({ offset: 9951, count: 50 });
        assert.equal(m.calls.length, 1);
    });

    it("last_interaction_period: TODAY, YESTERDAY, L7D, L30D or YYYY_MM_DD:YYYY_MM_DD", () => {
        assert.equal(normalizeInteractionPeriod("today"), "TODAY");
        assert.equal(normalizeInteractionPeriod("L30D"), "L30D");
        assert.equal(normalizeInteractionPeriod("2024_05_22:2024_05_23"), "2024_05_22:2024_05_23");
        assert.equal(normalizeInteractionPeriod("<2024_05_22:2024_05_23>"), "2024_05_22:2024_05_23");
        assert.throws(() => normalizeInteractionPeriod("L90D"), RangeError);
        assert.throws(() => normalizeInteractionPeriod("2024-05-22:2024-05-23"), RangeError);
    });

    it("--all walks 50 at a time until the total", async () => {
        const total = 120;
        m = mockFetch((url) => {
            const { offset, count } = JSON.parse(new URL(url).searchParams.get("data"));
            const n = Math.max(0, Math.min(count, total - offset));
            const users = Array.from({ length: n }, (_, i) => ({ user_id: String(offset + i) }));
            return { json: { error: 0, data: { total, count, offset, users } } };
        });
        const all = await getAllFollowers({ tagName: "VIP" });
        assert.deepEqual(
            m.calls.map((c) => dataOf(c).offset),
            [0, 50, 100],
        );
        assert.ok(m.calls.every((c) => dataOf(c).count === 50 && dataOf(c).tag_name === "VIP"));
        assert.equal(all.users.length, 120);
        assert.equal(all.users[119].user_id, "119");
        assert.equal(all.truncated, false);
    });

    it("--all stops at the documented offset ceiling (10,000 users) and says the list is truncated", async () => {
        m = mockFetch((url) => {
            const { offset } = JSON.parse(new URL(url).searchParams.get("data"));
            const users = Array.from({ length: 50 }, (_, i) => ({ user_id: String(offset + i) }));
            return { json: { error: 0, data: { total: 20000, users } } };
        });
        const all = await getAllFollowers({ offset: 9000 });
        assert.equal(dataOf(m.calls.at(-1)).offset, 9950);
        assert.equal(m.calls.length, 20);
        assert.equal(all.users.length, 1000);
        assert.equal(all.truncated, true);
    });
});

describe("oa follower update (v3.0/oa/user/update: profile fields under shared_info)", () => {
    it("sends name/phone/address/city_id/district_id/user_dob under shared_info, alias and external id at the top", async () => {
        m = mockFetch();
        await updateFollowerInfo(USER, {
            name: "Display name",
            phone: "0901234567",
            shared_info: { address: "ho chi minh", city_id: "79", district_id: 760, user_dob: "31/12/1999" },
            user_alias: "Alias name",
            user_external_id: "ED123",
        });
        assertPost(
            m.calls[0],
            `${V3}/oa/user/update`,
            JSON.stringify({
                user_id: USER,
                shared_info: {
                    address: "ho chi minh",
                    city_id: 79,
                    district_id: 760,
                    user_dob: "31/12/1999",
                    name: "Display name",
                    phone: "0901234567",
                },
                user_alias: "Alias name",
                user_external_id: "ED123",
            }),
        );
    });

    it("an alias alone sends no shared_info", () => {
        assert.deepEqual(buildFollowerUpdate(USER, { user_alias: "A" }), { user_id: USER, user_alias: "A" });
    });

    it("refuses unknown fields, a non-integer city id, a birth date before 1970 or not dd/MM/yyyy, and an empty update", async () => {
        m = mockFetch();
        for (const bad of [
            { nickname: "x" },
            { shared_info: { email: "a@b.c" } },
            { city_id: "HCM" },
            { user_dob: "31/12/1969" },
            { user_dob: "1999-12-31" },
            { user_dob: "31/02/1999" },
            {},
        ]) {
            await assert.rejects(updateFollowerInfo(USER, bad), Error, JSON.stringify(bad));
        }
        assert.equal(m.calls.length, 0);
    });
});

describe("oa follower delete-info / custom-info / custom-update", () => {
    it("delete-info: POST v2.0/oa/deletefollowerinfo {user_id}", async () => {
        m = mockFetch();
        await deleteFollowerInfo(USER);
        assertPost(m.calls[0], `${V2}/oa/deletefollowerinfo`, JSON.stringify({ user_id: USER }));
    });

    it("custom-info: GET v3.0/oa/user/detail/custominfo?data={user_id,fields_to_export}", async () => {
        m = mockFetch();
        await getFollowerCustomInfo(USER, ["first_name", "email"]);
        await getFollowerCustomInfo(USER);
        assertGet(m.calls[0], `${V3}/oa/user/detail/custominfo`);
        assert.deepEqual(dataOf(m.calls[0]), { user_id: USER, fields_to_export: ["first_name", "email"] });
        assert.deepEqual(dataOf(m.calls[1]), { user_id: USER });
    });

    it("custom-update: POST v3.0/oa/user/update/custominfo with user_id and the documented fields", async () => {
        m = mockFetch();
        const fields = {
            name: "Name Example",
            gender: "Nữ",
            user_dob: "30/10/1999",
            full_address: { user_city_id: "79", user_ward_id: "27343", user_address: "123 Street" },
            custom_info: { loyaltyPoints_number: 2500 },
        };
        await updateFollowerCustomInfo(USER, fields);
        assertPost(m.calls[0], `${V3}/oa/user/update/custominfo`, JSON.stringify({ user_id: USER, ...fields }));
    });

    it("custom-update refuses a gender outside Nam|Nữ|Khác, unknown fields, user_id in the JSON, and nothing", async () => {
        m = mockFetch();
        for (const bad of [
            { gender: "Male" },
            { email: "a@b.c" },
            { user_id: USER },
            { full_address: { street: "x" } },
            {},
        ]) {
            await assert.rejects(updateFollowerCustomInfo(USER, bad), Error, JSON.stringify(bad));
        }
        assert.equal(m.calls.length, 0);
    });
});

// ─── User fields ─────────────────────────────────────────────────────

describe("oa userfield (v3.0/oa/userfield/*)", () => {
    it("list: GET v3.0/oa/userfield/get, filters as data={field_type,fields_to_get}", async () => {
        m = mockFetch();
        await listUserFields();
        await listUserFields({ fieldType: "system", fields: ["user_id"] });
        assertGet(m.calls[0], `${V3}/oa/userfield/get`);
        assert.equal(new URL(m.calls[0].url).search, "");
        assert.deepEqual(dataOf(m.calls[1]), { field_type: "system", fields_to_get: ["user_id"] });
        await assert.rejects(listUserFields({ fieldType: "custom" }), RangeError);
        assert.equal(m.calls.length, 2);
    });

    it("create: POST v3.0/oa/userfield/create with the doc example's body", async () => {
        m = mockFetch();
        const field = {
            key: "ngay_dat_hang",
            name: "Ngày đặt hàng",
            data_type: "datetime",
            description: "Ngày khách hàng đặt đơn hàng",
            status: "active",
            additional_format: "dd/MM/yyyy",
        };
        await createUserField(field);
        assertPost(m.calls[0], `${V3}/oa/userfield/create`, JSON.stringify(field));
    });

    it("create refuses system data types, a format on a non-datetime, table columns past 5 or on a non-table", async () => {
        m = mockFetch();
        const col = (k) => ({ key: k, data_type: "text" });
        for (const bad of [
            { key: "a", name: "A", data_type: "gender" },
            { key: "a", name: "A", data_type: "text", additional_format: "dd/MM/yyyy" },
            { key: "a", name: "A", data_type: "datetime", additional_format: "MM/dd/yyyy" },
            { key: "a", name: "A", data_type: "table", additional_fields: ["1", "2", "3", "4", "5", "6"].map(col) },
            { key: "a", name: "A", data_type: "text", additional_fields: [col("x")] },
            { key: "a", name: "A", data_type: "text", status: "paused" },
            { key: "a", data_type: "text" },
        ]) {
            await assert.rejects(createUserField(bad), Error, JSON.stringify(bad));
        }
        assert.equal(m.calls.length, 0);
    });

    it("update: POST v3.0/oa/userfield/update {key, …changes}; nothing to change is refused", async () => {
        m = mockFetch();
        const field = {
            key: "thong_tin_don_hang",
            name: "Thông tin đơn hàng",
            status: "active",
            additional_fields: [{ key: "da_thanh_toan_chua", data_type: "boolean" }],
        };
        await updateUserField(field);
        assertPost(m.calls[0], `${V3}/oa/userfield/update`, JSON.stringify(field));
        await assert.rejects(updateUserField({ key: "x" }), TypeError);
        await assert.rejects(updateUserField({ key: "x", data_type: "text" }), RangeError);
        assert.equal(m.calls.length, 1);
    });

    it("delete: POST v3.0/oa/userfield/delete {key}", async () => {
        m = mockFetch();
        await deleteUserField("ma_don_hang");
        assertPost(m.calls[0], `${V3}/oa/userfield/delete`, JSON.stringify({ key: "ma_don_hang" }));
    });
});

// ─── Tags ────────────────────────────────────────────────────────────

describe("oa tag (v2.0/oa/tag/*)", () => {
    it("list: GET v2.0/oa/tag/gettagsofoa, no query", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: ["Q1", "Q2"] } }));
        const r = await getTags();
        assertGet(m.calls[0], `${V2}/oa/tag/gettagsofoa`);
        assert.equal(new URL(m.calls[0].url).search, "");
        assert.deepEqual(r.data, ["Q1", "Q2"]);
    });

    it("assign / untag: POST tagfollower / rmfollowerfromtag with user_id as the exact long number", async () => {
        m = mockFetch();
        await assignTag(USER, "Khách hàng Quận 1");
        await removeFollowerFromTag(USER, "Khách hàng mua lần đầu");
        assertPost(m.calls[0], `${V2}/oa/tag/tagfollower`, `{"user_id":${USER},"tag_name":"Khách hàng Quận 1"}`);
        assertPost(
            m.calls[1],
            `${V2}/oa/tag/rmfollowerfromtag`,
            `{"user_id":${USER},"tag_name":"Khách hàng mua lần đầu"}`,
        );
        await assert.rejects(assignTag("abc", "x"), TypeError);
        await assert.rejects(assignTag(USER, ""), TypeError);
        assert.equal(m.calls.length, 2);
    });

    it("remove: POST v2.0/oa/tag/rmtag {tag_name}", async () => {
        m = mockFetch();
        await removeTag("Khách hàng mua lần đầu");
        assertPost(m.calls[0], `${V2}/oa/tag/rmtag`, JSON.stringify({ tag_name: "Khách hàng mua lần đầu" }));
    });
});

// ─── Zalo Ads forms ──────────────────────────────────────────────────

describe("oa form get (v2.0/oa/form/get)", () => {
    it("GET with plain query form_id, from_time, to_time, offset, limit (seconds)", async () => {
        m = mockFetch();
        await getAdsForm({ formId: "F1", from: "1621137100", to: 1623689999, offset: 0, limit: 200 });
        assertGet(m.calls[0], `${V2}/oa/form/get`);
        const q = Object.fromEntries(new URL(m.calls[0].url).searchParams);
        assert.deepEqual(q, {
            form_id: "F1",
            from_time: "1621137100",
            to_time: "1623689999",
            offset: "0",
            limit: "200",
        });
    });

    it("dates and millisecond stamps become Unix seconds; the window is at most 30 days and limit at most 200", () => {
        const q = adsFormQuery({ formId: "F1", from: "2026-11-01T00:00:00Z", to: "1793491200000" });
        assert.equal(q.from_time, Date.UTC(2026, 10, 1) / 1000);
        assert.equal(q.to_time, 1793491200);
        assert.equal(q.limit, 200);
        const day = 86400;
        assert.doesNotThrow(() => adsFormQuery({ formId: "F", from: 0, to: 30 * day }));
        assert.throws(() => adsFormQuery({ formId: "F", from: 0, to: 30 * day + 1 }), RangeError);
        assert.throws(() => adsFormQuery({ formId: "F", from: 10, to: 5 }), RangeError);
        assert.throws(() => adsFormQuery({ formId: "F", from: 0, to: 1, limit: 201 }), RangeError);
        assert.throws(() => adsFormQuery({ formId: "F", from: "soon", to: 1 }), RangeError);
    });

    it("--all walks 200 at a time until the total", async () => {
        m = mockFetch((url) => {
            const offset = Number(new URL(url).searchParams.get("offset"));
            const n = Math.min(200, 450 - offset);
            const responses = Array.from({ length: n }, (_, i) => ({ leadId: String(offset + i), answers: [] }));
            return {
                json: { error: 0, data: { total: 450, questions: [{ questionId: "1", title: "Q" }], responses } },
            };
        });
        const all = await getAllAdsForm({ formId: "F1", from: 0, to: 100 });
        assert.deepEqual(
            m.calls.map((c) => new URL(c.url).searchParams.get("offset")),
            ["0", "200", "400"],
        );
        assert.equal(all.responses.length, 450);
        assert.equal(all.questions[0].title, "Q");
    });
});

// ─── Purchases ───────────────────────────────────────────────────────

describe("oa purchase (v3.0/oa/purchase/*)", () => {
    it("create-order: POST create_order {beneficiary, product_id as the exact long, voucher_code}", async () => {
        m = mockFetch();
        await createPurchaseOrder({ productId: PRODUCT, voucherCode: "DISCOUNT_100K" });
        await createPurchaseOrder({ beneficiary: "app", redeemCode: "GIFT_CODE_1" });
        assertPost(
            m.calls[0],
            `${V3}/oa/purchase/create_order`,
            `{"beneficiary":"OA","product_id":${PRODUCT},"voucher_code":"DISCOUNT_100K"}`,
        );
        assertPost(
            m.calls[1],
            `${V3}/oa/purchase/create_order`,
            JSON.stringify({ beneficiary: "APP", redeem_code: "GIFT_CODE_1" }),
        );
    });

    it("create-order needs exactly one of product id or redeem code, and an OA or APP beneficiary", async () => {
        m = mockFetch();
        for (const bad of [{}, { productId: PRODUCT, redeemCode: "G" }, { productId: PRODUCT, beneficiary: "USER" }]) {
            await assert.rejects(createPurchaseOrder(bad), Error, JSON.stringify(bad));
        }
        assert.equal(m.calls.length, 0);
    });

    it("confirm-order: POST confirm_order {order_id, verified_token}", async () => {
        m = mockFetch();
        await confirmPurchaseOrder("22ffed32d17738296161", "30fVkXZd9j9zWmqQrBhO");
        assertPost(
            m.calls[0],
            `${V3}/oa/purchase/confirm_order`,
            JSON.stringify({ order_id: "22ffed32d17738296161", verified_token: "30fVkXZd9j9zWmqQrBhO" }),
        );
    });

    it("a Zalo error answer becomes an OAError carrying the code", async () => {
        m = mockFetch(() => ({ json: { error: -201, message: "Parameters are invalid" } }));
        await assert.rejects(confirmPurchaseOrder("o", "t"), (e) => e instanceof OAError && e.code === -201);
    });
});

// ─── The commands ────────────────────────────────────────────────────

/** A program with `oa` and this area's commands, guarded the way src/index.js guards them. */
function program() {
    const p = new Command();
    p.option("--json").exitOverride();
    p.hook("preAction", (_, cmd) => enforceCliGuard(cmd, { json: Boolean(p.opts().json) }));
    registerUsersCommands(p.command("oa"));
    return p;
}

/** Run `zalo-agent <args>` in process: stdout lines, and the exit code (process.exit or process.exitCode). */
async function cli(args) {
    const out = [];
    const realExit = process.exit;
    const realLog = console.log;
    const realErr = console.error;
    let code = null;
    process.exit = (c) => {
        code = c ?? 0;
        throw new Error("__exit__");
    };
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => out.push(a.join(" "));
    const saved = process.exitCode;
    process.exitCode = undefined;
    _resetErrorLatch();
    try {
        await program().parseAsync(["node", "zalo-agent", ...args]);
    } catch (e) {
        if (e.message !== "__exit__") throw e;
    } finally {
        process.exit = realExit;
        console.log = realLog;
        console.error = realErr;
        if (code === null) code = process.exitCode ?? 0;
        process.exitCode = saved;
    }
    return { code, out: out.join("\n").replace(/\x1b\[[0-9;]*m/g, "") };
}

const GUARDED = [
    ["oa", "follower", "delete-info", USER],
    ["oa", "userfield", "delete", "ma_don_hang"],
    ["oa", "tag", "remove", "VIP"],
    ["oa", "purchase", "create-order", "--product-id", PRODUCT],
    ["oa", "purchase", "confirm-order", "22ffed32d17738296161", "30fVkXZd9j9zWmqQrBhO"],
];

describe("guarded commands send nothing without --yes", () => {
    for (const args of GUARDED) {
        it(`${args.slice(0, 3).join(" ")}: refused (exit 2) without --yes, previewed with --dry-run, sent with --yes`, async () => {
            m = mockFetch();
            const refused = await cli(args);
            assert.equal(refused.code, 2, refused.out);
            assert.equal(m.calls.length, 0);

            const dry = await cli([...args, "--dry-run"]);
            assert.equal(dry.code, 0, dry.out);
            assert.match(dry.out, /Dry run/);
            assert.equal(m.calls.length, 0);

            const done = await cli([...args, "--yes"]);
            assert.equal(done.code, 0, done.out);
            assert.equal(m.calls.length, 1);
            assert.equal(m.calls[0].init.method, "POST");
        });
    }

    it("the refusal names what would happen", async () => {
        m = mockFetch();
        const r = await cli(["--json", "oa", "purchase", "confirm-order", "ORD1", "TOK", "--oa-id", "shop"]);
        assert.equal(r.code, 2);
        assert.match(r.out, /order ORD1/);
        assert.match(r.out, /shop/);
        assert.equal(m.calls.length, 0);
    });
});

describe("command options become the documented requests", () => {
    it("follower update: named flags go under shared_info, --data is merged, flags win", async () => {
        m = mockFetch();
        const r = await cli([
            "oa",
            "follower",
            "update",
            USER,
            "--name",
            "N",
            "--city-id",
            "79",
            "--dob",
            "01/01/1990",
            "--alias",
            "A",
            "--external-id",
            "E1",
            "--data",
            '{"shared_info":{"name":"old","address":"addr"},"user_alias":"old"}',
        ]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(bodyOf(m.calls[0]), {
            user_id: USER,
            shared_info: { name: "N", address: "addr", city_id: 79, user_dob: "01/01/1990" },
            user_alias: "A",
            user_external_id: "E1",
        });
    });

    it("follower update with nothing to update fails (exit 1) and sends nothing", async () => {
        m = mockFetch();
        const r = await cli(["oa", "follower", "update", USER]);
        assert.equal(r.code, 1);
        assert.match(r.out, /nothing to update/);
        assert.equal(m.calls.length, 0);
    });

    it("follower list: filters map to tag_name, last_interaction_period, is_follower; both follower flags clash", async () => {
        m = mockFetch(() => ({
            json: { error: 0, data: { total: 2, offset: 0, users: [{ user_id: "11" }, { user_id: "12" }] } },
        }));
        const r = await cli([
            "oa",
            "follower",
            "list",
            "--tag",
            "VIP",
            "--last-interaction",
            "today",
            "--non-followers",
        ]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(dataOf(m.calls[0]), {
            offset: 0,
            count: 50,
            tag_name: "VIP",
            last_interaction_period: "TODAY",
            is_follower: false,
        });
        assert.match(r.out, /Users: 2 of 2/);
        assert.match(r.out, /- 12/);
        const clash = await cli(["oa", "follower", "list", "--followers-only", "--non-followers"]);
        assert.equal(clash.code, 1);
        assert.equal(m.calls.length, 1);
        const big = await cli(["oa", "follower", "list", "--count", "60"]);
        assert.equal(big.code, 1);
        assert.equal(m.calls.length, 1);
    });

    it("follower custom-info --fields and custom-update <json>", async () => {
        m = mockFetch();
        await cli(["oa", "follower", "custom-info", USER, "--fields", "a, b"]);
        await cli(["oa", "follower", "custom-update", USER, '{"gender":"Khác"}']);
        assert.deepEqual(dataOf(m.calls[0]), { user_id: USER, fields_to_export: ["a", "b"] });
        assert.deepEqual(bodyOf(m.calls[1]), { user_id: USER, gender: "Khác" });
        const bad = await cli(["oa", "follower", "custom-update", USER, "{nope"]);
        assert.equal(bad.code, 1);
        assert.equal(m.calls.length, 2);
    });

    it("userfield create/update/list map their flags", async () => {
        m = mockFetch();
        await cli([
            "oa",
            "userfield",
            "create",
            "orders",
            "Orders",
            "--type",
            "table",
            "--table-fields",
            '[{"key":"paid","data_type":"boolean"}]',
        ]);
        await cli(["oa", "userfield", "update", "orders", "--status", "inactive"]);
        await cli(["oa", "userfield", "list", "--type", "oa_custom"]);
        assert.deepEqual(bodyOf(m.calls[0]), {
            key: "orders",
            name: "Orders",
            data_type: "table",
            additional_fields: [{ key: "paid", data_type: "boolean" }],
        });
        assert.deepEqual(bodyOf(m.calls[1]), { key: "orders", status: "inactive" });
        assert.deepEqual(dataOf(m.calls[2]), { field_type: "oa_custom" });
    });

    it("form get: --from/--to/--offset/--limit become the query; a window past 30 days sends nothing", async () => {
        m = mockFetch(() => ({
            json: {
                error: 0,
                data: {
                    total: 1,
                    questions: [{ questionId: "322", title: "Full name" }],
                    responses: [
                        {
                            leadId: "L1",
                            submitTime: "1623670227",
                            adId: "19",
                            answers: [{ questionId: "322", responses: ["An"] }],
                        },
                    ],
                },
            },
        }));
        const r = await cli(["oa", "form", "get", "F1", "--from", "1621137100", "--to", "1623689999", "--limit", "20"]);
        assert.equal(r.code, 0, r.out);
        const q = Object.fromEntries(new URL(m.calls[0].url).searchParams);
        assert.deepEqual(q, {
            form_id: "F1",
            from_time: "1621137100",
            to_time: "1623689999",
            offset: "0",
            limit: "20",
        });
        assert.match(r.out, /Full name: An/);
        const wide = await cli(["oa", "form", "get", "F1", "--from", "2026-01-01", "--to", "2026-03-01"]);
        assert.equal(wide.code, 1);
        assert.equal(m.calls.length, 1);
    });

    it("tag list prints the string array; --json prints Zalo's answer", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: ["Q1", "Q2"] } }));
        const r = await cli(["oa", "tag", "list"]);
        assert.match(r.out, /Tags \(2\)/);
        assert.match(r.out, /- Q2/);
        const j = await cli(["--json", "oa", "tag", "list"]);
        assert.deepEqual(JSON.parse(j.out).data, ["Q1", "Q2"]);
    });

    it("purchase create-order prints the token and the confirm command", async () => {
        m = mockFetch(() => ({
            json: {
                error: 0,
                data: { order_id: "ORD1", product_name: "P", amount: 10, final_amount: 9, verified_token: "OTT1" },
            },
        }));
        const r = await cli(["oa", "purchase", "create-order", "--redeem-code", "GIFT", "--yes"]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(bodyOf(m.calls[0]), { beneficiary: "OA", redeem_code: "GIFT" });
        assert.match(r.out, /confirm-order ORD1 OTT1 --yes/);
    });
});

describe("follower info output", () => {
    it("shows the OA's alias first, then the Zalo name, and the documented fields", () => {
        const lines = describeFollower({
            user_id: USER,
            display_name: "Zalo Name",
            user_alias: "Alias",
            user_is_follower: false,
            user_last_interaction_date: "06/07/2023",
            tags_and_notes_info: { notes: [""], tag_names: ["VIP"] },
            shared_info: { phone: "84901234567", address: "" },
        });
        assert.equal(lines[0], "Name: Alias (Zalo Name)");
        assert.ok(lines.includes("Follows the OA: no"));
        assert.ok(lines.includes("Last interaction: 06/07/2023"));
        assert.ok(lines.includes("Tags: VIP"));
        assert.ok(lines.includes("Shared phone: 84901234567"));
        assert.ok(!lines.some((l) => l.startsWith("Notes") || l.includes("Shared address")));
        assert.equal(describeFollower({ display_name: "Zalo Name" })[0], "Name: Zalo Name");
    });
});
