/**
 * src/core/cloud-verify.js — what the daemon does when the server sends cmd 621, "your cloud queue may be stale".
 *
 * The frame is shaped like the live capture (`data.data` is the notice as a JSON string); the walker is injected, so
 * what is under test is the decision: when to walk, when not to, and that nothing else is ever sent.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { walkAst } from "../helpers/api-call-sites.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getCloudItems, getSyncState, setSyncState } from "../../src/core/db.js";
import { createStageLock } from "../../src/core/daemon-channel.js";
import {
    CMD_CLOUD_PUSH,
    CMD_MYCLOUD,
    EARLY_REMOVE_MS,
    THROTTLE_MS,
    createCloudVerifier,
    readCloudNotice,
    readCloudPush,
} from "../../src/core/cloud-verify.js";

it("keeps Zalo Web's own pace: a cloud verify push is acted on once in 30 minutes", () => {
    assert.equal(THROTTLE_MS, 30 * 60 * 1000);
});

const ROOT = mkdtempSync(join(tmpdir(), "zalo-cloud-verify-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

/** A cmd 621 frame as the socket tap hands it over. */
const frame = (notice = {}) => ({
    cmd: CMD_MYCLOUD,
    subCmd: 0,
    data: {
        error_code: 0,
        error_message: "success",
        data: JSON.stringify({
            mycloudMedia: {
                pageSize: 300,
                lastNoiseId: "server-newest-0000000000",
                forceVerify: 0,
                onboardingCompleted: 0,
                auditLocalCloudQueue: 0,
                correctCloudKey: 0,
                ...notice,
            },
        }),
    },
});

/** A tap that only records who subscribed. */
function fakeTap() {
    const subs = new Map();
    return {
        subs,
        on(cmd, fn) {
            subs.set(cmd, fn);
            return () => subs.delete(cmd);
        },
    };
}

function build(over = {}) {
    const calls = [];
    const lines = [];
    let clock = 1_000_000;
    const tap = fakeTap();
    const lock = createStageLock();
    const verifier = createCloudVerifier({
        tap,
        getApi: () => ({ marker: "api" }),
        lock,
        log: (l) => lines.push(l),
        now: () => clock,
        walk: async (opts) => {
            calls.push(opts);
            opts.onPage?.({ cursor: "page-1", page: 1, complete: false });
            opts.onPage?.({ cursor: "page-2", page: 2, complete: true });
            return { items: 3, removed: 1, pages: 2, failed: 0, failures: [], complete: true };
        },
        ...over,
    });
    return { verifier, calls, lines, tap, lock, advance: (ms) => (clock += ms) };
}

describe("cloud verify — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("reading the notice", () => {
    it("takes the live shape: the notice is a JSON string in data.data", () => {
        assert.deepEqual(readCloudNotice(frame()), {
            lastNoiseId: "server-newest-0000000000",
            pageSize: 300,
            forced: false,
            left: [],
        });
    });

    it("also takes it as an object; forceVerify and forceReset force a walk, the other two flags are named", () => {
        const f = frame({ forceVerify: 1 });
        f.data.data = JSON.parse(f.data.data);
        assert.equal(readCloudNotice(f).forced, true);
        assert.equal(readCloudNotice(frame({ forceReset: 1 })).forced, true);
        for (const k of ["correctCloudKey", "auditLocalCloudQueue"]) {
            const notice = readCloudNotice(frame({ [k]: 1 }));
            assert.equal(notice.forced, false, k);
            assert.deepEqual(notice.left, [k]);
        }
    });

    it("ignores anything that is not a mycloudMedia notice", () => {
        assert.equal(readCloudNotice(null), null);
        assert.equal(readCloudNotice({ data: {} }), null);
        assert.equal(readCloudNotice({ data: { data: "not json" } }), null);
        assert.equal(readCloudNotice({ data: { data: JSON.stringify({ other: 1 }) } }), null);
    });
});

