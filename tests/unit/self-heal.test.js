/**
 * The daemon self-heals a coverage gap from Zalo's offline queue, on its own socket.
 *
 * Zalo Web, on every authenticated connect (bundle 1.e0ef5e98…: `_doAfterAuth`
 * → `onAuthenticated` reads the handshake's `qCmds`, then `signalGetOffline` →
 * `doGetOffline` per queue), asks each queue for what it missed since its
 * saved cursor -- `{first:true, reqId, lastId, preIds:[]}` on cmd 510/511 sub 1
 * -- and pages while the answer says `more`, continuing from `lastActionId`
 * (`onGotOffline`). No phone is involved: that is the full restore's job
 * (cmd 590), which only a `zalo-agent sync` someone typed may start.
 *
 * These tests drive the real socket tap, the real frame decoder, the real
 * writers and a real zalo.db, through ./support/fake-socket.js: a Listener
 * stand-in whose "server" answers in the captured frame shapes. Every id is
 * made up, and short on purpose.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GroupMessage, UserMessage } from "zca-js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    initDb,
    getMessageById,
    getPendingSyncGaps,
    getSyncState,
    recordSyncGap,
    setMessageLocalPath,
    setMessageStatus,
} from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { createStageLock, startDaemonChannel, syncViaDaemon } from "../../src/core/daemon-channel.js";
import { createSocketTap } from "../../src/core/socket-tap.js";
import { createSelfHeal } from "../../src/core/self-heal.js";
import { fakeListener } from "./support/fake-socket.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-self-heal-"));
let dbSeq = 0;

const OWN = "900001";
const GROUP = "7301";
const PEER = "3301";
const MEMBER = "2301";
/** The handshake's queue list, as captured (agent/work/transfer-sync-v2/zalo-cap-sync.decoded.jsonl #1). */
const QCMDS = [
    { cmd: 515, subCmd: 0, queueName: "515_0" },
    { cmd: 517, subCmd: 0, queueName: "517_0" },
    { cmd: 518, subCmd: 0, queueName: "518_0" },
    { cmd: 510, subCmd: 1, queueName: "510_1" },
    { cmd: 511, subCmd: 1, queueName: "511_1" },
];
const T0 = Date.UTC(2026, 8, 1);

let idSeq = 0;
/** A msgId no other test uses; message times follow the ids, as Zalo's do. */
const nextId = () => String(5_300_000 + ++idSeq * 10);
const tsOf = (id) => T0 + (Number(id) - 5_300_000) * 1000;

/** One message row as the server sends it, in a push or an offline page. */
function row(msgId, { group = true, ...over } = {}) {
    return {
        actionId: String(Number(msgId) + 7),
        msgId,
        cliMsgId: String(tsOf(msgId) + 3),
        msgType: "webchat",
        uidFrom: group ? MEMBER : PEER,
        idTo: group ? GROUP : "0",
        dName: group ? "Member" : "Peer",
        ts: String(tsOf(msgId)),
        content: `text ${msgId}`,
        ...over,
    };
}

/** An offline-queue answer in the captured envelope (zalo-cap-sync.decoded.jsonl #15, #20). */
function page(cmd, rows, { more = 0, lastActionId, evict = 0, reqId, extra = {} } = {}) {
    const queueName = `${cmd}_1`;
    const last = lastActionId ?? rows[rows.length - 1]?.msgId ?? "0";
    return {
        error_code: 0,
        error_message: "",
        data: {
            lastActionId: last,
            more,
            msgs: cmd === 510 ? rows : [],
            groupMsgs: cmd === 511 ? rows : [],
            pageMsgs: [],
            clearUnreads: [],
            delivereds: [],
            seens: [],
            groupSeens: [],
            queueStatus: { [queueName]: { ids: rows.map((r) => r.msgId), lastId: last, evict } },
            reqId,
            eesession: [],
            ...extra,
        },
    };
}

/**
 * A fake server that answers each queue from a script of pages, echoing reqId;
 * an exhausted script answers "nothing more" at the cursor it was asked for.
 */
function scripted(pages = {}) {
    const left = { 510: [...(pages[510] || [])], 511: [...(pages[511] || [])] };
    return (payload) => {
        if (payload.cmd !== 510 && payload.cmd !== 511) return null;
        const next = left[payload.cmd].shift();
        if (next === null) return null; // scripted silence: this request times out
        const body = next ?? page(payload.cmd, [], { lastActionId: payload.data.lastId });
        body.data.reqId = payload.data.reqId;
        return body;
    };
}

