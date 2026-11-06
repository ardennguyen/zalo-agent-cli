/**
 * Self-test of the differential harness (tests/helpers/wire-diff, design.md 3.1 and 3.2).
 *
 * Every wire-<area>.test.js trusts this harness to see a difference between zca-js and our engine. So before any
 * of them: plant one difference in each field the harness compares and check that it fails; check that a declared
 * difference passes only while it is really there; and check, through real zca-js calls on both sides of a pair,
 * that what the fake recorded is what went over the wire (decrypted params, query order, multipart parts, the
 * frozen clock, every error shape). Until package K1 lands, both sides of a pair are zca-js (the harness's
 * stand-in); afterwards the pair asks K1's `createApi` for `{engine: "zca"}` on both sides, and this file still
 * holds.
 *
 * Every id here is fake.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { decodeFrame } from "../../src/core/sync-v2/index.js";
import {
    ALLOW,
    GLOBAL,
    T0,
    assertSameListener,
    assertSameWire,
    diffRecords,
    expectGolden,
    freezeTime,
    openListenerPair,
    openPair,
    seedRandom,
} from "../helpers/wire-diff/index.js";
import { flushGolden, goldenEntry, goldenSource } from "../helpers/wire-diff/golden.js";
import { differsFromWebOrder, webQueryOrder } from "../helpers/wire-diff/allow.js";
import { normalizeError, normalizeUpgrade, normalizeValue } from "../helpers/wire-diff/normalize.js";
import { parseMultipart, readBody } from "../helpers/wire-diff/body.js";
import { resolveCreateApi, standInCreateApi } from "../helpers/wire-diff/engines.js";
import { keyFrame, sealFrameData } from "../helpers/fake-zalo/frames.js";
import { settle } from "../helpers/wire-diff/listener-pair.js";
import { installFakeZalo } from "./fake-zalo-session.js";

const GROUP = "1000000000000000001";
const PEER = "2000000000000000002";
const MSG_ID = "3000000000000000003";

/** A JPEG stand-in: the bytes only have to be the same on both sides. */
const AVATAR = Buffer.from("fake-jpeg-bytes-for-the-harness");

/** A deep copy of a record whose `own` side a test may change. */
const clone = (rec) => structuredClone(rec);

/** The AssertionError text of `fn`, or null when it passed. */
function failureOf(fn) {
    try {
        fn();
        return null;
    } catch (e) {
        assert.ok(e instanceof assert.AssertionError, `not an assertion failure: ${e?.stack ?? e}`);
        return e.message;
    }
}

