/**
 * Which conversations `sync-media --prune-orphans` and `conv forget --orphans`
 * act on -- and that it is the same set `sync` reports when it recommends them.
 *
 * Both commands DELETE: downloaded media, and for `forget` every cached row. So
 * the question "is this conversation gone?" has to have one answer, recorded
 * once, that every command reads:
 *
 *   - `sync` used to derive its orphan warning from the conversation list it had
 *     just restored, then recommend `sync-media --prune-orphans` -- which never
 *     saw that list, so the conversations the warning named were not pruned.
 *   - the gone marker (threads.leftAt) was never cleared, so a group you left and
 *     then rejoined kept it, and prune deleted the media of a group you are in.
 *
 * Everything runs through the real commands: `sync` routed to an in-process
 * daemon channel whose `messages` stage returns a canned restore result, then
 * `sync-media` and `conv forget` against the same sandboxed zalo.db. The live
 * listener cannot be driven offline, so its half is exercised through the
 * writer both `listen` and `mcp start` call (src/core/live-store.js), and the
 * wiring in those two entry points is checked from their syntax trees.
 *
 * Every id here is fake.
 */
import { SANDBOX_CONFIG_DIR, SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as acorn from "acorn";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    initDb,
    upsertThread,
    insertMessage,
    getMessages,
    markThreadGone,
    getThreadLeftAt,
} from "../../src/core/db.js";
import {
    storeGroupEvent,
    storeGroupEventRow,
    storeLiveMessage,
    storeHistoryMessage,
} from "../../src/core/live-store.js";
import { startDaemonChannel } from "../../src/core/daemon-channel.js";
import { registerSyncCommands } from "../../src/commands/sync.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { FAKE, installFakeZalo, loginFake, runCommand } from "./fake-zalo-session.js";
import { walkAst } from "../helpers/zca-call-sites.js";

const ACCOUNT_DIR = join(CONFIG_DIR, "accounts", FAKE.ownId);
const DB_PATH = join(ACCOUNT_DIR, "zalo.db");
const MEDIA = join(ACCOUNT_DIR, "media");

/** Long before any run in this file: every seeded thread is quiet since then. */
const OLD = 1_700_000_000_000;
const LEFT_AT = OLD + 10_000;
const BACK_AT = OLD + 20_000;

/** The fake login's My Documents id (loginInfo.send2me_id in fake-zalo-session.js). */
const SEND2ME = "1000000000000000001";
/** A listed conversation the restore could not map to a thread id stays opaque. */
const OPAQUE_DM = `oneone/${"a".repeat(32)}`;

let fake;
let api;

before(async () => {
    assertSandboxed(CONFIG_DIR);
    assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    assert.ok(DB_PATH.startsWith(SANDBOX_HOME));
    // Human output, so the lines a user reads are what the assertions read.
    delete process.env.ZALO_JSON_MODE;
    fake = installFakeZalo();
    api = await loginFake();
});

after(() => fake?.uninstall());

beforeEach(() => {
    const h = initDb(DB_PATH);
    h.exec("DELETE FROM messages; DELETE FROM threads; DELETE FROM sync_state; DELETE FROM sync_gaps;");
    rmSync(MEDIA, { recursive: true, force: true });
});

/**
 * One cached conversation holding `files` downloaded attachments.
 *
 * @returns {string[]} the media paths, which exist on disk
 */
function seed(threadId, { type = "group", files = 1, lastUpdate = OLD } = {}) {
    upsertThread({ threadId, type, name: `name of ${threadId}`, lastUpdate });
    const paths = [];
    for (let i = 0; i < files; i++) {
        const msgId = `${threadId}-m${i}`;
        const path = join(MEDIA, threadId, `${msgId}.jpg`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "jpeg bytes");
        insertMessage({
            msgId,
            threadId,
            senderId: "2000000000000000002",
            senderName: "",
            text: "[photo]",
            timestamp: lastUpdate - i,
            type: "photo",
            raw_data: { src: "listen" },
            localPath: path,
            has_attachment: true,
        });
        paths.push(path);
    }
    return paths;
}

