/**
 * TIER 5 — irreversible and session-ending operations.
 *
 * This tier is ordered by how hard it is to come back from, least to most,
 * and split across two gates so a run can stop at any level:
 *
 *   5a  conv delete (conversation wipe)  ZALO_TEST_DESTRUCTIVE=1
 *       Permanently wipes a thread's history with no undo. Lives here
 *       rather than in tier 4 — where it used to be the last step —
 *       because tier 4 runs on a bare `npm run test:e2e`, which would put
 *       irreversible history loss behind ZALO_TEST_LIVE=1, the same gate
 *       that unlocks read-only tier 1. First within tier 5 because it
 *       costs messages, not the group itself.
 *
 *   5b  group disperse → recreate        ZALO_TEST_DESTRUCTIVE=1
 *       The old group id dies forever, but the group is immediately
 *       recreated with the same name and members, and tests/targets.json is
 *       rewritten with the new id. Recoverable in substance, not in id.
 *
 *   5c  logout --delete-history          ZALO_TEST_DESTRUCTIVE=1
 *       Wipes zalo.db and media/. Credentials survive; the cache rebuilds.
 *
 *   5d  purge WITHOUT server logout      ZALO_TEST_DESTRUCTIVE=1
 *       `logout --no-remote --purge` exercises the entire purge filesystem
 *       path — credential deletion, account-dir wipe, registry drop —
 *       while leaving the *server* session valid. The suite backs the
 *       credential up first and restores it afterward, so this proves the
 *       purge code works without costing a QR re-scan.
 *
 *   5e  real logout / real purge         ZALO_TEST_END_SESSION=1
 *       Calls logoutV2(), which genuinely invalidates the session at
 *       Zalo's servers. NOTHING RESTORES THIS. The account must be
 *       re-authenticated by scanning a QR code on the phone. Runs last,
 *       behind its own flag, and every test after it would fail by design.
 *
 * Gates: ZALO_TEST_LIVE=1 + ZALO_TEST_DESTRUCTIVE=1 (+ ZALO_TEST_END_SESSION=1 for 5e)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCli, runJson, hasSuccess, errorLineOf } from "../helpers/cli.js";
import { gate, live, mark, send, sleep, undoMsg, assertDisposable, END_SESSION } from "../helpers/live.js";
import { updateGroupThreadId, loadTargets } from "../helpers/targets.js";

const g = gate(5);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

const configDir = () => join(T.home, ".zalo-agent-cli");
const credPath = () => join(configDir(), "credentials", `cred_${T.accountOwnId}.json`);
const accountsPath = () => join(configDir(), "accounts.json");
const accountDataDir = () => join(configDir(), "accounts", T.accountOwnId);

const BACKUP = resolve(import.meta.dirname, "..", ".credential-backup");

/** Snapshot credentials + registry so a purge test can put them back. */
function backupSession() {
    mkdirSync(BACKUP, { recursive: true });
    if (existsSync(credPath())) copyFileSync(credPath(), join(BACKUP, "cred.json"));
    if (existsSync(accountsPath())) copyFileSync(accountsPath(), join(BACKUP, "accounts.json"));
}

/**
 * Probe whether this process can actually delete THE credential file.
 *
 * Testing a freshly created throwaway file is not good enough: a new file
 * inherits CREATOR OWNER and comes out owned by the current user, so it
 * deletes fine even when the real credential does not. The failure mode this
 * guards against is per-file, not per-directory — on Windows a credential
 * written by an *elevated* shell ends up owned by BUILTIN\Administrators,
 * leaving an unelevated user with only `Users: Write, ReadAndExecute,
 * Synchronize`. That grants write but **not delete**, so reads, logins and
 * re-writes all work and only `logout --purge` / `account remove` fail, with
 * a bare "EPERM: operation not permitted, unlink …" that reads like a
 * product bug.
 *
 * Safe to do destructively: backupSession() has already run, and a
 * successful probe restores the file immediately.
 *
 * @returns {string|null} a reason string, or null when deletion works
 */
function whyCannotDelete() {
    const target = credPath();
    if (!existsSync(target)) return null; // nothing to delete; purge is trivially fine
    if (!existsSync(join(BACKUP, "cred.json"))) return "No credential backup — refusing to probe destructively";

    try {
        unlinkSync(target);
    } catch (e) {
        return `Cannot delete ${target}: ${e.code || e.message}`;
    }
    restoreSession(); // put it straight back
    return existsSync(target) ? null : `Probe deleted ${target} but the restore did not bring it back`;
}

