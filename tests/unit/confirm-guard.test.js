/**
 * The one confirmation guard (src/core/confirm-guard.js): what it says, how the CLI settles a guarded command
 * (exit 2 unconfirmed, exit 0 for a dry run), every guarded CLI command wired to it, and the MCP confirm modes,
 * including `human` with and without a client that can be asked.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    CONFIRM_EXIT_CODE,
    GUARDS,
    confirmationRefusal,
    describeGuarded,
    dryRunReport,
    enforceCliGuard,
    gateCli,
    gateMcp,
    refusalLine,
    removedLabels,
    resolveConfirmMode,
} from "../../src/core/confirm-guard.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { registerFriendCommands } from "../../src/commands/friend.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { registerPollCommands } from "../../src/commands/poll.js";
import { registerReminderCommands } from "../../src/commands/reminder.js";
import { registerCatalogCommands } from "../../src/commands/catalog.js";
import { registerBankCommands } from "../../src/commands/bank.js";
import { registerAutoReplyCommands } from "../../src/commands/auto-reply.js";
import { registerQuickMsgCommands } from "../../src/commands/quick-msg.js";
import { registerProfileCommands } from "../../src/commands/profile.js";
import { registerAccountCommands } from "../../src/commands/account.js";
import { registerLoginCommands } from "../../src/commands/login.js";
import { registerLabelCommands } from "../../src/commands/label.js";
import { registerMCPWebhookCommands } from "../../src/commands/mcp-webhook.js";
import { SecurePage } from "../../src/core/secure-page.js";

const G = "7000000000000000001";
const U = "9100000000000000001";

/** Run `fn` with process.exit and console.log captured; process.exit throws so nothing after it runs. */
async function captured(fn) {
    const out = [];
    const realExit = process.exit;
    const realLog = console.log;
    let code = null;
    process.exit = (c) => {
        code = c ?? 0;
        throw new Error("__exit__");
    };
    console.log = (...a) => out.push(a.join(" "));
    let returned;
    const savedExitCode = process.exitCode;
    try {
        returned = await fn();
    } catch (e) {
        if (e.message !== "__exit__") throw e;
    } finally {
        process.exit = realExit;
        console.log = realLog;
        // error() sets 1; it must not become the test process's exit code.
        process.exitCode = savedExitCode;
    }
    return { code, out: out.join("\n"), returned };
}

/** One target with every field some guarded action reads. */
const SAMPLE_TARGET = {
    groupId: G,
    userIds: [U],
    userId: U,
    msgId: "5",
    threadId: G,
    threadIds: [G],
    pollId: "42",
    reminderId: "7",
    catalogId: "3",
    productIds: ["4"],
    bankAccountId: "1",
    autoReplyId: "1",
    quickMessageIds: ["1"],
    photoIds: ["1"],
    ownerId: U,
    name: "topic-remove",
    risk: "destructive",
};