/** What a `transfer-sync-v2` restore hands back, as the daemon relays it. */
function restoreResult(liveThreadIds, over = {}) {
    const opaque = liveThreadIds.filter((id) => /^(oneone|group)\//.test(id)).length;
    return {
        conversations: liveThreadIds.length,
        messagesSaved: 0,
        threadsMapped: liveThreadIds.length - opaque,
        threadsUnmapped: opaque,
        reason: "complete",
        days: null,
        from: 0,
        confirmed: true,
        resumes: 0,
        rePrompted: false,
        attachmentsSaved: 0,
        typeCounts: {},
        liveThreadIds,
        ...over,
    };
}

/**
 * Run the real `zalo-agent sync`, its message stage served by a daemon channel
 * in this process -- the route `sync` takes whenever listen/mcp is running.
 *
 * @param {object} result - what the daemon's restore returns
 * @param {string[]} [args] - extra `sync` flags
 * @param {() => void} [during] - runs inside the restore, before it returns
 */
async function runSync(result, args = [], during = null) {
    const chan = await startDaemonChannel({
        getApi: () => api,
        accountDir: ACCOUNT_DIR,
        runners: {
            messages: async () => {
                if (during) during();
                return result;
            },
        },
    });
    try {
        const r = await runCommand(registerSyncCommands, [
            "sync",
            "--force",
            "--no-reactions",
            "--no-conv-state",
            "--no-boards",
            "--no-cloud",
            "--no-media",
            ...args,
        ]);
        // A harness that never reached the report would make every "not
        // reported" assertion below pass for the wrong reason.
        assert.match(r.stdout, /Restored 0 message\(s\) from \d+ conversation\(s\)/, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /messages\s+ok/, `the sync did not finish its message stage:\n${r.stdout}`);
        return r;
    } finally {
        chan.stop();
    }
}

const prune = (...flags) => runCommand(registerSyncCommands, ["sync-media", "--prune-orphans", ...flags]);
const forget = (...flags) => runCommand(registerConvCommands, ["conv", "forget", "--orphans", ...flags]);

/** Which of `ids` a dry-run printed as one of its listed conversations. */
function listed(stdout, ids) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return ids.filter((id) => new RegExp(`^\\s*●\\s+${esc(id)}(\\s|$)`, "m").test(stdout)).sort();
}

