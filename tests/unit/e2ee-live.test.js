/**
 * The live socket transport for the key stack (src/core/e2ee-live.js), driven with a fake sender and tap so the
 * request/reply correlation and the 601 control subscription are proved offline. Nothing here touches a real socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    SignalCommandError,
    getKeyIdLive,
    listMyDevicesLive,
    parseBundleReply,
    registerDeviceLive,
    sendSignalCommand,
    subscribeCloudControls,
    CMD_PUSH_CONTROLS,
} from "../../src/core/e2ee-live.js";
import { bundleFromStore, generateDeviceIdentity } from "../../src/zalo/e2ee/index.js";

/** A throwaway account id (repeated-digit core: a fake by the no-real-ids convention). */
const OWN = "7000000000000000001";

/** A fake tap: `on(cmd, fn)` registers; `emit(cmd, frame)` delivers to current subscribers. */
function fakeTap() {
    const subs = new Map();
    return {
        on(cmd, fn) {
            if (!subs.has(cmd)) subs.set(cmd, new Set());
            subs.get(cmd).add(fn);
            return () => subs.get(cmd)?.delete(fn);
        },
        emit(cmd, frame) {
            for (const fn of [...(subs.get(cmd) ?? [])]) fn(frame);
        },
    };
}

// Every test in this file runs in the sandbox: a failing hook fails them all.
before(() => assertSandboxed(SANDBOX_CONFIG_DIR));

describe("sendSignalCommand", () => {
    it("resolves with the reply that matches the request id", async () => {
        const tap = fakeTap();
        const frame = { version: 1, cmd: 563, subCmd: 0, data: { reqId: "abc", data: { reqIid: 1 } } };
        const sent = [];
        const p = sendSignalCommand({
            send: (f) => {
                sent.push(f);
                queueMicrotask(() => tap.emit(563, { data: { reqId: "abc", data: { uids: [] } } }));
            },
            tap,
            frame,
            timeoutMs: 1000,
        });
        const reply = await p;
        assert.deepEqual(reply.data, { uids: [] });
        assert.equal(sent.length, 1);
    });

    it("ignores a reply for a different request id", async () => {
        const tap = fakeTap();
        const p = sendSignalCommand({
            send: () => {
                queueMicrotask(() => {
                    tap.emit(563, { data: { reqId: "other", data: { nope: 1 } } });
                    queueMicrotask(() => tap.emit(563, { data: { reqId: "abc", data: { ok: 1 } } }));
                });
            },
            tap,
            frame: { cmd: 563, data: { reqId: "abc" } },
            timeoutMs: 1000,
        });
        assert.deepEqual((await p).data, { ok: 1 });
    });

    it("rejects on an error reply", async () => {
        const tap = fakeTap();
        const p = sendSignalCommand({
            send: () => queueMicrotask(() => tap.emit(540, { data: { reqId: "x", data: { err: -205 } } })),
            tap,
            frame: { cmd: 540, data: { reqId: "x" } },
            timeoutMs: 1000,
        });
        await assert.rejects(p, (e) => e instanceof SignalCommandError && e.code === -205);
    });

    it("times out when no reply comes", async () => {
        const tap = fakeTap();
        const p = sendSignalCommand({
            send: () => {},
            tap,
            frame: { cmd: 564, data: { reqId: "y" } },
            timeoutMs: 20,
        });
        await assert.rejects(p, SignalCommandError);
    });
});

/**
 * A base64 bundle item for a freshly generated device on `slot`, in the nested shape GET_BUNDLE really returns:
 * `{deviceId, preKey:{iKey:{id,key}, signature, spKey:{id,key}}, opKeys:[{id,key}]}` (the mirror of SUBMIT_BUNDLE).
 */
async function bundleItemFor(slot) {
    const gen = await generateDeviceIdentity({ preKeyCount: 1 });
    const b = bundleFromStore(gen.store);
    return {
        deviceId: slot,
        preKey: {
            iKey: { id: b.registrationId, key: b.identityKey },
            signature: b.signedPreKey.signature,
            spKey: { id: b.signedPreKey.keyId, key: b.signedPreKey.publicKey },
        },
        opKeys: [{ id: b.preKeys[0].keyId, key: b.preKeys[0].publicKey }],
    };
}

