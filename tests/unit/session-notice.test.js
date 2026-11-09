/**
 * src/core/session-notice.js: the `session_expiring` event a daemon sends before the saved login ends by itself, once
 * per threshold (14, 7, 3, 1 days, ended), kept across a restart by a marker in the account folder, and started over
 * by a new login. `listen` and `mcp start` both run the watch.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acorn from "acorn";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    SESSION_NOTICE_DAYS,
    SESSION_NOTICE_FILE,
    createSessionNotices,
    describeSessionExpiring,
    fileNoticeStore,
    sessionExpiringEvent,
    sessionExpiringSystemEvent,
    sessionExpiryFromMarker,
    sessionThreshold,
    startSessionExpiryWatch,
} from "../../src/core/session-notice.js";
import { walkAst } from "../helpers/api-call-sites.js";

const ID = "1000000000000000981";
const END = "2026-12-01T00:00:00.000Z";
const NOW = Date.parse("2026-11-01T00:00:00Z");
const at = (daysLeft, { expiresAt = END, expired = false } = {}) => ({ expiresAt, daysLeft, expired });

let dir;
before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    dir = mkdtempSync(join(tmpdir(), "zalo-session-notice-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("sessionThreshold", () => {
    it("is the nearest of 14, 7, 3, 1 at or above the days left, 0 once ended, null with weeks left", () => {
        assert.deepEqual([...SESSION_NOTICE_DAYS], [14, 7, 3, 1]);
        const t = (d) => sessionThreshold(at(d));
        assert.deepEqual([30, 15, 14, 10, 8, 7, 4, 3, 2, 1, 0].map(t), [null, null, 14, 14, 14, 7, 7, 3, 3, 1, 1]);
        assert.equal(sessionThreshold(at(-1, { expired: true })), 0);
        assert.equal(sessionThreshold(null), null);
    });
});

describe("the event", () => {
    it("carries ids, dates and the command only", () => {
        const e = sessionExpiringEvent(ID, at(5), NOW);
        assert.deepEqual(e, {
            event: "session_expiring",
            accountId: ID,
            expiresAt: END,
            daysLeft: 5,
            expired: false,
            threshold: 7,
            command: `zalo-agent --account ${ID} login`,
            at: "2026-11-01T00:00:00.000Z",
        });
        assert.match(describeSessionExpiring(e), /ends on 2026-12-01 \(5 day\(s\) left\); log in again before then/);
        assert.match(describeSessionExpiring(e), /keeps the device id/);
        const ended = sessionExpiringEvent(ID, at(-2, { expired: true }), NOW);
        assert.match(describeSessionExpiring(ended), /ended on 2026-12-01; log in again/);
        const sys = sessionExpiringSystemEvent(e);
        assert.equal(sys.type, "session_expiring");
        assert.equal(sys.event, undefined);
        assert.equal(sys.daysLeft, 5);
        assert.equal(typeof sys.text, "string");
    });
});

describe("createSessionNotices", () => {
    it("says due once per threshold, again for a closer one, and starts over for a new session end", () => {
        const saved = new Map();
        const n = createSessionNotices({ load: (k) => saved.get(k) ?? null, save: (k, v) => saved.set(k, v) });
        const due = (expiry) => n.due(ID, expiry);
        assert.equal(due(at(20)), false, "weeks left");
        assert.equal(due(at(14)), true);
        assert.equal(due(at(13)), false, "same threshold");
        assert.equal(due(at(8)), false);
        assert.equal(due(at(6)), true, "7 crossed");
        assert.equal(due(at(2)), true, "3 crossed");
        assert.equal(due(at(1)), true, "1 crossed");
        assert.equal(due(at(0)), false);
        assert.equal(due(at(-1, { expired: true })), true, "ended");
        assert.equal(due(at(-3, { expired: true })), false);
        const later = "2027-03-01T00:00:00.000Z";
        assert.equal(due(at(89, { expiresAt: later })), false, "a new login, weeks left");
        assert.equal(due(at(10, { expiresAt: later })), true, "the new end counts its thresholds again");
    });
});

describe("startSessionExpiryWatch", () => {
    it("fires once per threshold, and not again after a restart for the same threshold", () => {
        const accountDir = join(dir, "acc");
        let expiry = at(10);
        const events = [];
        const watch = () =>
            startSessionExpiryWatch({
                ownId: ID,
                accountDir,
                emit: (e) => events.push(e),
                read: () => expiry,
                now: () => NOW,
                everyMs: 0,
            });
        const w1 = watch();
        assert.equal(events.length, 1, "checked at start");
        assert.equal(events[0].threshold, 14);
        assert.equal(w1.check(), null, "the hourly check sends nothing new");
        w1.stop();
        assert.ok(existsSync(join(accountDir, SESSION_NOTICE_FILE)));
        const marker = readFileSync(join(accountDir, SESSION_NOTICE_FILE), "utf8");
        assert.deepEqual(JSON.parse(marker), { expiresAt: END, threshold: 14 });

        const w2 = watch(); // a restart
        assert.equal(events.length, 1, "the same threshold is not sent again after a restart");
        expiry = at(6);
        assert.equal(w2.check().threshold, 7, "the next threshold goes out");
        assert.equal(events.length, 2);
        w2.stop();
        watch().stop();
        assert.equal(events.length, 2, "nor after another restart");
    });

    it("a failing reader or sink does not throw, and no readable session sends nothing", () => {
        const accountDir = join(dir, "acc2");
        const w = startSessionExpiryWatch({
            ownId: ID,
            accountDir,
            emit: () => {
                throw new Error("sink down");
            },
            read: () => {
                throw new Error("no jar");
            },
            everyMs: 0,
        });
        assert.equal(w.check(), null);
        assert.equal(existsSync(join(accountDir, SESSION_NOTICE_FILE)), false);
    });
});

describe("sessionExpiryFromMarker", () => {
    it("reads the end a daemon recorded, even with weeks left and nothing sent", () => {
        const accountDir = join(dir, "acc3");
        const events = [];
        startSessionExpiryWatch({
            ownId: ID,
            accountDir,
            emit: (e) => events.push(e),
            read: () => at(40),
            everyMs: 0,
        }).stop();
        assert.equal(events.length, 0);
        assert.deepEqual(
            sessionExpiryFromMarker(accountDir, () => NOW),
            {
                expiresAt: END,
                daysLeft: 30,
                expired: false,
            },
        );
        assert.equal(sessionExpiryFromMarker(accountDir, () => Date.parse(END) + 1).expired, true);
        assert.equal(sessionExpiryFromMarker(join(dir, "none")), null);
    });
});

describe("fileNoticeStore", () => {
    it("keeps one marker per account in one file", () => {
        const file = join(dir, "fleet-session-notices.json");
        const s = fileNoticeStore(file);
        assert.equal(s.load("1"), null);
        s.save("1", { expiresAt: END, threshold: 7 });
        s.save("2", { expiresAt: END, threshold: 3 });
        assert.deepEqual(fileNoticeStore(file).load("1"), { expiresAt: END, threshold: 7 });
        assert.deepEqual(fileNoticeStore(file).load("2"), { expiresAt: END, threshold: 3 });
    });
});

describe("`listen` and `mcp start` both run the watch", () => {
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const src = join(import.meta.dirname, "..", "..", "src", "commands", file);
            const ast = acorn.parse(readFileSync(src, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
            const calls = [];
            walkAst(ast, (node) => {
                if (node.type === "CallExpression" && node.callee?.name === "startSessionExpiryWatch") calls.push(node);
            });
            // Red if one entry point stops telling: AGENTS.md section 13 calls an asymmetry a defect.
            assert.equal(calls.length, 1, `${file} must start the session expiry watch`);
            const keys = calls[0].arguments[0].properties.map((p) => p.key.name);
            assert.ok(keys.includes("emit") && keys.includes("accountDir"));
        });
    }
});
