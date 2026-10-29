/**
 * What an agent reads before it calls anything: the tool descriptions, the parameter descriptions and the server's
 * instructions (the MCP `instructions` field every client receives on connect).
 *
 * A model calls a tool only as well as it understands it. A parameter with no description, a tool that points at a
 * tool that does not exist, or ids that carry different names in different replies (`id` in the live buffer,
 * `msgId` in history, `messageId` in a send reply, before 3.0 made it `msgId` everywhere) are how a weaker model ends up
 * with the wrong field name.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SERVER_INSTRUCTIONS } from "../../src/mcp/instructions.js";
import { newMcpServer } from "../../src/mcp/new-server.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { tool } from "./support/mcp-send-harness.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const { tools } = tool();
const params = (meta) =>
    Object.entries(z.toJSONSchema(meta.inputSchema, { io: "input", unrepresentable: "any" }).properties ?? {});
const toolNames = new Set(tools.keys());
const mentionedTools = (text) => [...text.matchAll(/\bzalo_[a-z_]+\b/g)].map((m) => m[0]);

describe("every tool and parameter is described", () => {
    it("has 27 tools, each with a description long enough to say what it does and when to use it", () => {
        assert.equal(tools.size, 27);
        for (const [name, { meta }] of tools) {
            assert.ok(meta.description.length >= 80, `${name}: description is ${meta.description.length} characters`);
        }
    });

    it("gives every parameter of every tool a description", () => {
        const missing = [];
        for (const [name, { meta }] of tools) {
            for (const [field, schema] of params(meta)) {
                if (!schema.description || schema.description.trim().length < 10) missing.push(`${name}.${field}`);
            }
        }
        assert.deepEqual(missing, []);
    });

    it("only points at tools that exist", () => {
        const bad = [];
        for (const [name, { meta }] of tools) {
            const texts = [meta.description, ...params(meta).map(([, s]) => s.description ?? "")];
            for (const t of texts) {
                for (const ref of mentionedTools(t)) if (!toolNames.has(ref)) bad.push(`${name} -> ${ref}`);
            }
        }
        for (const ref of mentionedTools(SERVER_INSTRUCTIONS)) {
            if (!toolNames.has(ref)) bad.push(`instructions -> ${ref}`);
        }
        assert.deepEqual(bad, []);
    });
});

describe("the id vocabulary is stated where an agent needs it", () => {
    it("says where each msgId comes from, and names the one vocabulary in the instructions", () => {
        // Red if a tool that takes a msgId stops saying where it comes from.
        for (const name of ["zalo_react", "zalo_undo", "zalo_view_media"]) {
            const text = params(tools.get(name).meta)
                .map(([, s]) => s.description)
                .join(" ");
            assert.match(text, /zalo_get_history|zalo_send_message/, `${name}: where msgId comes from`);
        }
        assert.match(tools.get("zalo_get_messages").meta.description, /`msgId` \(pass it as/);
        assert.match(tools.get("zalo_send_message").meta.description, /`msgId` and `cliMsgId`/);
        assert.match(SERVER_INSTRUCTIONS, /called `msgId` in every input and reply/);
        assert.match(SERVER_INSTRUCTIONS, /threadType is `dm` or `group`, in inputs and in replies/);
    });

    it("mentions no older name: the aliases are gone, so nothing may say they are kept", () => {
        const all = [SERVER_INSTRUCTIONS];
        for (const [, { meta }] of tools)
            all.push(meta.description, ...params(meta).map(([, s]) => s.description ?? ""));
        for (const text of all) {
            assert.doesNotMatch(text, /older clients/);
            assert.doesNotMatch(text, /\bmessageId\b/);
            assert.doesNotMatch(text, /0 = DM|0=DM/);
        }
    });

    it("tells the agent to send real line breaks, in the instructions, the tool and the parameter", () => {
        assert.match(SERVER_INSTRUCTIONS, /real line breaks/);
        assert.match(tools.get("zalo_send_message").meta.description, /real line breaks, never the two characters/);
        const text = params(tools.get("zalo_send_message").meta).find(([f]) => f === "text")[1].description;
        assert.match(text, /Real line breaks only/);
    });
});

describe("the server instructions", () => {
    it("stay short enough to sit in every session's context", () => {
        assert.ok(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8") < 4000);
    });

    it("name the rules a model gets wrong unprompted", () => {
        for (const needle of ["zalo_sync", "confirm: true", "zalo_undo", "threadType", "cliMsgId", "consumer"]) {
            assert.ok(SERVER_INSTRUCTIONS.includes(needle), `missing: ${needle}`);
        }
    });

    it("are what both transports hand a client on connect", async () => {
        // The stdio path and the HTTP path build their server through newMcpServer.
        assert.equal(newMcpServer("0.0.0").server._instructions, SERVER_INSTRUCTIONS);
        const http = createHTTPServer(() => {}, {}, 0, null, "127.0.0.1");
        await new Promise((r) => http.once("listening", r));
        try {
            const res = await fetch(`http://127.0.0.1:${http.address().port}/mcp`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "t", version: "0" },
                    },
                }),
            });
            const raw = await res.text();
            const data = raw.startsWith("{")
                ? raw
                : raw
                      .split("\n")
                      .find((l) => l.startsWith("data:"))
                      .slice(5);
            assert.equal(JSON.parse(data).result.instructions, SERVER_INSTRUCTIONS);
        } finally {
            http.close();
        }
    });
});
