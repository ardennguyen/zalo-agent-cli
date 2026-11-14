/**
 * Self-test of the wire harness (tests/helpers/wire-diff, design.md 3.1 to 3.3).
 *
 * Every wire-<area>.test.js trusts this harness to record what our engine put on the wire and to fail when that
 * changes. So before any of them: check, through real calls of the engine, that what the fake recorded is what
 * went over the wire (decrypted params, query order, multipart parts, the frozen clock, every error shape); and
 * plant one change in each field a golden entry holds and check that the golden comparison fails on it.
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
import { T0, expectGolden, freezeTime, openListenerWire, openWire, seedRandom } from "../helpers/wire-diff/index.js";
import { flushGolden, goldenEntry, goldenSource } from "../helpers/wire-diff/golden.js";
import { normalizeError, normalizeUpgrade, normalizeValue } from "../helpers/wire-diff/normalize.js";
import { parseMultipart, readBody } from "../helpers/wire-diff/body.js";
import { keyFrame, sealFrameData } from "../helpers/fake-zalo/frames.js";
import { settle } from "../helpers/wire-diff/listener-wire.js";
import { installFakeZalo } from "./fake-zalo-session.js";

const GROUP = "1000000000000000001";
const PEER = "2000000000000000002";
const MSG_ID = "3000000000000000003";

/** A JPEG stand-in: nothing decodes it. */
const AVATAR = Buffer.from("fake-jpeg-bytes-for-the-harness");

/** A deep copy of a record whose `own` side a test may change. */
const clone = (rec) => structuredClone(rec);

