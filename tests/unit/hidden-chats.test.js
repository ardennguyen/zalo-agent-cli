/**
 * Hidden chats (src/core/hidden-chats.js) and the deployment policy around them (src/core/deploy-policy.js).
 *
 * What each test would need to change to go red:
 * - policy: the precedence (per-account env, env, config, default) or the default `exclude`;
 * - the set: a thread Zalo lists as hidden not being hidden, or the PIN hash reaching the mirror file or any output;
 * - the PIN check: a wrong PIN accepted, the 7th wrong PIN not waiting, a right PIN during the back-off accepted;
 * - the views: a hidden thread in an `exclude` list or event, a contentless event carrying a thread id or content;
 * - the 601 controls: `reset` not clearing, `change_pin` not taking the new hash.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { HIDDEN_CHAT_MODES, resolveAllowPinArgument, resolveHiddenChats } from "../../src/core/deploy-policy.js";
import {
    HiddenChats,
    PIN_FREE_TRIES,
    attachHiddenChatControls,
    effectiveHiddenMode,
    hiddenEventView,
    hiddenKey,
    pinBackoffMs,
    withoutHidden,
} from "../../src/core/hidden-chats.js";
import { changeHiddenPin, resetHiddenPinAndDelete } from "../../src/core/hidden-chat-actions.js";
import { readControls } from "../../src/zalo/queues/control-queue.js";

const ACCOUNT = "1000000000000000001";
const HIDDEN_DM = "1000000000000000002";
const HIDDEN_GROUP = "1000000000000000003";
const VISIBLE = "1000000000000000004";
/** md5 of a test PIN; computed, so no PIN hash is a literal anywhere a reader could mistake for a real one. */
const md5 = (pin) => createHash("md5").update(pin).digest("hex");
const TEST_PIN = "2580";
const RAW = {
    pin: md5(TEST_PIN),
    threads: [
        { thread_id: HIDDEN_DM, is_group: 0 },
        { thread_id: HIDDEN_GROUP, is_group: 1 },
    ],
};

let dir;
before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    dir = mkdtempSync(join(tmpdir(), "zalo-hidden-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("the deployment policy", () => {
    it("hiddenChats: per-account env, then env, then config, then exclude", () => {
        assert.deepEqual(resolveHiddenChats({ env: {} }), { mode: "exclude", source: "default" });
        assert.deepEqual(HIDDEN_CHAT_MODES, ["exclude", "contentless", "include"]);
        const config = { hiddenChats: "contentless" };
        assert.equal(resolveHiddenChats({ config, env: {} }).mode, "contentless");
        assert.equal(resolveHiddenChats({ config, env: { ZALO_MCP_HIDDEN_CHATS: "include" } }).mode, "include");
        const env = { ZALO_MCP_HIDDEN_CHATS: "include", [`ZALO_MCP_HIDDEN_CHATS_${ACCOUNT}`]: "Exclude" };
        assert.deepEqual(resolveHiddenChats({ config, env, accountId: ACCOUNT }), {
            mode: "exclude",
            source: `ZALO_MCP_HIDDEN_CHATS_${ACCOUNT}`,
        });
        assert.equal(resolveHiddenChats({ config: { hiddenChats: "everything" }, env: {} }).mode, "exclude");
    });

    it("allowPinArgument: false unless a layer says true", () => {
        assert.deepEqual(resolveAllowPinArgument({ env: {} }), { allowed: false, source: "default" });
        assert.equal(resolveAllowPinArgument({ config: { allowPinArgument: true }, env: {} }).allowed, true);
        assert.equal(
            resolveAllowPinArgument({ config: { allowPinArgument: true }, env: { ZALO_MCP_ALLOW_PIN_ARGUMENT: "0" } })
                .allowed,
            false,
        );
        assert.equal(
            resolveAllowPinArgument({
                env: { ZALO_MCP_ALLOW_PIN_ARGUMENT: "no", [`ZALO_MCP_ALLOW_PIN_ARGUMENT_${ACCOUNT}`]: "yes" },
                accountId: ACCOUNT,
            }).allowed,
            true,
        );
        assert.equal(resolveAllowPinArgument({ config: { allowPinArgument: "maybe" }, env: {} }).allowed, false);
    });
});