describe("what the guard says", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    it("every guarded action finishes the sentence and says whether it can be taken back", () => {
        for (const key of Object.keys(GUARDS)) {
            const d = describeGuarded(key, SAMPLE_TARGET);
            assert.equal(typeof d.wouldDo, "string", key);
            assert.ok(d.wouldDo.length > 5, key);
            assert.doesNotMatch(d.wouldDo, /undefined/, key);
            assert.equal(typeof d.irreversible, "boolean", key);
            assert.ok(d.action, key);
        }
    });

    it("the refusal keeps `error` first and carries the fields a script reads", () => {
        const cli = confirmationRefusal("group.leave", { groupId: G });
        assert.deepEqual(Object.keys(cli), [
            "error",
            "confirmationRequired",
            "action",
            "wouldDo",
            "target",
            "irreversible",
            "retryWith",
        ]);
        assert.equal(cli.error, `Not done: confirmation needed: leave group ${G}`);
        assert.equal(cli.action, "group leave");
        assert.equal(cli.retryWith, "--yes");
        assert.equal(cli.irreversible, true);
        const mcp = confirmationRefusal("group.leave", { groupId: G }, "mcp");
        assert.equal(mcp.action, "zalo_group leave");
        assert.deepEqual(mcp.retryWith, { confirm: true });
    });

    it("the line a person reads names what would happen, that it is final, and both ways forward", () => {
        assert.equal(
            refusalLine("msg.undo", { msgId: "5", threadId: G }),
            `Not done: this would recall message 5 for everyone in conversation ${G} — this cannot be undone. ` +
                "Re-run with --yes, or --dry-run to preview.",
        );
        assert.match(refusalLine("friend.block", { userId: U }, "mcp"), /confirm: true, or dryRun: true/);
        assert.doesNotMatch(refusalLine("friend.block", { userId: U }), /cannot be undone/);
    });

    it("a long id list is shortened to five and a count", () => {
        const many = Array.from({ length: 8 }, (_, i) => String(9100000000000000001n + BigInt(i)));
        const d = describeGuarded("group.removeMember", { groupId: G, userIds: many });
        assert.match(d.wouldDo, /^remove 8 members \(.* and 3 more\) from group/);
    });

    it("label update is final only when it removes a label", () => {
        assert.equal(describeGuarded("label.update", { removedLabels: ["1 (A)"] }).irreversible, true);
        assert.equal(describeGuarded("label.update", { removedLabels: [] }).irreversible, false);
    });

    it("removedLabels: the labels whose id the new list leaves out", () => {
        const now = [{ id: 1, text: "Work" }, { id: 2, text: "Family" }, { id: 3 }];
        assert.deepEqual(removedLabels(now, [{ id: 1 }, { id: "2" }]), ["3"]);
        assert.deepEqual(removedLabels(now, [{ id: 3 }]), ["1 (Work)", "2 (Family)"]);
        assert.deepEqual(removedLabels(now, [...now, { id: 4 }]), []);
        assert.deepEqual(removedLabels(null, undefined), []);
    });
});

describe("the CLI guard", () => {
    it("without --yes or --dry-run: the refusal, and exit 2", async () => {
        const human = await captured(() => gateCli("poll.lock", { pollId: "42" }, {}, { json: false }));
        assert.equal(human.code, CONFIRM_EXIT_CODE);
        assert.equal(CONFIRM_EXIT_CODE, 2);
        assert.match(human.out, /✗ Not done: this would close poll 42/);
        const json = await captured(() => gateCli("poll.lock", { pollId: "42" }, {}, { json: true }));
        assert.equal(json.code, 2);
        assert.deepEqual(JSON.parse(json.out), confirmationRefusal("poll.lock", { pollId: "42" }));
    });

    it("--dry-run: the report, and exit 0, even with --yes", async () => {
        const r = await captured(() =>
            gateCli("poll.lock", { pollId: "42" }, { dryRun: true, yes: true }, { json: true }),
        );
        assert.equal(r.code, 0);
        assert.deepEqual(JSON.parse(r.out), dryRunReport("poll.lock", { pollId: "42" }));
        assert.equal(JSON.parse(r.out).sent, false);
    });

    it("--yes goes ahead; so does an invocation that is not the guarded case, and a command's own --dry-run", async () => {
        for (const [opts, how] of [
            [{ yes: true }, {}],
            [{}, { applies: false }],
            [{ dryRun: true }, { ownDryRun: true }],
        ]) {
            const r = await captured(() => gateCli("group.settings", { groupId: G }, opts, how));
            assert.equal(r.code, null, JSON.stringify([opts, how]));
            assert.equal(r.returned, true);
            assert.equal(r.out, "");
        }
    });
});

