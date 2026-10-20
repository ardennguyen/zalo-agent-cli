/**
 * `listen --events typing,upload`: two listener events zca-js emits that nothing consumed.
 *
 * Both are opt-in (not in the default --events), so each handler must sit
 * behind its own `enabledEvents.has(...)` check, or a plain `listen` would
 * start printing every keystroke indicator. `cipher_key` is the opposite: it
 * carries the session's key material and must stay unsubscribed.
 *
 * `listen` needs a live socket, which the offline suite never opens, so this
 * reads the source's structure, like tests/unit/listener-lifecycle-rules.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";

const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "listen.js"), "utf8");
const AST = acorn.parse(SRC, { ecmaVersion: "latest", sourceType: "module" });
const text = (n) => SRC.slice(n.start, n.end);

/** Every `<anything>.listener.on("<event>", ...)` call, with the IfStatements that enclose it. */
function subscriptions(event) {
    const found = [];
    const stack = [];
    (function visit(node) {
        if (!node || typeof node.type !== "string") return;
        if (node.type === "IfStatement") stack.push(node);
        if (
            node.type === "CallExpression" &&
            node.callee?.property?.name === "on" &&
            text(node.callee.object).endsWith("listener") &&
            node.arguments[0]?.value === event
        ) {
            found.push({ call: node, guards: stack.map((i) => text(i.test)) });
        }
        for (const key of Object.keys(node)) {
            if (["type", "start", "end", "loc"].includes(key)) continue;
            const v = node[key];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v.type === "string") visit(v);
        }
        if (node.type === "IfStatement") stack.pop();
    })(AST);
    return found;
}

describe("listen's opt-in events", () => {
    for (const [zcaEvent, flag] of [
        ["typing", "typing"],
        ["upload_attachment", "upload"],
    ]) {
        it(`${zcaEvent} is subscribed once, only when --events includes "${flag}"`, () => {
            const subs = subscriptions(zcaEvent);
            assert.equal(subs.length, 1, `expected one ${zcaEvent} subscription`);
            // Red if the handler is registered unconditionally: a default `listen` would print it.
            assert.ok(
                subs[0].guards.some((g) => g.includes(`enabledEvents.has("${flag}")`)),
                `${zcaEvent} must sit behind enabledEvents.has("${flag}")`,
            );
        });
    }

    it("neither is in the default --events", () => {
        const m = SRC.match(/"-e, --events <types>",[\s\S]*?"message,friend,group,reaction,read",\s*\)/);
        assert.ok(m, "the --events option is declared with its default");
        assert.doesNotMatch(m[0].match(/"message,friend[^"]*",\s*\)$/)[0], /typing|upload/);
    });

    it("never subscribes to cipher_key, the session's key material", () => {
        assert.equal(subscriptions("cipher_key").length, 0);
        assert.doesNotMatch(SRC, /["']cipher_key["']\s*,\s*\(/);
    });
});
