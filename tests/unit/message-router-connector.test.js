/**
 * The Companion Router's per-agent connector addresses: an agent bound by `connector:<slug>` takes every OAuth grant made
 * for `/mcp/a/<slug>` (the OAuth half is in mcp-oauth.test.js).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { agentForCredential, checkAgents } from "../../src/core/routing-policy.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("an agent bound to its own connector address", () => {
    it("takes every grant made for /mcp/a/<slug>, and nothing else; a grant for a missing agent is nobody's", () => {
        const { value: agents, error } = checkAgents([
            { slug: "dev", name: "Dev", credential: "connector:dev" },
            { slug: "claude", name: "Claude", credential: "oauth:claude-ai" },
        ]);
        assert.equal(error, undefined);
        assert.equal(agents[0].kind, "mcp-oauth");
        assert.equal(agentForCredential(agents, "oauth:claude-ai/0123", "dev").slug, "dev");
        assert.equal(agentForCredential(agents, "oauth:claude-ai/0123").slug, "claude");
        assert.equal(agentForCredential(agents, "oauth:claude-ai/0123", "ai"), null, "fails closed");
        assert.match(checkAgents([{ slug: "dev", name: "Dev", credential: "connector:ai" }]).error, /agent's own slug/);
    });
});