/** The account's orphan warning, as `sync` prints it: [conversations, files] or null. */
function reported(stdout) {
    const m =
        /(\d+) conversation\(s\) are no longer on your account but still cached here \((\d+) downloaded file/.exec(
            stdout,
        );
    return m ? [Number(m[1]), Number(m[2])] : null;
}

const allExist = (paths) => paths.every((p) => existsSync(p));
const noneExist = (paths) => paths.every((p) => !existsSync(p));

/** Our own leave, as zca-js hands it over: isSelf, and we are the member who went. */
function leaveEvent(threadId, time = LEFT_AT) {
    return {
        type: "leave",
        threadId,
        isSelf: true,
        data: { groupId: threadId, sourceId: FAKE.ownId, updateMembers: [{ id: FAKE.ownId }], time: String(time) },
    };
}

/** A live message frame in the listener's shape. */
function liveFrame(threadId, msgId, ts, type = 1) {
    return {
        threadId,
        type,
        isSelf: false,
        data: {
            msgId,
            cliMsgId: `${msgId}-cli`,
            uidFrom: "2000000000000000002",
            dName: "Member",
            ts: String(ts),
            msgType: "webchat",
            content: "hello",
        },
    };
}

describe("(a) the conversations sync reports are the ones prune-orphans and forget --orphans act on", () => {
    it("a full-history list's missing conversations are pruned and forgotten by the commands sync names", async () => {
        const dmLive = seed("dm-live", { type: "dm", files: 1 });
        const dmGone = seed("dm-gone", { type: "dm", files: 2 });
        const gLive = seed("g-live", { files: 4 });
        const gGone = seed("g-gone", { files: 8 });

        const s = await runSync(restoreResult(["dm-live", "g-live"]));
        // Red if the warning's count or file total stopped matching what the
        // two missing conversations hold (2 + 8 files, distinct by design).
        assert.deepEqual(reported(s.stdout), [2, 10], s.stdout);
        assert.match(s.stdout, /sync-media --prune-orphans/);
        assert.match(s.stdout, /conv forget --orphans/);

        // Red on v2.0-dev: forget saw only leftAt, which the list never set.
        const dry = await forget("--dry-run");
        assert.deepEqual(listed(dry.stdout, ["dm-live", "dm-gone", "g-live", "g-gone"]), ["dm-gone", "g-gone"]);

        // Red on v2.0-dev: prune found "No orphaned conversations".
        const p = await prune();
        assert.match(p.stdout, /Deleted 10 file\(s\) .* from 2 orphaned conversation\(s\)/, p.stdout);
        assert.ok(noneExist([...dmGone, ...gGone]), "the reported conversations' media must be gone");
        assert.ok(allExist([...dmLive, ...gLive]), "conversations in the list keep their media");

        const f = await forget();
        assert.match(f.stdout, /Forgot 2 conversation\(s\)/, f.stdout);
        assert.equal(getMessages("dm-gone").length, 0);
        assert.equal(getMessages("g-gone").length, 0);
        assert.equal(getMessages("dm-live").length, 1, "a listed conversation is never forgotten");
        assert.equal(getMessages("g-live").length, 4);
    });

    it("a --days run neither reports nor marks what its window did not cover", async () => {
        const kept = [...seed("dm-live", { type: "dm" }), ...seed("dm-quiet", { type: "dm" }), ...seed("g-quiet")];

        // The conversation round of a --days run lists only what was active in
        // the window. Red on v2.0-dev: it warned that dm-quiet and g-quiet were
        // "no longer on your account".
        const s = await runSync(restoreResult(["dm-live"], { days: 7, from: Date.now() - 7 * 86_400_000 }), [
            "--days",
            "7",
        ]);
        assert.equal(reported(s.stdout), null, s.stdout);

        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(kept));
    });

    it("a partial restore's list marks nothing", async () => {
        const kept = [...seed("dm-live", { type: "dm" }), ...seed("g-unserved")];
        // Only the shards that arrived are in the list; the rest were never
        // served, so their absence says nothing. Green on v2.0-dev as well (it
        // only reported on a finished restore); red if a partial list marked.
        const chan = await startDaemonChannel({
            getApi: () => api,
            accountDir: ACCOUNT_DIR,
            runners: { messages: async () => restoreResult(["dm-live"], { reason: "partial" }) },
        });
        try {
            const s = await runCommand(registerSyncCommands, [
                "sync",
                "--force",
                "--no-reactions",
                "--no-conv-state",
                "--no-boards",
                "--no-cloud",
                "--no-media",
            ]);
            assert.match(s.stdout, /Partial restore/, s.stdout);
        } finally {
            chan.stop();
        }
        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(kept));
    });

    it("an unmatched listed DM means no missing DM can be proven gone; groups still can", async () => {
        const dmGone = seed("dm-gone", { type: "dm", files: 2 });
        const gGone = seed("g-gone", { files: 8 });
        seed("dm-live", { type: "dm" });
        seed("g-live");

        // The list holds a DM the restore could not map to a thread id. It may
        // BE dm-gone, so dm-gone's absence proves nothing. Red on v2.0-dev: the
        // warning counted dm-gone, and prune then removed nothing at all.
        const s = await runSync(restoreResult(["dm-live", "g-live", OPAQUE_DM]));
        assert.deepEqual(reported(s.stdout), [1, 8], s.stdout);
        assert.match(
            s.stdout,
            /1 other cached conversation\(s\) are missing from the conversation list but were not marked gone: 1 listed conversation\(s\) could not be matched to a thread id/,
            s.stdout,
        );

        await prune();
        assert.ok(noneExist(gGone), "a group missing from an unambiguous group list is gone");
        assert.ok(allExist(dmGone), "a DM the list cannot account for keeps its media");
    });

    it("a listed conversation that returned no messages means nothing can be proven gone", async () => {
        // Three conversations listed, two accounted for: the silent one is in
        // no id list, so it could be either missing thread. Red on v2.0-dev:
        // both were reported gone.
        const kept = [...seed("dm-gone", { type: "dm" }), ...seed("g-gone")];
        seed("dm-live", { type: "dm" });
        seed("g-live");

        const s = await runSync(restoreResult(["dm-live", "g-live"], { conversations: 3 }));
        assert.equal(reported(s.stdout), null, s.stdout);
        assert.match(
            s.stdout,
            /2 other cached conversation\(s\) are missing from the conversation list but were not marked gone: 1 listed conversation\(s\) returned no messages/,
            s.stdout,
        );
        await prune();
        assert.ok(allExist(kept));
    });

    it("a conversation that started, or was active, around the restore is not marked gone", async () => {
        const busy = seed("dm-busy", { type: "dm", lastUpdate: Date.now() - 60_000 });
        seed("dm-live", { type: "dm" });

        // dm-new's first message lands while the restore runs -- after the
        // conversation list was taken, so the list cannot contain it. Red on
        // v2.0-dev: both were reported as no longer on the account.
        const s = await runSync(restoreResult(["dm-live"]), [], () => {
            storeLiveMessage(liveFrame("dm-new", "dm-new-m0", Date.now(), 0));
        });
        assert.equal(reported(s.stdout), null, s.stdout);

        const dry = await forget("--dry-run");
        assert.match(dry.stdout, /No orphaned conversations/, dry.stdout);
        assert.ok(allExist(busy));
    });

    it("a group we are added to while the restore runs is not marked gone", async () => {
        // Its only row is the join's system line, which the read side ignores
        // (the phone's line for our own leave is dated after the leave), so
        // only the activity check keeps the list from marking it. Red on
        // v2.0-dev: reported as no longer on the account.
        seed("dm-live", { type: "dm" });
        const join = {
            type: "join",
            threadId: "g-new",
            isSelf: true,
            data: {
                groupId: "g-new",
                sourceId: "2000000000000000002",
                updateMembers: [{ id: FAKE.ownId }],
                time: String(Date.now()),
            },
        };
        const s = await runSync(restoreResult(["dm-live"]), [], () => {
            // What listen/mcp do with it: the system line, then the event.
            storeGroupEventRow(join);
            storeGroupEvent(join, { ownId: FAKE.ownId });
        });
        assert.equal(reported(s.stdout), null, s.stdout);
        const dry = await forget("--dry-run");
        assert.equal(listed(dry.stdout, ["g-new"]).length, 0, dry.stdout);
    });

    it("My Documents is never marked gone from a list", async () => {
        // The friend list never contains the self-chat, so a list can easily
        // lack its id or carry it under another. Red on v2.0-dev: reported.
        const mine = seed(SEND2ME, { type: "dm", files: 3 });
        seed("dm-live", { type: "dm" });

        const s = await runSync(restoreResult(["dm-live"]));
        assert.equal(reported(s.stdout), null, s.stdout);
        await prune();
        assert.ok(allExist(mine), "files saved to My Documents must survive prune-orphans");
    });
});

