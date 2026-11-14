/**
 * src/core/oa/calls.js and `oa call` (src/commands/oa/calls.js): voice-call consent and call links.
 *
 * Asserted against Zalo's OA docs "Gọi thoại": `requestconsent` (POST v2.0 JSON: phone, call_type, numeric
 * reason_code), `checkconsent` (GET v2.0 `?data={"phone":…}`), `outbound` / `inbound` (POST v3.0) and `getmccinfo`
 * (GET v3.0); the documented enums are checked before sending, and the consent code table ("Mã lỗi") decides which
 * codes are answers and which are failures. globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { OAError, saveOACreds } from "../../src/core/oa/transport.js";
import {
    CALL_URLS,
    CONSENT_CODES,
    checkCallConsent,
    createInboundCallLink,
    createOutboundCallLink,
    getCallCenterInfo,
    normalizePhone,
    requestCallConsent,
} from "../../src/core/oa/calls.js";
import { registerCallsCommands } from "../../src/commands/oa/calls.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const U1 = "1000000000000000001";
const AGENT = "1000000000000000002";
const PHONE = "84901234567";

function mockFetch(reply = () => ({})) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        return new Response(JSON.stringify(r.json ?? { error: 0, message: "Success", data: {} }), {
            status: r.status ?? 200,
            headers: { "content-type": "application/json" },
        });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

function only(calls) {
    assert.equal(calls.length, 1, "exactly one request");
    const c = calls[0];
    const u = new URL(c.url);
    return {
        method: c.init.method,
        url: `${u.origin}${u.pathname}`,
        query: Object.fromEntries(u.searchParams),
        token: c.init.headers.access_token,
        type: c.init.headers["Content-Type"],
        body: c.init.body === undefined ? undefined : JSON.parse(c.init.body),
    };
}

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-call" });
});
afterEach(() => m?.restore());

describe("call endpoints match the docs", () => {
    it("URLs: consent on v2.0, links and MCC info on v3.0", () => {
        assert.deepEqual(CALL_URLS, {
            requestConsent: "https://openapi.zalo.me/v2.0/oa/call/requestconsent",
            checkConsent: "https://openapi.zalo.me/v2.0/oa/call/checkconsent",
            outbound: "https://openapi.zalo.me/v3.0/oa/call/outbound",
            inbound: "https://openapi.zalo.me/v3.0/oa/call/inbound",
            mccInfo: "https://openapi.zalo.me/v3.0/oa/call/getmccinfo",
        });
    });

    it("consent-request: POST JSON { phone, call_type, reason_code } with reason_code a number", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success" } }));
        const r = await requestCallConsent({ phone: "+84 901-234-567", callType: "video", reasonCode: "103" });
        const c = only(m.calls);
        assert.equal(c.method, "POST");
        assert.equal(c.url, CALL_URLS.requestConsent);
        assert.equal(c.token, "tok-call");
        assert.equal(c.type, "application/json");
        assert.deepEqual(c.body, { phone: PHONE, call_type: "video", reason_code: 103 });
        assert.equal(r.code, 0);
        assert.equal(r.consented, true);
    });

    it("consent-request: call_type defaults to audio", async () => {
        m = mockFetch();
        await requestCallConsent({ phone: PHONE, reasonCode: 101 });
        assert.equal(only(m.calls).body.call_type, "audio");
    });

    it("consent-request: an undocumented reason or call type, or a bad phone, sends nothing", async () => {
        m = mockFetch();
        await assert.rejects(requestCallConsent({ phone: PHONE, reasonCode: 102 }), /reason code must be one of 101/);
        await assert.rejects(requestCallConsent({ phone: PHONE }), /reason code/);
        await assert.rejects(requestCallConsent({ phone: PHONE, reasonCode: 101, callType: "sms" }), /call type/);
        await assert.rejects(requestCallConsent({ phone: "12ab", reasonCode: 101 }), /not a phone number/);
        assert.equal(m.calls.length, 0);
    });

    it("consent-request: 'Request sent' (2) is a result, not a failure", async () => {
        m = mockFetch(() => ({ json: { error: 2, message: "Request sent" } }));
        const r = await requestCallConsent({ phone: PHONE, reasonCode: 105 });
        assert.equal(r.code, 2);
        assert.equal(r.status, "Request sent");
        assert.equal(r.consented, false);
    });

    it("consent-request: a failure code throws with the docs' wording", async () => {
        m = mockFetch(() => ({ json: { error: 5, message: "x" } }));
        await assert.rejects(
            requestCallConsent({ phone: PHONE, reasonCode: 101 }),
            (e) => e instanceof OAError && e.code === 5 && e.message.includes(CONSENT_CODES[5]),
        );
    });

    it('consent-check: GET with ?data={"phone":…}, no body', async () => {
        m = mockFetch(() => ({
            json: { error: 0, message: "User approved the request", expired_time: 1648696628738 },
        }));
        const r = await checkCallConsent("0901234567");
        const c = only(m.calls);
        assert.equal(c.method, "GET");
        assert.equal(c.url, CALL_URLS.checkConsent);
        assert.deepEqual(JSON.parse(c.query.data), { phone: "0901234567" });
        assert.equal(c.body, undefined);
        assert.equal(r.consented, true);
        assert.equal(r.expired_time, 1648696628738);
    });

    it("consent-check: state codes (rejected, waiting, expired, not requested) are answers", async () => {
        for (const code of [3, 8, 16, 20]) {
            m = mockFetch(() => ({ json: { error: code, message: "m" } }));
            const r = await checkCallConsent(PHONE);
            assert.equal(r.code, code);
            assert.equal(r.status, CONSENT_CODES[code]);
            assert.equal(r.consented, false);
            m.restore();
        }
        m = undefined;
    });

    it("consent-check: a failure code or an OA error still throws", async () => {
        m = mockFetch(() => ({ json: { error: 6, message: "x" } }));
        await assert.rejects(
            checkCallConsent(PHONE),
            (e) => e.code === 6 && /Insufficient permissions/.test(e.message),
        );
        m.restore();
        m = mockFetch(() => ({ json: { error: -224, message: "package" } }));
        await assert.rejects(checkCallConsent(PHONE), (e) => e.code === -224);
    });

    it("outbound: POST { user_id, agent_id?, call_type }", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { call_link: "https://example.com/c", ttl: 172800 } } }));
        const r = await createOutboundCallLink({ userId: U1, agentId: AGENT });
        const c = only(m.calls);
        assert.equal(c.method, "POST");
        assert.equal(c.url, CALL_URLS.outbound);
        assert.deepEqual(c.body, { user_id: U1, agent_id: AGENT, call_type: "audio" });
        assert.equal(r.data.ttl, 172800);
        m.restore();
        m = mockFetch();
        await createOutboundCallLink({ userId: U1, callType: "audio_and_video" });
        assert.deepEqual(only(m.calls).body, { user_id: U1, call_type: "audio_and_video" });
    });

    it("outbound: no user id sends nothing", async () => {
        m = mockFetch();
        await assert.rejects(createOutboundCallLink({}), /user id/);
        assert.equal(m.calls.length, 0);
    });

    it("inbound: POST { branch_id?, agent_id?, call_type }", async () => {
        m = mockFetch();
        await createInboundCallLink({ branchId: "231747", callType: "video" });
        const c = only(m.calls);
        assert.equal(c.method, "POST");
        assert.equal(c.url, CALL_URLS.inbound);
        assert.deepEqual(c.body, { branch_id: "231747", call_type: "video" });
        m.restore();
        m = mockFetch();
        await createInboundCallLink();
        assert.deepEqual(only(m.calls).body, { call_type: "audio" });
    });

    it("mcc-info: GET getmccinfo, no query, no body", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { agents: [], branches: [] } } }));
        const r = await getCallCenterInfo();
        const c = only(m.calls);
        assert.equal(c.method, "GET");
        assert.equal(c.url, CALL_URLS.mccInfo);
        assert.deepEqual(c.query, {});
        assert.equal(c.body, undefined);
        assert.deepEqual(r.data, { agents: [], branches: [] });
    });

    it("normalizePhone keeps digits and drops a leading +", () => {
        assert.equal(normalizePhone("+84 901.234.567"), PHONE);
        assert.equal(normalizePhone("0901234567"), "0901234567");
        assert.throws(() => normalizePhone(""), /not a phone number/);
    });
});

describe("`oa call` commands", () => {
    async function run(args) {
        const root = new Command().option("--json").exitOverride();
        registerCallsCommands(root.command("oa"));
        const lines = [];
        const log = console.log;
        const err = console.error;
        console.log = (s) => lines.push(String(s));
        console.error = () => {};
        process.env.ZALO_JSON_MODE = "1";
        _resetErrorLatch();
        try {
            await root.parseAsync(["node", "zalo-agent", "--json", "oa", "call", ...args]);
        } finally {
            console.log = log;
            console.error = err;
            delete process.env.ZALO_JSON_MODE;
        }
        const exitCode = process.exitCode;
        process.exitCode = undefined;
        return { out: lines.length ? JSON.parse(lines.join("\n")) : undefined, exitCode };
    }

    it("registers the documented operations", () => {
        const root = new Command();
        registerCallsCommands(root.command("oa"));
        const call = root.commands[0].commands.find((c) => c.name() === "call");
        assert.deepEqual(
            call.commands.map((c) => c.name()),
            ["consent-request", "consent-check", "outbound", "inbound", "mcc-info"],
        );
    });

    it("consent-request needs --reason and sends it as a number", async () => {
        m = mockFetch();
        const { exitCode } = await run(["consent-request", PHONE, "--reason", "107", "--type", "audio"]);
        assert.equal(exitCode, undefined);
        assert.deepEqual(only(m.calls).body, { phone: PHONE, call_type: "audio", reason_code: 107 });
    });

    it("consent-check prints the state with consented false and exits 0", async () => {
        m = mockFetch(() => ({ json: { error: 8, message: "Waiting" } }));
        const { out, exitCode } = await run(["consent-check", PHONE]);
        assert.equal(exitCode, undefined);
        assert.equal(out.consented, false);
        assert.equal(out.status, "Waiting for user approval");
    });

    it("outbound / inbound pass --agent, --branch and --type", async () => {
        m = mockFetch();
        await run(["outbound", U1, "--agent", AGENT, "--type", "video"]);
        await run(["inbound", "--branch", "231747"]);
        const [a, b] = m.calls.map((c) => JSON.parse(c.init.body));
        assert.deepEqual(a, { user_id: U1, agent_id: AGENT, call_type: "video" });
        assert.deepEqual(b, { branch_id: "231747", call_type: "audio" });
    });

    it("a bad --type exits 1 and sends nothing", async () => {
        m = mockFetch();
        const { out, exitCode } = await run(["outbound", U1, "--type", "fax"]);
        assert.equal(exitCode, 1);
        assert.match(out.error, /call type/);
        assert.equal(m.calls.length, 0);
    });

    it("mcc-info prints Zalo's reply", async () => {
        m = mockFetch(() => ({
            json: { error: 0, data: { agents: [{ agent_id: AGENT, allocation: [1] }], branches: [] } },
        }));
        const { out } = await run(["mcc-info"]);
        assert.equal(out.data.agents[0].agent_id, AGENT);
    });
});
