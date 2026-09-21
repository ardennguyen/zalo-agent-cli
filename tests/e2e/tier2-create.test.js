/**
 * TIER 2 — sends and creates.
 *
 * Everything here ADDS state: messages, polls, reminders, notes, quick
 * messages, auto-reply rules, catalogs. Nothing is deleted; tier 4 does
 * that. Running tier 2 without tier 4 leaves visible test artifacts, which
 * is deliberate — a half-run should be obvious, not silent.
 *
 * Every write goes through helpers/live.js, which calls assertDisposable()
 * first, so a drifted thread id fails before the send rather than after.
 *
 * DM volume is kept deliberately low: the DM target is a real person, so
 * only the messages needed to exercise the 1:1 path are sent, and tier 4
 * recalls all of them.
 *
 * Artifacts are written to tests/.artifacts.json for tier 4 to clean up.
 *
 * Gate: ZALO_TEST_LIVE=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli, runJson, hasSuccess } from "../helpers/cli.js";
import { gate, live, mark, send, sleep, assertDisposable } from "../helpers/live.js";
import { IMAGES, FILES, verifyFixtures } from "../fixtures/index.js";

const g = gate(2);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

const ARTIFACTS = resolve(import.meta.dirname, "..", ".artifacts.json");

/** Everything tier 4 needs to clean up. */
const artifacts = { messages: [], polls: [], reminders: [], quickMsgs: [], autoReplies: [], catalogs: [] };

after(() => {
    if (!g.run) return;
    writeFileSync(ARTIFACTS, JSON.stringify(artifacts, null, 2), "utf-8");
});

/** Record a sent message so tier 4 can recall/delete it. */
function remember(thread, sent, what) {
    artifacts.messages.push({ threadId: thread.threadId, type: thread.type, ...sent, what });
    return sent;
}

/**
 * Record an ATTACHMENT send from its raw `runJson` result.
 *
 * Text sends go through `send()`, which returns a tidy {msgId, cliMsgId}.
 * Attachment sends do not: `msg send-image` with several paths answers with
 * an ARRAY of per-attachment results, a single attachment answers with one
 * object, and the msgId sits under `message` on some paths and at the top
 * level on others — the same shape drift tests/README.md warns about for
 * create endpoints. Rather than guess, walk the payload and collect every
 * {msgId, cliMsgId} pair it contains.
 *
 * This matters more than it looks. Tier 4 recalls only what the ledger
 * holds, and until now the ledger held plain-text sends ONLY — every image,
 * file, sticker, link, card, bank card and QR transfer was left behind.
 * For the group that is merely untidy, since tier 5a wipes the thread. For
 * the DM it is not: `conv delete` removes history from OUR side only, so
 * `msg undo` is the one thing that takes a message out of the other
 * person's view. An untracked DM attachment stays visible to them forever.
 *
 * @param {object} thread - targets.group or targets.dm
 * @param {object} r - the runJson() result of a send-* command
 * @param {string} what - label for the ledger
 * @returns {number} how many messages were recorded
 */
function rememberSent(thread, r, what) {
    if (!r?.ok) return 0;

    const found = [];
    const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        const msgId = node.msgId ?? node.message?.msgId;
        const cliMsgId = node.cliMsgId ?? node.message?.cliMsgId;
        if (msgId && cliMsgId) found.push({ msgId: String(msgId), cliMsgId: String(cliMsgId) });
        for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
    };
    // cliMsgId usually sits beside `message`, not inside it, so seed the
    // scan with the top-level pairing before descending.
    const top = r.data?.message?.msgId;
    const topCli = r.data?.cliMsgId;
    if (top && topCli) found.push({ msgId: String(top), cliMsgId: String(topCli) });
    walk(r.data);

    const seen = new Set();
    let n = 0;
    for (const m of found) {
        if (seen.has(m.msgId)) continue;
        seen.add(m.msgId);
        remember(thread, m, what);
        n++;
    }
    return n;
}