describe("the hidden set", () => {
    it("takes Zalo's list, normalizes ids, and keeps the PIN hash out of the mirror file", () => {
        const set = new HiddenChats({ accountId: ACCOUNT, stateDir: dir }).setFromServer(RAW);
        assert.equal(set.isHidden(HIDDEN_DM), true);
        assert.equal(set.isHidden(`g${HIDDEN_GROUP}`), true, "a g-prefixed id is the same group");
        assert.equal(set.isHidden(VISIBLE), false);
        assert.equal(set.hasPin, true);
        assert.equal(hiddenKey(`u${HIDDEN_DM}`), HIDDEN_DM);
        for (const f of readdirSync(dir)) {
            assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), new RegExp(RAW.pin), `${f} holds no PIN hash`);
        }
        assert.doesNotMatch(JSON.stringify(set), new RegExp(RAW.pin), "nor does the object's JSON");
        // A command with no session reads the ids back from the mirror.
        const again = new HiddenChats({ accountId: ACCOUNT, stateDir: dir });
        assert.equal(again.known, true);
        assert.equal(again.isHidden(HIDDEN_GROUP), true);
        assert.equal(again.verifyPin(TEST_PIN).reason, "no-pin", "the mirror has no hash to check a PIN against");
    });

    it("threads(): each hidden conversation with its kind", () => {
        const set = new HiddenChats().setFromServer(RAW);
        assert.deepEqual(set.threads(RAW), [
            { threadId: HIDDEN_DM, isGroup: false },
            { threadId: HIDDEN_GROUP, isGroup: true },
        ]);
    });
});

describe("the PIN check and its lockout", () => {
    it("a right PIN passes; a wrong one counts; the 7th wrong waits a growing back-off; a success resets", () => {
        let now = 1_000_000;
        const set = new HiddenChats({ stateDir: mkdtempSync(join(dir, "lock-")), now: () => now }).setFromServer(RAW);
        assert.deepEqual(set.verifyPin(TEST_PIN), { ok: true });
        assert.equal(set.verifyPin("12a4").reason, "shape");
        for (let i = 1; i < PIN_FREE_TRIES; i++) {
            const r = set.verifyPin("0000");
            assert.deepEqual([r.ok, r.reason, r.failures, r.retryAfterMs], [false, "wrong", i, 0]);
        }
        const sixth = set.verifyPin("0000");
        assert.equal(sixth.failures, PIN_FREE_TRIES);
        assert.equal(sixth.retryAfterMs, pinBackoffMs(PIN_FREE_TRIES));
        // Locked: even the right PIN is not checked until the wait is over.
        assert.equal(set.verifyPin(TEST_PIN).reason, "locked");
        now += pinBackoffMs(PIN_FREE_TRIES);
        const seventh = set.verifyPin("0000");
        assert.equal(seventh.retryAfterMs, 2 * pinBackoffMs(PIN_FREE_TRIES), "the back-off grows");
        now += seventh.retryAfterMs;
        assert.deepEqual(set.verifyPin(TEST_PIN), { ok: true });
        assert.equal(set.lockoutStatus().failures, 0);
    });

    it("the lockout state file holds counts and times only", () => {
        const stateDir = mkdtempSync(join(dir, "lockfile-"));
        const set = new HiddenChats({ stateDir }).setFromServer(RAW);
        set.verifyPin("1111");
        const state = JSON.parse(readFileSync(join(stateDir, "hidden-pin-lockout.json"), "utf8"));
        assert.deepEqual(Object.keys(state).sort(), ["failures", "lastFailureAt"]);
        assert.doesNotMatch(JSON.stringify(state), /1111/);
    });
});

describe("the views", () => {
    const set = new HiddenChats().setFromServer(RAW);
    const rows = [{ threadId: HIDDEN_DM }, { threadId: VISIBLE }, { threadId: HIDDEN_GROUP }];

    it("a list: exclude and contentless leave hidden threads out; include keeps them", () => {
        assert.deepEqual(withoutHidden(rows, set, "exclude"), [{ threadId: VISIBLE }]);
        assert.deepEqual(withoutHidden(rows, set, "contentless"), [{ threadId: VISIBLE }]);
        assert.deepEqual(withoutHidden(rows, set, "include"), rows);
        assert.equal(effectiveHiddenMode("exclude", true), "include", "an unlock includes for that one call");
    });

    it("an event: dropped, contentless with no id or content, or unchanged", () => {
        const msg = { event: "message", threadId: HIDDEN_DM, senderId: HIDDEN_DM, text: "secret", _cursor: 7 };
        assert.equal(hiddenEventView(msg, set, "exclude"), null);
        const dot = hiddenEventView(msg, set, "contentless");
        assert.deepEqual(dot, { event: "message", hidden: true, _cursor: 7 });
        assert.doesNotMatch(JSON.stringify(dot), new RegExp(`${HIDDEN_DM}|secret`));
        assert.equal(hiddenEventView(msg, set, "include"), msg);
        const visible = { ...msg, threadId: VISIBLE };
        assert.equal(hiddenEventView(visible, set, "exclude"), visible);
    });
});

