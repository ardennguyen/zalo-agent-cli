/**
 * Auto sync after a QR login (src/core/sync-v2/auto-sync.js): which control's key is used, and the whole path from a
 * fresh socket to a restore whose conversation request carries that key, against the fake phone.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { AUTO_SYNC_MAX_AGE_MS, autoSyncAfterLogin, pickTransferAfterLogin } from "../../src/core/sync-v2/auto-sync.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { FAKE, installQueuePulls, startFakeZalo } from "../helpers/fake-zalo/index.js";
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
    async function run(backlog) {
        zalo = await startFakeZalo();
        installQueuePulls(zalo.sock, backlog === null ? {} : { "603/1": { controls: backlog } });
        const phone = installFakePhone(zalo, { conversations: CONVS });
        api = await zalo.login();
        const account = `${FAKE.ownId}${++n}`;
        const out = await autoSyncAfterLogin(api, account, {
            pullWaitMs: 60,
            restore: (o) =>
                new SyncV2(api, account).restore({
                    ...o,
                    codecs: fakeCodecs(),
                    settleMs: 0,
                    pollMs: 20,
                    waitMs: 30_000,
                }),
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
        assert.match(out.reason, /no auto sync key/);
        assert.equal(phone.requests.length, 0, "no sync request went out");
    });

    it("starts nothing for a key that is too old", async () => {
        const { out, phone } = await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() - 10 * 60_000 })]);
        assert.equal(out.offered, false);
        assert.equal(phone.requests.length, 0);
    });

    it("lets go of the socket when it is done", async () => {
        await run([control({ temp_key: KEY, pc: 0 }, { ts: Date.now() })]);
        assert.ok(!api.listener.ws, "the socket is closed");
    });
});