describe("wire-diff harness", () => {
    let wire;
    /** Real records of our engine: a POST form call, a GET call, a send, a multipart call, an error. */
    const recs = {};

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        wire = await openWire();
        recs.post = await wire.run("getGroupInfo", [GROUP], { reply: { gridInfoMap: { [GROUP]: { name: "g" } } } });
        recs.get = await wire.run("keepAlive", [], { reply: { config_vesion: 1 } });
        recs.send = await wire.run("sendMessage", ["hi", PEER, 0], { reply: { msgId: MSG_ID } });
        recs.multipart = await wire.run(
            "changeGroupAvatar",
            () => [{ data: Buffer.from(AVATAR), metadata: { width: 10, height: 20 } }, GROUP],
            { reply: {} },
        );
        recs.error = await wire.run("getGroupInfo", [GROUP], {
            error: { inner: { error_code: 114, error_message: "bad" } },
        });
    });

    after(() => wire?.close());

    describe("what a run records", () => {
        it("records the call as it went over the wire: decrypted params, service key, query order, form", () => {
            const [req] = recs.post.own.requests;
            // Red if the params were not decrypted from the form, or the host not mapped back to its service key.
            assert.equal(req.method, "POST");
            assert.equal(req.service, "group");
            assert.equal(req.path, "/api/group/getmg-v2");
            assert.deepEqual(JSON.parse(req.params.gridVerMap), { [GROUP]: 0 });
            assert.deepEqual(req.formOrder, ["params"]);
            assert.equal(typeof req.rawParams, "string");
            assert.deepEqual(recs.post.own.result, { gridInfoMap: { [GROUP]: { name: "g" } } });
            assert.equal(recs.post.own.error, null);
            assert.equal(recs.post.name, "getGroupInfo");
            assert.deepEqual(recs.post.args, [GROUP]);
        });

        it("keeps the query names in wire order and the params out of `query`", () => {
            const [req] = recs.get.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, "chat");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.equal("params" in req.query, false);
            assert.equal(typeof req.params.imei, "string");
        });

        it("freezes the clock for each run: a clientId stamped from the session clock is t0", () => {
            // Red if run() stopped freezing time: the send would stamp whatever the clock said.
            assert.equal(recs.send.own.requests[0].params.clientId, T0);
            assert.equal(recs.send.own.result.message.msgId, MSG_ID);
        });

        it("splits a multipart body into its parts, with the boundary taken out of the content type", () => {
            const [req] = recs.multipart.own.requests;
            assert.equal(req.headers["content-type"], "multipart/form-data; boundary=<boundary>");
            assert.equal(req.parts.length, 1);
            assert.deepEqual(
                { name: req.parts[0].name, filename: req.parts[0].filename, type: req.parts[0].type },
                { name: "fileContent", filename: "blob", type: "image/jpeg" },
            );
            assert.equal(req.parts[0].size, AVATAR.length);
            assert.equal(req.params.originHeight, 20);
        });

        it("records an error as {message, code}, and no result", () => {
            assert.deepEqual(recs.error.own.error, { message: "bad", code: 114 });
            assert.equal(recs.error.own.result, undefined);
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
                [{ status: 500 }, { message: "HTTP 500", code: null }],
                [{ undecryptable: true }, { message: "Failed to parse response data", code: null }],
            ];
            for (const [error, expected] of cases) {
                const rec = await wire.run("getGroupInfo", [GROUP], { error });
                assert.deepEqual(rec.own.error, expected, JSON.stringify(error));
            }
            // A sequence answers in order and repeats its last answer; each run starts it over.
            for (let i = 0; i < 2; i++) {
                const rec = await wire.run("getGroupInfo", [GROUP], {
                    replies: {
                        "/getmg-v2": [{ inner: { error_code: 1, error_message: "first" } }, { data: { ok: 2 } }],
                    },
                });
                assert.deepEqual(rec.own.error, { message: "first", code: 1 }, `run ${i + 1}`);
            }
        });

        it("serves a routeSequence in order, then repeats the last answer", async () => {
            const seq = wire.fake.routeSequence("/x/upload", [{ data: { n: 1 } }, { data: { n: 2 } }]);
            const read = async () =>
                (await fetch(`https://${new URL(wire.fake.serviceMap.file[0]).host}/x/upload`)).json();
            const bodies = [await read(), await read(), await read()];
            wire.fake.clearRoutes();
            assert.equal(seq.served(), 3);
            assert.equal(
                bodies.every((b) => b.error_code === 0 && typeof b.data === "string"),
                true,
            );
            assert.equal(wire.fake.reverseHost("group-poll.zalo.invalid"), "group_poll");
            assert.equal(wire.fake.reverseHost("example.invalid"), null);
        });
    });

    describe("golden files", () => {
        let dir;
        before(async () => {
            dir = mkdtempSync(join(tmpdir(), "wire-golden-"));
            const saved = process.env.WIRE_GOLDEN_RECORD;
            process.env.WIRE_GOLDEN_RECORD = "harness";
            try {
                await expectGolden("harness", "getGroupInfo", recs.post.own, { dir });
                await expectGolden("harness", "changeGroupAvatar", recs.multipart.own, { dir });
                await expectGolden("harness", "error", recs.error.own, { dir });
                await assert.rejects(expectGolden("harness", "getGroupInfo", recs.post.own, { dir }), /recorded twice/);
            } finally {
                if (saved === undefined) delete process.env.WIRE_GOLDEN_RECORD;
                else process.env.WIRE_GOLDEN_RECORD = saved;
            }
            assert.deepEqual(flushGolden(), [join(dir, "harness.js")]);
        });
        after(() => rmSync(dir, { recursive: true, force: true }));

        it("records, then matches its own record, and names a missing entry or file", async () => {
            await expectGolden("harness", "getGroupInfo", recs.post.own, { dir });
            await expectGolden("harness", "changeGroupAvatar", recs.multipart.own, { dir });
            await expectGolden("harness", "error", recs.error.own, { dir });
            await assert.rejects(
                expectGolden("harness", "keepAlive", recs.get.own, { dir }),
                /no entry "keepAlive".*record\.mjs harness/,
            );
            await assert.rejects(
                expectGolden("nothing-here", "x", recs.get.own, { dir }),
                /no file golden\/nothing-here\.js/,
            );
        });

        /** Each change makes our side differ from its golden entry in one field. */
        const plants = [
            ["method", (r) => (r.requests[0].method = "GET")],
            ["service", (r) => (r.requests[0].service = "group_poll")],
            ["path", (r) => (r.requests[0].path = "/api/group/getmg-v3")],
            ["query order", (r) => r.requests[0].queryOrder.reverse()],
            ["a query value", (r) => (r.requests[0].query.zpw_ver = "694")],
            ["a param value", (r) => (r.requests[0].params.gridVerMap = "{}")],
            ["a param key", (r) => (r.requests[0].params.nretry = 0)],
            ["param key order", (r) => (r.requests[0].paramsOrder = ["x", ...r.requests[0].paramsOrder])],
            ["a header", (r) => (r.requests[0].headers["accept-language"] = "vi-VN,vi;q=0.9")],
            ["a missing header", (r) => delete r.requests[0].headers.referer],
            ["a form field", (r) => (r.requests[0].form.extra = "1")],
            ["the result", (r) => (r.result.gridInfoMap[GROUP].name = "h")],
            ["an extra request", (r) => r.requests.push(structuredClone(r.requests[0]))],
            ["an error instead of the result", (r) => (r.error = { message: "boom", code: null })],
        ];
        for (const [what, change] of plants) {
            it(`fails on a different ${what}`, async () => {
                const own = clone(recs.post.own);
                change(own);
                await assert.rejects(expectGolden("harness", "getGroupInfo", own, { dir }), /no longer matches/);
            });
        }

        it("fails on a different multipart part (bytes, name, count)", async () => {
            for (const change of [
                (p) => (p[0].sha256 = "0".repeat(64)),
                (p) => (p[0].name = "file"),
                (p) => p.push({ ...p[0] }),
            ]) {
                const own = clone(recs.multipart.own);
                change(own.requests[0].parts);
                await assert.rejects(expectGolden("harness", "changeGroupAvatar", own, { dir }), /no longer matches/);
            }
        });

        it("fails on a different error code or message", async () => {
            const code = clone(recs.error.own);
            code.error.code = 115;
            await assert.rejects(expectGolden("harness", "error", code, { dir }), /no longer matches/);
            const message = clone(recs.error.own);
            message.error.message = "other";
            await assert.rejects(expectGolden("harness", "error", message, { dir }), /no longer matches/);
        });

        it("keeps no encrypted params in an entry, so a fresh key is not a change, and writes a module", async () => {
            const entry = goldenEntry(recs.post.own);
            assert.equal("rawParams" in entry.requests[0], false);
            assert.deepEqual(entry.requests[0].params, recs.post.own.requests[0].params);
            const rekeyed = clone(recs.post.own);
            rekeyed.requests[0].rawParams = `${rekeyed.requests[0].rawParams}x`;
            await expectGolden("harness", "getGroupInfo", rekeyed, { dir });
            const file = join(dir, "source.js");
            writeFileSync(file, goldenSource("source", { b: { x: 1 }, a: { y: 2 } }));
            const m = await import(pathToFileURL(file).href);
            assert.deepEqual(Object.keys(m.default), ["a", "b"]);
        });
    });

    describe("listener wire", () => {
        let lw;
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
            lw = await openListenerWire({ socket: { authData } });
            await lw.start();
            await lw.play([
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
            lw.own.listener.requestOldMessages(0, null);
            await lw.settle();
            played = lw.snapshot();
        });

        after(async () => {
            await lw?.close();
        });

        it("decoded the sealed frames into events", () => {
            // Red if a frame were not delivered, or not decoded: the contents come only from the sealed bodies.
            const contents = (events) => events.filter((e) => e.name === "message").map((e) => e.args[0].data.content);
            assert.deepEqual(contents(played.own), ["hello", "group hi"]);
            assert.equal(
                played.own.some((e) => e.name === "cipher_key"),
                true,
            );
        });

        it("records the client's frames and its upgrade, without the per-connection noise", () => {
            assert.deepEqual(
                played.ownSent.map((f) => [f.cmd, f.sub]),
                [[510, 1]],
            );
            assert.equal(played.headers.own.headers.origin, "https://chat.zalo.me");
            assert.equal("host" in played.headers.own.headers, false);
            assert.equal("sec-websocket-key" in played.headers.own.headers, false);
            assert.match(played.headers.own.url, /t=%3Ct%3E/);
            const raw = normalizeUpgrade({
                url: "/?t=1&a=b",
                headers: { host: "h", x: "1" },
                rawHeaders: ["Host", "h", "X", "1"],
            });
            assert.deepEqual(raw, { url: "/?t=%3Ct%3E&a=b", headers: { x: "1" }, names: ["X"] });
        });
    });

    describe("pieces", () => {
        it("the CLI preload logs what the harness records: url, query order, headers, form, parts", () => {
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
        const wire = await openWire({ createApi: clockEngine });
        try {
            const rec = await wire.run("stamp");
            // Red if run() builds the engine before freezing time: `now`, `bound` and `next` would be the real
            // time, or if `now` were not passed to createApi.
            assert.deepEqual(rec.own.result, { injected: true, now: T0, bound: T0, next: T0 + 1 });
            // And again on the next run: a fresh engine, the clock back at t0.
            assert.deepEqual((await wire.run("stamp")).own.result, {
                injected: true,
                now: T0,
                bound: T0,
                next: T0 + 1,
            });
        } finally {
            wire.close();
        }
    });

    it("hands the run's clock to `during`, so a wait measured against s.now() can be moved on", async () => {
        const wire = await openWire({ createApi: clockEngine });
        try {
            let calls = 0;
            const rec = await wire.run("wait", [5000], {
                during: (clock) => {
                    calls++;
                    clock.advance(5000);
                },
            });
            // Red if `during` were not called, or got another clock than the one the engine reads.
            assert.equal(calls, 1);
            assert.equal(rec.own.result, "moved");
            // Without `during` time stands still for the whole call.
            assert.equal((await wire.run("wait", [5, 10])).own.result, "stood still");
            await assert.rejects(
                wire.run("stamp", [], {
                    during: () => {
                        throw new Error("the test's own mistake");
                    },
                }),
                /the test's own mistake/,
            );
        } finally {
            wire.close();
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

    it("waits until `balanced` holds, up to its limit", async () => {
        let behind = 1;
        const ahead = 2;
        setTimeout(() => (behind = 2), 80);
        // Red without the balance check: the count is stable from the start, so it would return before it caught up.
        await settle(() => behind + ahead, { quietMs: 10, maxMs: 2000, balanced: () => behind === ahead });
        assert.equal(behind, 2);
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