/** A program with every command group that has a guarded command, checked by the guard as src/index.js does. */
function guardedProgram(ran) {
    const program = new Command();
    program.option("--json").exitOverride();
    program.hook("preAction", (_, cmd) => enforceCliGuard(cmd, { json: true }));
    for (const register of [
        registerGroupCommands,
        registerFriendCommands,
        registerMsgCommands,
        registerConvCommands,
        registerPollCommands,
        registerReminderCommands,
        registerCatalogCommands,
        registerBankCommands,
        registerAutoReplyCommands,
        registerQuickMsgCommands,
        registerProfileCommands,
        registerAccountCommands,
        registerLoginCommands,
        registerLabelCommands,
    ]) {
        register(program);
    }
    const mcp = program.command("mcp");
    registerMCPWebhookCommands(mcp, program);
    // Nothing may reach an action: replace each with a recorder.
    const all = (c) => [c, ...c.commands.flatMap(all)];
    for (const c of all(program)) c.action(() => ran.push(c.name()));
    return program;
}

/** Every guarded CLI command, with arguments it parses. */
const GUARDED_CLI = [
    ["group leave", [G]],
    ["group remove-member", [G, U]],
    ["group remove-admin", [G, U]],
    ["group transfer-owner", [G, U]],
    ["group block-member", [G, U]],
    ["group disable-link", [G]],
    ["group disperse", [G]],
    ["group settings", [G, "--no-join-appr"]],
    ["friend remove", [U]],
    ["friend block", [U]],
    ["friend reject", [U]],
    ["friend undo-request", [U]],
    ["msg undo", ["5", G]],
    ["msg delete", ["5", G, "--everyone"]],
    ["conv delete", [G]],
    ["conv hidden-pin-reset", []],
    ["conv unhide", [G]],
    ["conv forget", [G]],
    ["poll lock", ["42"]],
    ["reminder remove", ["7", G]],
    ["catalog delete", ["3"]],
    ["catalog delete-product", ["3", "4"]],
    ["bank remove", ["1"]],
    ["auto-reply delete", ["1"]],
    ["quick-msg remove", ["1"]],
    ["profile delete-avatar", ["1"]],
    ["account remove", [U]],
    ["logout", []],
    ["mcp webhook purge", ["1"]],
];

describe("every guarded CLI command", () => {
    for (const [name, args] of GUARDED_CLI) {
        it(`${name}: refused with exit 2 before its action; --dry-run exits 0; --yes reaches it`, async () => {
            const ran = [];
            const parse = (extra) =>
                captured(() =>
                    guardedProgram(ran).parseAsync([...name.split(" "), ...args, ...extra], { from: "user" }),
                );
            const refused = await parse([]);
            assert.equal(refused.code, 2, refused.out);
            assert.equal(JSON.parse(refused.out).action, name);
            assert.equal(JSON.parse(refused.out).confirmationRequired, true);
            const dry = await parse(["--dry-run"]);
            if (name === "conv forget") {
                // Its own --dry-run lists what would go, from the local cache: the guard lets it through.
                assert.equal(dry.code, null);
            } else {
                assert.equal(dry.code, 0, dry.out);
                assert.equal(JSON.parse(dry.out).dryRun, true);
            }
            assert.deepEqual(ran, name === "conv forget" ? ["forget"] : [], "nothing ran unconfirmed");
            ran.length = 0;
            const yes = await parse(["--yes"]);
            assert.equal(yes.code, null, yes.out);
            assert.deepEqual(ran, [name.split(" ").at(-1)]);
        });
    }

    it("group settings is asked about only when it turns membership approval off", async () => {
        const ran = [];
        const r = await captured(() =>
            guardedProgram(ran).parseAsync(["group", "settings", G, "--join-appr", "--lock-poll"], { from: "user" }),
        );
        assert.equal(r.code, null);
        assert.deepEqual(ran, ["settings"]);
    });

    it("label update settles itself after reading the labels, so preAction lets it through", async () => {
        const ran = [];
        const r = await captured(() => guardedProgram(ran).parseAsync(["label", "update", "{}"], { from: "user" }));
        assert.equal(r.code, null);
        assert.deepEqual(ran, ["update"]);
    });
});

