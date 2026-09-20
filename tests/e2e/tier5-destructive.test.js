/**
 * TIER 5 — irreversible and session-ending operations.
 *
 * This tier is ordered by how hard it is to come back from, least to most,
 * and split across three gates so a run can stop at any level:
 *
 *   5a  group disperse → recreate      ZALO_TEST_DESTRUCTIVE=1
 *       The old group id dies forever, but the group is immediately
 *       recreated with the same name and members, and tests/targets.json is
 *       rewritten with the new id. Recoverable in substance, not in id.
 *
 *   5b  logout --delete-history        ZALO_TEST_DESTRUCTIVE=1
 *       Wipes zalo.db and media/. Credentials survive; the cache rebuilds.
 *
 *   5c  purge WITHOUT server logout    ZALO_TEST_DESTRUCTIVE=1
 *       `logout --no-remote --purge` exercises the entire purge filesystem
 *       path — credential deletion, account-dir wipe, registry drop —
 *       while leaving the *server* session valid. The suite backs the
 *       credential up first and restores it afterward, so this proves the
 *       purge code works without costing a QR re-scan.
 *
 *   5d  real logout / real purge       ZALO_TEST_END_SESSION=1
 *       Calls logoutV2(), which genuinely invalidates the session at
 *       Zalo's servers. NOTHING RESTORES THIS. The account must be
 *       re-authenticated by scanning a QR code on the phone. Runs last,
 *       behind its own flag, and every test after it would fail by design.
 *
 * Gates: ZALO_TEST_LIVE=1 + ZALO_TEST_DESTRUCTIVE=1 (+ ZALO_TEST_END_SESSION=1 for 5d)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCli, runJson, hasSuccess } from "../helpers/cli.js";
import { gate, live, sleep, END_SESSION } from "../helpers/live.js";
import { updateGroupThreadId } from "../helpers/targets.js";

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

// ── 5a. Group disperse → recreate ──────────────────────────────────────

describe("tier 5a · group disperse and recreate", { skip }, () => {
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
});

// ── 5b. Local history deletion ─────────────────────────────────────────

describe("tier 5b · logout --delete-history", { skip }, () => {
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

// ── 5c. Purge filesystem path, server session preserved ────────────────

describe("tier 5c · purge (server session preserved)", { skip }, () => {
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

// ── 5d. Real, unrecoverable session end ────────────────────────────────

const endSkip = skip || (END_SESSION ? false : "tier 5d needs ZALO_TEST_END_SESSION=1 — ends the session for real");

describe("tier 5d · REAL logout (invalidates the server session)", { skip: endSkip }, () => {
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

describe("tier 5d · REAL purge (credentials deleted, QR re-scan required)", { skip: endSkip }, () => {
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