describe("when a cmd 621 notice makes the daemon walk", () => {
    it("subscribes to cmd 621 and lets go of it on stop", () => {
        const { verifier, tap } = build();
        assert.ok(tap.subs.has(621));
        verifier.stop();
        assert.equal(tap.subs.has(621), false);
    });

    it("does not start the first walk: with no saved place it only says what to run", async () => {
        const { verifier, calls, lines } = build();
        assert.equal(await verifier.handle(frame()), "no-baseline");
        assert.equal(await verifier.handle(frame()), "no-baseline");
        assert.equal(calls.length, 0);
        assert.equal(lines.filter((l) => /sync-cloud/.test(l)).length, 1, "said once, not on every notice");
    });

    it("walks from the saved place, never from the top, and saves the place after every page", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls } = build();
        assert.equal(await verifier.handle(frame()), "walked");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].lastNoiseId, "my-place");
        assert.ok(!calls[0].full, "an automatic walk is never a full one");
        // No page cap: the walk reads until the server is done; the 30-minute pace is the bound.
        assert.equal(calls[0].maxPages, undefined);
        assert.equal(getSyncState("cloudCursor"), "page-2");
    });

    it("does nothing when the server's newest id is the place already saved", async () => {
        setSyncState("cloudCursor", "server-newest-0000000000");
        const { verifier, calls } = build();
        assert.equal(await verifier.handle(frame()), "current");
        assert.equal(calls.length, 0);
    });

    it("walks at most once in 30 minutes, and again after", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls, advance } = build();
        assert.equal(await verifier.handle(frame()), "walked");
        advance(THROTTLE_MS - 1000);
        assert.equal(await verifier.handle(frame()), "throttled");
        advance(2000);
        assert.equal(await verifier.handle(frame()), "walked");
        assert.equal(calls.length, 2);
    });

    it("leaves a notice that meets another stage, and does not count it against the throttle", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls, lock } = build();
        const release = lock.tryAcquire("sync");
        assert.equal(await verifier.handle(frame()), "stage-running");
        assert.equal(calls.length, 0);
        release();
        assert.equal(await verifier.handle(frame()), "walked");
    });

    it("holds the stage lock while it walks, and lets go after, even when the walk throws", async () => {
        setSyncState("cloudCursor", "my-place");
        let heldDuring = null;
        const { verifier, lock, lines } = build({
            walk: async () => {
                heldDuring = lock.current()?.stage;
                throw new Error("zcloud down");
            },
        });
        assert.equal(await verifier.handle(frame()), "failed");
        assert.equal(heldDuring, "cloud-verify");
        assert.equal(lock.current(), null);
        assert.ok(lines.some((l) => /zcloud down/.test(l)));
    });

    it("reports a walk that read nothing as failed, and one that read something as walked", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, lines } = build({
            walk: async () => ({
                items: 0,
                removed: 0,
                pages: 0,
                failed: 1,
                failures: [{ reason: "no zCloud" }],
                complete: false,
            }),
        });
        assert.equal(await verifier.handle(frame()), "failed");
        assert.ok(lines.some((l) => /no zCloud/.test(l)));
    });

    it("does not start a second walk while one runs", async () => {
        setSyncState("cloudCursor", "my-place");
        let release;
        const gate = new Promise((r) => (release = r));
        const { verifier, calls } = build({
            walk: async (o) => {
                calls.push(o);
                await gate;
                return { items: 0, removed: 0, pages: 1, failed: 0, failures: [], complete: true };
            },
        });
        const first = verifier.handle(frame());
        assert.equal(await verifier.handle(frame()), "busy");
        release();
        assert.equal(await first, "walked");
    });

    it("answers a forced verify as the Web does: the whole queue from the top, swept, past the pace and the id check", async () => {
        // The saved place equals the server's newest id, and a walk ran a minute ago: an ordinary notice would leave.
        setSyncState("cloudCursor", "server-newest-0000000000");
        const { verifier, calls, lines, advance } = build();
        assert.equal(await verifier.handle(frame({ lastNoiseId: "other" })), "walked");
        advance(60_000);
        setSyncState("cloudCursor", "server-newest-0000000000");
        assert.equal(await verifier.handle(frame()), "current");
        assert.equal(await verifier.handle(frame({ lastNoiseId: "newer" })), "throttled");
        assert.equal(await verifier.handle(frame({ forceVerify: 1 })), "walked");
        const forced = calls.at(-1);
        assert.equal(forced.full, true, "a forced walk sweeps what no page listed");
        assert.equal(forced.lastNoiseId, "", "from the top, not from the saved place");
        assert.equal(forced.maxPages, undefined, "no page cap: the whole queue");
        assert.ok(
            lines.some((l) => /forced verify \(the server asked\)/.test(l)),
            lines.join("|"),
        );
    });

    it("paces forced walks too, and still needs a person's first walk", async () => {
        const { verifier, calls, advance } = build();
        assert.equal(await verifier.handle(frame({ forceReset: 1 })), "no-baseline");
        setSyncState("cloudCursor", "my-place");
        assert.equal(await verifier.handle(frame({ forceReset: 1 })), "walked");
        advance(60_000);
        assert.equal(await verifier.handle(frame({ forceReset: 1 })), "throttled");
        advance(THROTTLE_MS);
        assert.equal(await verifier.handle(frame({ forceReset: 1 })), "walked");
        assert.equal(calls.length, 2);
    });

    it("names the key correction and the audit it does not do, and walks as usual", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls, lines } = build();
        assert.equal(await verifier.handle(frame({ correctCloudKey: 1, auditLocalCloudQueue: 1 })), "walked");
        assert.ok(!calls[0].full);
        assert.ok(lines.some((l) => /correct the cloud key; skipped/.test(l)));
        assert.ok(lines.some((l) => /audit of the local cloud queue; skipped/.test(l)));
    });

    it("says when a forced walk stopped before the end, so nothing was swept", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, lines } = build({
            walk: async () => ({ items: 1, removed: 0, pages: 500, failed: 0, failures: [], complete: false }),
        });
        assert.equal(await verifier.handle(frame({ forceVerify: 1 })), "walked");
        assert.ok(lines.some((l) => /nothing was swept/.test(l)));
    });

    it("ignores frames that are not notices", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls } = build();
        assert.equal(await verifier.handle({ cmd: 621, data: { data: "{}" } }), "ignored");
        assert.equal(calls.length, 0);
    });
});

