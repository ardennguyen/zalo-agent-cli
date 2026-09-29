/**
 * `logout` must end the session the way Zalo Web ends it — and must say so only
 * when it has seen the session end.
 *
 * Until this change both `logout` and `account remove` called only the patched
 * `logoutV2()`, which POSTs to `https://stg-wpa.chat.zalo.me/api/v2/login/logOut`.
 * That is a real call Zalo Web makes, but only as an optional extra step. The
 * web's actual logout is `GET https://wpa.chat.zalo.me/api/login/logOut` (cmd
 * 11135) with a plain query string. Tier 5 saw the result: logout reported
 * success, and the credential still answered `whoami` afterwards.
 *
 * How it went unnoticed is the more useful half. The patch header records that
 * host #3 (`wpa.chat.zalo.me`) was proven on 2026-09-19 — the next authenticated
 * call failed with error 600 — and that the staging host was then made active on
 * the strength of the CLI printing "Server session invalidated", a message it
 * prints whenever the call does not throw. So these tests pin two things: the
 * request that goes out, and that "ended" is only ever claimed after Zalo has
 * rejected a follow-up call.
 *
 * Transport: `ctx.options.polyfill` is zca-js's own HTTP seam, so the real
 * request builder runs with no socket, no session and no network. `logoutV2` and
 * `fetchAccountInfo` are fakes on the api object, because what matters about
 * them here is order and outcome, not their wire format.
 */

import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { serverLogout, describeLogout } from "../../src/core/logout.js";

assertSandboxed(CONFIG_DIR);

const OWN = "9000000000000000009";
const ROOT = join(import.meta.dirname, "..", "..");

/**
 * An api whose production logout goes through a recording fake transport.
 *
 * @param {object} [opts]
 * @param {object} [opts.logoutBody] - JSON the fake Zalo answers the production call with
 * @param {"ok"|"fail"} [opts.v2] - how the staging logoutV2 behaves
 * @param {"rejected"|"answers"|"network"} [opts.afterLogout] - how the follow-up probe behaves
 * @returns {{api: object, calls: string[], requests: object[]}}
 */
function harness({
    logoutBody = { error_code: 0, error_message: "Successful.", data: 1 },
    v2 = "ok",
    afterLogout = "rejected",
} = {}) {
    const calls = [];
    const requests = [];
    const ctx = {
        secretKey: Buffer.from("0123456789abcdef").toString("base64"),
        imei: "test-imei-0000",
        uid: OWN,
        userAgent: "zalo-agent-cli-offline-test",
        API_VERSION: 691,
        API_TYPE: 30,
        options: {
            logging: false,
            async polyfill(url, options) {
                calls.push("production");
                requests.push({ url, method: options?.method ?? "GET", body: options?.body ?? null });
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: async () => logoutBody,
                };
            },
        },
    };
    const api = {
        getContext: () => ctx,
        async logoutV2() {
            calls.push("v2");
            if (v2 === "fail") throw new Error("staging refused");
            return 1;
        },
        async fetchAccountInfo() {
            calls.push("probe");
            if (afterLogout === "rejected") {
                throw Object.assign(new Error("zpw_sek bị thiếu hoặc không đúng"), { code: 600 });
            }
            if (afterLogout === "network") throw new Error("fetch failed");
            return { profile: { userId: OWN } };
        },
    };
    return { api, calls, requests };
}

