/**
 * The live socket transport for the key stack (src/core/e2ee-live.js), driven with a fake sender and tap so the
 * request/reply correlation and the 601 control subscription are proved offline. Nothing here touches a real socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SignalCommandError,
    getKeyIdLive,
    listDevicesLive,
    sendSignalCommand,
    subscribeCloudControls,
    CMD_PUSH_CONTROLS,
} from "../../src/core/e2ee-live.js";
import { CMD_GET_LIST_DEVICES } from "../../src/zalo/e2ee/index.js";

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