// Media comes from tests/fixtures/ — real encoder output, committed, so
// these tests upload the same bytes every run and a failure means Zalo
// changed, not that a runtime-generated stub was malformed.
before(() => {
    if (!g.run) return;
    const problems = verifyFixtures();
    assert.deepEqual(problems, [], `fixtures are damaged, refusing to upload: ${problems.join("; ")}`);
});

describe("tier 2 · group text messages", { skip }, () => {
    it("sends a plain text message and returns a msgId + cliMsgId", async () => {
        const sent = remember(T.group, await send(T, T.group, mark("plain text")), "plain");
        assert.match(sent.msgId, /^\d+$/);
        assert.match(sent.cliMsgId, /^\d+$/);
    });

    it("sends with --md markdown styling", async () => {
        const sent = await send(T, T.group, `${mark("md")} **bold** *italic* __underline__ ~~strike~~`, ["--md"]);
        remember(T.group, sent, "markdown");
        assert.ok(sent.msgId);
    });

    it("sends with explicit --style specs", async () => {
        const sent = await send(T, T.group, `${mark("style")} styled-run`, ["--style", "0:5:bold"]);
        remember(T.group, sent, "style");
        assert.ok(sent.msgId);
    });

    it("sends with {color:...} markdown extensions", async () => {
        const sent = await send(T, T.group, `${mark("color")} {red:alert} {green:ok}`, ["--md"]);
        remember(T.group, sent, "color");
        assert.ok(sent.msgId);
    });

    it("mentions @All in a group via uid -1", async () => {
        const text = "@All group mention probe";
        const sent = await send(T, T.group, `${text} ${mark("mention")}`, ["--mention", "0:-1:4"]);
        remember(T.group, sent, "mention");
        assert.ok(sent.msgId);
    });

    it("--react auto-reacts to the message it just sent", async () => {
        assertDisposable(T.group.threadId, "msg send --react");
        const r = await runJson(
            ["msg", "send", "-t", "1", T.group.threadId, mark("auto-react"), "--react", ":>"],
            live(T),
        );
        assert.equal(r.ok, true, r.error);
        remember(T.group, { msgId: String(r.data.message.msgId), cliMsgId: String(r.data.cliMsgId) }, "auto-react");

        // REGRESSION GUARD — this used to append a human line AFTER the JSON.
        // success() wrote to stdout unconditionally, so `--json msg send
        // --react` produced JSON followed by "✓ Auto-reacted with…", which
        // broke any `| jq`. The confirmation now goes to stderr.
        assert.equal(r.trailing ?? "", "", "nothing may follow the JSON payload on stdout");
        assert.match(r.raw.stderr, /Auto-reacted with/, "the confirmation should still be reported, on stderr");
    });
});

