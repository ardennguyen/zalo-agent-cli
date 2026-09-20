/**
 * TIER 4 — deletions that undo tier 2.
 *
 * Runs AFTER tiers 1–3 because it destroys the artifacts those tiers
 * created and read. Within the tier the order matters too:
 *
 *   1. message-level deletes (delete, undo)  ← need the messages to exist
 *   2. account-level artifact deletes        ← independent of messages
 *   3. local-cache deletion                  ← independent of the server
 *   4. conv delete (wipes thread history)    ← LAST: it removes the very
 *      messages steps 1–2 operate on, so anything after it would have
 *      nothing left to act against
 *
 * Reads tests/.artifacts.json, written by tier 2. If that file is missing
 * the tier degrades to the paths that don't need it rather than failing.
 *
 * Gate: ZALO_TEST_LIVE=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCli, runJson, hasSuccess, errorLineOf } from "../helpers/cli.js";
import { gate, live, mark, send, sleep, undoMsg, assertDisposable } from "../helpers/live.js";

const g = gate(4);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

const ARTIFACTS = resolve(import.meta.dirname, "..", ".artifacts.json");

let artifacts = { messages: [], polls: [], reminders: [], quickMsgs: [], autoReplies: [], catalogs: [] };
const haveArtifacts = () => existsSync(ARTIFACTS);

before(() => {
    if (!g.run || !haveArtifacts()) return;
    try {
        artifacts = { ...artifacts, ...JSON.parse(readFileSync(ARTIFACTS, "utf-8")) };
    } catch {
        // A corrupt ledger should not block the independent cleanups.
    }
});

after(() => {
    if (!g.run) return;
    rmSync(ARTIFACTS, { force: true });
});

// ── 1. Message-level deletes ───────────────────────────────────────────

describe("tier 4 · message deletion", { skip }, () => {
    it("deletes a freshly sent group message (one-sided delete)", async () => {
        const sent = await send(T, T.group, mark("to be deleted"));
        await sleep(800);
        assertDisposable(T.group.threadId, "msg delete");
        const r = await runCli(["msg", "delete", "-t", "1", sent.msgId, T.group.threadId], live(T));
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        assert.ok(hasSuccess(r.stdout) || errorLineOf(r.stdout), "expected a definite outcome");
    });

    it("recalls a freshly sent group message for both sides (undo)", async () => {
        const sent = await send(T, T.group, mark("to be recalled"));
        await sleep(800);
        assertDisposable(T.group.threadId, "msg undo");
        const r = await runCli(["msg", "undo", "-t", "1", "-c", sent.cliMsgId, sent.msgId, T.group.threadId], live(T));
        assert.ok(
            hasSuccess(r.stdout) || /recalled/i.test(r.stdout),
            `undo did not report success: ${r.all.slice(0, 300)}`,
        );
    });

    it("recalls every message tier 2 sent to the group", { skip: skip || !haveArtifacts() }, async () => {
        const groupMsgs = artifacts.messages.filter((m) => String(m.threadId) === T.group.threadId);
        let handled = 0;
        for (const m of groupMsgs) {
            assertDisposable(m.threadId, "msg undo (tier-2 cleanup)");
            const r = await runCli(
                ["msg", "undo", "-t", String(m.type), "-c", m.cliMsgId, m.msgId, m.threadId],
                live(T),
            );
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, `undo of ${m.msgId} crashed`);
            handled++;
            await sleep(300);
        }
        assert.equal(handled, groupMsgs.length, "every tracked group message must be attempted");
    });

    it("recalls every message tier 2 sent to the DM target", { skip: skip || !haveArtifacts() || !T?.dm }, async () => {
        const dmMsgs = artifacts.messages.filter((m) => String(m.threadId) === T.dm.threadId);
        for (const m of dmMsgs) {
            assertDisposable(m.threadId, "msg undo (DM cleanup)");
            const r = await runCli(
                ["msg", "undo", "-t", String(m.type), "-c", m.cliMsgId, m.msgId, m.threadId],
                live(T),
            );
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, `undo of ${m.msgId} crashed`);
            await sleep(300);
        }
    });
});

// ── 2. Account-level artifact deletes ──────────────────────────────────

describe("tier 4 · account artifact cleanup", { skip }, () => {
    it("removes the quick messages tier 2 added", { skip: skip || !haveArtifacts() }, async () => {
        for (const id of artifacts.quickMsgs) {
            const r = await runCli(["quick-msg", "remove", id], live(T));
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        }
    });

    it("removes any leftover e2e quick messages found on the account", async () => {
        const list = await runJson(["quick-msg", "list"], live(T));
        if (!list.ok) return;
        const items = list.data?.items || (Array.isArray(list.data) ? list.data : []);
        const mine = items.filter((i) => /\[e2e\]|e2eprobe/.test(JSON.stringify(i)));
        for (const i of mine) {
            const id = i.id || i.itemId;
            if (!id) continue;
            await runCli(["quick-msg", "remove", String(id)], live(T));
            await sleep(250);
        }
    });

    it("deletes the auto-reply rules tier 2 created", { skip: skip || !haveArtifacts() }, async () => {
        for (const id of artifacts.autoReplies) {
            const r = await runCli(["auto-reply", "delete", id], live(T));
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        }
    });

    it("deletes catalog products, then the catalogs themselves", { skip: skip || !haveArtifacts() }, async () => {
        for (const cat of artifacts.catalogs) {
            for (const pid of cat.products || []) {
                const r = await runCli(["catalog", "delete-product", cat.id, pid], live(T, { timeout: 120_000 }));
                assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
                await sleep(300);
            }
            const r = await runCli(["catalog", "delete", cat.id], live(T, { timeout: 120_000 }));
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
        }
    });

    // Backstop for the ledger. Response shapes vary across these endpoints
    // (`catalog create` answers {item:{id}}, not {id}), so an id the ledger
    // failed to capture would otherwise orphan the artifact — and catalogs
    // count against a Zalo-side cap, where one leftover blocks the NEXT run's
    // creation with "Lỗi không xác định". Sweeping by name makes cleanup
    // independent of how any one response happens to be shaped.
    it("sweeps any [e2e]-named catalog the ledger missed", async () => {
        const list = await runJson(["catalog", "list"], live(T, { timeout: 120_000 }));
        assert.equal(list.ok, true, list.error);

        const strays = (list.data?.items || []).filter((c) => /\[e2e\]/.test(c.name || ""));
        for (const c of strays) {
            await runCli(["catalog", "delete", String(c.id)], live(T, { timeout: 120_000 }));
            await sleep(300);
        }

        const after2 = await runJson(["catalog", "list"], live(T, { timeout: 120_000 }));
        if (after2.ok) {
            const remaining = (after2.data?.items || []).filter((c) => /\[e2e\]/.test(c.name || ""));
            assert.deepEqual(
                remaining.map((c) => c.name),
                [],
                "an e2e catalog left behind will block the next run's catalog creation",
            );
        }
    });

    it("sweeps any [e2e]-named auto-reply rule the ledger missed", async () => {
        const list = await runJson(["auto-reply", "list"], live(T));
        if (!list.ok) return; // nothing to sweep if the surface is unavailable
        const items = list.data?.items || (Array.isArray(list.data) ? list.data : []);
        for (const i of items.filter((x) => /\[e2e\]/.test(JSON.stringify(x)))) {
            const id = i.id || i.itemId;
            if (!id) continue;
            await runCli(["auto-reply", "delete", String(id)], live(T));
            await sleep(250);
        }
    });

    it("removes the reminders tier 2 created", { skip: skip || !haveArtifacts() }, async () => {
        for (const rem of artifacts.reminders) {
            assertDisposable(rem.threadId, "reminder remove");
            const r = await runCli(
                ["reminder", "remove", "-t", String(rem.type), rem.id, rem.threadId],
                live(T, { timeout: 120_000 }),
            );
            assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
            await sleep(300);
        }
    });
});

// ── 3. Local cache deletion (server state untouched) ───────────────────

describe("tier 4 · local chat cache", { skip }, () => {
    it("logout --no-remote leaves the session alive (local-only, per-process)", async () => {
        // --no-remote skips logoutV2(), so nothing is invalidated server
        // side. Because each CLI invocation is its own process, this is
        // effectively a no-op — which is exactly why it is safe here and
        // the real logout is not.
        const r = await runCli(["logout", "--no-remote"], live(T));
        assert.match(r.all, /Logged out \(credentials kept/);

        const still = await runJson(["status"], live(T));
        assert.equal(still.ok, true, still.error);
        assert.equal(still.data.loggedIn, true, "a --no-remote logout must not end the session");
    });
});

// ── 4. Conversation history wipe — LAST ────────────────────────────────

describe("tier 4 · conversation history wipe (runs last)", { skip }, () => {
    // NOTE on what these can and cannot assert — see agent/work/transfer-sync-v2/NOTES.md § Ordering.
    //
    // The obvious check ("send a probe, wipe, confirm the probe is gone")
    // does not work, for two independent reasons:
    //
    //   1. `msg history` is not a reliable oracle. It is built on Zalo's
    //      OLD-message backfill (getGroupChatHistory for groups,
    //      requestOldMessages over the socket for DMs), and it lags live
    //      traffic badly — measured ~1.5 h stale on this account, and not
    //      advancing between consecutive calls. A just-sent message simply
    //      is not in it.
    //
    //   2. For a GROUP, `conv delete` removes the conversation from YOUR
    //      view; it does not delete the group's messages for everyone. So
    //      even a fresh oracle should still see them.
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
});

describe("tier 4 · local logout, traffic, then re-sync", { skip }, () => {
    // The scenario the cache exists for: the CLI is "logged out" locally,
    // messages happen, and later commands must still work. `--no-remote`
    // keeps the server session alive, so this costs no QR re-scan.

    it("logout --no-remote leaves the session usable", async () => {
        const out = await runCli(["logout", "--no-remote"], live(T));
        assert.match(out.all, /Logged out \(credentials kept/);

        const status = await runJson(["status"], live(T));
        assert.equal(status.ok, true, status.error);
        assert.equal(status.data.loggedIn, true, "a --no-remote logout must not end the session");
    });

    it("sending still works immediately after a local logout", async () => {
        await runCli(["logout", "--no-remote"], live(T));

        // Auto-login should transparently re-establish the session.
        const sent = await send(T, T.group, mark("post-logout traffic"));
        assert.match(sent.msgId, /^\d+$/, "a send after local logout should succeed via auto-login");
        await undoMsg(T, T.group, sent.msgId, sent.cliMsgId);
    });

    it("a live history fetch after logout still answers and keeps the cache db", async () => {
        await runCli(["logout", "--no-remote"], live(T));
        const r = await runJson(
            ["msg", "history", "-t", "1", "-n", "5", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(r.data.source, "live");

        const dbPath = join(T.home, ".zalo-agent-cli", "accounts", T.accountOwnId, "zalo.db");
        assert.ok(existsSync(dbPath), "fetching history should have created/kept the cache db");
    });

    // KNOWN GAP — see agent/work/transfer-sync-v2/NOTES.md § Ordering.
    // `msg history` calls insertMessage() but never upsertThread(), so the
    // `threads` table stays empty however much history is fetched. Only
    // `listen` and `sync` populate it — which is why `conv recent` almost
    // always falls through to its (meaningless) live ordering.
    it("CHARACTERIZATION: fetching history does not populate the threads table", async () => {
        const dbPath = join(T.home, ".zalo-agent-cli", "accounts", T.accountOwnId, "zalo.db");
        if (!existsSync(dbPath)) return;

        await runJson(
            ["msg", "history", "-t", "1", "-n", "5", "--no-cache", T.group.threadId],
            live(T, { timeout: 180_000 }),
        );

        const { default: Database } = await import("better-sqlite3");
        const db = new Database(dbPath, { readonly: true });
        try {
            const messages = db.prepare("SELECT COUNT(*) c FROM messages").get().c;
            const threads = db.prepare("SELECT COUNT(*) c FROM threads").get().c;
            assert.ok(messages > 0, "history should have written messages");
            assert.equal(threads, 0, "threads stays empty — only `listen`/`sync` call upsertThread()");
        } finally {
            db.close();
        }
    });
});
