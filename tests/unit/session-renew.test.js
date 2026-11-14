/**
 * Renewing the saved login from a running daemon (src/core/session-renew.js): when a link opens and what the events
 * carry, the page a phone scans (its headers, its one use, another account's scan), a restart, two accounts on one
 * host, the rate limit, and that the link never reaches a log line. The QR login is a scripted stand-in: nothing here
 * talks to Zalo. Every id is made up.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { QR_EVENT } from "../../src/zalo/enums.js";
import { QrPage, maskQrPath } from "../../src/utils/qr-http-server.js";
import {
    LOGINS_PER_HOUR,
    PAGE_HITS_PER_MIN,
    RENEW_DEFAULTS,
    RENEW_HINT_NO_PUBLIC_URL,
    RENEW_IMAGE_FILE,
    WRONG_ACCOUNT_MESSAGE,
    createSessionRenewal,
    describeSessionRenewed,
    inRenewWindow,
    resolveRenewSettings,
    saveRenewedLogin,
    sessionRenewedEvent,
    sessionRenewedSystemEvent,
} from "../../src/core/session-renew.js";
import {
    describeSessionExpiring,
    sessionExpiringEvent,
    sessionExpiringSystemEvent,
    startSessionExpiryWatch,
} from "../../src/core/session-notice.js";
import { getDefaultConfig, mergeMCPConfigLayer, resolveAccountMCPConfig } from "../../src/mcp/mcp-config.js";
import { validatePolicy } from "../../src/core/policy-schema.js";

const A = "1000000000000000921";
const B = "1000000000000000922";
const DAY = 86_400_000;
const T0 = Date.parse("2026-06-01T00:00:00Z");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const TOKEN_URL = /^https:\/\/host\.example\/a\/(\d+)\/zalo\/qr\/([A-Za-z0-9_-]{22})$/;

let root;
before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    mkdirSync(CONFIG_DIR, { recursive: true });
    root = mkdtempSync(join(CONFIG_DIR, "renew-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** A clock and timers that move only when told. */
function fakeTime(start = T0) {
    let t = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        timers: {
            setTimeout(fn, ms) {
                const id = ++seq;
                timers.set(id, { at: t + ms, fn });
                return id;
            },
            clearTimeout(id) {
                timers.delete(id);
            },
        },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                let next = null;
                for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
                if (!next) break;
                timers.delete(next[0]);
                t = next[1].at;
                next[1].fn();
            }
            t = end;
        },
    };
}

/** A login the test drives: `qr()`, `scan()`, `expire()`, then `succeed()` or `fail(err)`. */
function scriptedLogins() {
    const runs = [];
    const login = ({ onEvent }) =>
        new Promise((resolve, reject) => {
            const run = {
                onEvent,
                actions: {
                    retry: () => run.retries++,
                    abort: () => {
                        const e = new Error("aborted");
                        e.name = "QrLoginAborted";
                        reject(e);
                    },
                },
                retries: 0,
                qr: (layer = 1) => onEvent({ type: QR_EVENT.QR_GENERATED, data: { image: PNG, layer } }),
                scan: (name = "Someone") => onEvent({ type: QR_EVENT.QR_SCANNED, data: { display_name: name } }),
                expire: () => onEvent({ type: QR_EVENT.QR_EXPIRED, data: null, actions: run.actions }),
                succeed: (creds = { imei: "imei-new", cookie: [], userAgent: "ua", language: "vi" }) =>
                    resolve({ creds }),
                fail: (e) => reject(e),
            };
            runs.push(run);
        });
    return { login, runs };
}

function renewalFor(id, o = {}) {
    const dir = join(root, `${id}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const logs = [];
    const renewed = [];
    const scripted = scriptedLogins();
    const settings = { ...RENEW_DEFAULTS, ...(o.settings ?? {}) };
    const r = createSessionRenewal({
        ownId: id,
        accountDir: dir,
        publicUrl: o.publicUrl === undefined ? `https://host.example/a/${id}` : o.publicUrl,
        settings: () => settings,
        accountLabel: () => o.label ?? `Shop ${id.slice(-3)} (${id})`,
        login: scripted.login,
        onRenewed:
            o.onRenewed ??
            (async ({ creds }) => {
                renewed.push(creds);
            }),
        log: (l) => logs.push(l),
        ...(o.time ? { now: o.time.now, timers: o.time.timers } : {}),
    });
    return { r, dir, logs, renewed, runs: scripted.runs, settings };
}

