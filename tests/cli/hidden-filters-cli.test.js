/**
 * Hidden chats through the binary, against the fake session (tests/helpers/fake-api.js): the PIN is checked even when
 * nothing is hidden, and `conv archived`, `conv muted` and `read run` leave a hidden chat out unless --include-hidden
 * and the PIN.
 *
 * Red if a wrong PIN with zero hidden conversations exits 0 (live 2026-11-07: `conv hidden --pin-stdin` printed the
 * empty list), if a wrong PIN is not counted toward the lockout, if a hidden thread id appears in `conv archived` or
 * `conv muted` without the PIN (or is missing with it), or if `read run` asks Zalo about a hidden chat.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, getAccountDir, saveCredentials } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { FAKE_OWN_ID } from "../helpers/fake-api.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "index.js");
const FAKE_API = join(ROOT, "tests", "helpers", "fake-api.js");
const NO_NETWORK = join(ROOT, "tests", "helpers", "no-network.mjs");

const PIN = "5172";
const HIDDEN = "1000000000000000006";
const VISIBLE = "1000000000000000007";
const md5 = (s) => createHash("md5").update(s).digest("hex");

/** Run the CLI with the fake session, `stdin` piped in, and per-method replies. */
function run(argv, { stdin = "", replies = {} } = {}) {
    const env = {
        ...process.env,
        USERPROFILE: SANDBOX_HOME,
        HOME: SANDBOX_HOME,
        ZALO_SANDBOX_ACTIVE: "1",
        ZALO_TEST_FAKE_API: FAKE_API,
        ZALO_TEST_FAKE_API_MODE: "normal",
        ZALO_TEST_FAKE_API_REPLIES: JSON.stringify(replies),
        ZALO_AGENT_NO_UPDATE_CHECK: "1",
        NODE_OPTIONS: `--import=${pathToFileURL(NO_NETWORK).href}`,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
    };
    return new Promise((res) => {
        const child = spawn(process.execPath, [CLI, "--json", ...argv], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            let out = null;
            try {
                out = JSON.parse(stdout.trim());
            } catch {
                /* left null */
            }
            res({ code, stdout, stderr, out });
        });
        child.stdin.end(stdin);
    });
}

const lockout = () => {
    try {
        return JSON.parse(readFileSync(join(getAccountDir(FAKE_OWN_ID), "hidden-pin-lockout.json"), "utf8"));
    } catch {
        return null;
    }
};

before(() => {
    assertSandboxed(CONFIG_DIR);
    addAccount(FAKE_OWN_ID, "Fake Self");
    saveCredentials(FAKE_OWN_ID, { imei: "fake-imei", cookie: [], userAgent: "fake-agent", language: "vi" });
});

const resetState = () => {
    for (const f of ["hidden-pin-lockout.json", "hidden-threads.json"]) {
        rmSync(join(getAccountDir(FAKE_OWN_ID), f), { force: true });
    }
};

describe("conv hidden: the PIN is checked even when nothing is hidden", () => {
    const replies = { getHiddenConversations: { pin: md5(PIN), threads: [] } };

    it("a wrong PIN with zero hidden conversations exits 1 and counts toward the lockout", async () => {
        resetState();
        const r = await run(["conv", "hidden", "--pin-stdin"], { stdin: "0000\n", replies });
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.equal(Object.keys(r.out ?? {})[0], "error", r.stdout);
        assert.match(r.out.error, /Wrong PIN/);
        assert.doesNotMatch(r.stdout, /0000/, "the PIN typed is never printed");
        assert.equal(lockout()?.failures, 1);
    });

    it("the right PIN answers the empty list (exit 0) and clears the count", async () => {
        const r = await run(["conv", "hidden", "--pin-stdin"], { stdin: `${PIN}\n`, replies });
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.deepEqual(r.out, { count: 0, hasPin: true, threads: [] });
        assert.equal(lockout()?.failures, 0);
    });

    it("no terminal and no --pin-stdin: a needs-PIN reply (exit 2), not the list", async () => {
        const r = await run(["conv", "hidden"], { replies });
        assert.equal(r.code, 2, r.stdout + r.stderr);
        assert.equal(r.out?.pinRequired, true);
    });
});