describe("the MCP confirm mode", () => {
    it("is agent with nothing set", () => {
        assert.deepEqual(resolveConfirmMode({ config: {}, env: {} }), { mode: "agent", source: "default" });
        assert.equal(resolveConfirmMode({ config: { confirmMode: null }, env: {} }).mode, "agent");
    });

    it("reads confirmMode, and ZALO_MCP_CONFIRM_MODE wins over it", () => {
        for (const mode of ["agent", "human", "off"]) {
            assert.equal(resolveConfirmMode({ config: { confirmMode: mode }, env: {} }).mode, mode);
            assert.equal(
                resolveConfirmMode({ config: {}, env: { ZALO_MCP_CONFIRM_MODE: ` ${mode.toUpperCase()} ` } }).mode,
                mode,
            );
        }
        assert.deepEqual(
            resolveConfirmMode({ config: { confirmMode: "off" }, env: { ZALO_MCP_CONFIRM_MODE: "human" } }),
            {
                mode: "human",
                source: "ZALO_MCP_CONFIRM_MODE",
            },
        );
    });

    it("ZALO_MCP_CONFIRM_MODE_<ownId> wins over the plain variable for that account only", () => {
        const env = { ZALO_MCP_CONFIRM_MODE: "agent", ZALO_MCP_CONFIRM_MODE_4242: "off" };
        assert.deepEqual(resolveConfirmMode({ config: {}, env, accountId: "4242" }), {
            mode: "off",
            source: "ZALO_MCP_CONFIRM_MODE_4242",
        });
        assert.equal(resolveConfirmMode({ config: {}, env, accountId: "4343" }).mode, "agent");
        assert.equal(resolveConfirmMode({ config: {}, env }).mode, "agent");
    });

    it("the deprecated groupConfirm aliases mean off (or agent), env first, and an explicit mode wins over both", () => {
        assert.equal(resolveConfirmMode({ config: { groupConfirm: false }, env: {} }).mode, "off");
        assert.equal(resolveConfirmMode({ config: { groupConfirm: true }, env: {} }).mode, "agent");
        assert.equal(resolveConfirmMode({ config: { groupConfirm: "no" }, env: {} }).mode, "agent");
        for (const v of ["0", "false", "OFF", " no "]) {
            assert.equal(resolveConfirmMode({ config: {}, env: { ZALO_MCP_GROUP_CONFIRM: v } }).mode, "off", v);
        }
        assert.equal(
            resolveConfirmMode({ config: { groupConfirm: false }, env: { ZALO_MCP_GROUP_CONFIRM: "1" } }).mode,
            "agent",
            "env alias on beats config alias off",
        );
        assert.equal(
            resolveConfirmMode({ config: { groupConfirm: false, confirmMode: "human" }, env: {} }).mode,
            "human",
        );
        assert.equal(
            resolveConfirmMode({ config: { confirmMode: "agent" }, env: { ZALO_MCP_GROUP_CONFIRM: "0" } }).mode,
            "agent",
            "an explicit confirmMode in the file beats the env alias",
        );
    });

    it("a value that is not a mode is skipped, never read as off", () => {
        assert.equal(resolveConfirmMode({ config: { confirmMode: "maybe" }, env: {} }).mode, "agent");
        assert.equal(
            resolveConfirmMode({ config: { confirmMode: "nope", groupConfirm: false }, env: {} }).mode,
            "off",
            "falls through to the alias",
        );
    });
});

/** An McpServer stand-in whose low-level server can (or cannot) ask the person. */
function askingServer({ capabilities, answer, fail } = {}) {
    const asked = [];
    return {
        asked,
        server: {
            getClientCapabilities: () => capabilities,
            elicitInput: async (params, options) => {
                asked.push({ params, options });
                if (fail) throw new Error(fail);
                return answer;
            },
        },
    };
}

const payload = (r) => JSON.parse(r.content[0].text);
const LEAVE = { groupId: G };