describe("serverLogout sends Zalo Web's production logout", () => {
    it("GET https://wpa.chat.zalo.me/api/login/logOut with a plain query, time in seconds", async () => {
        const { api, requests } = harness();
        const before = Math.floor(Date.now() / 1000);
        await serverLogout(api);
        const after = Math.ceil(Date.now() / 1000);

        assert.equal(requests.length, 1, "exactly one production logout request");
        const req = requests[0];
        const url = new URL(req.url);
        // Red if the call goes back to staging, to a service-map host, or to the v2 path.
        assert.equal(url.origin, "https://wpa.chat.zalo.me", "production auth domain, not stg-wpa");
        assert.equal(url.pathname, "/api/login/logOut", "the web's logout path (cmd 11135), not /api/v2/");
        assert.equal(req.method, "GET", "the web sends it as a GET, not a POST");
        assert.equal(req.body, null, "no request body");

        const q = url.searchParams;
        // Red if the fields are AES-wrapped the way every other call is.
        assert.equal(q.get("params"), null, "a plain query string, not an encrypted params= blob");
        const time = Number(q.get("time"));
        // Red if `time` is milliseconds, which is what logoutV2 sends.
        assert.ok(time >= before && time <= after, `time must be unix SECONDS, got ${q.get("time")}`);
        assert.equal(q.get("client_version"), "691");
        assert.equal(q.get("type"), "30");
        assert.equal(q.get("imei"), "test-imei-0000");
        assert.equal(q.get("computer_name"), "Web");
        assert.equal(q.get("zpw_ver"), "691", "the common params ride along");
        assert.equal(q.get("zpw_type"), "30");
    });

    it("still runs the staging logoutV2 first, and its failure does not stop the production call", async () => {
        const { api, calls } = harness({ v2: "fail" });
        const result = await serverLogout(api);

        // Red if logoutV2 is dropped, reordered after the session is gone, or allowed to abort.
        assert.deepEqual(calls, ["v2", "production", "probe"]);
        assert.equal(result.v2.ok, false);
        assert.equal(result.production.ok, true, "a staging failure must not block the real logout");
    });

    it("reports a production rejection instead of swallowing it", async () => {
        const { api } = harness({
            logoutBody: { error_code: 102, error_message: "session key was improperly submitted" },
        });
        const result = await serverLogout(api);

        assert.equal(result.production.ok, false);
        assert.equal(result.production.code, 102);
        assert.match(result.production.error, /improperly submitted/);
    });
});

describe("serverLogout claims the session ended only after seeing it end", () => {
    it("a follow-up call rejected with error 600 is a verified end", async () => {
        const { api } = harness({ afterLogout: "rejected" });
        const result = await serverLogout(api);

        assert.equal(result.verdict, "ended");
    });

    it("a session that still answers is reported, not hidden behind a success line", async () => {
        const { api } = harness({ afterLogout: "answers" });
        const result = await serverLogout(api);

        // This is the tier 5 outcome. Red if the helper reports "ended" regardless.
        assert.equal(result.verdict, "still-answers");
    });

    it("a probe failure that is not a session rejection proves nothing", async () => {
        const { api } = harness({ afterLogout: "network" });
        const result = await serverLogout(api);

        // Red if any thrown error is read as proof of logout.
        assert.equal(result.verdict, "unverified");
        assert.match(result.probeError, /fetch failed/);
    });

    it("prints success only for a verified end", async () => {
        const levels = async (afterLogout) => {
            const { api } = harness({ afterLogout });
            return describeLogout(await serverLogout(api)).map((l) => l.level);
        };
        // The old code printed a success line whenever the call did not throw.
        // Red if a surviving or unverified session is ever reported as success.
        assert.ok((await levels("rejected")).includes("success"));
        assert.ok(!(await levels("answers")).includes("success"), "a surviving session is a warning");
        assert.ok(!(await levels("network")).includes("success"), "an unverified logout is not a success");
    });
});

/**
 * The body of one Commander `.action(...)` handler, by the command it is chained to.
 *
 * @param {string} file - repo-relative source file
 * @param {string} command - the `.command("...")` literal that starts the chain
 * @returns {string} source text from that command to the next `.command(` call
 */
function actionSource(file, command) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const start = src.indexOf(`.command("${command}`);
    assert.ok(start >= 0, `${file}: no .command("${command}")`);
    const next = src.indexOf(".command(", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
}

// The request-level tests above prove what serverLogout sends. These prove the
// two commands that end a session actually use it. They scan only login.js and
// account.js, so serverLogout existing in src/core/logout.js cannot satisfy them;
// they go red if either command goes back to calling logoutV2 on its own.
describe("both commands that end a session go through serverLogout", () => {
    for (const [file, command] of [
        ["src/commands/login.js", "logout"],
        ["src/commands/account.js", "remove"],
    ]) {
        it(`${file} \`${command}\``, () => {
            const body = actionSource(file, command);
            assert.ok(/serverLogout\(/.test(body), `${command} must end the session through serverLogout`);
            assert.ok(!/\.logoutV2\(/.test(body), `${command} must not call logoutV2 directly any more`);
        });
    }
});
