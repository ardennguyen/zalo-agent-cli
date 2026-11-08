/**
 * Auto sync after a QR login (src/core/sync-v2/auto-sync.js): which control's key is used, and the whole path from a
 * fresh socket to a restore whose conversation request carries that key, against the fake phone.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    AUTO_SYNC_MAX_AGE_MS,
    autoSyncAfterLogin,
    classifyLoginOffer,
    describeLoginControls,
    pickTransferAfterLogin,
} from "../../src/core/sync-v2/auto-sync.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { FAKE, installQueuePulls, ok, startFakeZalo } from "../helpers/fake-zalo/index.js";
import { fakeCodecs, installFakePhone } from "../helpers/fake-zalo/phone.js";

const NOW = Date.UTC(2026, 9, 26, 7, 43, 33);
const control = (data, { ts = NOW - 1000, act = "transfer_after_login", actionId = "1" } = {}) => ({
    actionId,
    controlId: actionId,
    content: { act, act_type: "transfer_sync2", ts, data: typeof data === "string" ? data : JSON.stringify(data) },
});
const KEY = "k".repeat(64);

describe("pickTransferAfterLogin", () => {
    it("takes the key of a transfer_after_login control that is for the web", () => {
        const got = pickTransferAfterLogin([control({ temp_key: KEY, imei: null, pc: 0 })], { now: NOW });
        assert.deepEqual(got, { tempKey: KEY, ageMs: 1000 });
    });

    it("ignores a control for the PC app (pc 1), one with no key or an empty one, and other acts", () => {
        const none = [
            control({ temp_key: KEY, pc: 1 }),
            control({ pc: 0 }),
            control({ temp_key: "", pc: 0 }),
            control({ temp_key: 5, pc: 0 }),
            control({ temp_key: KEY, pc: 0 }, { act: "transfer_status" }),
            control({ temp_key: KEY, pc: 0 }, { act: "upload_batch" }),
        ];
        assert.equal(pickTransferAfterLogin(none, { now: NOW }), null);
    });

    it("takes the latest of several, whatever their order", () => {
        const newer = control({ temp_key: "new".padEnd(64, "n"), pc: 0 }, { ts: NOW - 500 });
        const older = control({ temp_key: "old".padEnd(64, "o"), pc: 0 }, { ts: NOW - 9000 });
        for (const order of [
            [newer, older],
            [older, newer],
        ]) {
            const got = pickTransferAfterLogin(order, { now: NOW });
            assert.equal(got.tempKey.startsWith("new"), true);
            assert.equal(got.ageMs, 500);
        }
    });

    it("does not use a key older than the limit: the phone stopped honoring one 765 s old", () => {
        const old = control({ temp_key: KEY, pc: 0 }, { ts: NOW - AUTO_SYNC_MAX_AGE_MS - 1 });
        assert.equal(pickTransferAfterLogin([old], { now: NOW }), null);
        const edge = control({ temp_key: KEY, pc: 0 }, { ts: NOW - AUTO_SYNC_MAX_AGE_MS });
        assert.ok(pickTransferAfterLogin([edge], { now: NOW }), "exactly at the limit still counts");
        assert.equal(pickTransferAfterLogin([old], { now: NOW, maxAgeMs: 10 * 60_000 })?.tempKey, KEY);
    });

    it("is not thrown by malformed controls, and takes data that is already an object", () => {
        const odd = [
            null,
            undefined,
            {},
            { content: null },
            control("not json"),
            control({ temp_key: KEY, pc: 0 }, { ts: 0 }),
        ];
        assert.equal(pickTransferAfterLogin(odd, { now: NOW }), null);
        const asObject = {
            actionId: "9",
            content: { act: "transfer_after_login", ts: NOW - 10, data: { temp_key: KEY, pc: 0 } },
        };
        assert.equal(pickTransferAfterLogin([asObject], { now: NOW })?.tempKey, KEY);
        assert.equal(pickTransferAfterLogin(undefined, { now: NOW }), null);
    });
});

describe("classifyLoginOffer: what `login` says about the phone's 'sync messages' box", () => {
    it("ticked: a fresh offer for the web, with its key and age", () => {
        assert.deepEqual(classifyLoginOffer([control({ temp_key: KEY, imei: "x", pc: 0 })], { now: NOW }), {
            status: "ticked",
            tempKey: KEY,
            ageMs: 1000,
        });
    });

    it("late: the offer for the web is older than the limit (the phone would ask for a tap again)", () => {
        const old = control({ temp_key: KEY, pc: 0 }, { ts: NOW - AUTO_SYNC_MAX_AGE_MS - 5000 });
        assert.deepEqual(classifyLoginOffer([old], { now: NOW }), {
            status: "late",
            ageMs: AUTO_SYNC_MAX_AGE_MS + 5000,
        });
    });

    it("other-client: only an offer for the PC app (pc 1), which this client must not use", () => {
        assert.deepEqual(classifyLoginOffer([control({ temp_key: KEY, pc: 1 })], { now: NOW }), {
            status: "other-client",
        });
        // A web offer next to it wins.
        const both = [control({ temp_key: KEY, pc: 1 }), control({ temp_key: KEY, pc: 0 })];
        assert.equal(classifyLoginOffer(both, { now: NOW }).status, "ticked");
    });

    it("none: no offer, or one with no key: the box was not ticked", () => {
        assert.deepEqual(classifyLoginOffer([], { now: NOW }), { status: "none" });
        assert.deepEqual(classifyLoginOffer([control({ pc: 0 }), control({ temp_key: "", pc: 0 })], { now: NOW }), {
            status: "none",
        });
        assert.deepEqual(classifyLoginOffer(undefined, { now: NOW }), { status: "none" });
    });
});

describe("autoSyncAfterLogin against the fake phone", () => {
    let zalo = null;
    let api = null;
    let n = 0;
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    });

    const CONVS = [
        {
            id: "CONVA",
            kind: "oneone",
            lastTs: Date.UTC(2026, 9, 1, 0, 0, 2),
            messages: [{ id: "5001", text: "hi", ts: Date.UTC(2026, 9, 1, 0, 0, 1) }],
        },
    ];

    /** Log in to the fake, with the given 603 backlog, and run the auto sync with the real restore on fake codecs. */
    async function run(backlog, extra = {}) {
        zalo = await startFakeZalo();
        installQueuePulls(zalo.sock, backlog === null ? {} : { "603/1": { controls: backlog } });
        // The fake answers 603/1 only; 603/0 is answered empty here so a run does not wait out a page timeout.
        zalo.sock.respond(603, 0, (frame) => ok({ controls: [], more: 0, reqId: frame.data?.reqId }));
        if (extra.respond603) zalo.sock.respond(603, 1, extra.respond603);
        const phone = installFakePhone(zalo, { conversations: CONVS });
        api = await zalo.login();
        const account = `${FAKE.ownId}${++n}`;
        const opts = { ...extra };
        delete opts.respond603;
        const out = await autoSyncAfterLogin(api, account, {
            pullWaitMs: 60,
            pageTimeoutMs: 2000,
            authWaitMs: 500,
            restore: (o) =>
                new SyncV2(api, account).restore({
                    ...o,
                    codecs: fakeCodecs(),
                    settleMs: 0,
                    pollMs: 20,
                    waitMs: 30_000,
                }),
            ...opts,
        });
        return { out, phone };
    }

    it("asks the control queue only until it has the key", async () => {
        await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() - 500 })]);
        assert.equal(zalo.sock.framesOf(603).length, 1, "603/1 had it, so 603/0 was not asked");
    });

    it("reads the key from the control queue and sends it with the conversation request, and no other", async () => {
        const { out, phone } = await run([control({ temp_key: KEY, imei: null, pc: 0 }, { ts: Date.now() - 500 })]);
        assert.equal(out.offered, true);
        assert.equal(out.status, "ticked");
        assert.equal(out.result.reason, "complete");
        assert.equal(out.result.messagesSaved, 1);
        const [conv, ...messages] = phone.requests;
        assert.equal(conv.type, "conversation");
        assert.equal(conv.raw.tempKey, KEY, "the conversation request carries the key");
        assert.ok(messages.length > 0);
        assert.ok(
            messages.every((m) => m.raw.tempKey === ""),
            "the message requests do not",
        );
    });

    it("starts nothing when the phone offered no key (auto sync not ticked)", async () => {
        const { out, phone } = await run(null);
        assert.equal(out.offered, false);
        assert.equal(out.status, "none");
        assert.match(out.reason, /not ticked/);
        assert.equal(phone.requests.length, 0, "no sync request went out");
    });

    it("starts nothing for a key that is too old, and says it came late", async () => {
        const { out, phone } = await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() - 10 * 60_000 })]);
        assert.equal(out.offered, false);
        assert.equal(out.status, "late");
        assert.match(out.reason, /too long ago/);
        assert.equal(phone.requests.length, 0);
    });

    it("starts nothing for an offer meant for the PC app", async () => {
        const { out, phone } = await run([control({ temp_key: KEY, pc: 1 }, { ts: Date.now() - 500 })]);
        assert.equal(out.offered, false);
        assert.equal(out.status, "other-client");
        assert.equal(phone.requests.length, 0);
    });

    it("--no-sync: a ticked offer is reported, and nothing is restored", async () => {
        const { out, phone } = await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() - 500 })], {
            restoreWhenTicked: false,
        });
        assert.equal(out.offered, false);
        assert.equal(out.status, "ticked");
        assert.match(out.reason, /--no-sync/);
        assert.equal(phone.requests.length, 0, "no sync request went out");
    });

    it("lets go of the socket when it is done", async () => {
        await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() })]);
        assert.ok(!api.listener.ws, "the socket is closed");
    });

    /**
     * A control queue kept by a re-login that kept the device id: `old` controls from before, then the offer, served
     * in pages of 50 from the cursor a request names (the start when it names none), as the server does.
     */
    function keptQueue(old, offerTs) {
        const items = [];
        for (let i = 1; i <= old; i++) {
            items.push(
                control({ status: 1 }, { act: "transfer_status", actionId: String(i), ts: Date.now() - 86_400_000 }),
            );
        }
        items.push(control({ temp_key: KEY, imei: null, pc: 0 }, { actionId: String(old + 1), ts: offerTs }));
        const asked = [];
        const respond = (frame) => {
            const lastId = frame.data?.lastId ?? null;
            asked.push(lastId);
            const from = lastId === null ? 0 : items.findIndex((c) => c.actionId === String(lastId)) + 1;
            const page = items.slice(from, from + 50);
            const more = from + 50 < items.length ? 1 : 0;
            return ok({
                controls: page,
                more,
                lastActionId: page.at(-1)?.actionId ?? lastId,
                reqId: frame.data?.reqId,
            });
        };
        return { respond, asked };
    }

    it("finds the offer at the end of a kept device's queue, page by page from its start (red with one page)", async () => {
        const q = keptQueue(120, Date.now() - 500);
        const { out, phone } = await run(null, { respond603: q.respond });
        assert.equal(out.status, "ticked", "the offer on the third page was found");
        assert.equal(out.offered, true);
        assert.equal(phone.requests[0].raw.tempKey, KEY);
        assert.deepEqual(q.asked, [null, "50", "100"], "paged on `more` from the answer's lastActionId");
        assert.deepEqual(out.pulls, [{ queue: "603_1", from: "start", pages: 3, reason: "found" }]);
    });

    it("reads from the saved control cursor first, as Zalo Web does, and finds the offer after it", async () => {
        const q = keptQueue(120, Date.now() - 500);
        const cursors = [];
        const { out } = await run(null, {
            respond603: q.respond,
            restoreWhenTicked: false,
            cursorOf: (name) => {
                cursors.push(name);
                return name === "603_1" ? { id: "110", ts: 1 } : null;
            },
        });
        assert.equal(out.status, "ticked");
        assert.deepEqual(q.asked, ["110"], "one page from the cursor, not the whole queue");
        assert.deepEqual(out.pulls, [{ queue: "603_1", from: "cursor", pages: 1, reason: "found" }]);
        assert.deepEqual(cursors, ["603_1"]);
    });

    it("falls back to the start of the queue when the cursor finds nothing", async () => {
        const q = keptQueue(10, Date.now() - 500);
        const { out } = await run(null, {
            respond603: (frame) =>
                frame.data?.lastId === "999"
                    ? ok({ controls: [], more: 0, reqId: frame.data?.reqId })
                    : q.respond(frame),
            restoreWhenTicked: false,
            cursorOf: (name) => (name === "603_1" ? "999" : null),
        });
        assert.equal(out.status, "ticked");
        assert.deepEqual(out.pulls, [
            { queue: "603_1", from: "cursor", pages: 1, reason: "drained" },
            { queue: "603_1", from: "start", pages: 1, reason: "found" },
        ]);
    });

    it("says what it saw when nothing was ticked: every control, its act and pc, never a key", async () => {
        const stale = control({ temp_key: KEY, pc: 0 }, { actionId: "7", ts: Date.now() - 10 * 60_000 });
        const pc = control({ temp_key: KEY, pc: 1 }, { actionId: "8", ts: Date.now() - 500 });
        const { out } = await run([stale, pc]);
        assert.equal(out.status, "late");
        assert.equal(out.controls.length, 2);
        assert.deepEqual(
            out.controls.map((c) => [c.queue, c.actType, c.act, c.pc, c.hasKey]),
            [
                ["603_1", "transfer_sync2", "transfer_after_login", 0, true],
                ["603_1", "transfer_sync2", "transfer_after_login", 1, true],
            ],
        );
        assert.ok(out.controls[0].ageMs >= 10 * 60_000);
        assert.ok(!JSON.stringify(out).includes(KEY), "the key is in no part of the answer");
        assert.deepEqual(
            out.pulls.map((p) => [p.queue, p.from, p.reason]),
            [
                ["603_1", "start", "drained"],
                ["603_0", "start", "drained"],
            ],
        );
    });
});

