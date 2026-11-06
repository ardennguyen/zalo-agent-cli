/**
 * Two things `listen` and `mcp start` must do now that our listener announces every chat push (design 6.1 items 7
 * and FX 11, 12):
 *
 * - A message Zalo re-sends (534) is announced once. Self-heal stores it from the raw tap and hands it on; the
 *   listener then announces the same message as `message`. Without `selfHeal.isRepeatedRepush` a webhook receiver
 *   got it twice, and a message that already came live (501) and was re-sent got a second webhook too.
 * - An end-to-end encrypted message this client cannot read is counted, and named in the log once.
 *
 * The behavior runs through the real pieces: our listener over a real WebSocket to the fake Zalo socket, the real
 * socket tap, the real self-heal and writers on a real zalo.db, with a message handler wired the way both daemons
 * wire theirs. The part that lives inside two action handlers needing a live login (that both daemons call the two
 * guards, in that place) is read from their syntax trees, as self-heal-wiring.test.js does. Every id is fake.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getMessageById, initDb } from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { createSocketTap } from "../../src/core/socket-tap.js";
import { createSelfHeal } from "../../src/core/self-heal.js";
import { createUndecryptableNotice } from "../../src/core/e2ee-notice.js";
import { createSession } from "../../src/zalo/kernel/session.js";
import { loadJar } from "../../src/zalo/kernel/cookies.js";
import { API_TYPE, DEFAULT_API_VERSION } from "../../src/zalo/profile.js";
import { createListener } from "../../src/zalo/listener/listener.js";
import { startFakeSocket } from "../helpers/fake-zalo/socket.js";
import { ok } from "../helpers/fake-zalo/frames.js";
import { walkAst } from "../helpers/zca-call-sites.js";

// Fake ids (tests/unit/no-real-ids.test.js): past 2^53 where an id would be.
const OWN = "1000000000000000071";
const PEER = "2000000000000000072";
const GROUP = "3000000000000000073";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-repush-"));
let dbSeq = 0;
let idSeq = 0;
/** A msgId no other case uses. */
const nextId = () => String(5_000_000_000_000_000_700n + BigInt(++idSeq));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` is truthy, or fail after `ms`. */
async function until(pred, what, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await sleep(5);
    }
    assert.fail(`timed out waiting for ${what}`);
}

/** A 1-1 message as 501 and 534 carry it. */
const dm = (msgId, extra = {}) => ({
    actionId: msgId,
    msgId,
    cliMsgId: "1700000000071",
    uidFrom: PEER,
    idTo: "0",
    dName: "Fake Peer",
    ts: "1700000000000",
    msgType: "webchat",
    content: `hello ${msgId.slice(-3)}`,
    ...extra,
});

/** A group message as 521 and 552 carry it. */
const gm = (msgId, extra = {}) => dm(msgId, { idTo: GROUP, ...extra });

let rigs = [];

/**
 * A daemon's message path, minus the command around it: our listener on a fake socket, the tap and self-heal
 * attached after the storing handler, and that handler doing what `listen`/`mcp start` do with each message --
 * skip a repeated re-push, count an undecryptable one, announce and store the rest. `announced` is what a webhook
 * receiver would get: the handler's announcements plus self-heal's recovered ones.
 *
 * @param {{enabled?: boolean}} [o] - self-heal on (default) or off (`--no-self-heal`)
 */
async function daemon({ enabled = true } = {}) {
    const sock = await startFakeSocket();
    const ctx = createSession({ apiType: API_TYPE, apiVersion: DEFAULT_API_VERSION, selfListen: true });
    ctx.cookie = loadJar([{ key: "zpw_sek", value: "fake-sek-71", domain: "chat.zalo.me", path: "/" }]);
    ctx.userAgent = UA;
    ctx.uid = OWN;
    ctx.settings = { features: { socket: { ping_interval: 60000 } } };
    const listener = createListener(ctx, [sock.url]);
    listener.on("error", () => {});
    const api = { listener, getOwnId: () => OWN, getContext: () => ctx };
    const tap = createSocketTap({ log: () => {} });
    const announced = [];
    const logs = [];
    const undecryptable = createUndecryptableNotice({ log: (line) => logs.push(line) });
    const heal = createSelfHeal({
        getApi: () => api,
        tap,
        enabled,
        log: () => {},
        onRecovered: (items) => announced.push(...items.map(({ msg }) => ({ msgId: msg.data.msgId, catchUp: true }))),
        timeoutMs: 50,
        maxPages: 1,
    });
    let handled = 0;
    listener.on("message", (msg) => {
        handled++;
        if (heal.isRepeatedRepush(msg)) return;
        undecryptable.note(msg);
        announced.push({ msgId: msg.data.msgId, catchUp: false });
        storeLiveMessage(msg);
    });
    tap.attach(listener);
    heal.attach(listener);
    const keyed = once(listener, "cipher_key");
    listener.start();
    await keyed;
    await heal.settled();
    const r = { sock, listener, heal, announced, logs, undecryptable, handled: () => handled };
    rigs.push(r);
    return r;
}

before(() => assertSandboxed(CONFIG_DIR));

beforeEach(() => {
    initDb(join(ROOT, `db${dbSeq++}.sqlite`));
});

afterEach(async () => {
    for (const r of rigs) {
        try {
            r.listener.stop();
        } catch {
            /* already stopped */
        }
        await r.heal.settled();
        await r.sock.close();
    }
    rigs = [];
});

describe("a message Zalo re-sends (534) reaches the webhook once", () => {
    for (const enabled of [true, false]) {
        const mode = enabled ? "self-heal on" : "self-heal off";

        it(`${mode}: 501 then 534 of the same message is one announcement`, async () => {
            const d = await daemon({ enabled });
            const id = nextId();
            d.sock.push(501, 0, ok({ msgs: [dm(id)] }));
            await until(() => d.handled() === 1, "the live message");
            assert.ok(getMessageById(id), "the live message is stored");
            d.sock.push(534, 0, ok({ msgs: [dm(id)] }));
            await until(() => d.handled() === 2, "the re-sent message's event");
            await sleep(20);
            // Red without isRepeatedRepush: the re-push is announced (and posted) a second time.
            assert.deepEqual(d.announced, [{ msgId: id, catchUp: false }]);
        });

        it(`${mode}: a 534 of a message never seen is announced once, and stored`, async () => {
            const d = await daemon({ enabled });
            const id = nextId();
            d.sock.push(534, 0, ok({ groupMsgs: [gm(id)] }));
            await until(() => d.handled() === 1, "the re-sent message's event");
            await sleep(20);
            assert.ok(getMessageById(id), "the re-sent message is stored");
            // With self-heal on it is announced as recovered (stored from the tap first); off, as a live message.
            assert.deepEqual(d.announced, [{ msgId: id, catchUp: enabled }]);
        });
    }

    it("a 501 of an already stored message is still announced: only a re-push is skipped", async () => {
        const d = await daemon();
        const id = nextId();
        d.sock.push(501, 0, ok({ msgs: [dm(id)] }));
        await until(() => d.handled() === 1, "the first copy");
        d.sock.push(501, 0, ok({ msgs: [dm(id)] }));
        await until(() => d.handled() === 2, "the second copy");
        // Red if the guard skipped every stored message rather than re-pushes alone.
        assert.equal(d.announced.length, 2);
    });
});

describe("an end-to-end encrypted message this client cannot read", () => {
    it("two of them in two frames: both counted, one log line", async () => {
        const d = await daemon();
        d.sock.push(551, 0, ok({ msgs: [dm(nextId(), { msgType: "chat.e2ee.text", content: "fake-ciphertext" })] }));
        d.sock.push(552, 0, ok({ groupMsgs: [gm(nextId(), { msgType: "chat.e2ee.text", content: "fake-cipher" })] }));
        d.sock.push(501, 0, ok({ msgs: [dm(nextId())] }));
        await until(() => d.handled() === 3, "three messages");
        assert.equal(d.undecryptable.count(), 2);
        // Red if every undecryptable message logs (two lines), or none does.
        assert.equal(d.logs.length, 1);
        assert.match(d.logs[0], /end-to-end encrypted/);
        assert.doesNotMatch(d.logs[0], /\d{12,}/, "the line names no id");
    });

    it("note() answers whether a message was undecryptable, and counts nothing else", () => {
        const logs = [];
        const n = createUndecryptableNotice({ log: (l) => logs.push(l) });
        assert.equal(n.note({ data: { msgId: "1", content: "plain" } }), false);
        assert.equal(n.note({ data: { msgId: "2", undecryptable: true, content: "" } }), true);
        assert.equal(n.note(null), false);
        assert.equal(n.count(), 1);
        assert.equal(logs.length, 1);
    });
});

describe("both daemons call the two guards first in their message handler", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    const DAEMONS = [
        { file: "listen.js", attachFn: "attachAllHandlers" },
        { file: "mcp.js", attachFn: "attachListenerHandlers" },
    ];

    /** The source of a node. */
    const text = (src, n) => src.slice(n.start, n.end);

    for (const { file, attachFn } of DAEMONS) {
        it(`${file}: isRepeatedRepush first, then the undecryptable count, before anything is announced or stored`, () => {
            const src = readFileSync(join(SRC, file), "utf8");
            const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
            let attach = null;
            walkAst(ast, (n) => {
                if (n.type === "FunctionDeclaration" && n.id?.name === attachFn) attach = n;
            });
            assert.ok(attach, `${attachFn} not found: this guard has drifted`);
            let handler = null;
            walkAst(attach, (n) => {
                if (
                    !handler &&
                    n.type === "CallExpression" &&
                    n.callee?.property?.name === "on" &&
                    n.callee.object?.property?.name === "listener" &&
                    n.arguments[0]?.value === "message"
                ) {
                    handler = n.arguments[1];
                }
            });
            assert.ok(handler, `${file}: no listener.on("message") in ${attachFn}`);
            const body = handler.body.body;
            // Red if the guard is missing, or comes after the handler announced or stored the message.
            assert.match(text(src, body[0]), /^if \(selfHeal\.isRepeatedRepush\(msg\)\)/);
            assert.match(text(src, body[1]), /^undecryptable\.note\(msg\);$/);
            // One notice per daemon, built outside the function a re-login calls again (else it logs once per login).
            assert.doesNotMatch(text(src, attach), /createUndecryptableNotice/);
            assert.match(src, /const undecryptable = createUndecryptableNotice\(/);
        });
    }
});
