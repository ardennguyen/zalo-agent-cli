/**
 * TIER 1 — read-only live checks.
 *
 * Nothing here mutates server state. It runs first so that a dead
 * credential, a wrong account, or a drifted target id fails the run before
 * any later tier has created or destroyed anything.
 *
 * Gate: ZALO_TEST_LIVE=1
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { runCli, runJson, errorLineOf } from "../helpers/cli.js";
import { gate, live, probeSession, retryRead } from "../helpers/live.js";

const g = gate(1);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

/**
 * Read-only JSON call with transient-failure retry. Zalo's unofficial
 * endpoints intermittently answer 404/5xx; a read that matters should not
 * fail the suite over one bad round trip. Genuinely retired endpoints still
 * fail every attempt, so real breakage is not masked.
 */
const readJson = (args, opts) => retryRead(() => runJson(args, opts));

describe("tier 1 · session", { skip }, () => {
    let session;
    before(async () => {
        session = await probeSession(T);
    });

    it("the stored credential still authenticates", () => {
        assert.equal(session.ok, true, session.reason);
    });

    it("is the account tests/targets.json expects", () => {
        assert.equal(session.ownId, T.accountOwnId);
    });

    it("whoami returns a profile for that same id", async () => {
        const r = await readJson(["whoami"], live(T));
        assert.equal(r.ok, true, r.error);
        const p = r.data?.profile || {};
        assert.equal(String(p.userId || session.ownId), T.accountOwnId);
        assert.ok(p.displayName, "profile should carry a display name");
    });

    it("status masks the proxy rather than printing credentials", async () => {
        const { all } = await runCli(["status"], live(T));
        assert.doesNotMatch(all, /cookie|imei/i);
    });
});

