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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCli, runJson, hasSuccess, errorLineOf } from "../helpers/cli.js";
import { gate, live, sleep, assertDisposable, retryRead, assertSession } from "../helpers/live.js";

const g = gate(3);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

// Confirm WHICH account is logged in before this tier writes anything.
// gate() only reads env flags and targets.json; nothing else verified the
// session, so `--tier N` could drive a stranger's account.
before(async () => {
    if (!g.run) return;
    await assertSession(T);
});

/**
 * Run a live CLI command and assert it actually SUCCEEDED.
 *
 * The previous version of this helper was a provable no-op and every call
 * site below inherited it. Both of its assertions were constants:
 *
 *   - `r.stdout.trim().length > 0` can never be false. `runCli` does not pass
 *     `--json`, and src/index.js prints the unofficial-API disclaimer through
 *     warning(), which writes to STDOUT. There is always output.
 *   - `/at Command\.|Unhandled|at getApi/` can never match. Every action
 *     handler is `try { … } catch (e) { error(e.message) }`, and error()
 *     prints `  ✗ <msg>` with no stack trace.
 *
 * So all 19 call sites — including the *restore* halves of mute/unmute,
 * read/unread and auto-delete — passed whether or not the command worked.
 * A silently failing `conv auto-delete off` would leave a real person's DM
 * on a server-side 7-day message-destruction TTL with the suite green.
 *
 * @param {string[]} args
 * @param {string} label
 * @param {object} [opts]
 * @param {RegExp} [opts.allowError] - error text that is a legitimate refusal
 *   rather than a failure (e.g. `conv hide` on an account with no hidden-chat
 *   PIN). Anything else still fails.
 * @param {number} [opts.timeout]
 * @returns {Promise<{ok: boolean, refused: string|null, raw: object}>}
 */