describe("wire-diff harness", () => {
    let pair;
    /** Real records, zca-js on both sides: a POST form call, a GET call, a multipart call, an error. */
    const recs = {};

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        pair = await openPair({ ownEngine: "zca" });
        recs.post = await pair.run("getGroupInfo", [GROUP], { reply: { gridInfoMap: { [GROUP]: { name: "g" } } } });
        recs.get = await pair.run("keepAlive", [], { reply: { config_vesion: 1 } });
        recs.send = await pair.run("sendMessage", ["hi", PEER, 0], { reply: { msgId: MSG_ID } });
        recs.multipart = await pair.run(
            "changeGroupAvatar",
            () => [{ data: Buffer.from(AVATAR), metadata: { width: 10, height: 20 } }, GROUP],
            { reply: {} },
        );
        recs.error = await pair.run("getGroupInfo", [GROUP], {
            error: { inner: { error_code: 114, error_message: "bad" } },
        });
    });

    after(() => pair?.close());

    describe("what a pair records (zca-js on both sides)", () => {
        it("records the call as it went over the wire: decrypted params, service key, query order, form", () => {
            const [req] = recs.post.zca.requests;
            // Red if the params were not decrypted from the form, or the host not mapped back to its service key.
            assert.equal(req.method, "POST");
            assert.equal(req.service, "group");
            assert.equal(req.path, "/api/group/getmg-v2");
            assert.deepEqual(JSON.parse(req.params.gridVerMap), { [GROUP]: 0 });
            assert.deepEqual(req.formOrder, ["params"]);
            assert.equal(typeof req.rawParams, "string");
            assert.deepEqual(recs.post.zca.result, { gridInfoMap: { [GROUP]: { name: "g" } } });
            assert.equal(recs.post.zca.error, null);
        });

        it("keeps the query names in wire order and the params out of `query`", () => {
            const [req] = recs.get.zca.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, "chat");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.equal("params" in req.query, false);
            assert.equal(typeof req.params.imei, "string");
        });

        it("freezes the clock for each side: a clientId stamped from Date.now is t0 on both", () => {
            // Red if run() stopped freezing time: the two sides would stamp whatever the clock said.
            assert.equal(recs.send.zca.requests[0].params.clientId, T0);
            assert.equal(recs.send.own.requests[0].params.clientId, T0);
            assert.equal(recs.send.zca.result.message.msgId, MSG_ID);
        });

        it("splits a multipart body into its parts, with the boundary taken out of the content type", () => {
            const [req] = recs.multipart.zca.requests;
            assert.equal(req.headers["content-type"], "multipart/form-data; boundary=<boundary>");
            assert.equal(req.parts.length, 1);
            assert.deepEqual(
                { name: req.parts[0].name, filename: req.parts[0].filename, type: req.parts[0].type },
                { name: "fileContent", filename: "blob", type: "image/jpeg" },
            );
            assert.equal(req.parts[0].size, AVATAR.length);
            assert.equal(req.params.originHeight, 20);
        });

        it("records an error as {message, code}, and the same failure the same way on both sides", () => {
            assert.deepEqual(recs.error.zca.error, { message: "bad", code: 114 });
            assert.equal(recs.error.zca.result, undefined);
            assertSameWire(recs.error, []);
        });

        it("finds no difference between zca-js and itself, on every kind of call", () => {
            for (const rec of Object.values(recs)) assertSameWire(rec, []);
        });

        it("answers each error shape the way the server would: outer, inner, HTTP 500, undecryptable, sequence", async () => {
            const cases = [
                [
                    { outer: { error_code: 102, error_message: "outer said no" } },
                    { message: "outer said no", code: 102 },
                ],
                [
                    { inner: { error_code: 216, error_message: "inner said no" } },
                    { message: "inner said no", code: 216 },
                ],
                [{ status: 500 }, { message: "Request failed with status code 500", code: null }],
                [{ undecryptable: true }, { message: "Failed to parse response data", code: null }],
            ];
            for (const [error, expected] of cases) {
                const rec = await pair.run("getGroupInfo", [GROUP], { error });
                assert.deepEqual(rec.zca.error, expected, JSON.stringify(error));
                assertSameWire(rec, []);
            }
            // A sequence answers in order and repeats its last answer; each side of a run starts it over.
            const rec = await pair.run("getGroupInfo", [GROUP], {
                replies: { "/getmg-v2": [{ inner: { error_code: 1, error_message: "first" } }, { data: { ok: 2 } }] },
            });
            assert.deepEqual(rec.zca.error, { message: "first", code: 1 });
            assert.deepEqual(rec.own.error, { message: "first", code: 1 });
        });

        it("serves a routeSequence in order, then repeats the last answer", async () => {
            const seq = pair.fake.routeSequence("/x/upload", [{ data: { n: 1 } }, { data: { n: 2 } }]);
            const read = async () =>
                (await fetch(`https://${new URL(pair.fake.serviceMap.file[0]).host}/x/upload`)).json();
            const bodies = [await read(), await read(), await read()];
            pair.fake.clearRoutes();
            assert.equal(seq.served(), 3);
            assert.equal(
                bodies.every((b) => b.error_code === 0 && typeof b.data === "string"),
                true,
            );
            assert.equal(pair.fake.reverseHost("group-poll.zalo.invalid"), "group_poll");
            assert.equal(pair.fake.reverseHost("example.invalid"), null);
        });

        it("names the pair's engines: the stand-in until src/zalo/api.js exists, K1's createApi after", async () => {
            const { standIn } = await resolveCreateApi();
            assert.equal(pair.standIn, standIn);
            if (standIn) {
                await assert.rejects(standInCreateApi({}, {}, [], { engine: "own" }), /not available yet.*K1/);
                await assert.rejects(openPair(), /not available yet/);
            }
        });
    });

    describe("a planted difference fails, in every compared field", () => {
        /** Each change makes the own side differ from zca-js in one field; the failure must name that field. */
        const plants = [
            ["method", (r) => (r.requests[0].method = "GET"), "method"],
            ["service", (r) => (r.requests[0].service = "group_poll"), "service"],
            ["path", (r) => (r.requests[0].path = "/api/group/getmg-v3"), "path"],
            ["query order", (r) => r.requests[0].queryOrder.reverse(), "queryOrder"],
            ["a query value", (r) => (r.requests[0].query.zpw_ver = "694"), "query.zpw_ver"],
            ["a param value", (r) => (r.requests[0].params.gridVerMap = "{}"), "params.gridVerMap"],
            ["a param key", (r) => (r.requests[0].params.nretry = 0), "params.nretry"],
            [
                "param key order",
                (r) => (r.requests[0].paramsOrder = ["x", ...r.requests[0].paramsOrder]),
                "paramsOrder",
            ],
            ["the encrypted bytes", (r) => (r.requests[0].rawParams = `${r.requests[0].rawParams}x`), "rawParams"],
            [
                "a header",
                (r) => (r.requests[0].headers["accept-language"] = "vi-VN,vi;q=0.9"),
                "headers.accept-language",
            ],
            ["a missing header", (r) => delete r.requests[0].headers.referer, "headers.referer"],
            ["a form field", (r) => (r.requests[0].form.extra = "1"), "form.extra"],
            ["the result", (r) => (r.result.gridInfoMap[GROUP].name = "h"), `result.gridInfoMap.${GROUP}.name`],
            ["an extra request", (r) => r.requests.push(structuredClone(r.requests[0])), "requests.length"],
        ];
        for (const [what, change, field] of plants) {
            it(`a different ${what}`, () => {
                const rec = clone(recs.post);
                change(rec.own);
                const failure = failureOf(() => assertSameWire(rec, []));
                assert.ok(failure, `a different ${what} passed`);
                assert.match(failure, new RegExp(`differs: ${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
            });
        }

        it("a different multipart part (bytes, name, count)", () => {
            for (const change of [
                (p) => (p[0].sha256 = "0".repeat(64)),
                (p) => (p[0].name = "file"),
                (p) => p.push({ ...p[0] }),
            ]) {
                const rec = clone(recs.multipart);
                change(rec.own.requests[0].parts);
                assert.match(failureOf(() => assertSameWire(rec, [])) ?? "", /differs: parts/);
            }
        });

        it("a different error code, a different message, and an error on one side only", () => {
            const code = clone(recs.error);
            code.own.error.code = 115;
            assert.match(failureOf(() => assertSameWire(code, [])) ?? "", /differs: error\.code/);
            const message = clone(recs.error);
            message.own.error.message = "other";
            assert.match(failureOf(() => assertSameWire(message, [])) ?? "", /differs: error\.message/);
            const oneSide = clone(recs.post);
            oneSide.own.error = { message: "boom", code: null };
            delete oneSide.own.result;
            const failure = failureOf(() => assertSameWire(oneSide, [])) ?? "";
            assert.match(failure, /differs: result/);
            assert.match(failure, /differs: error/);
        });

        it("names every difference at once, not just the first", () => {
            const rec = clone(recs.post);
            rec.own.requests[0].service = "group_poll";
            rec.own.requests[0].path = "/elsewhere";
            const failure = failureOf(() => assertSameWire(rec, [])) ?? "";
            assert.match(failure, /differs: service/);
            assert.match(failure, /differs: path/);
            assert.deepEqual(
                diffRecords(rec).map((d) => [d.field, d.index]),
                [
                    ["service", 0],
                    ["path", 0],
                ],
            );
        });
    });

    describe("declared differences", () => {
        const pollRow = {
            method: "getGroupInfo",
            field: "service",
            zca: "group",
            own: "group_poll",
            why: "planted for the self-test",
        };

        it("a declared difference that is present passes", () => {
            const rec = clone(recs.post);
            rec.own.requests[0].service = "group_poll";
            assertSameWire(rec, [pollRow]);
        });

        it("a declared difference that is absent fails: a row cannot go stale silently", () => {
            assert.match(failureOf(() => assertSameWire(recs.post, [pollRow])) ?? "", /declared but absent: service/);
        });

        it("a declared difference with other values does not cover what was seen", () => {
            const rec = clone(recs.post);
            rec.own.requests[0].service = "group_board";
            const failure = failureOf(() => assertSameWire(rec, [pollRow])) ?? "";
            assert.match(failure, /differs: service/);
            assert.match(failure, /declared but absent: service/);
        });

        it("a row for another method allows nothing here", () => {
            const rec = clone(recs.post);
            rec.own.requests[0].service = "group_poll";
            assert.match(
                failureOf(() => assertSameWire(rec, [{ ...pollRow, method: "getAllGroups" }])) ?? "",
                /differs: service/,
            );
        });

        it("predicates and `.*` fields", () => {
            const rec = clone(recs.post);
            rec.own.requests[0].params.extra = 1;
            rec.own.requests[0].paramsOrder.push("extra");
            const rows = [
                { method: "getGroupInfo", field: "params.*", zca: undefined, own: (v) => v === 1, why: "self-test" },
                {
                    method: "getGroupInfo",
                    field: "paramsOrder",
                    zca: () => true,
                    own: (v) => v.at(-1) === "extra",
                    why: "self-test",
                },
            ];
            assertSameWire(rec, rows);
        });

        it("refuses a malformed row instead of allowing nothing or everything", () => {
            for (const bad of [
                { method: "getGroupInfo", field: "service", zca: "group", own: "x" },
                { method: "getGroupInfo", field: "service", zca: "group", why: "no own" },
                { method: "*", field: "service", zca: "group", own: "x", why: "a global row without when" },
            ]) {
                assert.ok(
                    failureOf(() => assertSameWire(recs.post, [bad])),
                    JSON.stringify(bad),
                );
            }
        });

        describe("the global rows", () => {
            const d1 = GLOBAL.find((r) => r.id === "D1");

            /** A record whose zca side has zca-js's query order, and whose own side has `ownOrder`. */
            function orderRecord(ownOrder) {
                const rec = clone(recs.get);
                rec.zca.requests[0].queryOrder = ["params", "zpw_ver", "zpw_type"];
                rec.own.requests[0].queryOrder = ownOrder;
                return rec;
            }

            it("D1 allows the Web's order where zca-js appends zpw_ver and zpw_type", () => {
                assert.equal(differsFromWebOrder(["params", "zpw_ver", "zpw_type"]), true);
                assert.equal(differsFromWebOrder(["zpw_ver", "zpw_type", "params"]), false);
                assert.equal(differsFromWebOrder(["zpw_ver", "zpw_type", "nretry"]), true);
                assert.equal(differsFromWebOrder(["params"]), false, "no version pair: not a D1 request");
                assert.deepEqual(webQueryOrder(["nretry", "params", "os", "zpw_ver", "zpw_type"]), [
                    "zpw_ver",
                    "zpw_type",
                    "params",
                    "os",
                ]);
                assertSameWire(orderRecord(["zpw_ver", "zpw_type", "params"]), [d1]);
            });

            it("D1 must be present where it applies, and allows no other order", () => {
                assert.match(
                    failureOf(() => assertSameWire(orderRecord(["params", "zpw_ver", "zpw_type"]), [d1])) ?? "",
                    /declared but absent: queryOrder \[0\]/,
                );
                assert.match(
                    failureOf(() => assertSameWire(orderRecord(["zpw_type", "zpw_ver", "params"]), [d1])) ?? "",
                    /differs: queryOrder/,
                );
            });

            it("a global row is not required where its `when` does not hold", () => {
                // zca-js's own keepAlive already sends zpw_ver first: D1 does not apply, both must agree.
                assertSameWire(recs.get, [d1]);
            });

            it("D2, D3, D4 and nretry describe zca-js as it is: each applies to a real zca-js request", () => {
                const row = (id) => GLOBAL.find((r) => r.id === id);
                const get = { zca: recs.get.zca.requests[0] };
                const send = { zca: recs.send.zca.requests[0] };
                // Red if zca-js stops sending what a row claims: the row would then never apply, and go stale.
                assert.equal(row("D2").when(get), true, "zca-js sends a form content type on a GET");
                assert.equal(row("D3").when(get), true, "zca-js sends its fixed Accept-Language");
                assert.equal(row("D4").when(get), true, "zca-js sends its hand-set Accept-Encoding");
                assert.equal(row("nretry").when(send), true, "zca-js puts nretry=0 in a send's query");
                assert.equal(row("D1").when(send), true, "zca-js's send query is not the Web's");
            });

            it("a send made the Web way passes the global rows, and only all of them together", () => {
                // The own side as the specs describe our engine: the Web's query order without nretry, no
                // Accept-Encoding set by hand, the browser's Accept-Language.
                const rec = clone(recs.send);
                const own = rec.own.requests[0];
                own.queryOrder = webQueryOrder(rec.zca.requests[0].queryOrder);
                delete own.query.nretry;
                delete own.headers["accept-encoding"];
                own.headers["accept-language"] = "vi-VN,vi;q=0.9,en;q=0.8";
                assertSameWire(rec, GLOBAL);
                // Without the nretry row the missing nretry is an unexplained difference.
                const failure =
                    failureOf(() =>
                        assertSameWire(
                            rec,
                            GLOBAL.filter((r) => r.id !== "nretry"),
                        ),
                    ) ?? "";
                assert.match(failure, /differs: query\.nretry/);
            });

            it("every area's list starts with the global rows, and an area row shadows a global one", () => {
                for (const [area, rows] of Object.entries(ALLOW)) {
                    assert.deepEqual(rows.slice(0, GLOBAL.length), [...GLOBAL], area);
                }
                const rec = orderRecord(["params", "zpw_ver", "zpw_type"]);
                rec.own.requests[0].queryOrder = ["zpw_type", "params", "zpw_ver"];
                const areaRow = {
                    method: "keepAlive",
                    field: "queryOrder",
                    zca: () => true,
                    own: (v) => v[0] === "zpw_type",
                    why: "self-test",
                };
                assertSameWire(rec, [d1, areaRow]);
            });
        });
    });

    describe("golden files", () => {
        let dir;
        before(() => {
            dir = mkdtempSync(join(tmpdir(), "wire-golden-"));
        });
        after(() => rmSync(dir, { recursive: true, force: true }));

        it("records, then matches its own record and fails on a change", async () => {
            const saved = process.env.WIRE_GOLDEN_RECORD;
            process.env.WIRE_GOLDEN_RECORD = "harness";
            try {
                await expectGolden("harness", "getGroupInfo", recs.post.own, { dir });
                await expectGolden("harness", "changeGroupAvatar", recs.multipart.own, { dir });
                await assert.rejects(expectGolden("harness", "getGroupInfo", recs.post.own, { dir }), /recorded twice/);
            } finally {
                if (saved === undefined) delete process.env.WIRE_GOLDEN_RECORD;
                else process.env.WIRE_GOLDEN_RECORD = saved;
            }
            const written = flushGolden();
            assert.deepEqual(written, [join(dir, "harness.js")]);

            await expectGolden("harness", "getGroupInfo", recs.post.own, { dir });
            await expectGolden("harness", "changeGroupAvatar", recs.multipart.own, { dir });
            const changed = clone(recs.post.own);
            changed.requests[0].params.gridVerMap = "{}";
            await assert.rejects(expectGolden("harness", "getGroupInfo", changed, { dir }), /no longer matches/);
            await assert.rejects(
                expectGolden("harness", "keepAlive", recs.get.own, { dir }),
                /no entry "keepAlive".*record\.mjs harness/,
            );
            await assert.rejects(
                expectGolden("nothing-here", "x", recs.get.own, { dir }),
                /no file golden\/nothing-here\.js/,
            );
        });

        it("keeps no encrypted params in an entry, and writes a module", () => {
            const entry = goldenEntry(recs.post.own);
            assert.equal("rawParams" in entry.requests[0], false);
            assert.deepEqual(entry.requests[0].params, recs.post.own.requests[0].params);
            const file = join(dir, "source.js");
            writeFileSync(file, goldenSource("source", { b: { x: 1 }, a: { y: 2 } }));
            return import(pathToFileURL(file).href).then((m) => assert.deepEqual(Object.keys(m.default), ["a", "b"]));
        });
    });

    describe("listener pair (zca-js on both sides)", () => {
        let lp;
        let played;
        const authData = { qCmds: [{ cmd: 510, subCmd: 1, queueName: "510_1" }], ctrl_qCmds: [], bk_cmds: [] };
        const msg = (msgId, content, extra = {}) => ({
            msgId,
            cliMsgId: "1700000000001",
            uidFrom: PEER,
            idTo: "0",
            dName: "Fake Peer",
            ts: "1700000000000",
            msgType: "webchat",
            content,
            ...extra,
        });

        before(async () => {
            lp = await openListenerPair({ ownEngine: "zca", socket: { authData } });
            await lp.start();
            played = await lp.play([
                {
                    cmd: 501,
                    encrypt: 2,
                    body: { error_code: 0, error_message: "", data: { msgs: [msg("5000000000000000005", "hello")] } },
                },
                {
                    cmd: 521,
                    encrypt: 1,
                    zip: "gzip",
                    body: {
                        error_code: 0,
                        error_message: "",
                        data: { groupMsgs: [msg("5000000000000000006", "group hi", { idTo: GROUP })] },
                    },
                },
                { text: "a text frame is ignored" },
            ]);
            lp.zca.listener.requestOldMessages(0, null);
            lp.own.listener.requestOldMessages(0, null);
            await lp.settle();
            played = lp.snapshot();
        });

        after(async () => {
            await lp?.close();
        });

        it("both listeners decoded the sealed frames into the same events", () => {
            // Red if a frame were not delivered, or not decoded: the contents come only from the sealed bodies.
            const contents = (events) => events.filter((e) => e.name === "message").map((e) => e.args[0].data.content);
            assert.deepEqual(contents(played.zca), ["hello", "group hi"]);
            assert.deepEqual(contents(played.own), ["hello", "group hi"]);
            assert.equal(
                played.zca.some((e) => e.name === "cipher_key"),
                true,
            );
            assertSameListener(played, []);
        });

        it("records each client's frames and its upgrade, without the per-connection noise", () => {
            assert.deepEqual(
                played.zcaSent.map((f) => [f.cmd, f.sub, f.data.reqId]),
                [[510, 1, "req_<n>"]],
            );
            assert.equal(played.headers.zca.headers.origin, "https://chat.zalo.me");
            assert.equal("host" in played.headers.zca.headers, false);
            assert.equal("sec-websocket-key" in played.headers.zca.headers, false);
            assert.match(played.headers.zca.url, /t=%3Ct%3E/);
            const raw = normalizeUpgrade({
                url: "/?t=1&a=b",
                headers: { host: "h", x: "1" },
                rawHeaders: ["Host", "h", "X", "1"],
            });
            assert.deepEqual(raw, { url: "/?t=%3Ct%3E&a=b", headers: { x: "1" }, names: ["X"] });
        });

        it("a planted difference in an event, a frame or the upgrade fails; an extra event fails unless declared", () => {
            const event = structuredClone(played);
            event.own.find((e) => e.name === "message").args[0].data.content = "changed";
            assert.match(
                failureOf(() => assertSameListener(event, [])) ?? "",
                /differs: event\.args\.0\.data\.content/,
            );

            const frame = structuredClone(played);
            frame.ownSent[0].data.lastId = "1";
            assert.match(failureOf(() => assertSameListener(frame, [])) ?? "", /differs: sent\.data\.lastId/);

            const bytes = structuredClone(played);
            bytes.ownSent[0].bytes += "00";
            assert.match(failureOf(() => assertSameListener(bytes, [])) ?? "", /differs: sent\.bytes/);

            const header = structuredClone(played);
            header.headers.own.headers.pragma = header.headers.own.headers.prgama ?? "no-cache";
            delete header.headers.own.headers.prgama;
            assert.match(failureOf(() => assertSameListener(header, [])) ?? "", /differs: upgrade\.headers/);

            const extra = structuredClone(played);
            extra.own.push({ name: "reaction", args: [{ threadId: PEER }] });
            assert.match(failureOf(() => assertSameListener(extra, [])) ?? "", /differs: event /);
            const declared = {
                method: "extra-reaction",
                field: "event",
                zca: undefined,
                own: (e) => e.name === "reaction",
                why: "self-test: an event only our listener emits",
            };
            assertSameListener(extra, [declared], { name: "extra-reaction" });
            assert.match(
                failureOf(() => assertSameListener(played, [declared], { name: "extra-reaction" })) ?? "",
                /declared but absent/,
            );
        });
    });

    describe("pieces", () => {
        it("the CLI preload logs what the harness compares: url, query order, headers, form, parts", () => {
            const dir = mkdtempSync(join(tmpdir(), "wire-offline-"));
            try {
                const log = join(dir, "requests.jsonl");
                const preload = pathToFileURL(join(import.meta.dirname, "support", "offline-session.js")).href;
                const script = [
                    'const fd = new FormData(); fd.append("fileContent", new Blob(["abc"], {type: "image/jpeg"}), "blob");',
                    'await fetch("https://file.offline.invalid/api/x?zpw_ver=1&zpw_type=30", {method: "POST", body: fd});',
                    'await fetch("https://chat.offline.invalid/api/y?b=2&a=1", {method: "POST", body: new URLSearchParams({k: "v"})});',
                ].join("\n");
                execFileSync(process.execPath, ["--import", preload, "--input-type=module", "-e", script], {
                    env: { ...process.env, ZALO_OFFLINE_LOG: log },
                    stdio: "pipe",
                });
                const [multipart, form] = readFileSync(log, "utf8")
                    .trim()
                    .split("\n")
                    .map((l) => JSON.parse(l));
                assert.deepEqual(multipart.queryOrder, ["zpw_ver", "zpw_type"]);
                assert.match(multipart.headers["content-type"], /^multipart\/form-data; boundary=/);
                assert.deepEqual(
                    multipart.parts.map((x) => [x.name, x.filename, x.type, x.size]),
                    [["fileContent", "blob", "image/jpeg", 3]],
                );
                assert.deepEqual(form.queryOrder, ["b", "a"]);
                assert.deepEqual(form.form, { k: "v" });
                assert.equal(form.url, "https://chat.offline.invalid/api/y?b=2&a=1");
                assert.equal(form.rawParams, null);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it("freezeTime freezes Date.now and new Date(), keeps instanceof, and restores", () => {
            const early = new Date();
            const clock = freezeTime(T0);
            try {
                assert.equal(Date.now(), T0);
                assert.equal(new Date().getTime(), T0);
                assert.equal(new Date(5).getTime(), 5);
                assert.equal(early instanceof Date, true);
                clock.advance(10);
                assert.equal(Date.now(), T0 + 10);
            } finally {
                clock.restore();
            }
            assert.notEqual(Date.now(), T0 + 10);
        });

        it("seedRandom repeats its sequence for a seed, and restores", () => {
            const real = Math.random;
            const r = seedRandom(7);
            const a = [Math.random(), Math.random()];
            r.reseed(7);
            const b = [Math.random(), Math.random()];
            r.restore();
            assert.deepEqual(a, b);
            assert.notEqual(a[0], a[1]);
            assert.equal(Math.random, real);
        });

        it("normalizes what engines hand out: bigints, big numbers, class instances, undefined, errors", () => {
            class Model {
                constructor() {
                    this.id = 1n;
                    this.gone = undefined;
                    this.when = new Date(0);
                }
            }
            const big = { _isBigNumber: true, toFixed: () => "12345678901234567890" };
            assert.deepEqual(normalizeValue({ m: new Model(), big, list: [undefined, Buffer.from("a")] }), {
                m: { id: "1", when: "1970-01-01T00:00:00.000Z" },
                big: "12345678901234567890",
                list: [null, { type: "Buffer", base64: "YQ==" }],
            });
            assert.deepEqual(normalizeError(Object.assign(new Error("x"), { code: 5 })), { message: "x", code: 5 });
            assert.deepEqual(normalizeError("plain"), { message: "plain", code: null });
        });

        it("reads every body shape a client hands to fetch, and splits multipart by its boundary", async () => {
            const fd = new globalThis.FormData();
            fd.append(
                "chunkContent",
                new globalThis.Blob([Buffer.from("abc")], { type: "application/octet-stream" }),
                "a.bin",
            );
            fd.append("note", "x");
            const { bytes, contentType } = await readBody(fd);
            const parts = parseMultipart(bytes, contentType);
            assert.deepEqual(
                parts.map((p) => [p.name, p.filename, p.type, p.bytes.toString()]),
                [
                    ["chunkContent", "a.bin", "application/octet-stream", "abc"],
                    ["note", null, null, "x"],
                ],
            );
            assert.equal((await readBody(new URLSearchParams({ a: "1" }))).bytes.toString(), "a=1");
            assert.equal((await readBody("s")).bytes.toString(), "s");
            assert.equal((await readBody(new Uint8Array([104, 105]))).bytes.toString(), "hi");
            assert.equal((await readBody({ getBuffer: () => Buffer.from("fd") })).bytes.toString(), "fd");
            assert.deepEqual(await readBody(undefined), { bytes: null, contentType: null });
            assert.equal(parseMultipart(Buffer.from("x"), "text/plain"), null);
        });

        it("seals frame data so the engine's decoder opens it: encrypt 0-3, zlib and gzip, 16- and 32-byte keys", () => {
            const body = { error_code: 0, error_message: "", data: { n: 1, text: "Tiếng Việt" } };
            for (const key of [Buffer.alloc(16, 3).toString("base64"), Buffer.alloc(32, 4).toString("base64")]) {
                for (const encrypt of [0, 1, 2, 3]) {
                    for (const zip of ["zlib", "gzip"]) {
                        const data = sealFrameData({ body, encrypt, key, zip });
                        assert.deepEqual(decodeFrame({ encrypt, data }, key), body, `encrypt ${encrypt} ${zip}`);
                    }
                }
            }
            const wrong = sealFrameData({ body, encrypt: 2, key: Buffer.alloc(32, 4).toString("base64") });
            assert.throws(() => decodeFrame({ encrypt: 2, data: wrong }, Buffer.alloc(32, 5).toString("base64")));
            const kf = keyFrame({ key: Buffer.alloc(16, 6).toString("base64"), authData: { qCmds: [1] } });
            const top = JSON.parse(kf.subarray(4).toString("utf8"));
            assert.deepEqual([kf.readUInt16LE(1), kf[3], top.encrypt], [1, 1, 2]);
            assert.deepEqual(decodeFrame(top, top.key).data, { qCmds: [1] });
        });
    });
});

describe("wire-diff harness: the run's clock", () => {
    /**
     * An engine in the shape of design 1.2: `s.now()` is `opts.now ?? Date.now`, bound while the engine is built,
     * and its clientId source is seeded from the clock at build time too. `wait` resolves only once `s.now()` has
     * moved by `ms`, as an upload's replay-last-chunk delay does.
     */
    function clockEngine(_ctx, _map, _ws, opts = {}) {
        const now = opts.now ?? Date.now;
        const bound = Date.now;
        let last = Date.now();
        return {
            stamp: async () => ({
                injected: typeof opts.now === "function",
                now: now(),
                bound: bound(),
                next: (last = Math.max(now(), last + 1)),
            }),
            wait: async (ms, tries = 400) => {
                const from = now();
                for (let i = 0; i < tries && now() - from < ms; i++) await new Promise((r) => setTimeout(r, 5));
                return now() - from >= ms ? "moved" : "stood still";
            },
        };
    }

    it("installs the clock before it builds each engine and injects it: a clock bound at build time reads t0", async () => {
        const pair = await openPair({ createApi: clockEngine });
        try {
            const rec = await pair.run("stamp");
            // Red if run() builds the engine before freezing time: `now`, `bound` and `next` would be the real
            // time (and `next` would differ between the sides), or if `now` were not passed to createApi.
            const want = { injected: true, now: T0, bound: T0, next: T0 + 1 };
            assert.deepEqual(rec.zca.result, want);
            assert.deepEqual(rec.own.result, want);
            assertSameWire(rec, []);
        } finally {
            pair.close();
        }
    });

    it("hands the run's clock to `during`, so a wait measured against s.now() can be moved on", async () => {
        const pair = await openPair({ createApi: clockEngine });
        try {
            const sides = [];
            const rec = await pair.run("wait", [5000], {
                during: (clock, side) => {
                    sides.push(side);
                    clock.advance(5000);
                },
            });
            // Red if `during` were not called, or got another clock than the one the engine reads.
            assert.deepEqual(sides, ["zca", "own"]);
            assert.equal(rec.zca.result, "moved");
            assert.equal(rec.own.result, "moved");
            // Without `during` time stands still for the whole call.
            assert.equal((await pair.run("wait", [5, 10])).own.result, "stood still");
            await assert.rejects(
                pair.run("stamp", [], {
                    during: () => {
                        throw new Error("the test's own mistake");
                    },
                }),
                /the test's own mistake/,
            );
        } finally {
            pair.close();
        }
    });
});

describe("wire-diff harness: listener settle", () => {
    it("after a push, waits for the first event even when it comes later than one quiet interval", async () => {
        let n = 0;
        setTimeout(() => (n = 2), 80);
        // Red with a settle that returns after the first quiet interval: n would still be 0.
        await settle(() => n, { quietMs: 10, maxMs: 2000, from: 0, growMs: 1000 });
        assert.equal(n, 2);
    });

    it("waits until both listeners emitted as many events, up to its limit", async () => {
        let zca = 1;
        const own = 2;
        setTimeout(() => (zca = 2), 80);
        // Red without the balance check: the count is stable from the start, so it would return before zca caught up.
        await settle(() => zca + own, { quietMs: 10, maxMs: 2000, balanced: () => zca === own });
        assert.equal(zca, 2);
        const t0 = performance.now();
        await settle(() => 1, { quietMs: 10, maxMs: 100, balanced: () => false });
        assert.ok(performance.now() - t0 >= 95, "a lasting imbalance ends at maxMs");
    });

    it("a frame nobody reacts to costs growMs, not maxMs", async () => {
        const t0 = performance.now();
        await settle(() => 0, { quietMs: 10, maxMs: 2000, from: 0, growMs: 50 });
        assert.ok(performance.now() - t0 < 1000);
    });
});

describe("wire-diff harness: the fake's early params", () => {
    it("lets a request whose params no session key opens reach a raw route, with params null", async () => {
        const fake = installFakeZalo();
        try {
            const host = fake.serviceMap.group[0];
            let seen;
            fake.rawRoute(
                (r) => r.path.endsWith("/negative"),
                (r) => {
                    seen = r.params;
                    return new Response("answered by the raw route", { status: 200 });
                },
            );
            // Red if the early decrypt threw again: the fetch would reject before the raw route ran.
            const res = await fetch(`${host}/api/group/negative?params=not-a-session-cipher`);
            assert.equal(await res.text(), "answered by the raw route");
            assert.equal(seen, null);
        } finally {
            fake.uninstall();
        }
    });
});