describe("the MCP guard", () => {
    let savedEnv;
    beforeEach(() => {
        savedEnv = { ...process.env };
        delete process.env.ZALO_MCP_CONFIRM_MODE;
        delete process.env.ZALO_MCP_GROUP_CONFIRM;
    });
    afterEach(() => {
        for (const k of ["ZALO_MCP_CONFIRM_MODE", "ZALO_MCP_GROUP_CONFIRM"]) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    it("agent: refused without confirm: true, with the CLI's fields and a line to read", async () => {
        for (const confirm of [undefined, false]) {
            const r = await gateMcp("group.leave", LEAVE, { confirm, config: {} });
            assert.equal(r.isError, true);
            assert.deepEqual(payload(r), confirmationRefusal("group.leave", LEAVE, "mcp"));
            assert.match(r.content[1].text, /^Not done: this would leave group .* Repeat the call with confirm: true/);
        }
        assert.equal(await gateMcp("group.leave", LEAVE, { confirm: true, config: {} }), null);
    });

    it("dryRun: the report, in every mode, and nothing is asked", async () => {
        const srv = askingServer({ capabilities: { elicitation: { form: {} } } });
        for (const confirmMode of ["agent", "human", "off"]) {
            const r = await gateMcp("poll.lock", { pollId: 4 }, { dryRun: true, config: { confirmMode }, server: srv });
            assert.notEqual(r.isError, true);
            assert.deepEqual(payload(r), dryRunReport("poll.lock", { pollId: 4 }, "mcp"));
        }
        assert.equal(srv.asked.length, 0);
    });

    it("off: no question; but an `always` action (zalo_write) still needs confirm", async () => {
        assert.equal(await gateMcp("group.leave", LEAVE, { config: { confirmMode: "off" } }), null);
        assert.equal(await gateMcp("group.leave", LEAVE, { config: { groupConfirm: false } }), null);
        const w = await gateMcp("write.run", { name: "x" }, { config: { confirmMode: "off" }, always: true });
        assert.equal(w.isError, true);
        assert.equal(payload(w).confirmationRequired, true);
        assert.equal(
            await gateMcp("write.run", { name: "x" }, { confirm: true, config: { confirmMode: "off" }, always: true }),
            null,
        );
    });

    it("an invocation that is not the guarded case goes ahead", async () => {
        assert.equal(await gateMcp("label.update", {}, { config: {}, applies: false }), null);
    });

    /** A secure page whose links point at an address nothing listens on: only its tickets are exercised. */
    const testPage = () => new SecurePage().configure({ accountId: "1", localBaseUrl: "http://127.0.0.1:9" });

    it("human, client without elicitation: a one-time approve page, whose approved ticket goes ahead once", async () => {
        for (const server of [undefined, {}, askingServer({ capabilities: {} })]) {
            const securePage = testPage();
            const call = { config: { confirmMode: "human" }, server, accountId: "1", securePage };
            const r = await gateMcp("group.leave", LEAVE, { ...call, confirm: true });
            assert.equal(r.isError, true);
            const p = payload(r);
            assert.equal(p.confirmationRequired, true);
            assert.match(p.secureUrl, /^http:\/\/127\.0\.0\.1:9\/zalo\/secure\//);
            assert.ok(p.retryWith.ticket);
            assert.match(r.content[1].text, /one-time link/);
            // The caller's confirm does not stand in; the person's approval on the page does, once.
            const pending = await gateMcp("group.leave", LEAVE, { ...call, confirm: true, ticket: p.retryWith.ticket });
            assert.equal(payload(pending).ticketRefused, "pending");
            securePage.store.settle(securePage.store.lookup(p.retryWith.ticket).ticket, "approved");
            const wrong = await gateMcp("group.disperse", LEAVE, { ...call, ticket: p.retryWith.ticket });
            assert.equal(payload(wrong).ticketRefused, "action", "a ticket is bound to its action");
            securePage.store.tickets.get(p.retryWith.ticket).status = "approved";
            assert.equal(await gateMcp("group.leave", LEAVE, { ...call, ticket: p.retryWith.ticket }), null);
            const again = await gateMcp("group.leave", LEAVE, { ...call, ticket: p.retryWith.ticket });
            assert.equal(payload(again).ticketRefused, "used");
        }
    });

    it("human, a client with URL-mode elicitation only: it is sent the page and the call waits for it", async () => {
        const securePage = testPage();
        const completed = [];
        const srv = {
            server: {
                getClientCapabilities: () => ({ elicitation: { url: {} } }),
                elicitInput: async (params) => {
                    assert.equal(params.mode, "url");
                    assert.ok(params.elicitationId);
                    // The person opens the link and approves while the call waits.
                    const token = params.url.split("/").pop();
                    setImmediate(() => securePage.store.settle(securePage.store.lookup(token).ticket, "approved"));
                    return { action: "accept" };
                },
                createElicitationCompletionNotifier: (id) => async () => completed.push(id),
            },
        };
        const call = { config: { confirmMode: "human" }, server: srv, accountId: "1", securePage };
        assert.equal(await gateMcp("group.leave", LEAVE, call), null);
        assert.equal(completed.length, 1, "notifications/elicitation/complete was sent");

        const declined = {
            server: { ...srv.server, elicitInput: async () => ({ action: "decline" }) },
        };
        const r = await gateMcp("group.leave", LEAVE, { ...call, server: declined });
        assert.equal(payload(r).declined, true);
    });

    it("human over the stateless HTTP transport: never asks, even a client that could", async () => {
        const srv = askingServer({ capabilities: { elicitation: { form: {}, url: {} } } });
        const r = await gateMcp("group.leave", LEAVE, {
            config: { confirmMode: "human" },
            server: srv,
            stateless: true,
            accountId: "1",
            securePage: testPage(),
        });
        assert.equal(payload(r).statelessTransport, true);
        assert.equal(payload(r).confirmationRequired, true);
        assert.equal(srv.asked.length, 0);
    });

    it("human: only the person's accept and yes goes ahead; the caller's confirm does not stand in", async () => {
        const yes = askingServer({
            capabilities: { elicitation: { form: {} } },
            answer: { action: "accept", content: { confirm: true } },
        });
        assert.equal(
            await gateMcp("group.leave", LEAVE, {
                config: { confirmMode: "human" },
                server: yes,
                extra: { requestId: 9 },
            }),
            null,
        );
        assert.equal(yes.asked.length, 1);
        assert.match(yes.asked[0].params.message, /leave group 7000000000000000001/);
        assert.equal(yes.asked[0].params.requestedSchema.properties.confirm.type, "boolean");
        assert.equal(yes.asked[0].options.relatedRequestId, 9, "the question rides on the tool call's request");

        for (const answer of [
            { action: "accept", content: { confirm: false } },
            { action: "decline" },
            { action: "cancel" },
        ]) {
            const srv = askingServer({ capabilities: { elicitation: { form: {} } }, answer });
            const r = await gateMcp("group.leave", LEAVE, {
                confirm: true,
                config: { confirmMode: "human" },
                server: srv,
            });
            assert.equal(srv.asked.length, 1, "asked even though the caller sent confirm: true");
            assert.equal(r.isError, true, JSON.stringify(answer));
            assert.equal(payload(r).declined, true);
            assert.match(payload(r).error, /did not confirm/);
        }
    });

    it("human: a question that fails sends nothing", async () => {
        const srv = askingServer({ capabilities: { elicitation: { form: {} } }, fail: "timed out" });
        const r = await gateMcp("group.leave", LEAVE, { config: { confirmMode: "human" }, server: srv });
        assert.equal(r.isError, true);
        assert.match(payload(r).error, /timed out/);
    });

    it("ZALO_MCP_CONFIRM_MODE from the process environment is read by default", async () => {
        process.env.ZALO_MCP_CONFIRM_MODE = "off";
        assert.equal(await gateMcp("group.leave", LEAVE, { config: { confirmMode: "agent" } }), null);
    });
});