describe("the 601 hidden_chat controls", () => {
    /** A socket tap stand-in: `fire` delivers one 601 frame. */
    function tap() {
        const subs = [];
        return {
            on: (cmd, fn) => (subs.push([cmd, fn]), () => {}),
            fire: (data) => subs.forEach(([, fn]) => fn({ data })),
        };
    }
    const control = (act, data = {}) => ({
        controls: [{ actionId: "1", content: { act_type: "hidden_chat", act, data: JSON.stringify(data) } }],
    });

    it("hidden_chat is a known act; reset clears; change_pin takes the new hash; add_remove refetches", async () => {
        assert.equal(readControls(control("reset"))[0].handled, true);
        const set = new HiddenChats().setFromServer(RAW);
        const fetched = [];
        const api = {
            getHiddenConversations: async () => {
                fetched.push(1);
                return RAW;
            },
        };
        const t = tap();
        attachHiddenChatControls({ tap: t, set, getApi: () => api, readControls });
        t.fire(control("change_pin", { pin: md5("9999") }));
        assert.equal(set.verifyPin("9999").ok, true, "the new hash is used at once");
        await new Promise((r) => setImmediate(r));
        set.setFromServer({ threads: RAW.threads, pin: md5("9999") });
        t.fire(control("reset"));
        assert.equal(set.isHidden(HIDDEN_DM), false);
        assert.equal(set.hasPin, false);
        fetched.length = 0;
        t.fire(control("add_remove"));
        await new Promise((r) => setImmediate(r));
        assert.ok(fetched.length >= 1, "the list was read again");
    });
});

describe("the hidden-chat actions", () => {
    it("changing the PIN checks the current one and the repeat, sends only on success, and holds no PIN", async () => {
        const sent = [];
        const api = { updateHiddenConversPin: async (pin) => sent.push(pin) };
        const set = new HiddenChats().setFromServer(RAW);
        assert.equal((await changeHiddenPin(api, set, { pin: "0000", newPin: "1357", newPin2: "1357" })).ok, false);
        assert.equal((await changeHiddenPin(api, set, { pin: TEST_PIN, newPin: "1357", newPin2: "1358" })).ok, false);
        assert.equal((await changeHiddenPin(api, set, { pin: TEST_PIN, newPin: "13a7", newPin2: "13a7" })).ok, false);
        assert.equal(sent.length, 0, "nothing sent on a refusal");
        const ok = await changeHiddenPin(api, set, { pin: TEST_PIN, newPin: "1357", newPin2: "1357" });
        assert.deepEqual(ok, { ok: true, hadPin: true });
        assert.equal(sent.length, 1);
        assert.equal(set.verifyPin("1357").ok, true, "the new PIN checks at once");
        assert.doesNotMatch(JSON.stringify(ok), /1357/);
    });

    it("removing the PIN lists the hidden chats, resets, then deletes each and reports it", async () => {
        const calls = [];
        const api = {
            getHiddenConversations: async () => RAW,
            resetHiddenConversPin: async () => calls.push(["reset"]),
            deleteChat: async (anchor, threadId, type) => calls.push(["delete", threadId, type]),
            // The group store answers the group's anchor; the DM has no cached message.
            getContext: () => ({}),
        };
        const set = new HiddenChats();
        const r = await resetHiddenPinAndDelete(api, set);
        assert.equal(calls[0][0], "reset", "the PIN goes first");
        assert.equal(r.reset, true);
        assert.equal(r.conversations.length, 2);
        assert.deepEqual(
            r.conversations.map((c) => [c.threadId, c.threadType]),
            [
                [HIDDEN_DM, "dm"],
                [HIDDEN_GROUP, "group"],
            ],
        );
        for (const c of r.conversations) assert.ok(c.deleted || c.error, "each one is reported");
        assert.equal(set.hasPin, false);
        assert.equal(set.isHidden(HIDDEN_DM), false);
    });
});