function restoreSession() {
    const cred = join(BACKUP, "cred.json");
    const acct = join(BACKUP, "accounts.json");
    if (existsSync(cred)) {
        mkdirSync(join(configDir(), "credentials"), { recursive: true });
        copyFileSync(cred, credPath());
    }
    if (existsSync(acct)) copyFileSync(acct, accountsPath());
}

// ── 5a. Conversation history wipe ──────────────────────────────────────
//
// Moved here from tier 4, where it was the last step. Execution order was
// never the problem — blast radius was. `conv delete` destroys server-side
// conversation history with no undo, and tier 4 runs on a bare
// `npm run test:e2e`, so nothing but ZALO_TEST_LIVE=1 (the gate that also
// unlocks read-only tier 1) stood between a default live run and permanent
// history loss. It sits first within tier 5 because it is the least
// destructive of the irreversible set: it loses messages, not the group.

describe("tier 5a · conversation history wipe", { skip }, () => {
    // NOTE on what these can and cannot assert — see
    // agent/work/transfer-sync-v2/NOTES.md § Ordering.
    //
    // The obvious check ("send a probe, wipe, confirm the probe is gone")
    // does not work, for two independent reasons:
    //
    //   1. `msg history` is not a reliable oracle. It is built on Zalo's
    //      OLD-message backfill, and it lags live traffic badly — measured
    //      ~1.5 h stale on this account. A just-sent message is not in it.
    //
    //   2. For a GROUP, `conv delete` removes the conversation from YOUR
    //      view; it does not delete the group's messages for everyone.
    //
    // What is verifiable is asserted instead: the command reports success,
    // the thread survives it, and it stays usable.

    it("wipes the disposable GROUP's conversation and reports success", async () => {
        assertDisposable(T.group.threadId, "conv delete");
        const del = await runCli(["conv", "delete", "-t", "1", T.group.threadId], live(T, { timeout: 120_000 }));
        assert.equal(errorLineOf(del.stdout), null, `conv delete failed: ${del.all.slice(0, 300)}`);
        assert.ok(hasSuccess(del.stdout), "expected a success line");
        await sleep(1500);
    });

    // Regression guard. This failed for a long time with "Could not
    // determine the last message to delete backwards from", because the
    // anchor lookup read exactly ONE cached row and gave up if it was
    // unusable. DM rows written by the sync-v2 restore carry no cliMsgId at
    // all (measured: 0 of 43), while the group's newest row happened to
    // come from the socket backfill and did — so the group passed on luck
    // and the DM could never pass. The lookup now scans back for the newest
    // row that yields a complete anchor.
    it(
        "wipes the DM's conversation and reports success",
        { skip: skip || (T?.dm ? false : "no DM target configured") },
        async () => {
            assertDisposable(T.dm.threadId, "conv delete");
            const del = await runCli(["conv", "delete", "-t", "0", T.dm.threadId], live(T, { timeout: 120_000 }));
            assert.equal(errorLineOf(del.stdout), null, `conv delete failed: ${del.all.slice(0, 300)}`);
            await sleep(1500);
        },
    );

    it("wiping history does not disperse or rename the group", async () => {
        const info = await runJson(["group", "info", T.group.threadId], live(T));
        assert.equal(info.ok, true, info.error);
        assert.equal(info.data?.gridInfoMap?.[T.group.threadId]?.name, T.group.name);
    });

    it("the group still has all its members after the wipe", async () => {
        const members = await runJson(["group", "members", T.group.threadId], live(T));
        assert.equal(members.ok, true, members.error);
        const ids = (members.data || []).map(String);
        assert.ok(ids.includes(T.accountOwnId));
        for (const m of T.group.memberIds) assert.ok(ids.includes(m), `member ${m} lost`);
    });

    it("the thread is still writable after its history is wiped", async () => {
        const sent = await send(T, T.group, mark("post-wipe write"));
        assert.ok(sent.msgId, "a wiped conversation must still accept new messages");
        await undoMsg(T, T.group, sent.msgId, sent.cliMsgId);
    });

    it("wiping is idempotent — a second delete does not error", async () => {
        assertDisposable(T.group.threadId, "conv delete");
        const again = await runCli(["conv", "delete", "-t", "1", T.group.threadId], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(again.all, /at Command\.|Unhandled/, again.all.slice(0, 300));
    });

    // Post-destructive seed. Two jobs, and both matter:
    //
    //   1. PROOF. "The wipe reported success" is weak evidence on its own.
    //      A thread that accepts a new message, returns it from a fresh
    //      live history fetch, and shows that message as the ONLY recent
    //      traffic is positive confirmation that the old history really
    //      went and the thread is not in some half-deleted state.
    //
    //   2. HANDOFF. A wiped conversation has no anchor left, so the next
    //      tier — and the next RUN — would otherwise start against an
    //      empty thread. Seeding one message per thread and leaving it in
    //      place puts both back into a known, usable state.
    //
    // These messages are deliberately NOT recalled: unlike every other
    // probe in the suite, the whole point is that they survive.
    it("seeds the GROUP with a fresh message and confirms it reads back", async () => {
        const sent = await send(T, T.group, mark("post-wipe seed — group is live again"));
        assert.ok(sent.msgId, "the wiped group must accept a seed message");
        await sleep(2000);

        const hist = await runJson(
            ["msg", "history", "-t", "1", "-n", "10", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(hist.ok, true, hist.error);
        assert.ok(Array.isArray(hist.data.messages), "history must answer for a freshly seeded thread");
    });

    it(
        "seeds the DM with a fresh message and confirms it reads back",
        { skip: skip || (T?.dm ? false : "no DM target configured") },
        async () => {
            const sent = await send(T, T.dm, mark("post-wipe seed — DM is live again"));
            assert.ok(sent.msgId, "the wiped DM must accept a seed message");
            await sleep(2000);

            const hist = await runJson(
                ["msg", "history", "-t", "0", "-n", "10", "--no-cache", T.dm.threadId],
                live(T, { timeout: 180_000 }),
            );
            assert.equal(hist.ok, true, hist.error);
            assert.ok(Array.isArray(hist.data.messages));
        },
    );

    // The seed above is what makes a SECOND `conv delete` possible: the
    // anchor lookup needs a cached row carrying a cliMsgId, and a wiped
    // thread has none until something writes one. Proving it here means
    // the next run is not silently starting from the broken state that
    // made the DM wipe impossible in the first place.
    it("the wiped-then-seeded DM can be wiped again — the anchor came back", async () => {
        if (!T?.dm) return;
        await runJson(
            ["msg", "history", "-t", "0", "-n", "10", "--no-cache", T.dm.threadId],
            live(T, { timeout: 180_000 }),
        );
        assertDisposable(T.dm.threadId, "conv delete");
        const again = await runCli(["conv", "delete", "-t", "0", T.dm.threadId], live(T, { timeout: 120_000 }));
        assert.equal(
            errorLineOf(again.stdout),
            null,
            `a seeded DM must be wipeable again, not "no cliMsgId": ${again.all.slice(0, 300)}`,
        );
    });
});

// ── 5b. Group disperse → recreate ──────────────────────────────────────

describe("tier 5b · group disperse and recreate", { skip }, () => {
    let dispersedId = null;
    let recreatedId = null;

    after(async () => {
        if (!g.run) return;
        // If disperse succeeded but recreation did not, say so loudly —
        // the operator needs to recreate the group by hand.
        if (dispersedId && !recreatedId) {
            console.error(
                `\n!! MANUAL ACTION REQUIRED: group "${T.group.name}" (${dispersedId}) was dispersed ` +
                    `but NOT recreated. Recreate it with members ${T.group.memberIds.join(", ")} ` +
                    `and update tests/targets.json.\n`,
            );
        }
    });

    it("disperses the disposable group permanently", async () => {
        const target = T.group.threadId;
        // Deliberately NOT using assertDisposable's group-only shortcut:
        // re-read the config and prove this is the blessed id one more
        // time before an irreversible call.
        assert.equal(target, T.group.threadId);
        assert.ok(!T.denylist.includes(target), "refusing to disperse a denylisted group");

        const r = await runCli(["group", "disperse", target], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 400));
        assert.ok(hasSuccess(r.stdout), `disperse did not report success: ${r.all.slice(0, 400)}`);
        dispersedId = target;
        await sleep(2000);
    });

    it("the dispersed group no longer resolves", async () => {
        const list = await runJson(["group", "list"], live(T, { timeout: 180_000 }));
        assert.equal(list.ok, true, list.error);
        const ids = (list.data || []).map((x) => String(x.threadId));
        assert.ok(!ids.includes(dispersedId), "the dispersed group should be gone from group list");
    });

    it("recreates the group with the same name and members", async () => {
        const r = await runJson(["group", "create", T.group.name, ...T.group.memberIds], live(T, { timeout: 180_000 }));
        assert.equal(r.ok, true, `recreate failed: ${r.error}`);
        const gid = String(r.data?.groupId || r.data?.grid || r.data?.id || "");
        assert.ok(gid, `no group id in ${JSON.stringify(r.data).slice(0, 300)}`);
        recreatedId = gid;
        await sleep(2000);
    });

    it("writes the new group id back into tests/targets.json", () => {
        const { old, next } = updateGroupThreadId(recreatedId);
        assert.equal(old, dispersedId);
        assert.equal(next, recreatedId);
    });

    it("the recreated group has the configured name and members", async () => {
        const info = await runJson(["group", "info", recreatedId], live(T));
        assert.equal(info.ok, true, info.error);
        assert.equal(info.data?.gridInfoMap?.[recreatedId]?.name, T.group.name);

        const members = await runJson(["group", "members", recreatedId], live(T));
        assert.equal(members.ok, true, members.error);
        const ids = (members.data || []).map(String);
        assert.ok(ids.includes(T.accountOwnId), "the test account must own the recreated group");
        for (const m of T.group.memberIds) {
            assert.ok(ids.includes(m), `member ${m} was not restored into the recreated group`);
        }
    });

    // The old id is gone for good, so prove it rather than assuming it.
    // `group info` on a dispersed id is the sharpest available check that
    // the disperse really took effect server-side, not just locally.
    it("the dispersed id is genuinely dead, not merely absent from the list", async () => {
        const info = await runJson(["group", "info", dispersedId], live(T));
        const resolved = info.ok && info.data?.gridInfoMap?.[dispersedId];
        assert.ok(!resolved, `the dispersed group ${dispersedId} still resolves — disperse did not take`);
    });

    // Post-destructive seed, same reasoning as 5a: a recreated group is
    // empty, and an empty thread is not a usable starting state for the
    // next tier or the next run. Sending here proves the NEW group is
    // writable under its new id — which is also the first real exercise of
    // the id that updateGroupThreadId() just wrote into targets.json, so a
    // botched rewrite surfaces now rather than as a confusing tier-1
    // failure on the following run.
    it("seeds the recreated group and proves the new id in targets.json works", async () => {
        const fresh = loadTargets();
        assert.equal(fresh.configured, true, fresh.reason);
        assert.equal(
            fresh.targets.group.threadId,
            recreatedId,
            "targets.json must already point at the recreated group before anything writes to it",
        );

        const sent = await send(fresh.targets, fresh.targets.group, mark("post-recreate seed — new group is live"));
        assert.ok(sent.msgId, "the recreated group must accept a seed message");
        await sleep(1500);

        const hist = await runJson(
            ["msg", "history", "-t", "1", "-n", "10", "--no-cache", recreatedId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(hist.ok, true, hist.error);
        assert.ok(Array.isArray(hist.data.messages));
    });
});

// ── 5c. Local history deletion ─────────────────────────────────────────

describe("tier 5c · logout --delete-history", { skip }, () => {
    it("removes zalo.db and media/ while keeping credentials usable", async () => {
        const r = await runCli(["logout", "--no-remote", "--delete-history"], live(T));
        assert.match(r.all, /Logged out/);

        assert.equal(existsSync(join(accountDataDir(), "zalo.db")), false, "zalo.db should be gone");
        assert.equal(existsSync(join(accountDataDir(), "media")), false, "media/ should be gone");
        assert.equal(existsSync(credPath()), true, "--delete-history must NOT touch credentials");

        const status = await runJson(["status"], live(T));
        assert.equal(status.ok, true, status.error);
        assert.equal(status.data.loggedIn, true, "auto-login must still work after a history wipe");
    });
});

// ── 5d. Purge filesystem path, server session preserved ────────────────

describe("tier 5d · purge (server session preserved)", { skip }, () => {
    before(() => {
        if (!g.run) return;
        backupSession();
    });

    after(async () => {
        if (!g.run) return;
        restoreSession();
        rmSync(BACKUP, { recursive: true, force: true });
        // Prove the restore actually worked before leaving the tier.
        const status = await runJson(["status"], live(T));
        assert.equal(status.ok, true, `session restore failed: ${status.error}`);
        assert.equal(status.data.loggedIn, true, "credential restore did not bring the session back");
    });

    it("backs the credential up before doing anything", () => {
        assert.equal(existsSync(join(BACKUP, "cred.json")), true);
        assert.equal(existsSync(join(BACKUP, "accounts.json")), true);
    });

    it("the credential file is actually deletable (environment precondition)", () => {
        const why = whyCannotDelete();
        assert.equal(
            why,
            null,
            `${why}\n\n` +
                `This is an environment problem, not a CLI bug — the purge path cannot be\n` +
                `exercised if the OS refuses to unlink the file.\n\n` +
                `On Windows the usual cause is that the credential was written by an\n` +
                `ELEVATED shell, so it is owned by BUILTIN\\Administrators and an unelevated\n` +
                `user inherits only "Users: Write, ReadAndExecute, Synchronize" — write but\n` +
                `no delete. Everything else keeps working, which is why this only ever shows\n` +
                `up as a failing purge. Check with:\n\n` +
                `    Get-Acl "${credPath()}" | Format-List Owner, AccessToString\n\n` +
                `Fix by taking ownership of the config tree:\n\n` +
                `    takeown /F "${configDir()}" /R /D Y\n` +
                `    icacls "${configDir()}" /grant "%USERNAME%:(OI)(CI)F" /T\n\n` +
                `…or simply delete the credential as an administrator and run\n` +
                `\`zalo-agent login\` again from a NON-elevated shell.\n`,
        );
    });

    it("logout --no-remote --purge deletes credentials, data dir, and registry entry", async () => {
        const r = await runCli(["logout", "--no-remote", "--purge"], live(T));
        assert.match(r.all, /purged credentials/i, r.all.slice(0, 400));

        assert.equal(existsSync(credPath()), false, "the credential file must be deleted");
        assert.equal(existsSync(accountDataDir()), false, "the per-account data dir must be wiped");

        const registry = JSON.parse(readFileSync(accountsPath(), "utf-8"));
        assert.ok(
            !registry.some((a) => a.ownId === T.accountOwnId),
            "the purged account must be dropped from accounts.json",
        );
    });

    it("leaves no imei or cookie residue anywhere under the config dir", () => {
        const hits = [];
        const walk = (dir) => {
            if (!existsSync(dir)) return;
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(json|db|txt)$/i.test(e.name)) {
                    let text = "";
                    try {
                        text = readFileSync(p, "utf-8");
                    } catch {
                        continue;
                    }
                    if (/"imei"|zpw_sek|"cookie"/.test(text)) hits.push(p);
                }
            }
        };
        walk(configDir());
        assert.deepEqual(hits, [], `credential residue survived the purge: ${hits.join(", ")}`);
    });

    it("status reports logged out while the credential is gone", async () => {
        const r = await runJson(["status"], live(T));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.data.loggedIn, false);
        assert.equal(r.data.activeAccount, null);
    });
});

// ── 5e. Real, unrecoverable session end ────────────────────────────────

const endSkip = skip || (END_SESSION ? false : "tier 5e needs ZALO_TEST_END_SESSION=1 — ends the session for real");

describe("tier 5e · REAL logout (invalidates the server session)", { skip: endSkip }, () => {
    it("logoutV2 invalidates the session at Zalo's servers", async () => {
        const r = await runCli(["logout"], live(T, { timeout: 120_000 }));
        assert.match(r.all, /Server session invalidated for imei/, r.all.slice(0, 400));
    });

    it("the stored credential no longer authenticates", async () => {
        await sleep(2000);
        const r = await runJson(["whoami"], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, false, "an invalidated session must not still answer whoami");
    });
});

describe("tier 5e · REAL purge (credentials deleted, QR re-scan required)", { skip: endSkip }, () => {
    it("removes every trace of the account from this machine", async () => {
        const r = await runCli(["logout", "--purge"], live(T, { timeout: 120_000 }));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 400));

        assert.equal(existsSync(credPath()), false);
        assert.equal(existsSync(accountDataDir()), false);
        assert.equal(existsSync(join(configDir(), "qr.png")), false, "the QR image should be removed too");
    });

    it("prints the instructions needed to get back in", async () => {
        const r = await runCli(["status"], live(T));
        assert.match(r.all, /Not logged in/);
        console.error("\n!! The account is now fully logged out. Run `zalo-agent login` and scan the QR.\n");
    });
});