describe("every notice leaves a line saying what was done with it", () => {
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("says so when the index is already current, was walked lately, or another stage is running", async () => {
        setSyncState("cloudCursor", "server-newest-0000000000");
        const { tap, lines } = build();
        tap.subs.get(CMD_MYCLOUD)(frame());
        await settle();
        assert.ok(
            lines.some((l) => /notice \(cmd 621\): the index is already at the server's newest id/.test(l)),
            lines.join("|"),
        );
    });

    it("says nothing extra for a notice it walked for (the walk reports itself), or for a frame that is no notice", async () => {
        setSyncState("cloudCursor", "my-place");
        const { tap, lines } = build();
        tap.subs.get(CMD_MYCLOUD)(frame());
        tap.subs.get(CMD_MYCLOUD)({ cmd: 621, data: { data: "{}" } });
        await settle();
        assert.equal(lines.filter((l) => /notice \(cmd 621\)/.test(l)).length, 0);
        assert.ok(lines.some((l) => /item\(s\) recorded/.test(l)));
    });
});

describe("`listen` and `mcp start` both answer cmd 621 from their socket tap", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const taps = [];
            const verifiers = [];
            walkAst(ast, (n) => {
                if (n.type === "VariableDeclarator" && n.init?.callee?.name === "createSocketTap") taps.push(n.id.name);
                if (n.type === "CallExpression" && n.callee?.name === "createCloudVerifier") verifiers.push(n);
            });
            // Red if one entry point stops keeping the cloud queue current: AGENTS.md §13 calls that asymmetry a defect.
            assert.equal(verifiers.length, 1, `${file} must build one cloud verifier`);
            const prop = (name) => verifiers[0].arguments[0]?.properties?.find((p) => p.key?.name === name);
            assert.equal(prop("tap")?.value?.name, taps[0], "it must ride the daemon's socket tap");
            assert.equal(prop("lock")?.value?.name, "stageLock", "it must take the daemon's stage lock");
        });
    }
});

