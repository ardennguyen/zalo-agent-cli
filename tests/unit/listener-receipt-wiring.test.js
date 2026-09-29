/**
 * `listen` and `mcp start` must send delivered receipts through one code path,
 * wired the same way in both.
 *
 * AGENTS.md §13: they are two entry points to the same socket, so any
 * asymmetry between them is a defect. What the receipts DO is tested by
 * behaviour in receipts.test.js. This file guards the only part that cannot be
 * driven offline -- the wiring inside two action handlers that need a live
 * login -- by reading the command files' syntax trees, the same technique as
 * listener-lifecycle-rules.test.js.
 *
 * Each rule is a way the receipts could silently stop in one listener only:
 *   - not attached at all;
 *   - attached once at start-up but not in the function a re-login calls
 *     again, so they stop after the first reconnect;
 *   - attached ahead of the storing handler, where a throw could reach it;
 *   - a receipter bound to one api object, which re-login replaces;
 *   - the opt-out flag not reaching it, or auto-seen creeping in.
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

/** Parse a command file once. */
function load(file) {
    const source = readFileSync(join(SRC, file), "utf8");
    return { ast: acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }) };
}

/** Every node of `root` matching `pred`. */
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

/** `<anything>.listener.on("message", …)` */
const isMessageHandler = (n) =>
    isCall(n, "on") && n.callee.object?.property?.name === "listener" && n.arguments[0]?.value === "message";

for (const { file, attachFn } of LISTENERS) {
    describe(`${file} wires delivered receipts through the shared path`, () => {
        const { ast } = load(file);

        it("imports createDeliveredReceipts from src/core/receipts.js", () => {
            const imp = all(ast, (n) => n.type === "ImportDeclaration" && n.source.value === "../core/receipts.js");
            const names = imp.flatMap((d) => d.specifiers.map((s) => s.imported?.name));
            assert.ok(names.includes("createDeliveredReceipts"), `${file} must use the shared receipter`);
        });

        // The receipter: `const X = createDeliveredReceipts({...})`.
        const decls = all(
            ast,
            (n) =>
                n.type === "VariableDeclarator" &&
                n.init?.type === "CallExpression" &&
                n.init.callee?.name === "createDeliveredReceipts",
        );

        it("builds exactly one receipter, from getApi rather than a captured api", () => {
            assert.equal(decls.length, 1, `${file} must build one receipter`);
            const arg = decls[0].init.arguments[0];
            assert.equal(arg?.type, "ObjectExpression");
            const getApi = arg.properties.find((p) => p.key?.name === "getApi");
            assert.ok(getApi, "the receipter must resolve the api per send -- re-login replaces it");
            // `getApi` (shorthand or a reference to the module's getApi), never an api value.
            assert.equal(getApi.value.type, "Identifier");
            assert.equal(getApi.value.name, "getApi");
        });

        it("takes `enabled` from the --no-delivered-receipts option", () => {
            const arg = decls[0].init.arguments[0];
            const enabled = arg.properties.find((p) => p.key?.name === "enabled");
            assert.ok(enabled, "the opt-out must reach the receipter");
            const reads = all(
                enabled.value,
                (n) =>
                    n.type === "MemberExpression" &&
                    n.object?.name === "opts" &&
                    n.property?.name === "deliveredReceipts",
            );
            // The flag itself (`--no-delivered-receipts` -> opts.deliveredReceipts)
            // is held to its --help registration by tests/cli/surface.test.js.
            assert.ok(reads.length > 0, "`enabled` must be derived from opts.deliveredReceipts");
        });

        it(`attaches inside ${attachFn}, after the storing message handler`, () => {
            const receipter = decls[0].id.name;
            const fn = all(ast, (n) => n.type === "FunctionDeclaration" && n.id?.name === attachFn)[0];
            assert.ok(fn, `${attachFn} not found -- this guard has drifted`);
            const attach = all(
                fn,
                (n) =>
                    isCall(n, "attach") &&
                    n.callee.object?.name === receipter &&
                    n.arguments[0]?.type === "MemberExpression",
            );
            assert.equal(
                attach.length,
                1,
                `${receipter}.attach(api.listener) must run in ${attachFn}, which re-login calls again`,
            );
            assert.equal(attach[0].arguments[0].property?.name, "listener");
            const store = all(fn, isMessageHandler);
            assert.ok(store.length > 0, "no message handler found");
            assert.ok(
                store[0].start < attach[0].start,
                "receipts must attach after the storing handler, so the write always runs first",
            );
        });

        it("never sends a seen receipt on its own", () => {
            const seen = all(
                ast,
                (n) =>
                    n.type === "CallExpression" &&
                    ["sendSeenReceipt", "sendSeenEvent", "markConversationRead"].includes(
                        n.callee?.property?.name ?? n.callee?.name,
                    ),
            );
            assert.deepEqual(seen, [], "read receipts are off deliberately; a listener must never send seenv2");
        });
    });
}