/** The GET_BUNDLE reply shape: data.keys = [{uid, err, keys: [deviceBundles]}]. */
function bundleReply(reqId, items) {
    return { data: { reqId, data: { err: 0, keys: [{ uid: OWN, err: 0, keys: items }], errData: [] } } };
}

describe("parseBundleReply and listMyDevicesLive", () => {
    it("parses the nested data.keys[uid].keys device bundles", async () => {
        const items = [await bundleItemFor(0), await bundleItemFor(2)];
        const parsed = parseBundleReply(bundleReply("r", items).data, OWN);
        assert.deepEqual(parsed.map((p) => p.deviceId).sort(), [0, 2]);
    });

    it("fills a missing deviceId from the requested slot (per-slot reply)", async () => {
        const item = await bundleItemFor(0);
        delete item.deviceId; // a per-slot reply may omit it
        const parsed = parseBundleReply(bundleReply("r", [item]).data, OWN, 0);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].deviceId, 0);
    });

    it("lists occupied slots by probing each platform slot (per-slot GET_BUNDLE)", async () => {
        // The phone (0) and pc (2) have bundles; the web slot (1) has none (its probe replies an error).
        const bySlot = { 0: await bundleItemFor(0), 2: await bundleItemFor(2) };
        const tap = fakeTap();
        const result = await listMyDevicesLive({
            send: (f) => {
                assert.equal(f.cmd, 541);
                const slot = f.data.data.uids[0].deviceId;
                queueMicrotask(() => {
                    if (bySlot[slot]) tap.emit(541, bundleReply(f.data.reqId, [bySlot[slot]]));
                    else tap.emit(541, { data: { reqId: f.data.reqId, data: { err: -1 } } });
                });
            },
            tap,
            ownUid: OWN,
            timeoutMs: 1000,
        });
        assert.deepEqual(result.occupiedSlots, [0, 2]);
        assert.deepEqual(
            result.devices.map((d) => d.platform),
            ["MOBILE", "PC"],
        );
    });
});

describe("getKeyIdLive", () => {
    it("reads the key id reply", async () => {
        const tap = fakeTap();
        const reply = await getKeyIdLive({
            send: (f) => queueMicrotask(() => tap.emit(564, { data: { reqId: f.data.reqId, data: { keyId: 42 } } })),
            tap,
            deviceId: 1,
            timeoutMs: 1000,
        });
        assert.equal(reply.data.keyId, 42);
    });
});

/**
 * A fake transport for the full registration round (564 -> 540 -> per-slot 541 -> 543), recording the command order.
 * Every 541 probe returns `allDevices`; getBundleForSlot then picks the entry for the requested slot. `keyId`/`iid`
 * drive the key-id match.
 */
function fakeRegistrationTransport({ allDevices, keyId = 16186, iid = 16186 }) {
    const subs = new Map();
    const order = [];
    const frames = [];
    const tap = {
        on(cmd, fn) {
            if (!subs.has(cmd)) subs.set(cmd, new Set());
            subs.get(cmd).add(fn);
            return () => subs.get(cmd)?.delete(fn);
        },
        emit(cmd, frame) {
            for (const fn of [...(subs.get(cmd) ?? [])]) fn(frame);
        },
    };
    const send = (frame) => {
        order.push(frame.cmd);
        frames.push(frame);
        const reqId = frame.data.reqId;
        queueMicrotask(() => {
            if (frame.cmd === 564) tap.emit(564, { data: { reqId, data: { err: 0, keyId } } });
            else if (frame.cmd === 540)
                tap.emit(540, { data: { reqId, data: { err: 0, keyExists: 1, iid, ts: 1, devices: [] } } });
            else if (frame.cmd === 541) tap.emit(541, bundleReply(reqId, allDevices));
            else if (frame.cmd === 543) tap.emit(543, { data: { reqId, data: { err: 0 } } });
        });
    };
    return { send, tap, order, frames };
}

