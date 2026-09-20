/**
 * TIER 3 — reversible mutations.
 *
 * Every test here changes server state and then puts it back. The restore
 * lives in the test's own `after()` (not at the end of the file) so that
 * aborting mid-tier leaves the smallest possible amount of drift.
 *
 * Ordering within the tier is deliberate: settings that affect whether
 * later commands are even permitted (group name, group settings) come
 * after the per-conversation toggles, so a failure in a toggle can't leave
 * the group in a state that blocks its own cleanup.
 *
 * Gate: ZALO_TEST_LIVE=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runCli, runJson, hasSuccess, errorLineOf } from "../helpers/cli.js";
import { gate, live, sleep, assertDisposable } from "../helpers/live.js";

const g = gate(3);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

/** Run a CLI command and assert it neither crashed nor printed an error. */
async function ok(args, label, timeout = 120_000) {
    const r = await runCli(args, live(T, { timeout }));
    assert.doesNotMatch(r.all, /at Command\.|Unhandled|at getApi/, `${label} crashed: ${r.all.slice(0, 300)}`);
    assert.ok(hasSuccess(r.stdout) || r.stdout.trim().length > 0, `${label} produced no output`);
    return r;
}

describe("tier 3 · conversation mute", { skip }, () => {
    after(async () => {
        if (!g.run) return;
        await runCli(["conv", "unmute", "-t", "1", T.group.threadId], live(T));
    });

    it("mutes the disposable group forever, then unmutes it", async () => {
        assertDisposable(T.group.threadId, "conv mute");
        await ok(["conv", "mute", "-t", "1", "-d", "-1", T.group.threadId], "mute");
        await sleep(400);
        await ok(["conv", "unmute", "-t", "1", T.group.threadId], "unmute");
    });

    it("accepts a finite mute duration", async () => {
        assertDisposable(T.group.threadId, "conv mute");
        await ok(["conv", "mute", "-t", "1", "-d", "3600", T.group.threadId], "mute 1h");
    });
});

describe("tier 3 · read / unread", { skip }, () => {
    after(async () => {
        if (!g.run) return;
        await runCli(["conv", "read", "-t", "1", T.group.threadId], live(T));
    });

    it("marks the group read, then unread, then read again", async () => {
        assertDisposable(T.group.threadId, "conv read/unread");
        await ok(["conv", "read", "-t", "1", T.group.threadId], "read");
        await sleep(400);
        await ok(["conv", "unread", "-t", "1", T.group.threadId], "unread");
        await sleep(400);
        await ok(["conv", "read", "-t", "1", T.group.threadId], "read again");
    });
});

describe("tier 3 · hide / unhide", { skip }, () => {
    let hidden = false;

    after(async () => {
        if (!g.run || !hidden) return;
        await runCli(["conv", "unhide", "-t", "1", T.group.threadId], live(T));
    });

    it("hides and unhides the disposable group", async () => {
        assertDisposable(T.group.threadId, "conv hide");
        const r = await runCli(["conv", "hide", "-t", "1", T.group.threadId], live(T, { timeout: 120_000 }));
        // Hiding requires the hidden-conversations PIN to be set. If this
        // account has no PIN, Zalo refuses — a clean refusal is fine, a
        // crash is not.
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        if (hasSuccess(r.stdout)) {
            hidden = true;
            await sleep(500);
            const back = await runCli(["conv", "unhide", "-t", "1", T.group.threadId], live(T));
            assert.ok(hasSuccess(back.stdout), back.stdout.slice(0, 300));
            hidden = false;
        }
    });
});

describe("tier 3 · auto-delete TTL", { skip }, () => {
    after(async () => {
        if (!g.run) return;
        await runCli(["conv", "auto-delete", "-t", "1", T.group.threadId, "off"], live(T));
    });

    it("sets a 7d TTL and reads it back, then turns it off", async () => {
        assertDisposable(T.group.threadId, "conv auto-delete");
        await ok(["conv", "auto-delete", "-t", "1", T.group.threadId, "7d"], "auto-delete 7d");
        await sleep(600);

        const status = await runJson(["conv", "auto-delete-status"], live(T));
        assert.equal(status.ok, true, status.error);

        await ok(["conv", "auto-delete", "-t", "1", T.group.threadId, "off"], "auto-delete off");
    });

    it("accepts each documented TTL value", async () => {
        assertDisposable(T.group.threadId, "conv auto-delete");
        for (const ttl of ["1d", "14d", "off"]) {
            const r = await runCli(["conv", "auto-delete", "-t", "1", T.group.threadId, ttl], live(T));
            assert.doesNotMatch(r.all, /Invalid TTL/, `TTL ${ttl} should be accepted`);
            await sleep(300);
        }
    });
});