async function ok(args, label, { allowError = null, timeout = 120_000 } = {}) {
    const r = await runCli(args, live(T, { timeout }));
    assert.doesNotMatch(r.all, /at Command\.|Unhandled|at getApi/, `${label} crashed: ${r.all.slice(0, 300)}`);

    const err = errorLineOf(r.stdout);
    if (err && allowError && allowError.test(err)) return { ok: false, refused: err, raw: r };

    assert.equal(err, null, `${label} failed: ${err}`);
    assert.ok(hasSuccess(r.stdout), `${label} did not report success: ${r.stdout.slice(0, 300)}`);
    return { ok: true, refused: null, raw: r };
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

// DM parity for the per-conversation toggles. Each of these takes
// `-t/--type` and Zalo routes 0=User and 1=Group to different endpoints,
// but the suite only ever drove `-t 1`. Grouped into one describe with a
// single restoring `after()` so an abort mid-block still puts the DM back
// — it is a real person's thread, not a disposable group.
describe("tier 3 · DM conversation toggles", { skip: skip || (T?.dm ? false : "no DM target configured") }, () => {
    // These restores used to be four bare runCli() calls whose results were
    // discarded — runCli never rejects, so a restore that failed on every
    // invocation was invisible. The auto-delete one is the sharp edge: `7d`
    // maps to a real server-side TTL on a REAL PERSON's thread, so a silently
    // failed "off" quietly deletes their messages a week later.
    after(async () => {
        if (!g.run || !T?.dm) return;
        const failures = [];
        for (const [args, label] of [
            [["conv", "unmute", "-t", "0", T.dm.threadId], "unmute"],
            [["conv", "unhide", "-t", "0", T.dm.threadId], "unhide"],
            [["conv", "auto-delete", "-t", "0", T.dm.threadId, "off"], "auto-delete off"],
            [["conv", "read", "-t", "0", T.dm.threadId], "read"],
        ]) {
            const r = await runCli(args, live(T));
            const err = errorLineOf(r.stdout);
            // unhide on a thread that was never hidden is a no-op refusal.
            if (err && !/not hidden|pin|chưa/i.test(err)) failures.push(`${label}: ${err}`);
        }
        assert.deepEqual(failures, [], `DM left mutated — these restores failed: ${failures.join(" | ")}`);
    });

    it("mutes and unmutes the DM", async () => {
        assertDisposable(T.dm.threadId, "conv mute");
        await ok(["conv", "mute", "-t", "0", "-d", "-1", T.dm.threadId], "dm mute");
        await sleep(400);
        await ok(["conv", "unmute", "-t", "0", T.dm.threadId], "dm unmute");
    });

    it("marks the DM read, then unread, then read again", async () => {
        assertDisposable(T.dm.threadId, "conv read");
        await ok(["conv", "read", "-t", "0", T.dm.threadId], "dm read");
        await sleep(400);
        await ok(["conv", "unread", "-t", "0", T.dm.threadId], "dm unread");
        await sleep(400);
        await ok(["conv", "read", "-t", "0", T.dm.threadId], "dm read again");
    });

    // Hiding needs the account's hidden-conversations PIN. No PIN is a clean
    // refusal, not a failure — but it must be an EXPLICIT allowance, not the
    // blanket "any output counts" the old ok() gave every call site.
    it("hides and unhides the DM", async () => {
        assertDisposable(T.dm.threadId, "conv hide");
        const hidden = await ok(["conv", "hide", "-t", "0", T.dm.threadId], "dm hide", {
            allowError: /pin|chưa đặt|not set/i,
        });
        if (!hidden.ok) return; // no PIN on this account — nothing to unhide
        await sleep(400);
        await ok(["conv", "unhide", "-t", "0", T.dm.threadId], "dm unhide");
    });

    it("sets a DM auto-delete TTL and turns it back off", async () => {
        assertDisposable(T.dm.threadId, "conv auto-delete");
        await ok(["conv", "auto-delete", "-t", "0", T.dm.threadId, "7d"], "dm ttl 7d");
        await sleep(400);
        await ok(["conv", "auto-delete", "-t", "0", T.dm.threadId, "off"], "dm ttl off");
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

// This block destroyed the account owner's real bio, on every run, behind
// the same gate that unlocks read-only tier 1.
//
// It captured the "current" bio by scraping human-mode stdout with
// `match(/●\s*(.*)$/m)`. Without /g that returns the FIRST match, and the
// first `●` line is not the bio — src/index.js runs autoLogin() for every
// non-login command, which emits `  ● Auto-login: <display name>` before
// `profile bio` prints its own `  ● Bio: …`. So `original` became the
// account's own name, and after() wrote THAT back as the "restore". The
// genuine bio was never captured by any run, so it was unrecoverable.
//
// Read it as JSON instead, and refuse to touch the bio at all unless the
// prior value was read cleanly — `profile bio [text]` accepts an empty
// argument and will blank a real bio, so defaulting to "" on a failed read
// is itself destructive.
describe("tier 3 · profile bio", { skip }, () => {
    let original = null; // null = never captured; "" = genuinely empty
    let changed = false;

    after(async () => {
        if (!g.run || !changed) return;
        if (original === null) {
            console.error("\n!! MANUAL ACTION REQUIRED: the bio was changed but the original was never captured.\n");
            return;
        }
        const back = await runJson(["profile", "bio", original], live(T));
        // The restore is the whole point of the block, so assert it landed.
        assert.equal(back.ok, true, `bio restore failed — bio may still read the test value: ${back.error}`);
    });

    it("updates the bio and restores the previous value", async () => {
        const before = await runJson(["profile", "bio"], live(T));
        assert.equal(before.ok, true, `could not read the current bio, refusing to overwrite it: ${before.error}`);

        // `profile bio` with no argument renders an empty bio as the literal
        // string "(empty)" (src/commands/profile.js:102). Writing that back
        // would set the bio to those seven characters.
        const raw = typeof before.data?.bio === "string" ? before.data.bio : null;
        assert.notEqual(raw, null, `bio read returned no 'bio' field: ${JSON.stringify(before.data).slice(0, 200)}`);
        original = raw === "(empty)" ? "" : raw;

        const r = await runJson(["profile", "bio", "e2e temporary status"], live(T));
        assert.equal(r.ok, true, r.error);
        changed = true;
        assert.equal(r.data?.bio ?? r.data?.requested, "e2e temporary status");
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
        assert.equal(errorLineOf(r.stdout), null, `rename failed: ${errorLineOf(r.stdout)}`);
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
    // This used to write ASSUMED defaults — "--no-lock-poll --no-lock-post
    // --no-sign-admin" — without ever reading what the group's settings
    // actually were, and discarded the result. If the owner had deliberately
    // locked posts, the suite silently unlocked them. Capture first, restore
    // to the captured values, and assert the restore landed.
    let priorSettings = null;

    before(async () => {
        if (!g.run) return;
        const info = await retryRead(() => runJson(["group", "info", T.group.threadId], live(T)));
        priorSettings = info.ok ? (info.data?.gridInfoMap?.[T.group.threadId]?.setting ?? null) : null;
    });

    after(async () => {
        if (!g.run || !priorSettings) return;
        const flag = (on, name) => (on ? `--${name}` : `--no-${name}`);
        const r = await runCli(
            [
                "group",
                "settings",
                T.group.threadId,
                flag(priorSettings.lockCreatePoll, "lock-poll"),
                flag(priorSettings.lockCreatePost, "lock-post"),
                flag(priorSettings.signAdminMsg, "sign-admin"),
                flag(priorSettings.blockName, "block-name"),
            ],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(errorLineOf(r.stdout), null, `group settings not restored: ${errorLineOf(r.stdout)}`);
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

// This was the only mutating block in the tier with no after(). The
// link-info assertion sits BETWEEN enable and disable, and link-info is on
// the set of endpoints this suite documents as intermittently 404/5xx — so
// one blip aborted the test with the group's PUBLIC JOIN LINK left enabled,
// and nothing later turned it off. The restore now lives in after(), guarded
// so it only fires if enable actually succeeded.
describe("tier 3 · group invite link", { skip }, () => {
    let enabled = false;

    after(async () => {
        if (!g.run || !enabled) return;
        const off = await runCli(["group", "disable-link", T.group.threadId], live(T, { timeout: 120_000 }));
        assert.equal(errorLineOf(off.stdout), null, `invite link left ENABLED on the group: ${off.all.slice(0, 300)}`);
    });

    it("enables, inspects and disables the invite link", async () => {
        assertDisposable(T.group.threadId, "group enable-link");
        await ok(["group", "enable-link", T.group.threadId], "enable-link");
        enabled = true;
        await sleep(600);

        // Read-only, and on a flaky endpoint — retry rather than abort with
        // the link still up.
        const info = await retryRead(() => runJson(["group", "link-info", T.group.threadId], live(T)));
        assert.equal(info.ok, true, info.error);

        await ok(["group", "disable-link", T.group.threadId], "disable-link");
        enabled = false;
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

    // DM parity, and not a formality: groups and DMs take completely
    // different code paths here. A group first tries the REST endpoint
    // getGroupChatHistory and only falls back to the socket; a DM has no
    // REST endpoint at all and goes straight to requestOldMessages over the
    // WebSocket. Testing only `-t 1` left that whole branch unexercised —
    // and it mattered: because nothing ever history-fetched the DM, its
    // cache held only sync-v2 rows with no cliMsgId, which is exactly what
    // made `conv delete` on a DM impossible (see tier 5a).
    it(
        "msg history returns messages for the DM over the socket path",
        { skip: skip || (T?.dm ? false : "no DM target configured") },
        async () => {
            const r = await runJson(
                ["msg", "history", "-t", "0", "-n", "10", T.dm.threadId],
                live(T, { timeout: 180_000 }),
            );
            assert.equal(r.ok, true, r.error);
            assert.equal(String(r.data.threadId), T.dm.threadId);
            // "dm", not "user": the CLI reports the thread type in its own
            // vocabulary, which does not mirror zca-js's ThreadType.User.
            assert.equal(r.data.threadType, "dm");
            assert.ok(Array.isArray(r.data.messages));
        },
    );

    it(
        "a DM history fetch caches rows that carry a cliMsgId",
        { skip: skip || (T?.dm ? false : "no DM target configured") },
        async () => {
            await runJson(
                ["msg", "history", "-t", "0", "-n", "10", "--no-cache", T.dm.threadId],
                live(T, { timeout: 180_000 }),
            );

            const dbPath = join(T.home, ".zalo-agent-cli", "accounts", T.accountOwnId, "zalo.db");
            if (!existsSync(dbPath)) return;

            const { default: Database } = await import("better-sqlite3");
            const db = new Database(dbPath, { readonly: true });
            let withCli = 0;
            try {
                const rows = db
                    .prepare("SELECT senderId, raw_data FROM messages WHERE threadId = ? ORDER BY timestamp DESC")
                    .all(T.dm.threadId);
                for (const row of rows) {
                    let raw = {};
                    try {
                        raw = JSON.parse(row.raw_data || "{}");
                    } catch {
                        continue;
                    }
                    if ((raw.data ?? raw).cliMsgId !== undefined) withCli++;
                }
            } finally {
                db.close();
            }

            // The socket backfill persists the full frame; the sync-v2
            // restore persists a minimal shape without cliMsgId. Only the
            // former yields a usable `conv delete` anchor, so this is the
            // precondition that tier 5a's DM wipe depends on.
            assert.ok(withCli > 0, "a DM history fetch must cache at least one row carrying a cliMsgId");
        },
    );
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

        // vote / unvote / lock were crash-only asserted, so all three could
        // fail on every invocation and stay green. Demand success.
        if (optionId !== null) {
            await ok(["poll", "vote", pollId, optionId], "poll vote");
            await sleep(600);
            await ok(["poll", "unvote", pollId], "poll unvote");
        }

        // Locking is the reversible end-state for a poll — there is no
        // `poll delete`, so a locked poll is as closed as it gets.
        await ok(["poll", "lock", pollId], "poll lock");
    });

    // `poll add-option` and `poll share` sit between an existing create and
    // the lock above: zero extra blast radius, and neither had any coverage.
    it("adds an option to a poll and shares it", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const created = await runJson(
            ["poll", "create", T.group.threadId, "[e2e] add-option cycle", "One", "Two", "--add-options"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(created.ok, true, created.error);
        const pollId = String(created.data?.poll_id || created.data?.pollId || created.data?.id || "");
        assert.ok(pollId, `no poll id in ${JSON.stringify(created.data).slice(0, 200)}`);
        await sleep(800);

        await ok(["poll", "add-option", pollId, "Three"], "poll add-option");
        await sleep(600);

        const after2 = await runJson(["poll", "info", pollId], live(T));
        assert.equal(after2.ok, true, after2.error);
        const names = (after2.data?.options || []).map((o) => String(o.content ?? o.text ?? ""));
        assert.ok(names.includes("Three"), `added option missing from ${JSON.stringify(names)}`);

        await ok(["poll", "share", pollId], "poll share");
        await ok(["poll", "lock", pollId], "poll lock");
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

    // KNOWN GAP — see agent/work/transfer-sync-v2/NOTES.md § Ordering.
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
// sync-mobile
//
// --socket is what this tier exercises, and it must stay explicit. The
// phone-backed restore became the DEFAULT for `sync-mobile`, so a bare
// invocation here would wake the owner's phone and block on a human tapping
// "ĐỒNG BỘ NGAY" -- in a tier that runs under plain ZALO_TEST_LIVE=1.
// --socket opens a WebSocket and asks the server for recent history
// (cmd 510/511), which is what the real
// Zalo Web client does — see agent/work/transfer-sync-v2/NOTES.md § Mobile sync. It is still gated
// as a live test for a different reason: Zalo permits ONE web session per
// account, so running it will close a `listen` daemon or a browser Zalo Web
// session on the same account.
//
// --legacy keeps the retired pull_mobile_msg path, and THAT still pings the
// phone, so it keeps its own opt-in flag on top of ZALO_TEST_LIVE:
//
//     ZALO_TEST_LIVE=1 ZALO_TEST_SYNC_MOBILE=1 node --test tests/e2e/tier3-mutate-restore.test.js
//
// The rest of the surface (flag parsing, the no-account guard) is covered
// offline in tests/cli/, and the backfill itself is unit-tested against a fake
// listener in tests/unit/sync-backfill.test.js — both at zero cost.
// ---------------------------------------------------------------------------
describe("tier 3 · sync-mobile --socket (socket backfill — no phone contact)", { skip }, () => {
    let r;

    before(async () => {
        if (skip) return;
        r = await runCli(["sync-mobile", "--socket", "--wait", "45"], live(T, { timeout: 120_000 }));
    });

    it("bounds its own wait rather than hanging", () => {
        assert.equal(r.killed, false, "sync-mobile must cap itself");
    });

    // "Already synced … skipping" is a legitimate outcome, not a failure.
    // The freshness debounce landed after this regex was written, so any
    // run following an earlier one inside the window failed here for doing
    // exactly the right thing — the debounce exists precisely to avoid
    // re-pinging. Whether it fires depends on how recently the suite last
    // ran, which made this the kind of test that passes alone and fails in
    // sequence.
    it("reports a recognizable outcome", () => {
        assert.match(
            r.all,
            /Backfilled \d+\/\d+ message|returned no history|already running|another web session|Could not open a connection|Already synced .* skipping/,
            `no recognizable outcome: ${r.all.slice(-300)}`,
        );
    });

    it("never reaches the phone on the default path", () => {
        assert.doesNotMatch(r.all, /pullMobileMsg|Sync Messages -> Sync Now/, "the default path must stay off-phone");
    });

    it("explains the one-web-session rule when Zalo closes it as a duplicate", () => {
        if (!/another web session/.test(r.all)) return;
        assert.match(r.all, /one web session per account/i);
    });
});

const SYNC_MOBILE = process.env.ZALO_TEST_SYNC_MOBILE === "1";
const syncSkip = skip || (SYNC_MOBILE ? false : "needs ZALO_TEST_SYNC_MOBILE=1 — --legacy pings a real phone");

// The five newer top-level sync commands had ZERO live coverage — they
// appeared only in the offline surface manifest. Three of them cannot write
// anything server-side, which makes them the cheapest live tests in the
// suite: `sync --plan` returns before it even acquires the daemon lock, and
// the board and cloud passes only read and index. `sync-media --dry-run`
// reports what it would fetch without fetching. None taps the phone.
// Lifecycle leaves that sit BETWEEN an existing tier-2 create and an
// existing tier-4 delete: zero extra blast radius, and none had coverage.
// `reminder edit` and `catalog update-product` are the interesting two —
// both take the argument-order shape that produced the `group rename` swap
// bug, where the CLI passed (id, name) to an API expecting (name, id) and
// the command could never have worked.
describe("tier 3 · create/mutate/delete lifecycles", { skip }, () => {
    it("renames a catalog, lists its products, and updates one", async () => {
        const created = await runJson(["catalog", "create", "[e2e] lifecycle"], live(T, { timeout: 120_000 }));
        if (!created.ok) return; // catalogs are capped; tier 2 owns the sweep
        const catId = String(created.data?.item?.id ?? created.data?.id ?? "");
        assert.ok(catId, `no catalog id in ${JSON.stringify(created.data).slice(0, 200)}`);

        try {
            await ok(["catalog", "rename", catId, "[e2e] lifecycle renamed"], "catalog rename");

            const prod = await runJson(
                ["catalog", "add-product", catId, "[e2e] p1", "1000", "first"],
                live(T, { timeout: 120_000 }),
            );
            assert.equal(prod.ok, true, prod.error);
            const pid = String(prod.data?.item?.product_id ?? prod.data?.product_id ?? "");
            assert.ok(pid, `no product id in ${JSON.stringify(prod.data).slice(0, 200)}`);

            const listed = await runJson(["catalog", "products", catId], live(T, { timeout: 120_000 }));
            assert.equal(listed.ok, true, listed.error);

            await ok(
                ["catalog", "update-product", catId, pid, "[e2e] p1 renamed", "2000", "second"],
                "catalog update-product",
            );
        } finally {
            await runCli(["catalog", "delete", catId], live(T, { timeout: 120_000 }));
        }
    });

    it("reads, edits and removes a reminder", async () => {
        assertDisposable(T.group.threadId, "reminder create");
        const created = await runJson(
            ["reminder", "create", "-t", "1", T.group.threadId, "[e2e] lifecycle reminder"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(created.ok, true, created.error);
        const id = String(created.data?.id ?? created.data?.reminderId ?? created.data?.topicId ?? "");
        assert.ok(id, `no reminder id in ${JSON.stringify(created.data).slice(0, 200)}`);

        try {
            const info = await runJson(["reminder", "info", id], live(T));
            assert.equal(info.ok, true, info.error);

            const responses = await runJson(["reminder", "responses", id], live(T));
            assert.equal(responses.ok, true, responses.error);

            await ok(
                ["reminder", "edit", "-t", "1", id, T.group.threadId, "[e2e] lifecycle reminder edited"],
                "reminder edit",
            );
        } finally {
            await runCli(["reminder", "remove", "-t", "1", id, T.group.threadId], live(T, { timeout: 120_000 }));
        }
    });

    it("updates a quick message and an auto-reply rule", async () => {
        const kw = `e2elc${T.accountOwnId.slice(-4)}`;
        const created = await runJson(["quick-msg", "add", kw, "[e2e] lifecycle qm"], live(T));
        if (created.ok) {
            const id = String(created.data?.id ?? created.data?.itemId ?? created.data?.item?.id ?? "");
            try {
                if (id) await ok(["quick-msg", "update", id, kw, "[e2e] lifecycle qm edited"], "quick-msg update");
            } finally {
                if (id) await runCli(["quick-msg", "remove", id], live(T));
            }
        }

        const rule = await runJson(
            ["auto-reply", "create", "[e2e] lifecycle ar", "--no-enable"],
            live(T, { timeout: 120_000 }),
        );
        if (!rule.ok) return; // auto-reply is hard-capped; tier 2 owns the purge
        const rid = String(rule.data?.id ?? rule.data?.item?.id ?? "");
        try {
            if (rid)
                await ok(
                    ["auto-reply", "update", rid, "[e2e] lifecycle ar edited", "--no-enable"],
                    "auto-reply update",
                );
        } finally {
            if (rid) await runCli(["auto-reply", "delete", rid], live(T));
        }
    });
});

describe("tier 3 · the read-only sync passes", { skip }, () => {
    it("sync --plan reports a plan without touching the socket or the lock", async () => {
        const r = await runCli(["sync", "--plan"], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        assert.equal(errorLineOf(r.stdout), null, `sync --plan failed: ${errorLineOf(r.stdout)}`);
        // --plan must not be able to reach the phone-confirm path.
        assert.doesNotMatch(r.all, /ĐỒNG BỘ NGAY|confirm .*phone/i, "--plan must never prompt the phone");
    });

    it("sync-media --dry-run reports without downloading", async () => {
        const r = await runCli(["sync-media", "--dry-run", "-n", "5"], live(T, { timeout: 180_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        assert.equal(errorLineOf(r.stdout), null, `sync-media --dry-run failed: ${errorLineOf(r.stdout)}`);
    });

    it("sync-boards reads one thread's board items", async () => {
        const r = await runCli(["sync-boards", "-T", T.group.threadId], live(T, { timeout: 180_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        assert.equal(errorLineOf(r.stdout), null, `sync-boards failed: ${errorLineOf(r.stdout)}`);
    });

    it("sync-cloud indexes one page", async () => {
        const r = await runCli(["sync-cloud", "-p", "1"], live(T, { timeout: 180_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        // Report the error LINE, not the first 300 chars of everything. The
        // disclaimer goes to stdout ahead of any command output, so
        // `r.all.slice(0, 300)` is all disclaimer and the real failure was
        // invisible -- a live run reported "sync-cloud failed: <disclaimer>",
        // which reads like the disclaimer was the error.
        assert.equal(errorLineOf(r.stdout), null, `sync-cloud failed: ${errorLineOf(r.stdout)}`);
    });

    it("sync-reactions drains one page within its own wait bound", async () => {
        const r = await runCli(["sync-reactions", "-p", "1", "-w", "15"], live(T, { timeout: 120_000 }));
        assert.equal(r.killed, false, "sync-reactions must cap its own wait");
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
    });
});

describe("tier 3 · sync-mobile --legacy (opt-in: pings a real phone)", { skip: syncSkip }, () => {
    // ONE invocation. The retired endpoint answers empty, and this now stops
    // there instead of re-polling for two minutes.
    let r;

    before(async () => {
        if (syncSkip) return;
        r = await runCli(["sync-mobile", "--legacy"], live(T, { timeout: 90_000 }));
    });

    it("makes exactly one attempt and stops", () => {
        assert.equal(r.killed, false, "--legacy must not loop");
        assert.doesNotMatch(r.all, /Waiting for sync data/, "the retry loop is gone");
    });

    it("reports a recognizable outcome", () => {
        assert.match(
            r.all,
            /Already synced|no longer serves it|nothing new to save|Synced \d+\/\d+ message|Sync failed/,
            `no recognizable outcome: ${r.all.slice(-300)}`,
        );
    });

    it("points at the working command when the endpoint is dead", () => {
        if (!/no longer serves it/.test(r.all)) return;
        assert.match(r.all, /without --legacy/, "a dead end must name the path that works");
    });
});