describe("registerDeviceLive — the full connect-time sequence", () => {
    it("runs 564 -> 540 -> GET_BUNDLE(-1) -> INIT_SESSION(543); success is SUBMIT_BUNDLE, key id matches", async () => {
        const our = await generateDeviceIdentity({ preKeyCount: 2 });
        const bundle = bundleFromStore(our.store);
        // The account's device registry after our submit: our slot 1 plus the phone (0) and pc (2).
        const allDevices = [await bundleItemFor(1), await bundleItemFor(0), await bundleItemFor(2)];
        const { send, tap, order, frames } = fakeRegistrationTransport({ allDevices, keyId: 16186, iid: 16186 });
        const reg = await registerDeviceLive({
            send,
            tap,
            ownUid: OWN,
            deviceId: 1,
            bundle,
            store: our.store,
            timeoutMs: 2000,
        });
        assert.equal(reg.registered, true, "SUBMIT_BUNDLE success = registered");
        assert.equal(reg.keyMatches, true, "GET_KEY_ID keyId matches SUBMIT_BUNDLE iid");
        assert.equal(reg.listedInBundles, true, "our slot appears in GET_BUNDLE(-1)");
        assert.deepEqual(reg.subdevices.built.sort(), [0, 2], "sessions built to the other devices only");
        assert.equal(order[0], 564, "GET_KEY_ID first");
        assert.equal(order[1], 540, "SUBMIT_BUNDLE second");
        assert.equal(frames[1].data.data.delSS, 1, "SUBMIT_BUNDLE asks the other devices to drop stale sessions");
        assert.ok(order.includes(541), "GET_BUNDLE(-1) for the device registry");
        assert.ok(order.includes(543), "INIT_SESSION built the subdevice sessions");
        const init = frames.find((f) => f.cmd === 543).data.data;
        assert.equal(init.type, 0, "the connect-time subdevice init is type 0");
        assert.deepEqual(init.data.map((e) => e.deviceId).sort(), [0, 2]);
        for (const e of init.data) {
            assert.equal(typeof e.data, "string", "the encrypted init message rides in `data`, as the client sends it");
            assert.equal(e.initMsg, undefined);
        }
    });

    it("stays registered on SUBMIT_BUNDLE success even if our slot is not yet in the bundle list", async () => {
        const our = await generateDeviceIdentity({ preKeyCount: 1 });
        const bundle = bundleFromStore(our.store);
        const allDevices = [await bundleItemFor(0), await bundleItemFor(2)]; // our slot 1 absent
        const { send, tap } = fakeRegistrationTransport({ allDevices });
        const reg = await registerDeviceLive({
            send,
            tap,
            ownUid: OWN,
            deviceId: 1,
            bundle,
            store: our.store,
            timeoutMs: 2000,
        });
        assert.equal(reg.registered, true, "SUBMIT_BUNDLE success is the criterion, not the device list");
        assert.equal(reg.listedInBundles, false);
        assert.deepEqual(reg.subdevices.built.sort(), [0, 2]);
    });

    it("fails when SUBMIT_BUNDLE replies an error", async () => {
        const our = await generateDeviceIdentity({ preKeyCount: 1 });
        const bundle = bundleFromStore(our.store);
        const subs = new Map();
        const tap = {
            on(cmd, fn) {
                if (!subs.has(cmd)) subs.set(cmd, new Set());
                subs.get(cmd).add(fn);
                return () => subs.get(cmd)?.delete(fn);
            },
            emit(cmd, frame) {
                for (const fn of [...(subs.get(cmd) ?? [])]) fn(frame);
            },
        };
        const send = (frame) => {
            const reqId = frame.data.reqId;
            queueMicrotask(() => {
                if (frame.cmd === 564) tap.emit(564, { data: { reqId, data: { err: 0, keyId: 1 } } });
                else if (frame.cmd === 540) tap.emit(540, { data: { reqId, data: { err: -1 } } });
            });
        };
        await assert.rejects(
            registerDeviceLive({ send, tap, ownUid: OWN, deviceId: 1, bundle, store: our.store, timeoutMs: 2000 }),
            SignalCommandError,
        );
    });
});

describe("the secret-free debug mode", () => {});

describe("subscribeCloudControls", () => {
    it("delivers pcloud_info controls from a 601 frame", () => {
        const tap = fakeTap();
        const subscribe = subscribeCloudControls(tap);
        const seen = [];
        subscribe((c) => seen.push(c));
        tap.emit(CMD_PUSH_CONTROLS, {
            data: {
                controls: [
                    {
                        actionId: "1",
                        controlId: "2",
                        content: {
                            act_type: "personal_cloud",
                            act: "pcloud_info",
                            data: JSON.stringify({ session_id: "s", device_name: "d", user_action: 1 }),
                        },
                    },
                ],
            },
        });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].actType, "personal_cloud");
        assert.equal(seen[0].act, "pcloud_info");
        assert.equal(seen[0].data.session_id, "s");
    });
});