describe("a cloud-queue entry pushed live (cmd 620)", () => {
    const OWN = "1001";
    const PEER = "1002";
    const api = { getOwnId: () => OWN, getContext: () => ({ loginInfo: {} }) };
    /** A DM item this account sent to PEER, shaped like the pushed body's key names. */
    const addItem = (cli, noiseId = `noise-${cli}`) => ({
        noiseId,
        action: 1,
        actionType: 1,
        cliTs: 1,
        ts: 1_790_000_000_000,
        msgInfo: { cliMsgId: cli, glbMsgId: `g${cli}`, srcId: OWN, destId: PEER, destType: 0, ts: 1_790_000_000_000 },
        mediaInfo: { mediaSize: 10 },
        encryptInfo: {},
    });
    const removeItem = (cli) => ({
        noiseId: `rm-${cli}`,
        action: 2,
        ts: 1_790_000_000_001,
        msgInfo: { extInfo: { orgMsgs: [{ type: 1, uidTo: PEER, uidFrom: OWN, clientDelMsgId: cli }] } },
    });
    const pushFrame = (item) => ({ cmd: CMD_CLOUD_PUSH, subCmd: 0, data: item });
    const noises = () => getCloudItems(PEER).map((r) => r.noiseId);

    it("is cmd 620, Zalo PC's CLOUD.PUSH, and is read from the frame's data", () => {
        assert.equal(CMD_CLOUD_PUSH, 620);
        assert.equal(readCloudPush(pushFrame(addItem("1"))).noiseId, "noise-1");
        assert.equal(readCloudPush({ data: { data: JSON.stringify(addItem("2")) } }).noiseId, "noise-2");
        assert.equal(readCloudPush({ data: { error_code: 0 } }), null);
        assert.equal(readCloudPush({ data: "not json" }), null);
        assert.equal(readCloudPush(null), null);
    });

    it("subscribes to cmd 620 and lets go of it on stop", () => {
        const { verifier, tap } = build({ getApi: () => api });
        assert.ok(tap.subs.has(620));
        verifier.stop();
        assert.equal(tap.subs.has(620), false);
        assert.equal(tap.subs.has(621), false);
    });

    it("records an added item in the index, with no baseline and no stage lock", async () => {
        const { verifier, lock } = build({ getApi: () => api });
        const release = lock.tryAcquire("sync");
        assert.equal(await verifier.handlePush(pushFrame(addItem("10"))), "added");
        release();
        assert.deepEqual(noises(), ["noise-10"]);
        assert.equal(getSyncState("cloudCursor"), null, "a push never moves the walk's saved place");
    });

    it("deletes the item a removal names", async () => {
        const { verifier } = build({ getApi: () => api });
        await verifier.handlePush(pushFrame(addItem("20")));
        assert.deepEqual(noises(), ["noise-20"]);
        assert.equal(await verifier.handlePush(pushFrame(removeItem("20"))), "removed");
        assert.deepEqual(noises(), []);
    });

    it("lets a removal that overtook its add cancel that add, for an hour, as Zalo PC's validator does", async () => {
        const { verifier, advance } = build({ getApi: () => api });
        assert.equal(await verifier.handlePush(pushFrame(removeItem("30"))), "unchanged");
        assert.equal(await verifier.handlePush(pushFrame(addItem("30"))), "cancelled");
        assert.deepEqual(noises(), [], "the late add is dropped");
        assert.equal(await verifier.handlePush(pushFrame(addItem("30", "noise-30b"))), "added", "only once");

        await verifier.handlePush(pushFrame(removeItem("31")));
        advance(EARLY_REMOVE_MS + 1);
        assert.equal(await verifier.handlePush(pushFrame(addItem("31"))), "added", "forgotten after an hour");
    });

    it("changes nothing for temp and duplicate entries", async () => {
        const { verifier } = build({ getApi: () => api });
        assert.equal(await verifier.handlePush(pushFrame({ ...addItem("40"), action: 4 })), "noop");
        assert.equal(await verifier.handlePush(pushFrame({ ...addItem("41"), action: 6 })), "noop");
        assert.deepEqual(noises(), []);
    });

    it("answers reset_cloud with a walk from the top, not by emptying the index from one entry", async () => {
        setSyncState("cloudCursor", "my-place");
        const { verifier, calls } = build({ getApi: () => api });
        await verifier.handlePush(pushFrame(addItem("50")));
        assert.equal(await verifier.handlePush(pushFrame({ noiseId: "reset", action: 5, ts: 2 })), "reset:walked");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].full, true);
        assert.equal(calls[0].lastNoiseId, "");
        assert.deepEqual(noises(), ["noise-50"], "the index is kept until the walk has run");
    });

    it("still needs a person's first walk for a reset", async () => {
        const { verifier, calls } = build({ getApi: () => api });
        assert.equal(await verifier.handlePush(pushFrame({ noiseId: "reset", action: 5 })), "reset:no-baseline");
        assert.equal(calls.length, 0);
    });

    it("never throws into the socket: junk, a writer that throws, an api that is gone", async () => {
        const { verifier, lines } = build({
            getApi: () => {
                throw new Error("signed out");
            },
            apply: () => {
                throw new Error("disk full");
            },
        });
        assert.equal(await verifier.handlePush({ data: 42 }), "ignored");
        assert.equal(await verifier.handlePush(pushFrame(addItem("60"))), "failed");
        assert.ok(lines.some((l) => /disk full/.test(l)));
    });
});