const queueRequests = (listener) => listener.sent.filter((p) => p.cmd === 510 || p.cmd === 511);
const pending = () => getPendingSyncGaps().map((g) => ({ fromTs: g.fromTs, toTs: g.toTs, reason: g.reason }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A daemon's wiring, minus the command around it: the storing handler first,
 * then the tap and the self-heal, exactly as listen/mcp attach them.
 */
function daemon({
    respond = scripted(),
    enabled = true,
    lock = createStageLock(),
    now,
    store = storeLiveMessage,
} = {}) {
    const listener = fakeListener({ respond });
    const tap = createSocketTap();
    const logs = [];
    const recovered = [];
    const api = { listener, getOwnId: () => OWN };
    const heal = createSelfHeal({
        getApi: () => api,
        tap,
        lock,
        enabled,
        log: (line) => logs.push(line),
        onRecovered: (items) => recovered.push(...items),
        timeoutMs: 150,
        maxPages: 4,
        now,
    });
    listener.on("message", (m) => store(m));
    tap.attach(listener);
    heal.attach(listener);
    listener.emit("connected");
    return { listener, tap, heal, logs, recovered, lock, api };
}

/** A message the listener received live, as zca-js hands it over. */
const live = (listener, r, group = true) =>
    listener.emit("message", group ? new GroupMessage(OWN, { ...r }) : new UserMessage(OWN, { ...r }));

/** Connect and authenticate, then wait for the catch-up it triggers. */
async function connectAndSettle(d, qCmds = QCMDS) {
    d.listener.auth({ qCmds });
    await sleep(0);
    await d.heal.settled();
}

beforeEach(() => {
    initDb(join(ROOT, `db${dbSeq++}.sqlite`));
});

describe("self-heal: catch up from the offline queue on the daemon's own socket", () => {
    let savedFetch;
    let httpCalls;

    before(() => {
        assertSandboxed(CONFIG_DIR);
    });

    beforeEach(() => {
        // Nothing here may reach the network: the phone-backed restore starts with
        // a REST call (transfer-sync-v2/request-sync) as well as cmd 590.
        savedFetch = globalThis.fetch;
        httpCalls = [];
        globalThis.fetch = async (url) => {
            httpCalls.push(String(url));
            throw new Error("offline test: no HTTP");
        };
    });

    afterEach(() => {
        globalThis.fetch = savedFetch;
    });

    it("(a) after a drop and reconnect, it pulls each queue from the last message stored, on the same listener", async () => {
        const d = daemon();
        const g1 = nextId();
        live(d.listener, row(g1));
        assert.ok(getMessageById(g1), "seed: the listener stored it");

        d.listener.reconnect(); // a NEW ws object, as zca-js makes on retry
        await connectAndSettle(d);

        const asked = queueRequests(d.listener);
        // Red if the tap does not re-arm on the new ws (nothing sent), the
        // cursor is not the last stored message, or other queues are asked.
        assert.deepEqual(
            asked.map((p) => ({ cmd: p.cmd, subCmd: p.subCmd, first: p.data.first, lastId: p.data.lastId })),
            [
                { cmd: 510, subCmd: 1, first: true, lastId: g1 },
                { cmd: 511, subCmd: 1, first: true, lastId: g1 },
            ],
            "510 has no cursor of its own, so it starts where 511 is -- the web's shared lastActionId",
        );
        for (const p of asked) {
            assert.deepEqual(p.data.preIds, []);
            assert.match(String(p.data.reqId), /^req_\d+$/, "the web's reqId shape");
        }
    });

    it("(a) at start-up with no saved cursor, each queue starts from its newest stored message", async () => {
        // Stored before any self-heal existed, so no cursor was ever saved.
        const dm = nextId();
        const gr = nextId();
        storeLiveMessage(new UserMessage(OWN, row(dm, { group: false })));
        storeLiveMessage(new GroupMessage(OWN, row(gr)));

        const d = daemon();
        await connectAndSettle(d);

        assert.deepEqual(
            queueRequests(d.listener).map((p) => [p.cmd, p.data.lastId]),
            [
                [510, dm],
                [511, gr],
            ],
        );
    });

    it("(a) the cursor never passes a message the listener failed to write", async () => {
        const written = nextId();
        const lost = nextId();
        // The daemon's writer fails on one message (a locked db, a crash mid-handler).
        const d = daemon({ store: (m) => (m.data.msgId === lost ? { stored: false } : storeLiveMessage(m)) });
        live(d.listener, row(written));
        live(d.listener, row(lost));
        assert.equal(getMessageById(lost), null, "seed: that write failed");

        d.listener.reconnect();
        await connectAndSettle(d);

        // Red if the cursor follows every message seen rather than every row
        // written: the pull would then start after `lost` and skip it for good.
        assert.equal(queueRequests(d.listener).find((p) => p.cmd === 511).data.lastId, written);
    });

    it("(a) it follows the handshake's qCmds, and never asks a queue it cannot read", async () => {
        const d = daemon();
        live(d.listener, row(nextId()));
        await connectAndSettle(d, [
            { cmd: 515, subCmd: 0, queueName: "515_0" },
            { cmd: 511, subCmd: 1, queueName: "511_1" },
        ]);
        // 515/517/518 are the E2EE queues (default-embed-render …js SignalCommands).
        assert.deepEqual(
            d.listener.sent.map((p) => p.cmd),
            [511],
        );
    });

    it("(b) recovered rows are written insert-if-absent; a row already cached is left exactly as it was", async () => {
        const keptId = nextId();
        const newId = nextId();
        const respond = scripted({
            511: [page(511, [row(keptId, { content: "a different copy", dName: "Member (renamed)" }), row(newId)])],
        });
        const d = daemon({ respond });
        live(d.listener, row(keptId, { msgType: "chat.photo", content: { href: "https://p.invalid/a.jpg" }, st: 3 }));
        setMessageLocalPath(keptId, join(ROOT, "media", "a.jpg"));
        setMessageStatus(keptId, 3);
        const kept = getMessageById(keptId);

        await connectAndSettle(d);

        const fresh = getMessageById(newId);
        assert.ok(fresh, "the missed message was not stored");
        assert.equal(fresh.threadId, GROUP);
        assert.equal(fresh.text, `text ${newId}`);
        assert.equal(JSON.parse(fresh.raw_data).src, "offline", "its provenance must say where it came from");
        // Red if the catch-up writes through the listener's upsert.
        assert.deepEqual(getMessageById(keptId), kept, "a cached row was modified");
        // What a bot is shown: only the message it never saw.
        assert.deepEqual(
            d.recovered.map((r) => r.msg.data.msgId),
            [newId],
        );
    });

    it("(b) a recall that happened during the drop is applied, not stored as a message", async () => {
        const said = nextId();
        const undoId = nextId();
        const undo = row(undoId, {
            msgType: "chat.undo",
            content: {
                globalMsgId: said,
                cliMsgId: String(tsOf(said) + 3),
                deleteMsg: 0,
                srcId: MEMBER,
                destId: GROUP,
            },
        });
        const d = daemon({ respond: scripted({ 511: [page(511, [undo])] }) });
        live(d.listener, row(said));

        await connectAndSettle(d);

        // Red if removals are skipped, as a history fetch skips them: the
        // sender withdrew it, and the cache would still show it.
        assert.equal(getMessageById(said).type, "deleted", "the recall was not applied");
        assert.equal(getMessageById(undoId), null, "the recall notification was stored as a message");
    });

    it("(c) a gap inside the covered window is resolved", async () => {
        const d = daemon();
        const g1 = nextId();
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");

        await connectAndSettle(d);

        // Red if a drained queue does not count as coverage.
        assert.deepEqual(pending(), [], "a fully covered gap is still pending");
    });

    it("(c) a gap that starts before the cursor keeps its uncovered start pending", async () => {
        const d = daemon();
        const g1 = nextId();
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) - 60_000, tsOf(g1) + 60_000, "startup-gap");

        await connectAndSettle(d);

        // Red if coverage is claimed from before the cursor, or the remainder
        // is dropped instead of kept for `sync`.
        assert.deepEqual(pending(), [{ fromTs: tsOf(g1) - 60_000, toTs: tsOf(g1), reason: "uncovered:startup-gap" }]);
        assert.ok(
            d.logs.some((l) => l.includes("zalo-agent sync --from")),
            "the remainder must be named with the command that closes it",
        );
    });

    it("(c) a queue that reports evict keeps everything before the oldest message it returned", async () => {
        const g1 = nextId();
        const survivor = nextId();
        const d = daemon({ respond: scripted({ 511: [page(511, [row(survivor)], { evict: 1 })] }) });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 1_000, tsOf(survivor) + 60_000, "reconnect-gap");

        await connectAndSettle(d);

        assert.ok(getMessageById(survivor), "what the queue still held must be stored");
        // Red if evict is ignored and full coverage is claimed (M2).
        assert.deepEqual(pending(), [
            { fromTs: tsOf(g1) + 1_000, toTs: tsOf(survivor), reason: "queue-evicted:511_1" },
        ]);
    });

    it("(c) a queue that does not answer leaves every gap exactly as it was", async () => {
        const d = daemon({ respond: scripted({ 510: [null] }) });
        const g1 = nextId();
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");
        const before = getPendingSyncGaps();

        await connectAndSettle(d);

        // Red if one drained queue is taken as coverage for the account.
        assert.deepEqual(getPendingSyncGaps(), before);
        assert.ok(d.logs.some((l) => /510_1/.test(l) && /zalo-agent sync --from/.test(l)));
    });

    it("(c) it pages on `more` from lastActionId, and claims coverage only once a queue is drained", async () => {
        const g1 = nextId();
        const a = nextId();
        const b = nextId();
        const respond = scripted({ 511: [page(511, [row(a)], { more: 1, lastActionId: a }), page(511, [row(b)])] });
        const d = daemon({ respond });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(b) + 5_000, "reconnect-gap");

        await connectAndSettle(d);

        const asked = queueRequests(d.listener).filter((p) => p.cmd === 511);
        assert.deepEqual(
            asked.map((p) => [p.data.first, p.data.lastId]),
            [
                [true, g1],
                [false, a],
            ],
            "the second page continues from the first page's lastActionId, first:false",
        );
        assert.ok(getMessageById(a) && getMessageById(b));
        assert.deepEqual(pending(), []);
    });

    it("(c) a queue still saying `more` at the page cap is not coverage", async () => {
        const g1 = nextId();
        const pages = [];
        for (let i = 0; i < 6; i++) {
            const id = nextId();
            pages.push(page(511, [row(id)], { more: 1, lastActionId: id }));
        }
        const d = daemon({ respond: scripted({ 511: pages }) });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");
        const before = getPendingSyncGaps();

        await connectAndSettle(d);

        assert.equal(queueRequests(d.listener).filter((p) => p.cmd === 511).length, 4, "maxPages is the runaway stop");
        assert.deepEqual(getPendingSyncGaps(), before, "a truncated drain claimed coverage");
    });

    it("(c) a queue answering with messages from before the cursor is not taken as coverage", async () => {
        // The web's own use says lastId means "after this"; an answer that
        // contradicts it cannot vouch for the window after the cursor either.
        const older = nextId();
        const g1 = nextId();
        const d = daemon({ respond: scripted({ 511: [page(511, [row(older)])] }) });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");
        const before = getPendingSyncGaps();

        await connectAndSettle(d);

        assert.ok(getMessageById(older), "what came back is still stored, insert-if-absent");
        assert.deepEqual(getPendingSyncGaps(), before, "an out-of-order answer claimed coverage");
        assert.ok(d.logs.some((l) => /before the cursor/.test(l)));
    });

    it("(c) only the answer to its own request counts -- another reader's page on the same cmd is ignored", async () => {
        // zalo_get_history pages the same 510/511 stream through zca-js, outside
        // the stage lock, and its answers carry no reqId of ours. Taking one as
        // a queue page would store the wrong rows and claim coverage from them.
        const foreign = nextId();
        const g1 = nextId();
        const answers = scripted();
        const respond = (payload, listener) => {
            if (payload.cmd === 511) listener.push(511, 1, page(511, [row(foreign)], { lastActionId: foreign }));
            return answers(payload);
        };
        const d = daemon({ respond });
        live(d.listener, row(g1));

        await connectAndSettle(d);

        assert.equal(getMessageById(foreign), null, "a page answering someone else was taken as the queue's");
        assert.equal(d.heal.cursor("511_1").id, g1, "the cursor moved on someone else's page");
    });

    it("(d) no phone-backed request is ever sent -- no cmd 590/592 and no HTTP at all", async () => {
        const g1 = nextId();
        const d = daemon({ respond: scripted({ 511: [page(511, [row(nextId())], { evict: 1 })] }) });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) - 60_000, tsOf(g1) + 60_000, "startup-gap");

        await connectAndSettle(d);
        d.listener.reconnect();
        await connectAndSettle(d);

        // Red if a remainder or an eviction ever reaches for the phone restore.
        const cmds = [...new Set(d.listener.sent.map((p) => p.cmd))].sort();
        assert.deepEqual(cmds, [510, 511]);
        assert.deepEqual(httpCalls, []);
        assert.ok(getPendingSyncGaps().length > 0, "this scenario must leave work for `sync`, or it proves nothing");
    });

    it("(e) it waits behind a running sync stage, and a stage is refused while it runs", async () => {
        const accountDir = join(ROOT, `acct${dbSeq}`);
        mkdirSync(accountDir, { recursive: true });
        const order = [];
        let open;
        const gate = new Promise((r) => (open = r));
        let entered;
        const inStage = new Promise((r) => (entered = r));
        const lock = createStageLock();

        let hold = false;
        const answers = scripted();
        const respond = (payload) => (hold ? null : answers(payload));
        const d = daemon({ lock, respond });
        live(d.listener, row(nextId()));
        const wrapped = d.listener.sendWs;
        d.listener.sendWs = (p) => {
            order.push(`send ${p.cmd}`);
            wrapped(p);
        };
        const channel = await startDaemonChannel({
            getApi: () => d.api,
            accountDir,
            lock,
            runners: {
                messages: async () => {
                    entered();
                    await gate;
                    order.push("stage done");
                    return { messagesSaved: 0 };
                },
            },
        });
        try {
            const stage = syncViaDaemon(accountDir, { stage: "messages" });
            await inStage;
            d.listener.auth({ qCmds: QCMDS });
            await sleep(60);
            // Red if the catch-up shares the socket with a running stage.
            assert.deepEqual(order, [], "the catch-up started beside a running stage");

            open();
            assert.equal((await stage).ok, true);
            await d.heal.settled();
            assert.deepEqual(order, ["stage done", "send 510", "send 511"]);

            // The other direction: a stage arriving mid-catch-up is refused, named.
            hold = true;
            d.listener.reconnect();
            d.listener.auth({ qCmds: QCMDS });
            await sleep(10);
            const refused = await syncViaDaemon(accountDir, { stage: "messages" });
            assert.equal(refused.status, 409);
            assert.equal(refused.busyStage, "self-heal");
            await d.heal.settled();
        } finally {
            channel.stop();
        }
    });

    it("with --no-self-heal it asks nothing and writes nothing", async () => {
        const d = daemon({ enabled: false });
        const g1 = nextId();
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");

        d.listener.reconnect();
        await connectAndSettle(d);

        // Red if the opt-out is ignored anywhere: a request, a cursor, a gap touched.
        assert.deepEqual(d.listener.sent, []);
        assert.equal(getSyncState("offlineCursor:511_1"), null);
        assert.equal(getPendingSyncGaps().length, 1);
    });
});

