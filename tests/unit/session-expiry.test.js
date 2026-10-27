/**
 * src/core/session-expiry.js: when the saved login ends, from the saved cookie jar, and where a daemon says so.
 *
 * Nothing extends `zpw_sek` (it is set once at login with a 90-day life), so the end date is the one thing a long
 * running daemon can warn about in advance. Only a date may come out of here, never a cookie's value.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createDaemonHealth, renderPrometheus } from "../../src/core/daemon-health.js";
import {
    EXPIRY_WARN_DAYS,
    SESSION_COOKIE,
    describeSessionExpiry,
    sessionExpiryFor,
    sessionExpiryOf,
} from "../../src/core/session-expiry.js";
import { walkAst } from "../helpers/zca-call-sites.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T00:00:00Z");
const now = () => NOW;
const cookie = (extra) => ({ key: SESSION_COOKIE, value: "SECRET-VALUE", domain: "chat.zalo.me", ...extra });

describe("session expiry — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("sessionExpiryOf", () => {
    it("is the creation time plus the max-age of the session cookie, in a serialized tough-cookie jar", () => {
        const created = new Date(NOW - 10 * DAY).toISOString();
        const out = sessionExpiryOf({ cookies: [cookie({ creation: created, maxAge: 90 * 86_400 })] }, now);
        assert.equal(out.expiresAt, new Date(NOW + 80 * DAY).toISOString());
        assert.equal(out.daysLeft, 80);
        assert.equal(out.expired, false);
    });

    it("prefers an absolute expires date when the cookie has one, and takes a bare array of cookies", () => {
        const end = new Date(NOW + 5 * DAY).toISOString();
        const out = sessionExpiryOf([cookie({ expires: end, creation: "2020-01-01T00:00:00Z", maxAge: 1 })], now);
        assert.equal(out.expiresAt, end);
        assert.equal(out.daysLeft, 5);
    });

    it("takes the earliest end when the jar holds the cookie twice, and says so once it has passed", () => {
        const out = sessionExpiryOf(
            {
                cookies: [
                    cookie({ expires: new Date(NOW + 30 * DAY).toISOString() }),
                    cookie({ expires: new Date(NOW - 2 * DAY).toISOString() }),
                ],
            },
            now,
        );
        assert.equal(out.expired, true);
        assert.equal(out.daysLeft, -2);
    });

    it("counts the very moment of the end as ended", () => {
        const out = sessionExpiryOf({ cookies: [cookie({ expires: new Date(NOW).toISOString() })] }, now);
        assert.equal(out.expired, true);
        assert.equal(out.daysLeft, 0);
        const before = sessionExpiryOf({ cookies: [cookie({ expires: new Date(NOW + 1).toISOString() })] }, now);
        assert.equal(before.expired, false);
    });

    it("ignores every other cookie, and gives null when no end is known", () => {
        const other = { key: "zpsid", expires: new Date(NOW + DAY).toISOString() };
        assert.equal(sessionExpiryOf({ cookies: [other] }, now), null);
        assert.equal(sessionExpiryOf({ cookies: [cookie({ maxAge: 100 })] }, now), null, "no creation time");
        assert.equal(sessionExpiryOf({ cookies: [cookie({ creation: "2026-10-01T00:00:00Z" })] }, now), null);
        for (const junk of [null, undefined, 7, "x", {}, { cookies: "x" }, { cookies: [null, 3] }]) {
            assert.equal(sessionExpiryOf(junk, now), null);
        }
    });

    it("never carries a cookie value out", () => {
        const out = sessionExpiryOf({ cookies: [cookie({ expires: new Date(NOW + DAY).toISOString() })] }, now);
        assert.doesNotMatch(JSON.stringify(out), /SECRET-VALUE/);
        assert.deepEqual(Object.keys(out).sort(), ["daysLeft", "expired", "expiresAt"]);
    });
});

describe("sessionExpiryFor", () => {
    it("is null for an account with no saved login, and never throws", () => {
        assert.equal(sessionExpiryFor("0000000000000"), null);
    });
});

describe("describeSessionExpiry", () => {
    const at = (days) => ({
        expiresAt: new Date(NOW + days * DAY).toISOString(),
        daysLeft: days,
        expired: days <= 0,
    });

    it("says when it ends, warns inside the warning window, and says when it has ended", () => {
        assert.match(describeSessionExpiry(at(60)), /good until 2026-12-26 \(60 days\)/);
        assert.match(describeSessionExpiry(at(EXPIRY_WARN_DAYS)), /plan a new QR login/);
        assert.doesNotMatch(describeSessionExpiry(at(EXPIRY_WARN_DAYS + 1)), /plan a new QR login/);
        assert.match(describeSessionExpiry(at(-1)), /ended on 2026-10-26: log in again/);
        assert.equal(describeSessionExpiry(null), null);
    });
});

describe("the daemon health says so", () => {
    const health = (session) => {
        const h = createDaemonHealth({ kind: "listen", accountId: "A1", version: "t" });
        h.setSource("session", () => session);
        return h;
    };
    const soon = { expiresAt: "2026-11-01T00:00:00.000Z", daysLeft: 5, expired: false };

    it("adds the session to the snapshot and a warning when it is close or over", () => {
        const h = health(soon);
        const snap = h.snapshot();
        assert.deepEqual(snap.session, soon);
        assert.ok(snap.warnings.some((w) => /ends on 2026-11-01 \(5 day\(s\) left\)/.test(w)));
        assert.equal(snap.status, "degraded");
        h.stop();
        const over = health({ expiresAt: "2026-10-01T00:00:00.000Z", daysLeft: -26, expired: true });
        assert.ok(over.snapshot().warnings.some((w) => /ended on 2026-10-01/.test(w)));
        over.stop();
    });

    it("is quiet while there are weeks left, and when the account has no readable session", () => {
        const far = health({ expiresAt: "2027-01-01T00:00:00.000Z", daysLeft: 70, expired: false });
        assert.deepEqual(far.snapshot().warnings, []);
        far.stop();
        const none = health(null);
        assert.equal(none.snapshot().session, null);
        assert.deepEqual(none.snapshot().warnings, []);
        none.stop();
    });

    it("exports the days left as a metric", () => {
        const h = health(soon);
        assert.match(renderPrometheus(h.snapshot()), /zalo_session_days_left\{account="A1"\} 5/);
        h.stop();
        const none = health(null);
        assert.doesNotMatch(renderPrometheus(none.snapshot()), /zalo_session_days_left/);
        none.stop();
    });
});

describe("`listen` and `mcp start` both report it", () => {
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const src = join(import.meta.dirname, "..", "..", "src", "commands", file);
            const ast = acorn.parse(readFileSync(src, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
            const sources = [];
            walkAst(ast, (node) => {
                if (
                    node.type === "CallExpression" &&
                    node.callee?.property?.name === "setSource" &&
                    node.arguments?.[0]?.value === "session"
                )
                    sources.push(node);
            });
            // Red if one entry point stops reporting the end of the saved login: AGENTS.md section 13 calls that a defect.
            assert.equal(sources.length, 1, `${file} must plug in the session source`);
        });
    }
});