describe("(b) a conversation the account is back in is not an orphan", () => {
    it("a join event naming us clears the mark, and prune keeps the media", async () => {
        const media = seed("g-rejoined", { files: 4 });
        storeGroupEvent(leaveEvent("g-rejoined"), { ownId: FAKE.ownId });
        const before = await forget("--dry-run");
        assert.deepEqual(listed(before.stdout, ["g-rejoined"]), ["g-rejoined"], "leaving must mark the group gone");

        // Red on v2.0-dev: nothing cleared leftAt, so prune deleted all four.
        const back = storeGroupEvent(
            {
                type: "join",
                threadId: "g-rejoined",
                isSelf: true,
                data: {
                    groupId: "g-rejoined",
                    sourceId: "2000000000000000002",
                    updateMembers: [{ id: FAKE.ownId }],
                    time: String(BACK_AT),
                },
            },
            { ownId: FAKE.ownId },
        );
        assert.equal(back.gone, false);

        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(media));
        const f = await forget("--dry-run");
        assert.match(f.stdout, /No orphaned conversations/, f.stdout);
    });

    it("a message in the thread after we left clears the mark", async () => {
        const media = seed("g-rejoined", { files: 2 });
        storeGroupEvent(leaveEvent("g-rejoined"), { ownId: FAKE.ownId });
        // Red on v2.0-dev: a message after the leave changed nothing.
        assert.equal(storeLiveMessage(liveFrame("g-rejoined", "g-rejoined-new", BACK_AT)).stored, true);
        assert.equal(getThreadLeftAt("g-rejoined"), null, "the listener clears the marker itself");

        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(media));
    });

    it("a newer message from a writer that does not clear the mark still outranks it", async () => {
        // Rejoined while no listener ran; `msg history` then fetches what was
        // said since. Its write-back leaves the marker alone (so does a
        // restore's), so only the read side can see the account is back. Red
        // if getOrphanThreads stopped weighing messages against the marker.
        const media = seed("g-rejoined", { files: 2 });
        storeGroupEvent(leaveEvent("g-rejoined"), { ownId: FAKE.ownId });
        assert.equal(storeHistoryMessage(liveFrame("g-rejoined", "g-rejoined-fetched", BACK_AT)).stored, true);

        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(media));
    });

    it("a later sync listing the conversation clears the mark, even a --days one", async () => {
        const media = seed("g-rejoined", { files: 2 });
        storeGroupEvent(leaveEvent("g-rejoined"), { ownId: FAKE.ownId });
        // The list holds it under its real id: the restore mapped it through the
        // CURRENT group list, so the account is a member again. Red on v2.0-dev.
        await runSync(restoreResult(["g-rejoined"], { days: 7, from: Date.now() - 7 * 86_400_000 }), ["--days", "7"]);

        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(media));
    });

    it("clearing the mark keeps conv delete's cutoff: msg history still refuses what was deleted", async () => {
        seed("dm-deleted", { type: "dm", files: 1 });
        markThreadGone("dm-deleted", LEFT_AT); // what conv delete records
        // The contact writes again, so the conversation is back on the list.
        storeLiveMessage(liveFrame("dm-deleted", "dm-deleted-new", BACK_AT, 0));

        // Red on v2.0-dev: still an orphan despite the new message.
        const f = await forget("--dry-run");
        assert.match(f.stdout, /No orphaned conversations/, f.stdout);

        // Green on v2.0-dev too, and must stay green: clearing the gone marker
        // must not let fetched history bring back what the delete removed.
        const old = storeHistoryMessage(liveFrame("dm-deleted", "dm-deleted-old", LEFT_AT - 1, 0));
        assert.equal(old.stored, false);
        assert.match(old.reason, /delete marker/);
        assert.equal(storeHistoryMessage(liveFrame("dm-deleted", "dm-deleted-later", BACK_AT + 1, 0)).stored, true);
    });

    it("a database written before the split keeps its delete marker after the mark clears", () => {
        // A zalo.db from before the delete marker had its own column: leftAt
        // was both. Red if the migration does not carry it over -- the old
        // message below would then be written back.
        const oldPath = join(SANDBOX_HOME, "pre-split.db");
        const raw = new Database(oldPath);
        raw.exec(
            "CREATE TABLE threads (threadId TEXT PRIMARY KEY, type TEXT, name TEXT, lastUpdate INTEGER, " +
                "sync_timestamp INTEGER DEFAULT 0, respondedByMe INTEGER, lastGlobalId TEXT, lastClientId TEXT, leftAt INTEGER)",
        );
        raw.prepare("INSERT INTO threads (threadId, type, name, lastUpdate, leftAt) VALUES (?, 'dm', 'x', ?, ?)").run(
            "dm-old-db",
            OLD,
            LEFT_AT,
        );
        raw.close();

        initDb(oldPath);
        storeLiveMessage(liveFrame("dm-old-db", "dm-old-db-new", BACK_AT, 0));
        const old = storeHistoryMessage(liveFrame("dm-old-db", "dm-old-db-old", LEFT_AT - 1, 0));
        assert.equal(old.stored, false, "the pre-split leftAt must survive as the delete marker");
        initDb(DB_PATH);
    });
});

