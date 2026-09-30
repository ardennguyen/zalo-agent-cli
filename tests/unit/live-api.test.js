/**
 * src/core/live-api.js, and `mcp start` handing it to the tools and the notifier.
 *
 * Every login replaces the zca-js API object, and `mcp start` logs in again
 * after a dropped connection. The MCP tools and the notifier were handed the
 * object once, at start-up, so after the first re-login they kept calling the
 * replaced one: `zalo_get_history`'s socket scan on a stopped listener, every
 * send through a session the daemon had given up. These pin the stand-in that
 * always reads the current session, and that `mcp.js` uses it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { liveApi } from "../../src/core/live-api.js";
import { walkAst } from "../helpers/zca-call-sites.js";

/** A fake zca-js API: a method that reports which session answered, and a listener. */
function session(name) {
    return {
        name,
        listener: { id: `${name}-listener` },
        sendMessage(text) {
            return { sentBy: this.name, text };
        },
    };
}

describe("liveApi -- the current session, whichever that is", () => {
    it("forwards to the session that is current at the moment of use", () => {
        let current = session("first");
        const api = liveApi(() => current);
        assert.equal(api.sendMessage("a").sentBy, "first");
        current = session("second"); // a re-login replaced the API object
        // Red if the object is captured once: the call would still go to "first".
        assert.equal(api.sendMessage("b").sentBy, "second");
        assert.equal(api.listener.id, "second-listener", "the live listener, not the stopped one");
    });

    it("binds a method to the session it came from", () => {
        let current = session("first");
        const api = liveApi(() => current);
        const send = api.sendMessage; // read now, called after the swap
        current = session("second");
        assert.equal(send("c").sentBy, "first", "`this` must be the API the method belongs to");
    });

    it("between sessions, says so instead of calling a dead one", () => {
        const api = liveApi(
            () => {
                throw new Error("Not logged in. Run: zalo-agent login");
            },
            { unavailable: "logging in again; try again shortly" },
        );
        assert.throws(() => api.sendMessage("x"), /logging in again; try again shortly/);
        const plain = liveApi(() => {
            throw new Error("Not logged in");
        });
        assert.throws(() => plain.listener, /Not logged in/, "without the option, getApi's own error");
    });

    it("is not mistaken for a promise, and answers `in`", async () => {
        const api = liveApi(() => session("s"));
        assert.equal(await api, api, "awaiting it must not call a `then`");
        assert.ok("sendMessage" in api);
        assert.ok(!("pullMobileMsg" in api));
    });
});

describe("mcp start hands the tools and the notifier the live session", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "mcp.js"), "utf8");
    const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const nodes = [];
    walkAst(ast, (n) => nodes.push(n));

    const live = nodes
        .filter((n) => n.type === "VariableDeclarator" && n.init?.type === "CallExpression")
        .filter((n) => n.init.callee?.name === "liveApi")
        .map((n) => n.id.name);
    const isGetApiCall = (n) => n?.type === "CallExpression" && n.callee?.name === "getApi";

    it("builds one live session view", () => {
        assert.equal(live.length, 1, "mcp.js must build liveApi(getApi) once");
    });

    it("gives it to the HTTP tools, the stdio tools and the notifier -- never a getApi() snapshot", () => {
        const deps = nodes.find(
            (n) => n.type === "VariableDeclarator" && n.id?.name === "deps" && n.init?.type === "ObjectExpression",
        );
        const apiProp = deps?.init.properties.find((p) => p.key?.name === "api");
        // Red if any of the three goes back to `getApi()`: it keeps the start-up object.
        assert.equal(apiProp?.value?.name, live[0], "createHTTPServer's deps.api");

        const stdio = nodes.find((n) => n.type === "CallExpression" && n.callee?.name === "createMCPServer");
        assert.equal(stdio?.arguments[0]?.name, live[0], "createMCPServer's api");

        const notifier = nodes.find((n) => n.type === "NewExpression" && n.callee?.name === "ZaloNotifier");
        assert.equal(notifier?.arguments[0]?.name, live[0], "ZaloNotifier's api");

        for (const call of [stdio, notifier]) assert.ok(!isGetApiCall(call.arguments[0]));
    });
});