describe("M2: the server saying it dropped or reset a queue is a gap, not coverage", () => {
    it("a live push reporting evict records the window the queue lost", async () => {
        const d = daemon();
        const g1 = nextId();
        live(d.listener, row(g1));
        await connectAndSettle(d);
        assert.deepEqual(pending(), []);

        const after = nextId();
        d.listener.push(521, 0, page(511, [row(after)], { evict: 1 }));
        await sleep(0);

        // Red if a live evict is ignored: we would go on claiming coverage.
        assert.deepEqual(pending(), [{ fromTs: tsOf(g1), toTs: tsOf(after), reason: "queue-evicted:511_1" }]);
    });

    it("resetLastActionId moves the cursor and leaves the gap pending", async () => {
        const g1 = nextId();
        const resetTo = nextId();
        const d = daemon({
            respond: scripted({ 511: [page(511, [], { extra: { resetLastActionId: resetTo } })] }),
        });
        live(d.listener, row(g1));
        recordSyncGap(tsOf(g1) + 5_000, tsOf(g1) + 60_000, "reconnect-gap");

        await connectAndSettle(d);

        assert.equal(JSON.parse(getSyncState("offlineCursor:511_1")).id, resetTo);
        assert.ok(
            getPendingSyncGaps().some((g) => g.reason === "reconnect-gap" || g.reason.startsWith("queue-reset")),
            "a reset queue cannot vouch for the window it was asked about",
        );
    });
});
