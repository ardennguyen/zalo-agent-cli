/**
 * src/core/socket-tap.js -- the raw reader on the listener's WebSocket.
 *
 * zca-js decodes each frame and emits typed events, throwing away everything
 * else in the envelope: `queueStatus`, `lastActionId`, `more`, `evict`,
 * `resetLastActionId`, `clearUnreads`, `pageMsgs`, and the handshake's
 * `qCmds` (apis/listen.js keeps only the cipher `key` of cmd 1). The tap
 * keeps them, for the offline-queue catch-up and for what follows it (read
 * state, pageMsgs). These pin the four properties it must have: frames are
 * routed by cmd, it re-arms on every new socket, it remembers the handshake,
 * and a broken subscriber cannot break the socket.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSocketTap, readFrame } from "../../src/core/socket-tap.js";
import { fakeListener, serverFrame } from "./support/fake-socket.js";

describe("socket tap", () => {
    it("decodes a frame and hands it to that cmd's subscribers only", () => {
        const listener = fakeListener();
        const tap = createSocketTap();
        tap.attach(listener);
        const got = { 521: [], 501: [] };
        tap.on(521, (f) => got[521].push(f));
        tap.on(501, (f) => got[501].push(f));

        listener.push(521, 0, {
            error_code: 0,
            data: { lastActionId: "11", queueStatus: { "511_1": { lastId: "7" } } },
        });

        assert.equal(got[501].length, 0);
        assert.equal(got[521].length, 1);
        assert.equal(got[521][0].cmd, 521);
        assert.equal(got[521][0].subCmd, 0);
        // Red if the tap hands over only what zca-js keeps.
        assert.deepEqual(got[521][0].data.queueStatus, { "511_1": { lastId: "7" } });
        assert.equal(got[521][0].data.lastActionId, "11");
    });

    it("re-arms on the NEW socket after a reconnect, and never double-delivers", () => {
        const listener = fakeListener();
        const tap = createSocketTap();
        tap.attach(listener);
        tap.attach(listener); // re-login calls attach again; must stay one tap per socket
        const seen = [];
        tap.on(521, (f) => seen.push(f.data.n));

        listener.push(521, 0, { data: { n: 1 } });
        listener.reconnect(); // zca-js builds a new ws on retry
        listener.push(521, 0, { data: { n: 2 } });

        // Red if the tap stayed on the dead socket (no 2) or doubled up.
        assert.deepEqual(seen, [1, 2]);
    });

    it("keeps the handshake's queue list", () => {
        const listener = fakeListener();
        const tap = createSocketTap();
        tap.attach(listener);
        assert.equal(tap.auth(), null);

        const qCmds = [{ cmd: 510, subCmd: 1, queueName: "510_1" }];
        listener.auth({ qCmds, bk_cmds: { "510_1": "510_0" } });

        assert.deepEqual(tap.auth().qCmds, qCmds);
        assert.deepEqual(tap.auth().bk_cmds, { "510_1": "510_0" });
    });

    it("a subscriber that throws does not stop the others, and a bad frame is skipped", () => {
        const listener = fakeListener();
        const errors = [];
        const tap = createSocketTap({ log: (line) => errors.push(line) });
        tap.attach(listener);
        const seen = [];
        tap.on(521, () => {
            throw new Error("boom");
        });
        tap.on(521, (f) => seen.push(f.data.n));

        listener.ws.emit("message", Buffer.from([1, 2])); // too short to be a frame
        listener.ws.emit("message", Buffer.concat([Buffer.from([1, 9, 2, 0]), Buffer.from("{not json")]));
        listener.push(521, 0, { data: { n: 3 } });

        assert.deepEqual(seen, [3]);
        assert.equal(errors.length, 1, "the throwing subscriber is reported once");
    });

    it("unsubscribes", () => {
        const listener = fakeListener();
        const tap = createSocketTap();
        tap.attach(listener);
        const seen = [];
        const off = tap.on(521, () => seen.push(1));
        off();
        listener.push(521, 0, { data: {} });
        assert.deepEqual(seen, []);
    });

    it("readFrame reads the header the way zca-js does", () => {
        const f = readFrame(serverFrame(511, 1, { error_code: 0, data: { more: 0 } }));
        assert.equal(f.cmd, 511);
        assert.equal(f.subCmd, 1);
        assert.equal(f.version, 1);
        assert.deepEqual(f.data, { more: 0 });
        assert.equal(readFrame(Buffer.from([1])), null);
    });
});