describe("(c) a conversation that really is gone is still pruned", () => {
    it("our own removal is detected, and prune deletes the media", async () => {
        const media = seed("g-removed", { files: 3 });
        const r = storeGroupEvent(
            {
                type: "remove_member",
                threadId: "g-removed",
                isSelf: true,
                data: {
                    groupId: "g-removed",
                    sourceId: "2000000000000000002",
                    updateMembers: [{ id: FAKE.ownId }],
                    time: String(LEFT_AT),
                },
            },
            { ownId: FAKE.ownId },
        );
        assert.equal(r.gone, true);
        const p = await prune();
        assert.match(p.stdout, /Deleted 3 file\(s\) .* from 1 orphaned conversation\(s\)/, p.stdout);
        assert.ok(noneExist(media));
    });

    it("removing or blocking SOMEONE ELSE does not mark our own group gone", async () => {
        // zca-js sets isSelf when we are the ACTOR too, so an admin removing a
        // member got their own group flagged. Red on v2.0-dev: prune deleted it.
        const media = seed("g-admin", { files: 2 });
        for (const type of ["remove_member", "block_member"]) {
            const r = storeGroupEvent(
                {
                    type,
                    threadId: "g-admin",
                    isSelf: true,
                    data: {
                        groupId: "g-admin",
                        sourceId: FAKE.ownId,
                        updateMembers: [{ id: "2000000000000000003" }],
                        time: String(LEFT_AT),
                    },
                },
                { ownId: FAKE.ownId },
            );
            assert.equal(r.gone, false, type);
        }
        const p = await prune();
        assert.match(p.stdout, /No orphaned conversations are holding downloaded media/, p.stdout);
        assert.ok(allExist(media));
    });

    it("a message from before we left does not bring the conversation back", async () => {
        // A backlog replay or a late delivery is not a sighting. Green on
        // v2.0-dev (nothing cleared); red if the clear ignored timestamps.
        const media = seed("g-left", { files: 2 });
        storeGroupEvent(leaveEvent("g-left"), { ownId: FAKE.ownId });
        storeLiveMessage(liveFrame("g-left", "g-left-late", LEFT_AT - 5_000));
        const p = await prune();
        assert.match(p.stdout, /Deleted 2 file\(s\) .* from 1 orphaned conversation\(s\)/, p.stdout);
        assert.ok(noneExist(media));
    });

    it("leaving a listed group while the restore runs is not undone by that list", async () => {
        // The list was taken before the leave, so it still holds the group.
        // Green on v2.0-dev (nothing cleared); red if a list cleared marks set
        // after it was taken.
        const media = seed("g-listed", { files: 2 });
        seed("dm-live", { type: "dm" });
        await runSync(restoreResult(["g-listed", "dm-live"]), [], () => {
            storeGroupEvent(leaveEvent("g-listed", Date.now()), { ownId: FAKE.ownId });
        });
        const p = await prune();
        assert.match(p.stdout, /Deleted 2 file\(s\) .* from 1 orphaned conversation\(s\)/, p.stdout);
        assert.ok(noneExist(media));
    });

    it("a list-marked conversation stays gone through a later sync that does not list it", async () => {
        const media = seed("dm-gone", { type: "dm", files: 2 });
        seed("dm-live", { type: "dm" });
        await runSync(restoreResult(["dm-live"]));
        await runSync(restoreResult(["dm-live"], { days: 7, from: Date.now() - 7 * 86_400_000 }), ["--days", "7"]);
        await prune();
        assert.ok(noneExist(media));
    });
});