describe("conv archived and conv muted leave hidden chats out", () => {
    const replies = {
        getHiddenConversations: { pin: md5(PIN), threads: [{ thread_id: HIDDEN, is_group: 0 }] },
        getArchivedChatList: {
            items: [
                { id: HIDDEN, type: 0 },
                { id: VISIBLE, type: 0 },
            ],
            version: 3,
        },
        getMute: {
            chatEntries: [
                { id: HIDDEN, duration: -1, muteMode: 1 },
                { id: VISIBLE, duration: -1, muteMode: 1 },
            ],
            groupChatEntries: [],
        },
    };

    it("archived: left out without the PIN; shown with --include-hidden and the PIN", async () => {
        resetState();
        const hidden = await run(["conv", "archived"], { replies });
        assert.equal(hidden.code, 0, hidden.stdout + hidden.stderr);
        assert.deepEqual(hidden.out, { items: [{ id: VISIBLE, type: 0 }], version: 3 });
        const shown = await run(["conv", "archived", "--include-hidden", "--pin-stdin"], {
            stdin: `${PIN}\n`,
            replies,
        });
        assert.equal(shown.code, 0, shown.stdout + shown.stderr);
        assert.deepEqual(
            shown.out.items.map((i) => i.id),
            [HIDDEN, VISIBLE],
        );
        const wrong = await run(["conv", "archived", "--include-hidden", "--pin-stdin"], { stdin: "0000\n", replies });
        assert.equal(wrong.code, 1);
        assert.equal(wrong.stdout.includes(HIDDEN), false);
    });

    it("muted: left out without the PIN; shown with it", async () => {
        resetState();
        const hidden = await run(["conv", "muted"], { replies });
        assert.equal(hidden.code, 0, hidden.stdout + hidden.stderr);
        assert.deepEqual(
            hidden.out.chatEntries.map((m) => m.id),
            [VISIBLE],
        );
        assert.equal(hidden.stdout.includes(HIDDEN), false);
        const shown = await run(["conv", "muted", "--include-hidden", "--pin-stdin"], { stdin: `${PIN}\n`, replies });
        assert.deepEqual(
            shown.out.chatEntries.map((m) => m.id),
            [HIDDEN, VISIBLE],
        );
    });

    it("read run: a read naming a hidden chat is refused (exit 2) before Zalo is asked", async () => {
        resetState();
        const args = JSON.stringify({ oneone: [HIDDEN] });
        const r = await run(["read", "run", "last-seen", "--args", args], {
            replies: { ...replies, "(raw request)": { asked: true } },
        });
        assert.equal(r.code, 2, r.stdout + r.stderr);
        assert.equal(r.out?.hidden, true);
        assert.equal(r.out?.pinRequired, true);
        const visible = await run(["read", "run", "last-seen", "--args", JSON.stringify({ oneone: [VISIBLE] })], {
            replies,
        });
        assert.equal(visible.code, 0, visible.stdout + visible.stderr);
    });
});

describe("mcp approver", () => {
    const SECRET = "fake approver passphrase";
    const file = () => join(getAccountDir(FAKE_OWN_ID), "approver-secret.json");

    it("set --stdin keeps a salted hash only; status says so; remove deletes it; nothing echoes it", async () => {
        const set = await run(["mcp", "approver", "set", "--stdin"], { stdin: `${SECRET}\n` });
        assert.equal(set.code, 0, set.stdout + set.stderr);
        assert.equal(set.out.approverPassword, true);
        assert.equal((set.stdout + set.stderr).includes(SECRET), false);
        // Sealed like the other account secrets (the hash itself is checked in tests/unit/approval-delivery.test.js).
        const stored = readFileSync(file());
        assert.equal(stored.includes(SECRET), false);
        assert.equal(stored.subarray(0, 7).toString(), "ZACSEAL");

        const status = await run(["mcp", "approver", "status"]);
        assert.equal(status.out.approverPassword, true);
        const short = await run(["mcp", "approver", "set", "--stdin"], { stdin: "short\n" });
        assert.equal(short.code, 1);
        const removed = await run(["mcp", "approver", "remove"]);
        assert.deepEqual([removed.code, removed.out.removed], [0, true]);
        assert.equal((await run(["mcp", "approver", "status"])).out.approverPassword, false);
    });

    it("set with no terminal and no --stdin: exit 2, nothing written", async () => {
        const r = await run(["mcp", "approver", "set"]);
        assert.equal(r.code, 2, r.stdout + r.stderr);
        assert.equal(r.out?.approverPassword, undefined);
    });
});
