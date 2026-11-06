/**
 * `logout --keep-session` on a real session against the offline fake Zalo: the key-only logout sends Zalo Web's
 * production `GET api/login/logOut`, then Zalo Web's `logoutV2` (src/zalo/official-logout.js `sendLogoutV2`), then
 * probes the key with `fetchAccountInfo`.
 *
 * What is pinned is the logoutV2 the Web sends (cmd 12743): `POST stg-wpa.chat.zalo.me/api/v2/login/logOut`, the
 * common params in the query, and a form whose only field is `params`, sealed with the session key, holding
 * exactly `{time, imei, computer_name, language}` in that order, with `time` in unix SECONDS. The old logoutV2
 * call this replaces sent milliseconds and no `language`. Also: a refused logoutV2 does not stop the probe, and a probe that fails to parse prints nothing
 * (the protocol layer never writes to stdout, so no logging switch is needed around it any more).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { describeLogout, serverLogout } from "../../src/core/logout.js";
import { clearSession } from "../../src/core/zalo-client.js";
import { openSession } from "../../src/zalo/kernel/cipher.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, loginFake } from "./fake-zalo-session.js";

const KEEP = { keepSession: true };
const V2_HOST = "stg-wpa.chat.zalo.me";
const V2_PATH = "/api/v2/login/logOut";

/** A plain (unsealed) JSON answer, as Zalo gives both logout calls. */
const plain = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("logout --keep-session sends Zalo Web's logoutV2", () => {
    let fake;
    let api;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
    });

    beforeEach(async () => {
        fake = installFakeZalo();
        api = await loginFake();
        fake.requests.length = 0;
    });

    afterEach(() => {
        clearSession();
        fake.uninstall();
    });

    /**
     * Answer the two logout calls and the probe.
     *
     * @param {{v2?: object, probe?: object}} [opts] - the logoutV2 answer (plain JSON) and the me-v2 answer (an
     *   answer spec of fake-zalo-session.js)
     */
    function serve({
        v2 = { error_code: 0, error_message: "Successful.", data: 1 },
        probe = { inner: { error_code: 600, error_message: "fake: session key rejected" } },
    } = {}) {
        fake.rawRoute(
            (r) => r.host === "wpa.chat.zalo.me" && r.path === "/api/login/logOut",
            () => plain({ error_code: 0, error_message: "Successful.", data: 1 }),
        );
        fake.rawRoute(
            (r) => r.host === V2_HOST && r.path === V2_PATH,
            () => plain(v2),
        );
        fake.routeAnswer("/api/social/profile/me-v2", probe);
    }

    const order = () =>
        fake.requests.map((r) => `${r.method} ${r.host}${r.path}`).filter((c) => !c.includes("registry.npmjs.org"));

    it("POSTs the sealed Web form, time in unix seconds, after the production GET and before the probe", async () => {
        serve();
        const before = Math.floor(Date.now() / 1000);
        const result = await serverLogout(api, KEEP);
        const after = Math.ceil(Date.now() / 1000);

        assert.deepEqual(order(), [
            "GET wpa.chat.zalo.me/api/login/logOut",
            `POST ${V2_HOST}${V2_PATH}`,
            `GET ${new URL(api.zpwServiceMap.profile[0]).host}/api/social/profile/me-v2`,
        ]);
        const req = fake.requests.find((r) => r.host === V2_HOST && r.path === V2_PATH);
        // The common params ride in the query; the sealed fields go in the form, never in the query.
        assert.equal(req.query.zpw_ver, String(api.getContext().API_VERSION));
        assert.equal(req.query.zpw_type, String(api.getContext().API_TYPE));
        assert.equal(req.query.params, undefined, "params travel in the form, not the query");
        assert.deepEqual(Object.keys(req.form), ["params"], "the form's only field is params");
        assert.match(req.headers["content-type"], /^application\/x-www-form-urlencoded/);
        assert.equal(req.headers.origin, "https://chat.zalo.me", "a script call from the chat page");

        const opened = openSession(FAKE.sessionKey, req.form.params);
        assert.notEqual(opened, null, "sealed with the session key");
        const sent = JSON.parse(opened);
        // The Web form exactly (logoutV2 @11580968): red on a key added, dropped or moved, `language` included.
        assert.deepEqual(Object.keys(sent), ["time", "imei", "computer_name", "language"]);
        assert.equal(sent.imei, FAKE_CREDENTIALS.imei);
        assert.equal(sent.computer_name, "Web");
        assert.equal(sent.language, FAKE_CREDENTIALS.language);
        // Red if `time` goes back to milliseconds, which the old logoutV2 sent.
        assert.ok(
            Number.isInteger(sent.time) && sent.time >= before && sent.time <= after,
            `time is unix seconds, got ${sent.time}`,
        );

        assert.deepEqual(result.production, { ok: true });
        assert.deepEqual(result.v2, { ok: true });
        assert.equal(result.mode, "key-only");
        assert.equal(result.verdict, "ended", "the probe was refused with 600");
    });

    it("sends the session's own language, not a fixed one", async () => {
        serve();
        api.getContext().language = "en";
        await serverLogout(api, KEEP);
        const req = fake.requests.find((r) => r.host === V2_HOST && r.path === V2_PATH);
        assert.equal(JSON.parse(openSession(FAKE.sessionKey, req.form.params)).language, "en");
    });

    it("records a refused logoutV2 with Zalo's words, and still probes the key", async () => {
        serve({ v2: { error_code: 102, error_message: "fake: session key was improperly submitted" } });
        const result = await serverLogout(api, KEEP);

        assert.equal(result.v2.ok, false);
        assert.match(result.v2.error, /improperly submitted/);
        assert.ok(order().at(-1).endsWith("/api/social/profile/me-v2"), "the probe ran after the refusal");
        assert.equal(result.verdict, "ended");
    });

    it("prints nothing when the probe's reply does not open, and reports it as an empty reply", async () => {
        serve({ probe: { undecryptable: true } });
        const written = [];
        const write = process.stdout.write;
        process.stdout.write = (chunk, ...rest) => {
            written.push(String(chunk));
            const cb = rest.find((x) => typeof x === "function");
            if (cb) cb();
            return true;
        };
        let result;
        try {
            result = await serverLogout(api, KEEP);
        } finally {
            process.stdout.write = write;
        }

        assert.ok(order().at(-1).endsWith("/api/social/profile/me-v2"), "the probe went out");
        assert.equal(result.verdict, "unverified");
        // The words logout.js classifies an empty reply by (EMPTY_REPLY): red if the kernel's message changes.
        assert.match(result.probeError, /Failed to parse response data/);
        assert.ok(describeLogout(result).some((l) => /came back empty/.test(l.text)));
        // Red if anything on the way (the transport, the probe, the logout) writes to stdout.
        assert.equal(written.join(""), "");
    });
});