describe("(d) --dry-run lists exactly what the real run removes, and removes nothing", () => {
    /** One orphan from a leave event, one from a full list, one conversation still live. */
    async function mixedOrphans() {
        const left = seed("g-left", { files: 2 });
        const gone = seed("dm-gone", { type: "dm", files: 1 });
        const live = seed("g-live", { files: 4 });
        storeGroupEvent(leaveEvent("g-left"), { ownId: FAKE.ownId });
        // g-left is not listed: a group the account left is not in its current
        // group list, so a restore never maps it to its id.
        await runSync(restoreResult(["g-live"]));
        return { left, gone, live, ids: ["g-left", "dm-gone", "g-live"] };
    }

    it("sync-media --prune-orphans", async () => {
        const { left, gone, live, ids } = await mixedOrphans();

        const dry = await prune("--dry-run");
        // Red on v2.0-dev: dm-gone (the list's orphan) was missing.
        assert.deepEqual(listed(dry.stdout, ids), ["dm-gone", "g-left"], dry.stdout);
        assert.match(dry.stdout, /Dry run: 3 file\(s\) .*across 2 orphaned conversation\(s\)/, dry.stdout);
        assert.ok(allExist([...left, ...gone, ...live]), "a dry run deletes no file");
        for (const id of ["g-left", "dm-gone"]) {
            assert.ok(
                getMessages(id).every((m) => m.localPath),
                "a dry run clears no pointer, so nothing is requeued",
            );
        }

        const real = await prune();
        assert.match(real.stdout, /Deleted 3 file\(s\) .* from 2 orphaned conversation\(s\)/, real.stdout);
        assert.ok(noneExist([...left, ...gone]), "the real run deletes what the dry run listed");
        assert.ok(allExist(live), "and nothing it did not list");
    });

    it("conv forget --orphans", async () => {
        const { left, gone, live, ids } = await mixedOrphans();

        const dry = await forget("--dry-run");
        assert.deepEqual(listed(dry.stdout, ids), ["dm-gone", "g-left"], dry.stdout);
        assert.equal(getMessages("g-left").length, 2, "a dry run forgets no row");
        assert.equal(getMessages("dm-gone").length, 1);
        assert.ok(allExist([...left, ...gone, ...live]));

        const real = await forget();
        assert.match(real.stdout, /Forgot 2 conversation\(s\): 3 message\(s\) and 3 file\(s\)/, real.stdout);
        assert.equal(getMessages("g-left").length, 0);
        assert.equal(getMessages("dm-gone").length, 0);
        assert.equal(getMessages("g-live").length, 4);
        assert.ok(allExist(live));
    });

    it("lists every orphan, not only the first page of them", async () => {
        // A preview that silently stops at 15 (prune) or 20 (forget) does not
        // show what the real run is about to remove. Red on v2.0-dev.
        const ids = Array.from({ length: 22 }, (_, i) => `g-many-${String(i).padStart(2, "0")}`);
        for (const id of ids) {
            seed(id);
            storeGroupEvent(leaveEvent(id), { ownId: FAKE.ownId });
        }
        assert.deepEqual(listed((await prune("--dry-run")).stdout, ids), ids);
        assert.deepEqual(listed((await forget("--dry-run")).stdout, ids), ids);
    });
});