describe("describeLoginControls", () => {
    it("one line per control (repeats by queue and id dropped), with no key in it", () => {
        const c = control({ temp_key: KEY, imei: null, pc: 0 }, { actionId: "3", ts: NOW - 2000 });
        const odd = { actionId: "4", content: { act_type: "group", act: "join", data: "not json" } };
        const got = describeLoginControls(
            [
                { queue: "603_1", control: c },
                { queue: "603_1", control: c },
                { queue: "601_0", control: c },
                { queue: "603_0", control: odd },
                { queue: "603_0", control: null },
            ],
            NOW,
        );
        assert.deepEqual(got, [
            {
                queue: "603_1",
                actionId: "3",
                actType: "transfer_sync2",
                act: "transfer_after_login",
                pc: 0,
                hasKey: true,
                ageMs: 2000,
            },
            {
                queue: "601_0",
                actionId: "3",
                actType: "transfer_sync2",
                act: "transfer_after_login",
                pc: 0,
                hasKey: true,
                ageMs: 2000,
            },
            { queue: "603_0", actionId: "4", actType: "group", act: "join", pc: null, hasKey: false, ageMs: null },
        ]);
        assert.ok(!JSON.stringify(got).includes(KEY));
        assert.deepEqual(describeLoginControls(undefined, NOW), []);
    });
});

describe("login --verbose: the lines that say what the offer check saw", () => {
    it("names each queue read and each control, never the key", async () => {
        const { describeOfferCheck } = await import("../../src/commands/login.js");
        const lines = describeOfferCheck({
            pulls: [
                { queue: "603_1", from: "cursor", pages: 1, reason: "drained" },
                { queue: "603_1", from: "start", pages: 3, reason: "found" },
            ],
            controls: describeLoginControls(
                [{ queue: "603_1", control: control({ temp_key: KEY, pc: 0 }, { actionId: "9", ts: NOW - 4000 }) }],
                NOW,
            ),
        });
        assert.deepEqual(lines, [
            "Control queues read: 603_1 from cursor (1 page(s), drained); 603_1 from start (3 page(s), found)",
            "Controls seen: 1",
            "  603_1 #9: act_type=transfer_sync2 act=transfer_after_login pc=0 key=yes age=4 s",
        ]);
        assert.deepEqual(describeOfferCheck({}), ["Control queues read: none", "Controls seen: 0"]);
    });
});
