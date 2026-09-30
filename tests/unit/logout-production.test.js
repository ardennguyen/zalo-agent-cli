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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, loadCredentials, saveCredentials } from "../../src/core/credentials.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { serverLogout, describeLogout, finishLocalLogout, logoutNeedsSession } from "../../src/core/logout.js";

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
            // What zca-js threw after every successful logout on 2026-09-30.
            if (afterLogout === "empty") throw new Error("Failed to parse response data");
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

    it("sends the production logout FIRST, then logoutV2 best-effort", async () => {
        const { api, calls } = harness({ v2: "fail" });
        const result = await serverLogout(api);

        // Measured live 2026-09-30: with logoutV2 first, it killed the session
        // key and the production call answered "Invalid Param"; sent first, the
        // production call answered "Successful.". Red if logoutV2 goes back in
        // front, is dropped, or its failure is allowed to abort the rest.
        assert.deepEqual(calls, ["production", "v2", "probe"]);
        assert.equal(result.production.ok, true);
        assert.equal(result.v2.ok, false, "a staging failure is recorded, not hidden");
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

    it("runs the probe with zca-js logging off, then restores it", async () => {
        // The probe's failure is the expected outcome of a working logout, and
        // zca-js printed it as a raw stack trace. Red if the probe logs again,
        // or if logging stays off for the rest of the process.
        const { api } = harness({ afterLogout: "empty" });
        api.getContext().options.logging = true;
        const probe = api.fetchAccountInfo;
        let loggingDuringProbe;
        api.fetchAccountInfo = async () => {
            loggingDuringProbe = api.getContext().options.logging;
            return probe();
        };

        await serverLogout(api);

        assert.equal(loggingDuringProbe, false);
        assert.equal(api.getContext().options.logging, true);
    });

    it("an empty reply after an accepted logout says so, but never as a success", async () => {
        const { api } = harness({ afterLogout: "empty" });
        const lines = describeLogout(await serverLogout(api));

        assert.ok(!lines.some((l) => l.level === "success"), "an empty reply is not proof");
        assert.ok(lines.some((l) => /came back empty/.test(l.text)));
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
 * A logged-in account as it sits on disk: saved credentials plus a chat cache
 * and one downloaded file, under the sandboxed CONFIG_DIR.
 *
 * @param {string} ownId - a fake id by the no-real-ids convention
 * @returns {{accountDir: string, db: string, media: string}}
 */
function loggedInAccount(ownId) {
    saveCredentials(ownId, { imei: "test-imei-0000", cookie: [], userAgent: "offline-test" });
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    mkdirSync(join(accountDir, "media", "thread"), { recursive: true });
    const db = join(accountDir, "zalo.db");
    const media = join(accountDir, "media", "thread", "photo.jpg");
    writeFileSync(db, "cache");
    writeFileSync(media, "jpeg");
    return { accountDir, db, media };
}

// Measured live 2026-09-30: Zalo's logout calls end only the session key, and
// with the credentials kept the next command logged straight back in. So a
// real logout deletes them. These run on real files in the sandbox.
describe("a real logout deletes the saved credentials", () => {
    it("deletes the credentials and keeps the chat cache by default", () => {
        const own = "9000000000000000011";
        const { db, media } = loggedInAccount(own);
        assert.ok(loadCredentials(own), "precondition: credentials saved");

        const out = finishLocalLogout(own);

        // Red if logout goes back to "credentials kept — will auto-login".
        assert.equal(out.credentialsDeleted, true);
        assert.equal(loadCredentials(own), null, "nothing left to auto-login with");
        assert.ok(existsSync(db) && existsSync(media), "history is kept unless asked");
    });

    it("--delete-history also removes the chat cache and media", () => {
        const own = "9000000000000000022";
        const { db, media } = loggedInAccount(own);

        const out = finishLocalLogout(own, { deleteHistory: true });

        assert.equal(out.credentialsDeleted, true);
        assert.equal(loadCredentials(own), null);
        assert.deepEqual(out.history, { dbDeleted: true, mediaDeleted: true });
        assert.ok(!existsSync(db) && !existsSync(media));
    });

    it("keeps everything while a daemon holds the account's lock", () => {
        const own = "9000000000000000033";
        const { accountDir, db } = loggedInAccount(own);
        assert.equal(acquireLock(accountDir), true, "precondition: this process holds the lock");
        try {
            const out = finishLocalLogout(own, { deleteHistory: true });

            // Red if the guard is dropped: a running listen/mcp daemon would lose
            // the credentials it needs to re-auth after a drop.
            assert.equal(out.blockedPid, process.pid);
            assert.ok(loadCredentials(own), "credentials untouched under a held lock");
            assert.ok(existsSync(db), "history untouched under a held lock");
        } finally {
            releaseLock(accountDir);
        }
    });
});

// The entry point auto-logs in before most commands. A logout that will not
// call Zalo must not (measured 2026-09-30: --no-remote, and a logout about to
// refuse because a daemon runs, both logged in first).
describe("logout decides whether it needs a session before any login", () => {
    it("--no-remote never needs one", () => {
        assert.equal(logoutNeedsSession({ remote: false }, { ownId: "9000000000000000044" }), false);
    });

    it("nor does a logout that will refuse because a daemon holds the account", () => {
        const own = "9000000000000000055";
        const accountDir = join(CONFIG_DIR, "accounts", own);
        mkdirSync(accountDir, { recursive: true });
        assert.equal(acquireLock(accountDir), true);
        try {
            assert.equal(logoutNeedsSession({}, { ownId: own }), false);
        } finally {
            releaseLock(accountDir);
        }
        // Red if the lock check is dropped: with the daemon gone, it does need one.
        assert.equal(logoutNeedsSession({}, { ownId: own }), true);
    });

    it("a normal logout does, to end the session at Zalo", () => {
        assert.equal(logoutNeedsSession({}, { ownId: "9000000000000000066" }), true);
        assert.equal(logoutNeedsSession({}, null), true);
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