describe("listen and mcp start hand storeGroupEvent the account's own id", () => {
    // Removal is only ours when WE are among the removed members, and telling
    // that from "we removed someone" needs our uid. An entry point that stopped
    // passing it would disagree with the other about which groups are gone --
    // the listen/mcp asymmetry AGENTS.md §13 calls a defect.
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const { file, attachFn } of [
        { file: "listen.js", attachFn: "attachAllHandlers" },
        { file: "mcp.js", attachFn: "attachListenerHandlers" },
    ]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const nodes = (root, pred) => {
                const out = [];
                walkAst(root, (n) => pred(n) && out.push(n));
                return out;
            };
            const [fn] = nodes(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === attachFn);
            assert.ok(fn, `${attachFn} not found -- this guard has drifted`);
            const [handler] = nodes(
                fn,
                (n) =>
                    n.type === "CallExpression" &&
                    n.callee?.property?.name === "on" &&
                    n.arguments[0]?.value === "group_event",
            );
            assert.ok(handler, `no group_event handler in ${attachFn}`);
            const calls = nodes(
                handler,
                (n) =>
                    n.type === "CallExpression" &&
                    n.callee?.type === "Identifier" &&
                    n.callee.name === "storeGroupEvent",
            );
            assert.equal(calls.length, 1, `${file} must record group departures through storeGroupEvent`);
            const opts = calls[0].arguments[1];
            assert.equal(opts?.type, "ObjectExpression", `${file} must pass storeGroupEvent an options object`);
            const own = opts.properties.find((p) => p.key?.name === "ownId");
            assert.ok(own, `${file} must pass the account's own id`);
            assert.equal(own.value.type, "MemberExpression");
            assert.equal(own.value.object?.name, "activeAcc");
            assert.equal(own.value.property?.name, "ownId");
        });
    }
});