describe("tier 3 · friend alias", { skip: skip || (T?.dm ? false : "no DM target configured") }, () => {
    let original = null;
    let changed = false;

    after(async () => {
        if (!g.run || !changed) return;
        if (original) await runCli(["friend", "alias", T.dm.threadId, original], live(T));
        else await runCli(["friend", "alias-remove", T.dm.threadId], live(T));
    });

    it("sets an alias, then restores the original", async () => {
        // Capture the current alias so the restore is exact.
        const before = await runJson(["friend", "alias-list"], live(T));
        if (before.ok) {
            const found = (before.data?.items || []).find((i) => String(i.userId) === T.dm.threadId);
            original = found?.alias ?? null;
        }

        const r = await runCli(["friend", "alias", T.dm.threadId, "e2e-temp-alias"], live(T));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        if (hasSuccess(r.stdout)) {
            changed = true;
            await sleep(600);
            const after2 = await runJson(["friend", "alias-list"], live(T));
            if (after2.ok) {
                const found = (after2.data?.items || []).find((i) => String(i.userId) === T.dm.threadId);
                assert.equal(found?.alias, "e2e-temp-alias", "the alias should have taken effect");
            }
        }
    });
});

describe("tier 3 · profile bio", { skip }, () => {
    let original = "";
    let changed = false;

    after(async () => {
        if (!g.run || !changed) return;
        await runCli(["profile", "bio", original], live(T));
    });

    it("updates the bio and restores the previous value", async () => {
        const before = await runCli(["profile", "bio"], live(T));
        const m = before.stdout.match(/●\s*(.*)$/m);
        original = m ? m[1].trim() : "";

        const r = await runCli(["profile", "bio", "e2e temporary status"], live(T));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        if (hasSuccess(r.stdout)) changed = true;
    });
});

describe("tier 3 · group rename", { skip }, () => {
    let renamed = false;

    after(async () => {
        if (!g.run || !renamed) return;
        // Always put the canonical name back — later tiers and
        // targets.json both key off it.
        await runCli(["group", "rename", T.group.threadId, T.group.name], live(T, { timeout: 120_000 }));
    });

    // REGRESSION GUARD — rename used to fail every single time.
    //
    // group.js called changeGroupName(groupId, name) but zca-js declares
    // changeGroupName(name, groupId) — the arguments were swapped, so Zalo
    // got the group id as the new name and rejected the call with
    // "Tham số không hợp lệ". (changeGroupAvatar(source, groupId) right
    // below it was always in the declared order; rename was the outlier.)
    it("renames the disposable group and restores its configured name", async () => {
        assertDisposable(T.group.threadId, "group rename");
        const temp = `${T.group.name} (e2e)`;

        const r = await runCli(["group", "rename", T.group.threadId, temp], live(T, { timeout: 120_000 }));
        assert.equal(errorLineOf(r.stdout), null, `rename failed: ${r.all.slice(0, 300)}`);
        assert.ok(hasSuccess(r.stdout), "rename should report success");
        renamed = true;
        await sleep(2000);

        const info = await runJson(["group", "info", T.group.threadId], live(T));
        assert.equal(info.ok, true, info.error);
        assert.equal(info.data?.gridInfoMap?.[T.group.threadId]?.name, temp, "the new name must actually take effect");

        const back = await runCli(["group", "rename", T.group.threadId, T.group.name], live(T, { timeout: 120_000 }));
        assert.equal(errorLineOf(back.stdout), null, `restore failed: ${back.all.slice(0, 300)}`);
        renamed = false;
        await sleep(2000);

        const after2 = await runJson(["group", "info", T.group.threadId], live(T));
        assert.equal(
            after2.data?.gridInfoMap?.[T.group.threadId]?.name,
            T.group.name,
            "the group name must be restored exactly — targets.json depends on it",
        );
    });
});

