/**
 * The live socket transport for the key stack (src/core/e2ee-live.js), driven with a fake sender and tap so the
 * request/reply correlation and the 601 control subscription are proved offline. Nothing here touches a real socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SignalCommandError,
    describeShape,
    e2eeDebugEnabled,
    getKeyIdLive,
    listDevicesLive,
    registerDeviceLive,
    sendSignalCommand,
    subscribeCloudControls,
    CMD_PUSH_CONTROLS,
} from "../../src/core/e2ee-live.js";
import { CMD_GET_LIST_DEVICES, bundleFromStore, generateDeviceIdentity } from "../../src/zalo/e2ee/index.js";

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

describe("e2ee live transport — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(SANDBOX_CONFIG_DIR));
});

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

describe("listDevicesLive and getKeyIdLive", () => {
    it("lists the account's devices from the reply", async () => {
        const tap = fakeTap();
        const result = await listDevicesLive({
            send: (f) => {
                assert.equal(f.cmd, CMD_GET_LIST_DEVICES);
                queueMicrotask(() =>
                    tap.emit(CMD_GET_LIST_DEVICES, {
                        data: { reqId: f.data.reqId, data: { uids: [{ uid: "u1", devices: [{ deviceId: 1 }] }] } },
                    }),
                );
            },
            tap,
            ownUid: "u1",
            timeoutMs: 1000,
        });
        assert.deepEqual(result.occupiedSlots, [1]);
        assert.equal(result.devices[0].platform, "WEB");
    });

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

/** A fake transport that answers the full registration round; records the order of commands sent. */
function fakeRegistrationTransport({ peers, listSlots }) {
    const subs = new Map();
    const order = [];
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
        const reqId = frame.data.reqId;
        queueMicrotask(() => {
            if (frame.cmd === 564) tap.emit(564, { data: { reqId, data: {} } });
            else if (frame.cmd === 540) tap.emit(540, { data: { reqId, data: { ts: 123 } } });
            else if (frame.cmd === 541) {
                const slot = frame.data.data.uids[0].deviceId;
                tap.emit(541, { data: { reqId, data: peers[slot] ? { keys: [peers[slot]] } : { keys: [] } } });
            } else if (frame.cmd === 543) tap.emit(543, { data: { reqId, data: {} } });
            else if (frame.cmd === 563) {
                tap.emit(563, {
                    data: { reqId, data: { uids: [{ uid: OWN, devices: listSlots.map((s) => ({ deviceId: s })) }] } },
                });
            }
        });
    };
    return { send, tap, order };
}

/** A base64 bundle item for a freshly generated peer device on `slot`. */
async function peerBundleItem(slot) {
    const gen = await generateDeviceIdentity({ preKeyCount: 1 });
    const b = bundleFromStore(gen.store);
    return {
        deviceId: slot,
        registrationId: b.registrationId,
        identityKey: b.identityKey,
        signedPreKey: b.signedPreKey,
        preKey: b.preKeys[0],
    };
}

describe("registerDeviceLive — the full connect-time checklist", () => {
    it("runs 564 -> 540 -> INIT_SUBDEVICE(541/543) -> 563 in order and registers only when 563 lists us", async () => {
        const our = await generateDeviceIdentity({ preKeyCount: 2 });
        const bundle = bundleFromStore(our.store);
        const peers = { 0: await peerBundleItem(0), 2: await peerBundleItem(2) };
        const { send, tap, order } = fakeRegistrationTransport({ peers, listSlots: [1] });
        const reg = await registerDeviceLive({
            send,
            tap,
            ownUid: OWN,
            deviceId: 1,
            bundle,
            store: our.store,
            timeoutMs: 2000,
        });
        assert.equal(reg.registered, true);
        assert.deepEqual(reg.subdevices.built.sort(), [0, 2]);
        assert.equal(order[0], 564, "GET_KEY_ID first");
        assert.equal(order[1], 540, "SUBMIT_BUNDLE second");
        assert.ok(order.includes(543), "INIT_SESSION sent after building subdevice sessions");
        assert.equal(order[order.length - 1], 563, "GETLIST last");
    });

    it("reports not registered when the server list does not include our slot", async () => {
        const our = await generateDeviceIdentity({ preKeyCount: 1 });
        const bundle = bundleFromStore(our.store);
        const { send, tap } = fakeRegistrationTransport({ peers: {}, listSlots: [] });
        const reg = await registerDeviceLive({
            send,
            tap,
            ownUid: OWN,
            deviceId: 1,
            bundle,
            store: our.store,
            timeoutMs: 2000,
        });
        assert.equal(reg.registered, false);
        assert.deepEqual(reg.occupiedSlots, []);
        // No peer bundles: INIT_SUBDEVICE builds nothing, which is tolerated.
        assert.deepEqual(reg.subdevices.built, []);
    });
});

describe("the secret-free debug mode", () => {
    it("describeShape shows field names, numbers and lengths but never string contents", () => {
        const shape = describeShape({
            err: -205,
            user_action: 1,
            ok: true,
            encrypted_private_key: "AAAABBBBCCCCDDDD",
            nested: { token: "super-secret-value", n: 3 },
        });
        assert.equal(shape.err, -205);
        assert.equal(shape.user_action, 1);
        assert.equal(shape.ok, true);
        assert.equal(shape.encrypted_private_key, "str(16)");
        assert.equal(shape.nested.token, "str(18)");
        assert.equal(shape.nested.n, 3);
        const flat = JSON.stringify(shape);
        assert.equal(flat.includes("super-secret-value"), false);
        assert.equal(flat.includes("AAAABBBB"), false);
    });

    it("e2eeDebugEnabled reads the env flag", () => {
        assert.equal(e2eeDebugEnabled({}), false);
        assert.equal(e2eeDebugEnabled({ ZALO_E2EE_DEBUG: "0" }), false);
        assert.equal(e2eeDebugEnabled({ ZALO_E2EE_DEBUG: "false" }), false);
        assert.equal(e2eeDebugEnabled({ ZALO_E2EE_DEBUG: "1" }), true);
    });
});

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
