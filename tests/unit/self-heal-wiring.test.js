/**
 * `listen` and `mcp start` must self-heal through one code path, wired the same way.
 *
 * AGENTS.md §13: they are two entry points to the same socket, so any asymmetry
 * between them is a defect. What the catch-up DOES is tested by behavior in
 * self-heal.test.js; this guards the part that lives inside two action handlers
 * needing a live login, by reading the command files' syntax trees -- the same
 * technique as listener-receipt-wiring.test.js.
 *
 * Each rule is a way self-heal could silently stop in one listener only:
 *   - never built, or built from a captured api that re-login replaces;
 *   - the opt-out flag not reaching it;
 *   - the tap or the self-heal attached once at start-up but not in the
 *     function re-login calls again, so both go deaf after the first reconnect;
 *   - attached ahead of the storing handler, so the cursor could pass a row
 *     that was never written;
 *   - its lock not the daemon channel's, so it could run beside a sync stage;
 *   - what it recovers never reaching the bot-facing output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { walkAst } from "../helpers/zca-call-sites.js";

const SRC = join(import.meta.dirname, "..", "..", "src", "commands");

const LISTENERS = [
    { file: "listen.js", attachFn: "attachAllHandlers" },
    { file: "mcp.js", attachFn: "attachListenerHandlers" },
];

function load(file) {
    const source = readFileSync(join(SRC, file), "utf8");
    return { ast: acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }), source };
}

function all(root, pred) {
    const out = [];
    walkAst(root, (n) => {
        if (pred(n)) out.push(n);
    });
    return out;
}

const isCall = (n, prop) =>
    n.type === "CallExpression" &&
    n.callee?.type === "MemberExpression" &&
    !n.callee.computed &&
    n.callee.property?.name === prop;

const isMessageHandler = (n) =>
    isCall(n, "on") && n.callee.object?.property?.name === "listener" && n.arguments[0]?.value === "message";

/** `const X = <factory>({...})` declarators. */
const built = (ast, factory) =>
    all(
        ast,
        (n) => n.type === "VariableDeclarator" && n.init?.type === "CallExpression" && n.init.callee?.name === factory,
    );

const prop = (objectExpr, name) => objectExpr?.properties?.find((p) => p.key?.name === name);

for (const { file, attachFn } of LISTENERS) {
    describe(`${file} self-heals through the shared path`, () => {
        const { ast, source } = load(file);
        const heals = built(ast, "createSelfHeal");
        const taps = built(ast, "createSocketTap");
        const locks = built(ast, "createStageLock");

        it("builds one self-heal, one socket tap and one stage lock", () => {
            assert.equal(heals.length, 1, `${file} must build one self-heal`);
            assert.equal(taps.length, 1, `${file} must build one socket tap`);
            assert.equal(locks.length, 1, `${file} must build one stage lock`);
        });

        it("resolves the api per run, and takes `enabled` from --no-self-heal", () => {
            const arg = heals[0].init.arguments[0];
            const getApi = prop(arg, "getApi");
            assert.ok(getApi, "re-login replaces the api; a captured one goes deaf");
            assert.equal(getApi.value.type, "Identifier");
            assert.equal(getApi.value.name, "getApi");
            const enabled = prop(arg, "enabled");
            assert.ok(enabled, "the opt-out must reach the self-heal");
            const reads = all(
                enabled.value,
                (n) => n.type === "MemberExpression" && n.object?.name === "opts" && n.property?.name === "selfHeal",
            );
            assert.ok(reads.length > 0, "`enabled` must be derived from opts.selfHeal");
            assert.match(source, /\.option\(\s*"--no-self-heal"/, "the flag must be registered");
        });

        it("shares its lock and tap with the daemon channel's socket", () => {
            const arg = heals[0].init.arguments[0];
            const lock = prop(arg, "lock");
            const tap = prop(arg, "tap");
            assert.equal(lock?.value?.name, locks[0].id.name, "the self-heal must hold the channel's lock");
            assert.equal(tap?.value?.name, taps[0].id.name);
            const channel = all(ast, (n) => n.type === "CallExpression" && n.callee?.name === "startDaemonChannel");
            assert.equal(channel.length, 1);
            const chanLock = prop(channel[0].arguments[0], "lock");
            // Red if the channel keeps a lock of its own: a stage could then start beside a catch-up.
            assert.equal(chanLock?.value?.name, locks[0].id.name, "startDaemonChannel must get the same lock");
        });

        it("hands what it recovers to the bot-facing output", () => {
            const arg = heals[0].init.arguments[0];
            assert.ok(prop(arg, "onRecovered"), "recovered messages must reach the buffer/webhook, flagged catchUp");
            assert.match(source, /catchUp:\s*true/, "a recovered message must be marked as catch-up");
        });

        it(`attaches the tap and the self-heal inside ${attachFn}, after the storing handler`, () => {
            const fn = all(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === attachFn)[0];
            assert.ok(fn, `${attachFn} not found -- this guard has drifted`);
            const store = all(fn, isMessageHandler);
            assert.ok(store.length > 0, "no message handler found");
            for (const who of [taps[0].id.name, heals[0].id.name]) {
                const attach = all(
                    fn,
                    (n) =>
                        isCall(n, "attach") &&
                        n.callee.object?.name === who &&
                        n.arguments[0]?.type === "MemberExpression",
                );
                assert.equal(
                    attach.length,
                    1,
                    `${who}.attach(api.listener) must run in ${attachFn}, which re-login calls`,
                );
                assert.equal(attach[0].arguments[0].property?.name, "listener");
                assert.ok(store[0].start < attach[0].start, `${who} must attach after the storing handler`);
            }
        });
    });
}