describe("tier 3 · group settings", { skip }, () => {
    after(async () => {
        if (!g.run) return;
        // Restore the permissive defaults.
        await runCli(
            ["group", "settings", T.group.threadId, "--no-lock-poll", "--no-lock-post", "--no-sign-admin"],
            live(T, { timeout: 120_000 }),
        );
    });

    it("toggles a setting on and back off", async () => {
        assertDisposable(T.group.threadId, "group settings");
        await ok(["group", "settings", T.group.threadId, "--sign-admin"], "sign-admin on");
        await sleep(600);
        await ok(["group", "settings", T.group.threadId, "--no-sign-admin"], "sign-admin off");
    });

    it("accepts the negated form of each documented flag", async () => {
        assertDisposable(T.group.threadId, "group settings");
        const r = await runCli(
            ["group", "settings", T.group.threadId, "--no-lock-poll", "--no-lock-post", "--no-block-name"],
            live(T, { timeout: 120_000 }),
        );
        assert.doesNotMatch(r.all, /at Command\.|Unhandled|unknown option/i, r.all.slice(0, 300));
    });
});

describe("tier 3 · group invite link", { skip }, () => {
    it("enables, inspects and disables the invite link", async () => {
        assertDisposable(T.group.threadId, "group enable-link");
        const on = await runCli(["group", "enable-link", T.group.threadId], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(on.all, /at Command\.|Unhandled/, on.all.slice(0, 300));
        await sleep(600);

        const info = await runJson(["group", "link-info", T.group.threadId], live(T));
        assert.equal(info.ok, true, info.error);

        const off = await runCli(["group", "disable-link", T.group.threadId], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(off.all, /at Command\.|Unhandled/, off.all.slice(0, 300));
    });
});

describe("tier 3 · message history and local cache", { skip }, () => {
    it("msg history returns messages for the disposable group", async () => {
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "10", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(String(r.data.threadId), T.group.threadId);
        assert.equal(r.data.threadType, "group");
        assert.ok(["sqlite", "live"].includes(r.data.source), `unexpected source ${r.data.source}`);
        assert.ok(Array.isArray(r.data.messages));
    });

    it("--no-cache forces a live fetch", async () => {
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "5", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(r.data.source, "live", "--no-cache must not be served from sqlite");
    });

    it("honors -n as an upper bound", async () => {
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "3", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.ok(r.data.messages.length <= 3, `expected ≤3 messages, got ${r.data.messages.length}`);
    });
});

describe("tier 3 · polls (vote lifecycle)", { skip }, () => {
    it("creates, votes, unvotes and locks a throwaway poll", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const created = await runJson(
            ["poll", "create", T.group.threadId, "[e2e] vote cycle", "Alpha", "Beta"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(created.ok, true, created.error);
        const pollId = String(created.data?.poll_id || created.data?.pollId || created.data?.id || "");
        assert.ok(pollId, `no poll id in ${JSON.stringify(created.data).slice(0, 200)}`);

        await sleep(800);
        const info = await runJson(["poll", "info", pollId], live(T));
        assert.equal(info.ok, true, info.error);

        const optionId =
            (info.data?.options || [])[0]?.votedMemberIds !== undefined ? String(info.data.options[0].id ?? 0) : null;

        if (optionId !== null) {
            const voted = await runCli(["poll", "vote", pollId, optionId], live(T));
            assert.doesNotMatch(voted.all, /at Command\.|Unhandled/, voted.all.slice(0, 300));
            await sleep(600);
            const unvoted = await runCli(["poll", "unvote", pollId], live(T));
            assert.doesNotMatch(unvoted.all, /at Command\.|Unhandled/, unvoted.all.slice(0, 300));
        }

        // Locking is the reversible end-state for a poll — there is no
        // `poll delete`, so a locked poll is as closed as it gets.
        const locked = await runCli(["poll", "lock", pollId], live(T));
        assert.doesNotMatch(locked.all, /at Command\.|Unhandled/, locked.all.slice(0, 300));
    });
});
describe("tier 3 · local cache and the --no-cache flag", { skip }, () => {
    // `msg history` has two sources. Default: serve from sqlite when the
    // cache already holds >= limit messages for that thread, otherwise fall
    // through to a live fetch. `--no-cache`: always fetch live and amend the
    // db. The `source` field in --json output says which path ran, so these
    // assert the actual branch taken rather than just "it returned rows".

    it("default path reports its source as either sqlite or live", async () => {
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "5", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.ok(["sqlite", "live"].includes(r.data.source), `unexpected source ${r.data.source}`);
    });

    it("--no-cache always reports source:live, even right after a cached read", async () => {
        // Warm whatever cache there is first…
        await runJson(["msg", "history", "-t", "1", "-n", "5", T.group.threadId], live(T, { timeout: 180_000 }));
        // …then prove --no-cache ignores it.
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "5", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(r.data.source, "live", "--no-cache must never be served from sqlite");
    });

    it("a live fetch amends the db so a later read can be served from cache", async () => {
        // Force a live fetch that writes rows…
        const liveRead = await runJson(
            ["msg", "history", "-t", "1", "-n", "3", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(liveRead.ok, true, liveRead.error);

        // …then ask for no more than it just cached. The default path serves
        // from sqlite only when the cache holds >= limit rows.
        const cached = await runJson(
            ["msg", "history", "-t", "1", "-n", "1", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(cached.ok, true, cached.error);
        assert.ok(["sqlite", "live"].includes(cached.data.source));
    });

    it("history is newest-first in both modes", async () => {
        for (const extra of [[], ["--no-cache"]]) {
            const r = await runJson(
                ["msg", "history", "-t", "1", "-n", "10", ...extra, T.group.threadId],
                live(T, { timeout: 180_000 }),
            );
            assert.equal(r.ok, true, r.error);
            const ts = r.data.messages.map((m) => m.timestamp).filter((t) => typeof t === "number");
            const sorted = [...ts].sort((a, b) => b - a);
            assert.deepEqual(ts, sorted, `not newest-first with ${extra.join(" ") || "(default)"}`);
        }
    });

    // KNOWN GAP — see tests/NOTES.md § Ordering.
    // `conv recent` reads the sqlite `threads` table first and silently falls
    // back to a live path when it is empty. There is no --no-cache flag to
    // force either branch, so a caller cannot tell which one answered.
    it("conv recent offers no --no-cache flag (documented gap)", async () => {
        const r = await runCli(["conv", "recent", "--no-cache"], live(T, { timeout: 60_000 }));
        assert.notEqual(r.code, 0, "there is currently no such flag");
        assert.match(r.all, /unknown option/i);
    });

    it("conv recent returns threads regardless of which branch answers", async () => {
        const r = await runJson(["conv", "recent", "-n", "5"], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, r.error);
        assert.ok(Array.isArray(r.data) && r.data.length > 0);
    });
});

// ---------------------------------------------------------------------------
// sync-mobile — OFF BY DEFAULT. It pings the user's phone.
//
// Each run of `sync-mobile` calls pullMobileMsg, and when Zalo returns no
// session token (the normal case) it then RE-POLLS every 5 seconds for ~2
// minutes — ~24 further pings. Three tests at ~25 pings each put ~75
// notifications on a real phone in a few minutes. That happened once; it is
// not happening again by accident.
//
// So this suite is gated behind its own flag, ON TOP OF ZALO_TEST_LIVE, and
// runs exactly ONE command instead of three. Enable it deliberately, when the
// phone's owner is expecting it:
//
//     ZALO_TEST_LIVE=1 ZALO_TEST_SYNC_MOBILE=1 node --test tests/e2e/tier3-mutate-restore.test.js
//
// The rest of the command's surface (flag parsing, the no-account guard) is
// covered offline in tests/cli/ at zero cost to anyone's phone.
// ---------------------------------------------------------------------------
const SYNC_MOBILE = process.env.ZALO_TEST_SYNC_MOBILE === "1";
const syncSkip = skip || (SYNC_MOBILE ? false : "needs ZALO_TEST_SYNC_MOBILE=1 — this command pings a real phone");

describe("tier 3 · sync-mobile (opt-in: pings a real phone)", { skip: syncSkip }, () => {
    // One invocation, and every assertion is made against it. sync-mobile
    // cannot make the phone do anything by itself — it prints instructions and
    // waits for the user to run Settings -> Sync Messages -> Sync Now by hand.
    let r;

    before(async () => {
        if (syncSkip) return;
        r = await runCli(["sync-mobile"], live(T, { timeout: 200_000 }));
    });

    it("bounds its own wait rather than hanging", () => {
        assert.equal(r.killed, false, "sync-mobile must cap itself (~2 min)");
    });

    it("reports a recognizable outcome", () => {
        assert.match(
            r.all,
            /Already synced|Sync complete|nothing new to save|Timeout waiting for sync data|Sync failed/,
            `no recognizable outcome: ${r.all.slice(-300)}`,
        );
    });

    it("names the exact phone-side steps when it needs them", () => {
        if (!/Waiting for sync data/.test(r.all)) return;
        assert.match(r.all, /Settings -> Sync Messages -> Sync Now/, "the instruction must name the phone path");
    });
});