const expiry = (daysLeft, now = T0) => ({
    expiresAt: new Date(now + daysLeft * DAY + 3_600_000).toISOString(),
    daysLeft,
    expired: daysLeft < 0,
});

/** A daemon's session watch on a renewal, with the events it sends. */
function watchFor(id, renewal, read, time) {
    const dir = join(root, `w-${id}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const events = [];
    const w = startSessionExpiryWatch({
        ownId: id,
        accountDir: dir,
        emit: (e) => events.push(e),
        renewal,
        read,
        now: time?.now ?? Date.now,
        everyMs: 0,
    });
    return { w, events };
}

describe("renewal settings", () => {
    it("defaults: on, 7 days before the end, a link lasts 24 hours", () => {
        const s = resolveRenewSettings({ config: getDefaultConfig(), accountId: A, env: {}, policy: () => undefined });
        assert.deepEqual([s.enabled, s.daysBefore, s.linkTtlMs], [true, 7, 24 * 3_600_000]);
        assert.deepEqual(s.warnings, []);
    });

    it("layers: mcp-config < accounts.<ownId> < environment (per-account first) < policy", () => {
        const base = mergeMCPConfigLayer(getDefaultConfig(), {
            session: { renew: { daysBefore: 5, linkTtl: "12h" } },
            accounts: { [A]: { session: { renew: { daysBefore: 3 } } } },
        });
        const cfgA = resolveAccountMCPConfig(base, { accountId: A }).config;
        const none = { policy: () => undefined };
        assert.equal(resolveRenewSettings({ config: base, accountId: B, env: {}, ...none }).daysBefore, 5);
        const a = resolveRenewSettings({ config: cfgA, accountId: A, env: {}, ...none });
        assert.deepEqual([a.daysBefore, a.linkTtlMs, a.sources.daysBefore], [3, 12 * 3_600_000, "config"]);
        const env = { ZALO_SESSION_RENEW_DAYS: "2", [`ZALO_SESSION_RENEW_DAYS_${A}`]: "4", ZALO_SESSION_RENEW: "on" };
        assert.equal(resolveRenewSettings({ config: cfgA, accountId: A, env, ...none }).daysBefore, 4);
        assert.equal(resolveRenewSettings({ config: cfgA, accountId: B, env, ...none }).daysBefore, 2);
        const off = { [`ZALO_SESSION_RENEW_${A}`]: "off" };
        assert.equal(resolveRenewSettings({ config: cfgA, accountId: A, env: off, ...none }).enabled, false);
        assert.equal(resolveRenewSettings({ config: cfgA, accountId: B, env: off, ...none }).enabled, true);
        const policy = (k) => ({ "session.renew.daysBefore": 9, "session.renew.enabled": true })[k];
        const p = resolveRenewSettings({ config: cfgA, accountId: A, env: off, policy });
        assert.deepEqual([p.enabled, p.daysBefore, p.sources.enabled], [true, 9, "policy"]);
    });

    it("an unusable value is left out with a warning, never a crash", () => {
        const config = { session: { renew: { daysBefore: 30, linkTtl: "1m", enabled: "maybe" } } };
        const s = resolveRenewSettings({ config, accountId: A, env: {}, policy: () => undefined });
        assert.deepEqual([s.enabled, s.daysBefore, s.linkTtlMs], [true, 7, 24 * 3_600_000]);
        assert.equal(s.warnings.length, 3);
    });

    it("the policy schema takes the three keys, within the same bounds", () => {
        const ok = validatePolicy({ session: { renew: { enabled: false, daysBefore: 14, linkTtl: "6h" } } });
        assert.deepEqual(ok.errors, []);
        assert.ok(validatePolicy({ session: { renew: { daysBefore: 15 } } }).errors.length > 0);
        assert.ok(validatePolicy({ session: { renew: { linkTtl: "5m" } } }).errors.length > 0);
    });

    it("the window: daysBefore days or fewer left, or ended", () => {
        assert.equal(inRenewWindow(expiry(8), 7), false);
        assert.equal(inRenewWindow(expiry(7), 7), true);
        assert.equal(inRenewWindow(expiry(-2), 7), true);
        assert.equal(inRenewWindow(null, 7), false);
    });
});

describe("session_expiring with a renewal", () => {
    it("no publicUrl: no link, the event as before plus renewHint", () => {
        const { r } = renewalFor(A, { publicUrl: null });
        const { events } = watchFor(A, r, () => expiry(6));
        assert.equal(events.length, 1);
        const e = events[0];
        assert.equal(e.event, "session_expiring");
        assert.equal(e.threshold, 7);
        assert.equal(e.command, `zalo-agent --account ${A} login`);
        assert.equal(e.renewUrl, undefined);
        assert.equal(e.renewExpiresAt, undefined);
        assert.equal(e.renewHint, RENEW_HINT_NO_PUBLIC_URL);
        assert.match(describeSessionExpiring(e), /No renewal link: set publicUrl/);
        assert.equal(r.status(), null);
    });

    it("renewal off: the event exactly as before", () => {
        const { r } = renewalFor(A, { settings: { enabled: false } });
        const { events } = watchFor(A, r, () => expiry(6));
        assert.deepEqual(Object.keys(events[0]).sort(), [
            "accountId",
            "at",
            "command",
            "daysLeft",
            "event",
            "expired",
            "expiresAt",
            "threshold",
        ]);
    });

    it("outside the window (14-day threshold, 7-day window): the threshold event without a link", () => {
        const { r } = renewalFor(A);
        const { events } = watchFor(A, r, () => expiry(12));
        assert.equal(events.length, 1);
        assert.equal(events[0].threshold, 14);
        assert.equal(events[0].renewUrl, undefined);
        assert.equal(events[0].renewHint, undefined);
    });

    it("within the window: the link is in the event, a new link each linkTtl sends a new event, the old link dies", async () => {
        const time = fakeTime();
        const { r, logs } = renewalFor(A, { time });
        const end = T0 + 6 * DAY + 3_600_000;
        const read = () => ({
            expiresAt: new Date(end).toISOString(),
            daysLeft: Math.floor((end - time.now()) / DAY),
            expired: false,
        });
        const { w, events } = watchFor(A, r, read, time);
        assert.equal(events.length, 1);
        const [, acct, token] = TOKEN_URL.exec(events[0].renewUrl);
        assert.equal(acct, A);
        assert.equal(events[0].renewExpiresAt, new Date(T0 + DAY).toISOString());
        assert.deepEqual(r.status(), { open: true, expiresAt: events[0].renewExpiresAt, scanning: false });
        // An hourly look within the day: the same link, no new event.
        time.advance(3_600_000);
        assert.equal(w.check(), null);
        // The link runs out: the renewal asks the watch at once, and a new link goes out.
        time.advance(DAY);
        assert.equal(events.length, 2);
        const second = TOKEN_URL.exec(events[1].renewUrl)[2];
        assert.notEqual(second, token);
        const res = fakeRes();
        assert.equal(await r.handle({ url: `/zalo/qr/${token}`, method: "GET" }, res), false, "the old link is dead");
        // The token is never in a log line or the text the log and the MCP buffer carry.
        for (const line of [...logs, describeSessionExpiring(events[1]), sessionExpiringSystemEvent(events[1]).text])
            assert.ok(!line.includes(token) && !line.includes(second), `the token leaked: ${line}`);
        assert.equal(sessionExpiringSystemEvent(events[1]).renewUrl, events[1].renewUrl, "the buffer has the link");
        r.stop();
    });

    it("an ended login (signed out) still gets a link", () => {
        const { r } = renewalFor(A);
        const { events } = watchFor(A, r, () => expiry(-1));
        assert.equal(events[0].threshold, 0);
        assert.equal(events[0].expired, true);
        assert.match(events[0].renewUrl, TOKEN_URL);
        r.stop();
    });

    it("a daemon restart while a link is open: a new link, and the old one is dead", async () => {
        const first = renewalFor(A);
        const a = watchFor(A, first.r, () => expiry(5));
        const oldToken = TOKEN_URL.exec(a.events[0].renewUrl)[2];
        first.r.stop(); // the process ends: the token lived in memory only
        const second = renewalFor(A);
        const b = watchFor(A, second.r, () => expiry(5));
        assert.match(b.events[0].renewUrl, TOKEN_URL);
        assert.notEqual(TOKEN_URL.exec(b.events[0].renewUrl)[2], oldToken);
        assert.equal(await second.r.handle({ url: `/zalo/qr/${oldToken}`, method: "GET" }, fakeRes()), false);
        second.r.stop();
    });

    it("two accounts on one host: each renews only its own, and neither serves the other's link", async () => {
        const ra = renewalFor(A);
        const rb = renewalFor(B);
        const a = watchFor(A, ra.r, () => expiry(3));
        const b = watchFor(B, rb.r, () => expiry(40));
        assert.equal(b.events.length, 0, "B is not due");
        assert.equal(rb.r.status(), null);
        const tokenA = TOKEN_URL.exec(a.events[0].renewUrl)[2];
        assert.equal(await rb.r.handle({ url: `/zalo/qr/${tokenA}`, method: "GET" }, fakeRes()), false);
        rb.settings.daysBefore = 14;
        rb.settings.enabled = true;
        b.w.check();
        // B's own link (once B is due under its own settings) is under B's own address.
        const forB = rb.r.openNow();
        assert.equal(TOKEN_URL.exec(forB.renewUrl)[1], B);
        assert.equal(await ra.r.handle({ url: `/zalo/qr/${TOKEN_URL.exec(forB.renewUrl)[2]}` }, fakeRes()), false);
        ra.r.stop();
        rb.r.stop();
    });

    it("by hand: refused without publicUrl; the open link again; --fresh replaces it", () => {
        const none = renewalFor(A, { publicUrl: null });
        assert.throws(
            () => none.r.openNow(),
            (e) => e.code === "NO_PUBLIC_URL",
        );
        const { r } = renewalFor(A);
        const one = r.openNow();
        assert.equal(one.issued, true);
        const again = r.openNow();
        assert.deepEqual([again.issued, again.renewUrl], [false, one.renewUrl]);
        const fresh = r.openNow({ fresh: true });
        assert.equal(fresh.issued, true);
        assert.notEqual(fresh.renewUrl, one.renewUrl);
        r.stop();
    });
});

/** A response stand-in for a route that should not answer. */
function fakeRes() {
    return {
        writeHead() {
            throw new Error("answered");
        },
        end() {},
    };
}

describe("the renewal page", () => {
    let server;
    let base;
    let fallback;
    const live = [];

    before(async () => {
        // As the daemon wires it: the renewal's link first, then the process's own QR page (no link open: 404).
        fallback = new QrPage();
        server = http.createServer(async (req, res) => {
            for (const r of live) if (await r.handle(req, res)) return;
            if (await fallback.handle(req, res)) return;
            res.writeHead(404);
            res.end();
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => {
        for (const r of live) r.stop();
        server.close();
    });

    const pathOf = (url) => new URL(url).pathname.replace(/^\/a\/\d+/, "");
    const until = async (check, what) => {
        const end = Date.now() + 3000;
        while (!(await check())) {
            if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    const status = async (path) => (await fetch(`${base}${path}/status`)).json();

    it("opening it starts a QR login; its headers are the secure pages'; it says which account; one use", async () => {
        const t = renewalFor(A);
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        const page = await fetch(`${base}${path}`);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
        assert.equal(page.headers.get("x-content-type-options"), "nosniff");
        assert.equal(page.headers.get("referrer-policy"), "no-referrer");
        assert.equal(page.headers.get("x-frame-options"), "DENY");
        assert.match(page.headers.get("content-security-policy"), /default-src 'none'.*frame-ancestors 'none'/);
        await page.text();
        assert.equal(t.runs.length, 1, "the visit started a login");
        t.runs[0].qr();
        assert.ok(existsSync(join(t.dir, RENEW_IMAGE_FILE)));
        const html = await (await fetch(`${base}${path}`)).text();
        assert.match(html, new RegExp(`ACCOUNT="Shop 921 \\(${A}\\)"`));
        assert.match(html, /Renew the login with QR/);
        assert.equal(t.runs.length, 1, "a second visit while one runs starts no second login");
        const img = await fetch(`${base}${path}/qr.png`);
        assert.equal(img.headers.get("content-type"), "image/png");
        assert.equal(img.headers.get("x-content-type-options"), "nosniff");
        // The daemon is logged in, but that is not this page's login: not "done" before the phone confirms.
        let s = await status(path);
        assert.deepEqual([s.loggedIn, s.outcome], [false, null]);
        t.runs[0].scan("Shop");
        assert.equal(t.r.expectingKick(), true, "from the scan, the old session's kick is expected");
        s = await status(path);
        assert.equal(s.scanned, "Shop");
        t.runs[0].succeed();
        await until(() => t.renewed.length === 1, "the switch");
        s = await status(path);
        assert.deepEqual([s.loggedIn, s.outcome], [true, "done"]);
        assert.ok(!existsSync(join(t.dir, RENEW_IMAGE_FILE)), "the code is removed");
        // Read once: the link dies, and opening it again starts nothing.
        await until(async () => (await fetch(`${base}${path}`)).status === 404, "the link to die");
        assert.equal(t.runs.length, 1);
        assert.equal(t.r.status(), null);
        assert.equal(t.r.expectingKick(), true, "the kick grace outlives the link");
    });

    it("a name that looks like markup stays text: it never closes the script or adds an element", async () => {
        const t = renewalFor(A, { label: "</script><img src=x onerror=alert(1)> $& (1)" });
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        await (await fetch(`${base}${path}`)).text();
        t.runs[0].qr();
        const html = await (await fetch(`${base}${path}`)).text();
        assert.ok(!html.includes("</script><img"), "the name closed the script");
        assert.equal(html.split("</script>").length - 1, 1);
        const line = html.split("\n").find((l) => l.startsWith("const ACCOUNT="));
        assert.equal(
            JSON.parse(line.slice("const ACCOUNT=".length, -1)),
            "</script><img src=x onerror=alert(1)> $& (1)",
        );
    });

    it("a scan by another account: refused on the page, nothing saved, the link stays for the right phone", async () => {
        const t = renewalFor(A);
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        await (await fetch(`${base}${path}`)).text();
        t.runs[0].qr();
        t.runs[0].fail(Object.assign(new Error("x"), { code: "WRONG_ACCOUNT" }));
        await until(async () => (await status(path)).outcome === "failed", "the refusal");
        const s = await status(path);
        assert.equal(s.message, WRONG_ACCOUNT_MESSAGE);
        assert.equal(s.loggedIn, false);
        assert.deepEqual(t.renewed, [], "nothing was saved");
        assert.ok(t.logs.some((l) => /another account was refused/.test(l)));
        // A reload asks for a new code: a new login on the same link.
        await (await fetch(`${base}${path}`)).text();
        assert.equal(t.runs.length, 2);
        assert.equal((await status(path)).outcome, null);
    });

    it("an expired code waits for 'Get a new code'; nobody asking ends that login, and the button starts a new one", async () => {
        const time = fakeTime(Date.now());
        const t = renewalFor(A, { time });
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        await (await fetch(`${base}${path}`)).text();
        t.runs[0].qr();
        t.runs[0].expire();
        const s = await status(path);
        assert.deepEqual([s.expired, s.canRefresh], [true, true]);
        assert.equal((await fetch(`${base}${path}/refresh`, { method: "POST" })).status, 200);
        assert.equal(t.runs[0].retries, 1);
        t.runs[0].qr();
        t.runs[0].expire();
        time.advance(5 * 60_000);
        await until(async () => (await status(path)).canRefresh === true, "the new-login offer");
        await fetch(`${base}${path}/refresh`, { method: "POST" });
        await until(() => t.runs.length === 2, "a new login");
    });

    it("the switch failing shows on the page, and the link stays", async () => {
        const t = renewalFor(A, {
            onRenewed: async () => {
                throw new Error("cannot log in");
            },
        });
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        await (await fetch(`${base}${path}`)).text();
        t.runs[0].succeed();
        await until(async () => (await status(path)).outcome === "failed", "the failure");
        assert.equal((await fetch(`${base}${path}`)).status, 200);
    });

    it(`at most ${PAGE_HITS_PER_MIN} requests a minute on a link, and ${LOGINS_PER_HOUR} logins an hour`, async () => {
        const t = renewalFor(A);
        live.push(t.r);
        const path = pathOf(t.r.openNow().renewUrl);
        const codes = [];
        for (let i = 0; i < PAGE_HITS_PER_MIN + 1; i++) codes.push((await fetch(`${base}${path}/status`)).status);
        assert.equal(codes.filter((c) => c === 200).length, PAGE_HITS_PER_MIN);
        const last = await fetch(`${base}${path}/status`);
        assert.equal(last.status, 429);
        assert.equal(last.headers.get("retry-after"), "60");

        const u = renewalFor(A);
        live.push(u.r);
        const p2 = pathOf(u.r.openNow().renewUrl);
        for (let i = 0; i < LOGINS_PER_HOUR + 1; i++) {
            await (await fetch(`${base}${p2}`)).text();
            u.runs.at(-1)?.fail(Object.assign(new Error("declined"), { name: "QrLoginDeclined" }));
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(u.runs.length, LOGINS_PER_HOUR);
        assert.match((await status(p2)).message, /Too many codes/);
    });

    it("the access log's mask hides the token", () => {
        const t = renewalFor(A);
        const url = t.r.openNow().renewUrl;
        const token = TOKEN_URL.exec(url)[2];
        assert.ok(!maskQrPath(`${pathOf(url)}/status`).includes(token));
        t.r.stop();
    });
});

describe("session_renewed and the save", () => {
    it("the event: ids and dates, and whether the device id was kept", () => {
        const e = sessionRenewedEvent(A, expiry(89), { deviceKept: true, at: T0 });
        assert.deepEqual(Object.keys(e).sort(), ["accountId", "at", "daysLeft", "deviceKept", "event", "expiresAt"]);
        assert.equal(e.event, "session_renewed");
        assert.equal(e.daysLeft, 89);
        assert.match(
            describeSessionRenewed(e),
            /renewed by QR; it now ends on .* \(89 day\(s\)\); the device id was kept/,
        );
        const sys = sessionRenewedSystemEvent(e);
        assert.equal(sys.type, "session_renewed");
        assert.equal(sys.event, undefined);
    });

    it("saves as login saves: sealed credentials, the kick marker cleared, the device id compared first", () => {
        const calls = [];
        const deps = {
            readSavedDevice: () => ({ imei: "imei-old" }),
            loginDeviceChange: (prev, imei) => ({ newDevice: prev.imei !== imei }),
            saveCredentials: (id, creds, o) => calls.push(["save", id, creds.imei, o.now]),
            clearKickMarker: (f) => calls.push(["kick", f]),
            kickFile: (d) => `${d}/kicked.json`,
            getAccountDir: (id) => `/acc/${id}`,
        };
        const kept = saveRenewedLogin({ ownId: A, creds: { imei: "imei-old" }, now: 5, deps });
        assert.deepEqual(kept, { deviceKept: true });
        assert.deepEqual(calls, [
            ["save", A, "imei-old", 5],
            ["kick", `/acc/${A}/kicked.json`],
        ]);
        assert.deepEqual(saveRenewedLogin({ ownId: A, creds: { imei: "other" }, deps }), { deviceKept: false });
    });

    it("a session_expiring event built without a renewal is unchanged", () => {
        const e = sessionExpiringEvent(A, expiry(3), T0);
        assert.equal("renewUrl" in e || "renewHint" in e, false);
    });
});