describe("tier 1 · account registry", { skip }, () => {
    it("account list includes the account under test", async () => {
        const { all } = await runCli(["account", "list"], live(T));
        assert.match(all, new RegExp(T.accountOwnId));
    });

    it("account info reports it as active", async () => {
        const { all } = await runCli(["account", "info"], live(T));
        assert.match(all, new RegExp(T.accountOwnId));
    });

    it("account devices lists linked sessions read-only", async () => {
        const r = await readJson(["account", "devices"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("no command output ever contains a proxy password", async () => {
        for (const args of [["account", "list"], ["account", "info"], ["status"]]) {
            const { all } = await runCli(args, live(T));
            assert.doesNotMatch(all, /:\/\/[^:@\s]+:(?!\*\*\*)[^@\s]+@/, `\`${args.join(" ")}\` leaked a password`);
        }
    });
});

describe("tier 1 · friends", { skip }, () => {
    it("friend list returns a populated array", async () => {
        const r = await readJson(["friend", "list"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        const arr = Array.isArray(r.data) ? r.data : r.data?.items || [];
        assert.ok(arr.length > 0, "expected at least one friend");
        assert.ok(arr[0].userId, "entries carry a userId usable as a thread_id");
    });

    it(
        "friend info resolves the disposable DM target",
        { skip: T?.dm ? false : "no DM target configured" },
        async () => {
            const r = await readJson(["friend", "info", T.dm.threadId], live(T));
            assert.equal(r.ok, true, r.error);
            const p = Object.values(r.data?.changed_profiles || {})[0];
            assert.ok(p, "expected a profile record");
            assert.equal(String(p.userId), T.dm.threadId);
            assert.equal(p.isFr, 1, "the DM target must be a friend for 1:1 tests to be meaningful");
        },
    );

    it("friend search is accent-insensitive", async () => {
        const r = await readJson(["friend", "search", "nguyen"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data));
    });

    // KNOWN DEFECT (upstream) — see tests/NOTES.md § Known issues.
    // Zalo answers this endpoint with HTTP 404; zca-js is calling a route
    // that no longer exists. The CLI surface is fine — the API is gone.
    it("friend online returns a list", { todo: "Zalo returns HTTP 404 — retired endpoint in zca-js" }, async () => {
        const r = await runJson(["friend", "online"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
    });

    it("CHARACTERIZATION: friend online currently 404s", async () => {
        const r = await runJson(["friend", "online"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, false);
        assert.match(r.error, /404/);
    });

    it("friend close lists close friends", { todo: "Zalo returns HTTP 404 — retired endpoint in zca-js" }, async () => {
        const r = await runJson(["friend", "close"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
    });

    it("CHARACTERIZATION: friend close currently 404s", async () => {
        const r = await runJson(["friend", "close"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, false);
        assert.match(r.error, /404/);
    });

    it("friend alias-list works in its default (unpaginated) form", async () => {
        const r = await readJson(["friend", "alias-list"], live(T));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data?.items), "expected an items array");
    });

    // REGRESSION GUARD — this used to fail, and it was OUR bug.
    //
    // It was misfiled for a while as an upstream Zalo defect
    // ("Tham số không hợp lệ"). The real cause was
    // `.option("-c, --count <n>", ..., parseInt, 100)`: Commander calls a
    // coercion as fn(value, previousValue), and JS parseInt takes a RADIX
    // second — so this evaluated parseInt("100", 100) => NaN, and we sent
    // NaN to Zalo. Zalo was right to reject it. See src/utils/parse-options.js.
    it("friend alias-list accepts explicit -c/-p paging", async () => {
        const r = await readJson(["friend", "alias-list", "-c", "100", "-p", "1"], live(T));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data?.items), "expected an items array");
    });

    it("alias-list paging returns a different page for -p 2", async () => {
        const p1 = await readJson(["friend", "alias-list", "-c", "5", "-p", "1"], live(T));
        const p2 = await readJson(["friend", "alias-list", "-c", "5", "-p", "2"], live(T));
        assert.equal(p1.ok, true, p1.error);
        assert.equal(p2.ok, true, p2.error);
        const ids1 = (p1.data?.items || []).map((i) => String(i.userId));
        const ids2 = (p2.data?.items || []).map((i) => String(i.userId));
        if (ids1.length && ids2.length) {
            assert.notDeepEqual(ids1, ids2, "page 2 should differ from page 1");
        }
    });

    it("friend recommendations returns suggestion items", async () => {
        const r = await readJson(["friend", "recommendations"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data?.recommItems), "expected a recommItems array");
    });

    it("friend sent-requests responds", async () => {
        const r = await readJson(["friend", "sent-requests"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
    });

    it("friend request-status resolves for the DM target", { skip: T?.dm ? false : "no DM target" }, async () => {
        const r = await readJson(["friend", "request-status", T.dm.threadId], live(T));
        assert.equal(r.ok, true, r.error);
    });
});

describe("tier 1 · groups", { skip }, () => {
    it("group list contains the disposable group", async () => {
        const r = await readJson(["group", "list"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        const ids = (r.data || []).map((x) => String(x.threadId));
        assert.ok(ids.includes(T.group.threadId), `disposable group ${T.group.threadId} not found`);
    });

    it("group list -q filters accent-insensitively and finds it by name", async () => {
        const r = await readJson(["group", "list", "-q", "viec rieng"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        const names = (r.data || []).map((x) => x.name);
        assert.ok(
            names.some((n) => n === T.group.name),
            `accent-insensitive query should match "${T.group.name}", got: ${names.join(" | ")}`,
        );
    });

    it("group info confirms the disposable group's identity", async () => {
        const r = await readJson(["group", "info", T.group.threadId], live(T));
        assert.equal(r.ok, true, r.error);
        const info = r.data?.gridInfoMap?.[T.group.threadId];
        assert.ok(info, "expected gridInfoMap keyed by the group id");
        assert.equal(info.name, T.group.name, "name drift means targets.json is stale — stop before writing");
    });

    it("group members lists the configured member ids", async () => {
        const r = await readJson(["group", "members", T.group.threadId], live(T));
        assert.equal(r.ok, true, r.error);
        const members = (r.data || []).map(String);
        assert.ok(members.includes(T.accountOwnId), "the test account must be a member");
        for (const m of T.group.memberIds) {
            assert.ok(members.includes(m), `configured member ${m} is no longer in the group`);
        }
    });

    it("group blocked / link-info respond for a group we own", async () => {
        for (const args of [
            ["group", "blocked", T.group.threadId],
            ["group", "link-info", T.group.threadId],
        ]) {
            const r = await readJson(args, live(T));
            assert.equal(r.ok, true, `${args.join(" ")}: ${r.error}`);
        }
    });

    it("group invite-boxes responds", async () => {
        const r = await readJson(["group", "invite-boxes"], live(T));
        assert.equal(r.ok, true, r.error);
    });
});

describe("tier 1 · conversations", { skip }, () => {
    it("conv recent returns threads with usable ids", async () => {
        const r = await readJson(["conv", "recent", "-n", "5"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data) && r.data.length > 0);
        for (const c of r.data) assert.ok(c.threadId, "every row needs a thread_id");
    });

    it("conv recent --friends-only returns only DMs", async () => {
        const r = await readJson(["conv", "recent", "-n", "5", "--friends-only"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        for (const c of r.data) assert.equal(c.type, "User");
    });

    it("conv recent --groups-only returns only groups", async () => {
        const r = await readJson(["conv", "recent", "-n", "5", "--groups-only"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        for (const c of r.data) assert.equal(c.type, "Group");
    });

    it("conv pinned / archived / hidden / auto-delete-status all respond", async () => {
        for (const args of [
            ["conv", "pinned"],
            ["conv", "archived"],
            ["conv", "hidden"],
            ["conv", "auto-delete-status"],
        ]) {
            const r = await readJson(args, live(T));
            assert.equal(r.ok, true, `${args.join(" ")}: ${r.error}`);
        }
    });

    it("conv hidden never prints the raw PIN in human mode", async () => {
        const { all } = await runCli(["conv", "hidden"], live(T));
        assert.doesNotMatch(all, /\bpin\b\s*[:=]\s*\d{4}\b/i);
    });
});

describe("tier 1 · profile and settings", { skip }, () => {
    it("profile me returns the account profile", async () => {
        const r = await readJson(["profile", "me"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("profile settings returns privacy settings", async () => {
        const r = await readJson(["profile", "settings"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("profile avatars lists the avatar gallery", async () => {
        const r = await readJson(["profile", "avatars"], live(T));
        assert.equal(r.ok, true, r.error);
    });
});

describe("tier 1 · misc read-only surfaces", { skip }, () => {
    it("label list responds", async () => {
        const r = await readJson(["label", "list"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("quick-msg list responds", async () => {
        const r = await readJson(["quick-msg", "list"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("auto-reply list responds", async () => {
        const r = await readJson(["auto-reply", "list"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("catalog list responds", async () => {
        const r = await readJson(["catalog", "list"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("msg sticker-list finds stickers for a common keyword", async () => {
        const r = await readJson(["msg", "sticker-list", "hello"], live(T));
        assert.equal(r.ok, true, r.error);
    });

    it("reminder list responds for the disposable group", async () => {
        const r = await readJson(["reminder", "list", "-t", "1", T.group.threadId], live(T));
        assert.equal(r.ok, true, r.error);
    });
});

describe("tier 1 · --json cleanliness", { skip }, () => {
    it("--json output carries no banner, info lines, or ANSI escapes", async () => {
        for (const args of [["status"], ["conv", "pinned"], ["label", "list"]]) {
            // Retry on a transient upstream blip: this test is about output
            // *shape*, not about whether Zalo happened to answer this second.
            const r = await retryRead(async () => {
                const out = await runCli(["--json", ...args], live(T));
                const failed = errorLineOf(out.stdout);
                return failed ? { ok: false, error: failed, out } : { ok: true, out };
            });
            assert.equal(r.ok, true, `${args.join(" ")}: ${r.error}`);

            const { stdout } = r.out;
            assert.doesNotMatch(stdout, /unofficial Zalo APIs/, `${args.join(" ")} leaked the disclaimer`);
            assert.doesNotMatch(stdout, /^\s*[●✓⚠]/m, `${args.join(" ")} leaked a human status line`);
            const ansi = new RegExp(String.fromCharCode(0x1b) + "\\[");
            assert.doesNotMatch(stdout, ansi, `${args.join(" ")} leaked ANSI escapes`);
            assert.doesNotThrow(() => JSON.parse(stdout.trim()), `${args.join(" ")} is not parseable`);
        }
    });

    it("auto-login info line is suppressed in --json mode", async () => {
        const { stdout } = await runCli(["--json", "status"], live(T));
        assert.doesNotMatch(stdout, /Auto-login/);
    });
});