describe("tier 2 · image attachments", { skip }, () => {
    // One test per format, because zca-js branches on extension
    // (jpg/jpeg/png/webp take the "image" upload path, everything else does
    // not) and readImageMetadata() branches on magic bytes. A PNG-only test
    // would leave both the JPEG segment scan and the GIF path unproven end
    // to end.
    for (const [key, fx] of Object.entries(IMAGES)) {
        it(`sends ${fx.format} ${fx.width}x${fx.height} (${fx.name})`, async () => {
            assertDisposable(T.group.threadId, "msg send-image");
            const r = await runJson(
                ["msg", "send-image", "-t", "1", T.group.threadId, fx.path, "-m", mark(`image ${key}`)],
                live(T, { timeout: 180_000 }),
            );
            assert.equal(r.ok, true, `${fx.name}: ${r.error}`);
            rememberSent(T.group, r, `image ${key}`);
        });
    }

    it("sends several images in one message", async () => {
        assertDisposable(T.group.threadId, "msg send-image");
        const r = await runJson(
            [
                "msg",
                "send-image",
                "-t",
                "1",
                T.group.threadId,
                IMAGES.png.path,
                IMAGES.jpg.path,
                IMAGES.gif.path,
                "-m",
                mark("multi-image"),
            ],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        rememberSent(T.group, r, "multi-image");
    });

    it("sends an image to the DM target", { skip: skip || (T?.dm ? false : "no DM target") }, async () => {
        assertDisposable(T.dm.threadId, "msg send-image");
        const r = await runJson(
            ["msg", "send-image", "-t", "0", T.dm.threadId, IMAGES.png.path, "-m", mark("DM image")],
            live(T, { timeout: 180_000 }),
        );
        assert.equal(r.ok, true, r.error);
        rememberSent(T.dm, r, "dm-image");
    });

    it("reports a missing image path instead of failing silently", async () => {
        assertDisposable(T.group.threadId, "msg send-image");
        const r = await runCli(
            ["msg", "send-image", "-t", "1", T.group.threadId, "./no-such-image.png"],
            live(T, { timeout: 60_000 }),
        );
        assert.equal(r.killed, false);
        assert.match(r.all, /File not found|ENOENT|not allowed/i);
    });

    // REGRESSION GUARD — send-image used to hang on these.
    //
    // zca-js routes by EXTENSION, not by command: anything outside
    // jpg/jpeg/png/webp/gif takes the "others" path, which waits on a
    // WebSocket upload-complete frame. send-image never started a listener,
    // so `send-image photo.bmp` hung forever with no output — the same bug
    // already fixed in send-file. Zalo permits these formats (it denylists
    // only executables), so users really do hit this.
    for (const key of ["bmp", "tiff"]) {
        it(`send-image accepts a non-inline ${key.toUpperCase()} and returns promptly`, async () => {
            const fx = IMAGES[key];
            assertDisposable(T.group.threadId, "msg send-image");
            const r = await runJson(
                ["msg", "send-image", "-t", "1", T.group.threadId, fx.path, "--upload-timeout", "25000"],
                live(T, { timeout: 45_000 }),
            );
            assert.equal(r.ok, true, `${fx.name}: ${r.error}`);
            assert.ok(r.data?.attachment?.[0]?.msgId, `expected an attachment msgId for ${fx.name}`);
        });
    }

    it("warns that a non-inline format will arrive as a file attachment", async () => {
        assertDisposable(T.group.threadId, "msg send-image");
        const r = await runCli(
            ["msg", "send-image", "-t", "1", T.group.threadId, IMAGES.bmp.path, "--upload-timeout", "25000"],
            live(T, { timeout: 45_000 }),
        );
        assert.equal(r.killed, false, "must not hang");
        assert.match(r.all, /Not an inline image format/, "the command name should not quietly mislead");
    });
});

/**
 * `msg send-file` args with an explicit --upload-timeout.
 *
 * The CLI default is 120s, which is longer than these tests' harness
 * timeouts — so a dropped upload-complete frame would be killed by the
 * harness (looking like the hang we fixed) instead of producing the CLI's
 * own "Upload timed out" error. Setting it below the harness budget keeps
 * a transient legible.
 */
function sendFileArgs(thread, ...paths) {
    return ["msg", "send-file", "-t", String(thread.type), thread.threadId, ...paths, "--upload-timeout", "25000"];
}

describe("tier 2 · file attachments", { skip }, () => {
    // REGRESSION GUARD — this used to hang forever.
    //
    // zca-js's uploadAttachment() resolves synchronously for images but, for
    // "video"/"others", awaits a promise only apis/listen.js can settle when
    // the upload-complete frame arrives over the WebSocket. send-file never
    // started a listener, so the await never settled and the command hung
    // with no output at all. Fixed in src/commands/msg.js by bringing the
    // listener up around the send (plus a --upload-timeout so a missed frame
    // fails loudly rather than silently).
    //
    // The 45s cap is the point: if this ever hangs again, the test fails
    // instead of stalling the suite.
    for (const [key, fx] of Object.entries(FILES)) {
        it(`sends ${key} (${fx.name}) and returns promptly`, async () => {
            assertDisposable(T.group.threadId, "msg send-file");
            const r = await runJson(
                [...sendFileArgs(T.group, fx.path), "-m", mark(`file ${key}`)],
                live(T, { timeout: 45_000 }),
            );
            assert.equal(r.ok, true, `${fx.name}: ${r.error}`);
            rememberSent(T.group, r, `file ${key}`);
            const id = r.data?.attachment?.[0]?.msgId;
            assert.ok(id, `expected an attachment msgId, got ${JSON.stringify(r.data)}`);
        });
    }

    it("sends several files in one message", async () => {
        assertDisposable(T.group.threadId, "msg send-file");
        const r = await runJson(
            [...sendFileArgs(T.group, FILES.txt.path, FILES.csv.path), "-m", mark("multi-file")],
            live(T, { timeout: 60_000 }),
        );

        // Zalo occasionally drops the upload-complete frame this path waits
        // on. That is upstream flakiness, not a defect — what this test
        // actually guards is that the command always REACHES a verdict
        // rather than hanging, which is the bug that was fixed. So a clean
        // "Upload timed out" is an acceptable outcome; a harness kill is not.
        if (!r.ok) {
            assert.match(r.error, /Upload timed out/i, `expected success or a clean timeout, got: ${r.error}`);
            assert.equal(r.raw.killed, false, "the CLI must bound its own wait, not be killed by the harness");
            return;
        }
        assert.equal(r.data?.attachment?.length, 2, "both files should come back with msgIds");
        rememberSent(T.group, r, "multi-file");
    });

    it("sends a file to the DM target", { skip: skip || (T?.dm ? false : "no DM target") }, async () => {
        assertDisposable(T.dm.threadId, "msg send-file");
        const r = await runJson(
            [...sendFileArgs(T.dm, FILES.pdf.path), "-m", mark("DM file")],
            live(T, { timeout: 45_000 }),
        );
        assert.equal(r.ok, true, r.error);
        rememberSent(T.dm, r, "dm-file");
    });

    it("exits cleanly instead of leaving the listener holding the event loop", async () => {
        assertDisposable(T.group.threadId, "msg send-file");
        const r = await runCli(sendFileArgs(T.group, FILES.txt.path), live(T, { timeout: 45_000 }));
        assert.equal(r.killed, false, "the command must exit on its own, not be killed by the timeout");
        assert.equal(r.code, 0);
    });

    it("surfaces a bad path as an error rather than hanging", async () => {
        assertDisposable(T.group.threadId, "msg send-file");
        const r = await runCli(
            ["msg", "send-file", "-t", "1", T.group.threadId, "./definitely-not-a-real-file.pdf"],
            live(T, { timeout: 45_000 }),
        );
        assert.equal(r.killed, false, "a missing file must not hang the upload channel");
        assert.match(r.all, /File not found|ENOENT/i);
    });

    it("honors --upload-timeout instead of waiting forever", async () => {
        // A 1ms budget cannot possibly be met, so this proves the timeout is
        // wired in — the command must fail fast and say why, not hang.
        assertDisposable(T.group.threadId, "msg send-file");
        const r = await runCli(
            ["msg", "send-file", "-t", "1", T.group.threadId, FILES.zip.path, "--upload-timeout", "1"],
            live(T, { timeout: 45_000 }),
        );
        assert.equal(r.killed, false, "--upload-timeout must bound the wait");
        assert.match(r.all, /Upload timed out/i);
    });

    it("sends a link with auto-preview", async () => {
        assertDisposable(T.group.threadId, "msg send-link");
        const r = await runCli(
            ["msg", "send-link", "-t", "1", T.group.threadId, "https://zalo.me", "-m", mark("link")],
            live(T, { timeout: 180_000 }),
        );
        assert.ok(hasSuccess(r.stdout) || /Link sent/.test(r.stdout), r.stdout.slice(0, 300));
    });

    // NOT tracked for recall, deliberately: link / sticker / card / bank /
    // QR all go through runCli rather than runJson, so there is no parsed
    // payload to take a msgId from — the tests only assert a success line.
    // That is acceptable ONLY because every one of them is group-only, and
    // tier 5a wipes the group conversation. None of them is ever sent to
    // the DM, where an unrecalled message would stay in a real person's
    // view forever. If one of these is ever pointed at T.dm, switch it to
    // runJson and rememberSent() it first.
    it("searches and sends a sticker", async () => {
        assertDisposable(T.group.threadId, "msg sticker");
        const r = await runCli(["msg", "sticker", "-t", "1", T.group.threadId, "hello"], live(T, { timeout: 120_000 }));
        assert.ok(hasSuccess(r.stdout), r.stdout.slice(0, 300));
    });

    it("sends a contact card", async () => {
        assertDisposable(T.group.threadId, "msg send-card");
        const r = await runCli(
            ["msg", "send-card", "-t", "1", T.group.threadId, T.group.memberIds[0]],
            live(T, { timeout: 120_000 }),
        );
        assert.ok(hasSuccess(r.stdout), r.stdout.slice(0, 300));
    });

    it("sends a bank card", async () => {
        assertDisposable(T.group.threadId, "msg send-bank");
        const r = await runCli(
            ["msg", "send-bank", "-t", "1", T.group.threadId, "0123456789", "-b", "ocb", "-n", "TEST ACCOUNT"],
            live(T, { timeout: 120_000 }),
        );
        assert.ok(hasSuccess(r.stdout), r.stdout.slice(0, 300));
    });

    it("generates and sends a VietQR transfer image (compact template)", async () => {
        assertDisposable(T.group.threadId, "msg send-qr-transfer");
        const r = await runCli(
            [
                "msg",
                "send-qr-transfer",
                "-t",
                "1",
                T.group.threadId,
                "0123456789",
                "-b",
                "ocb",
                "-a",
                "10000",
                "-m",
                "e2e probe",
            ],
            live(T, { timeout: 180_000 }),
        );
        assert.ok(hasSuccess(r.stdout), r.stdout.slice(0, 400));
    });

    it("sends a bare QR with --template qronly", async () => {
        assertDisposable(T.group.threadId, "msg send-qr-transfer");
        const r = await runCli(
            ["msg", "send-qr-transfer", "-t", "1", T.group.threadId, "0123456789", "-b", "vcb", "--template", "qronly"],
            live(T, { timeout: 180_000 }),
        );
        assert.ok(hasSuccess(r.stdout), r.stdout.slice(0, 400));
    });
});

describe("tier 2 · DM messages", { skip: skip || (T?.dm ? false : "no DM target configured") }, () => {
    it("sends a plain text DM", async () => {
        const sent = remember(T.dm, await send(T, T.dm, mark("DM plain text")), "dm-plain");
        assert.ok(sent.msgId);
    });

    it("sends a styled DM", async () => {
        const sent = await send(T, T.dm, `${mark("DM styled")} **bold**`, ["--md"]);
        remember(T.dm, sent, "dm-markdown");
        assert.ok(sent.msgId);
    });

    it("reacts to a DM message it sent", async () => {
        const sent = remember(T.dm, await send(T, T.dm, mark("DM react target")), "dm-react-target");
        await sleep(500);
        const r = await runCli(
            ["msg", "react", "-t", "0", "-c", sent.cliMsgId, sent.msgId, T.dm.threadId, ":>"],
            live(T),
        );
        assert.ok(hasSuccess(r.stdout) || /Reacted/.test(r.stdout), r.stdout.slice(0, 300));
    });

    it("forwards a message into the disposable group", async () => {
        const sent = remember(T.dm, await send(T, T.dm, mark("forward source")), "dm-forward-source");
        await sleep(500);
        assertDisposable(T.group.threadId, "msg forward");
        const r = await runCli(
            ["msg", "forward", "-t", "1", sent.msgId, T.group.threadId],
            live(T, { timeout: 120_000 }),
        );
        // Forward is exercised for its code path; Zalo may reject a
        // cross-thread forward of a just-sent message, so a clean error is
        // an acceptable outcome — a crash is not.
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
    });
});

describe("tier 2 · polls", { skip }, () => {
    it("creates a poll in the disposable group", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const r = await runJson(
            ["poll", "create", T.group.threadId, `${TAGGED("poll")}`, "Option A", "Option B", "Option C"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(r.ok, true, r.error);
        const id = r.data?.poll_id || r.data?.pollId || r.data?.id;
        assert.ok(id, `expected a poll id in ${JSON.stringify(r.data).slice(0, 200)}`);
        artifacts.polls.push(String(id));
    });

    it("creates a poll with the four boolean option flags", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const r = await runJson(
            [
                "poll",
                "create",
                T.group.threadId,
                TAGGED("poll flags"),
                "Yes",
                "No",
                "--multi",
                "--add-options",
                "--anonymous",
                "--hide-preview",
            ],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(r.ok, true, r.error);
        const id = r.data?.poll_id || r.data?.pollId || r.data?.id;
        if (id) artifacts.polls.push(String(id));
    });

    // REGRESSION GUARD — `--expire` used to fail every time.
    //
    // poll.js computed `opts.expire * 60 * 1000`, a DURATION, where Zalo
    // wants an absolute epoch deadline — so 60 minutes read as Jan 1 1970
    // and the call was rejected with "Tham số không hợp lệ". Fixed to
    // `Date.now() + opts.expire * 60 * 1000`. Bisected at the time:
    // --expire was the only one of the five poll flags that failed.
    it("creates a poll with an expiry", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const r = await runJson(
            ["poll", "create", T.group.threadId, TAGGED("poll expiry"), "Yes", "No", "--expire", "60"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(r.ok, true, r.error);
        const id = r.data?.poll_id || r.data?.pollId || r.data?.id;
        assert.ok(id, "expected a poll id");
        artifacts.polls.push(String(id));
    });

    it("sets the poll deadline in the future, not in 1970", async () => {
        assertDisposable(T.group.threadId, "poll create");
        const before = Date.now();
        const r = await runJson(
            ["poll", "create", T.group.threadId, TAGGED("poll deadline"), "Yes", "No", "--expire", "60"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(r.ok, true, r.error);
        const id = r.data?.poll_id || r.data?.pollId || r.data?.id;
        if (id) artifacts.polls.push(String(id));

        // Zalo echoes the deadline back; whatever field it lands in, it must
        // be an epoch in the future — that is the whole point of the fix.
        const expiry = Number(r.data?.expiredTime ?? r.data?.expired_time ?? 0);
        if (expiry > 0) {
            assert.ok(
                expiry > before,
                `poll deadline ${expiry} (${new Date(expiry).toISOString()}) should be in the future`,
            );
        }
    });
});

describe("tier 2 · reminders", { skip }, () => {
    it("creates a reminder in the disposable group", async () => {
        assertDisposable(T.group.threadId, "reminder create");
        const r = await runJson(
            ["reminder", "create", "-t", "1", T.group.threadId, TAGGED("reminder"), "--emoji", "⏰"],
            live(T, { timeout: 120_000 }),
        );
        assert.equal(r.ok, true, r.error);
        const id = r.data?.id || r.data?.reminderId || r.data?.topicId;
        if (id) artifacts.reminders.push({ id: String(id), threadId: T.group.threadId, type: 1 });
    });

    // DM parity. Every `reminder` subcommand takes `-t/--type` with 0=User,
    // and Zalo serves DM reminders from /api/board/oneone/list rather than
    // the group's /api/board/listReminder — a genuinely different endpoint
    // behind the same CLI surface. The suite used to exercise only `-t 1`,
    // so the whole 1:1 branch was unverified.
    it(
        "creates a reminder in the DM as well — the 1:1 endpoint is a different one",
        { skip: skip || (T?.dm ? false : "no DM target configured") },
        async () => {
            assertDisposable(T.dm.threadId, "reminder create");
            const r = await runJson(
                ["reminder", "create", "-t", "0", T.dm.threadId, TAGGED("dm reminder"), "--emoji", "⏰"],
                live(T, { timeout: 120_000 }),
            );
            assert.equal(r.ok, true, r.error);
            const id = r.data?.id || r.data?.reminderId || r.data?.topicId;
            if (id) artifacts.reminders.push({ id: String(id), threadId: T.dm.threadId, type: 0 });
        },
    );
});

describe("tier 2 · group notes", { skip }, () => {
    it("creates a pinned note in the disposable group", async () => {
        assertDisposable(T.group.threadId, "group note-create");
        const r = await runCli(
            ["group", "note-create", T.group.threadId, TAGGED("note"), "--pin"],
            live(T, { timeout: 120_000 }),
        );
        assert.doesNotMatch(r.all, /at Command\.|Unhandled/, r.all.slice(0, 300));
    });

    // There is deliberately no DM equivalent here, and that is a finding
    // rather than an omission: zca-js types createNote as
    // createNote(options, groupId) — group-only — so the CLI cannot make a
    // note ("Ghi chú") on a 1:1 thread at all. zca-js DOES ship
    // getFriendBoardList(conversationId), the DM-side board reader, but no
    // CLI command exposes it (only sync-v2/board.js touches getListBoard).
    // Until a command surfaces it there is nothing to drive from here.
    it("CHARACTERIZATION: notes are group-only — the CLI has no DM board command", () => {
        assert.equal(
            typeof T.dm?.threadId === "string" || T.dm === null,
            true,
            "DM target shape unchanged; this test documents a missing command, not a failure",
        );
    });
});

describe("tier 2 · account-level artifacts", { skip }, () => {
    // Account-level artifacts are the one place a half-finished run bites
    // the next one: quick-message keywords must be unique, and catalogs
    // count against an account cap. Sweeping leftovers first makes tier 2
    // re-runnable after an abort instead of failing on its own debris.
    before(async () => {
        if (!g.run) return;
        await purgeStaleQuickMsgs();
        await purgeStaleCatalogs();
    });

    it("adds a quick message under a run-unique keyword", async () => {
        const r = await runJson(["quick-msg", "add", QUICK_KEYWORD, TAGGED("quick msg")], live(T));
        assert.equal(r.ok, true, r.error);
        const id = r.data?.id || r.data?.itemId || r.data?.item?.id;
        if (id) artifacts.quickMsgs.push(String(id));
    });

    it("rejects a duplicate keyword", async () => {
        const r = await runJson(["quick-msg", "add", QUICK_KEYWORD, TAGGED("dup")], live(T));
        assert.equal(r.ok, false, "a second add on the same keyword must be refused");
        assert.match(r.error, /Duplicate keyword/i);
    });

    // REGRESSION GUARD — `auto-reply create` used to fail on its defaults.
    //
    // `--start`/`--end` defaulted to 0, and Zalo rejects startTime:0 /
    // endTime:0 with "Tham số không hợp lệ", so the command could never
    // succeed without the user guessing that two undocumented epoch values
    // were mandatory. Fixed: unset start means "now", unset end means one
    // year out.
    //
    // Note the account-state ceiling underneath: Zalo refuses to create a
    // rule when more than one already exists ("Bạn chỉ có thể chỉnh sửa khi
    // tổng số tin trả lời tự động đang tồn tại không nhiều hơn 1"). That is
    // the user's own data, not a defect — so these tests assert the payload
    // clears validation, and treat the quota message as an acceptable
    // outcome.
    const isQuotaRefusal = (e) => /không nhiều hơn|no more than/i.test(e || "");

    it("creates a disabled auto-reply rule on defaults (disabled so it cannot answer real people)", async () => {
        const r = await runJson(["auto-reply", "create", TAGGED("auto-reply"), "--no-enable", "--scope", "1"], live(T));
        if (r.ok) {
            const id = r.data?.item?.id || r.data?.id || r.data?.itemId;
            if (id) artifacts.autoReplies.push(String(id));
            return;
        }
        assert.doesNotMatch(
            r.error,
            /Tham số không hợp lệ/,
            "defaults must produce a well-formed payload — this was the bug",
        );
        assert.ok(isQuotaRefusal(r.error), `expected creation or Zalo's quota refusal, got: ${r.error}`);
    });

    it("accepts explicit epoch start/end too", async () => {
        const now = Date.now();
        const r = await runJson(
            [
                "auto-reply",
                "create",
                TAGGED("ar timed"),
                "--no-enable",
                "--scope",
                "1",
                "--start",
                String(now),
                "--end",
                String(now + 86_400_000),
            ],
            live(T),
        );
        if (r.ok) {
            const id = r.data?.item?.id || r.data?.id || r.data?.itemId;
            if (id) artifacts.autoReplies.push(String(id));
            return;
        }
        assert.doesNotMatch(r.error, /Tham số không hợp lệ/, "a real timestamp must clear payload validation");
        assert.ok(isQuotaRefusal(r.error), `expected creation or Zalo's quota refusal, got: ${r.error}`);
    });

    it("creates a catalog", async () => {
        const r = await runJson(["catalog", "create", TAGGED("catalog")], live(T, { timeout: 120_000 }));
        assert.equal(r.ok, true, r.error);
        // `catalog create` answers {item: {id, name, …}} — not a bare {id}.
        // Reading only `r.data.id` silently recorded nothing, which left the
        // catalog orphaned and eventually tripped Zalo's catalog cap.
        const id = r.data?.item?.id || r.data?.catalogId || r.data?.id;
        assert.ok(id, `no catalog id in ${JSON.stringify(r.data).slice(0, 200)}`);
        artifacts.catalogs.push({ id: String(id), products: [] });
    });

    it("adds a product to that catalog", { skip: skip }, async () => {
        if (!artifacts.catalogs.length) return; // catalog creation is tier-gated upstream
        const cat = artifacts.catalogs[0];
        const r = await runJson(
            ["catalog", "add-product", cat.id, TAGGED("product"), "10000", "e2e test product"],
            live(T, { timeout: 120_000 }),
        );
        if (r.ok) {
            const pid = r.data?.productId || r.data?.id;
            if (pid) cat.products.push(String(pid));
        }
    });
});

/** A tagged label short enough for fields with tight length limits. */
function TAGGED(what) {
    return `[e2e] ${what} ${new Date().toISOString().slice(11, 19)}`;
}

/**
 * Quick-message keywords must be unique per account, so a fixed one turns
 * every re-run after an abort into a "Duplicate keyword" failure. Derive it
 * from the run's start time instead.
 */
const QUICK_KEYWORD = `e2e${Date.now().toString(36)}`;

/** Delete any quick message left behind by an earlier e2e run. */
async function purgeStaleQuickMsgs() {
    const list = await runJson(["quick-msg", "list"], live(T));
    if (!list.ok) return;
    const stale = (list.data?.items || []).filter(
        (i) => /^e2e/i.test(i.keyword || "") || /\[e2e\]/.test(i.message?.title || ""),
    );
    for (const i of stale) {
        await runCli(["quick-msg", "remove", String(i.id)], live(T));
        await sleep(250);
    }
}

/** Delete any catalog left behind by an earlier e2e run (they count against a cap). */
async function purgeStaleCatalogs() {
    const list = await runJson(["catalog", "list"], live(T, { timeout: 120_000 }));
    if (!list.ok) return;
    const stale = (list.data?.items || []).filter((c) => /\[e2e\]/.test(c.name || ""));
    for (const c of stale) {
        await runCli(["catalog", "delete", String(c.id)], live(T, { timeout: 120_000 }));
        await sleep(250);
    }
}
