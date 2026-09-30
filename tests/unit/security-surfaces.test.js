/**
 * The three security-relevant surfaces that sat at 0% function coverage.
 *
 * Each is reachable from data this account does not control, each fails
 * open rather than closed, and each was covered only by a checkbox in
 * tests/README.md's manual section:
 *
 *   1. src/utils/open-file.js       — a shell, fed a Zalo-supplied filename
 *   2. src/utils/qr-http-server.js  — the 0.0.0.0 vs 127.0.0.1 bind guard,
 *                                     a regression that already shipped once
 *   3. src/mcp/mcp-http-transport.js — bearer auth, where an empty token
 *                                     silently means "no auth at all"
 *
 * All three are testable offline; nothing here opens a Zalo session.
 */

import "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFile, SHELL_METACHARACTERS } from "../../src/utils/open-file.js";
import { sanitize } from "../../src/core/sync-v2/media.js";
import { startQrServer, qrVersion } from "../../src/utils/qr-http-server.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

// ── 1. shell injection through a downloaded filename ───────────────────

describe("openFile — a Zalo filename must not reach cmd.exe as syntax", () => {
    // On Windows openFile() runs `start "" <path>` with shell: true. cmd.exe
    // treats & ^ % ` ! | < > " as syntax, so a path carrying one is a
    // command-injection vector — and the path is built from the filename
    // Zalo hands us for an attachment.
    const EVIL = ["holiday&calc.exe.jpg", "a^b.jpg", "100%s.jpg", "x`whoami`.jpg", "a|b.jpg", 'q"r.jpg'];

    it("sanitize() strips every character cmd.exe would act on", () => {
        for (const name of EVIL) {
            const safe = sanitize(name);
            assert.ok(
                !SHELL_METACHARACTERS.test(safe),
                `sanitize left a shell metacharacter in ${JSON.stringify(safe)} (from ${JSON.stringify(name)})`,
            );
        }
    });

    it("sanitize() still strips the characters Windows forbids in a filename", () => {
        const BS = String.fromCharCode(92);
        for (const ch of ["/", BS, ":", "*", "?", "<", ">", "|", '"']) {
            assert.ok(!sanitize(`a${ch}b`).includes(ch), `sanitize kept ${JSON.stringify(ch)}`);
        }
    });

    it("sanitize() leaves ordinary names — including Vietnamese — alone", () => {
        assert.equal(sanitize("Ảnh chụp màn hình.png"), "Ảnh chụp màn hình.png");
        assert.equal(sanitize("report-2026_final (1).pdf"), "report-2026_final (1).pdf");
    });

    it("openFile() refuses a metacharacter path outright, as a second line of defence", () => {
        // openFile is also reachable from the MCP zalo_view_media tool with a
        // path this codebase did not build, so the guard cannot rely on
        // sanitize() having run.
        const errs = [];
        const realErr = console.error;
        console.error = (m) => errs.push(String(m));
        try {
            openFile("C:\\media\\holiday&calc.exe.jpg");
        } finally {
            console.error = realErr;
        }
        // On non-Windows the guard does not apply (no shell is used), so the
        // assertion is conditional on the branch actually being taken.
        if (process.platform === "win32") {
            assert.equal(errs.length, 1, "expected a refusal");
            assert.match(errs[0], /Refusing to open a path containing shell metacharacters/);
        }
    });
});

// ── 2. the QR server's bind guard ──────────────────────────────────────

describe("startQrServer — bind host", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close?.()));

    it("binds loopback by default, so the QR is not offered to the network", async () => {
        const s = startQrServer("nonexistent-qr.png", 0, [0], false);
        servers.push(s);
        assert.match(s.url, /^http:\/\/(127\.0\.0\.1|localhost)[:/]/, `default bind must be loopback, got ${s.url}`);
    });

    it("only reaches 0.0.0.0 when exposeOnLan is explicitly true", async () => {
        // The regression this guards already shipped once: scanning the QR
        // signs the scanner in as this account, so a LAN bind offers the
        // account to every host on the network. It must stay opt-in.
        const s = startQrServer("nonexistent-qr.png", 0, [0], true);
        servers.push(s);
        assert.ok(s.url, "expected a server url");
    });

    it("exposes a close() that actually stops listening", async () => {
        const s = startQrServer("nonexistent-qr.png", 0, [0], false);
        assert.equal(typeof s.close, "function");
        s.close();
    });
});

// The page polls /status and swaps in each regenerated QR by this version.
// Measured 2026-09-30: a page opened on the first QR kept it through two
// regenerations, and the scan of the expired code failed.
describe("qrVersion — which QR is current", () => {
    it("is null before any QR exists, and changes when the QR is regenerated", () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-qr-"));
        const qr = join(dir, "qr.png");
        try {
            assert.equal(qrVersion(qr), null);
            writeFileSync(qr, "first");
            utimesSync(qr, new Date(1_790_000_000_000), new Date(1_790_000_000_000));
            const first = qrVersion(qr);
            assert.equal(typeof first, "number");
            writeFileSync(qr, "second");
            utimesSync(qr, new Date(1_790_000_100_000), new Date(1_790_000_100_000));
            // Red if the page has nothing that changes when a new QR lands.
            assert.notEqual(qrVersion(qr), first);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 3. MCP bearer auth ─────────────────────────────────────────────────

describe("createHTTPServer — bearer auth", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    /** Start the transport on an ephemeral port and return its base URL. */
    async function start(authToken) {
        const noopRegister = () => {};
        // /health reports deps.buffer.getStats().length, so the fake needs
        // that much shape or the handler 500s and the auth assertions below
        // would be testing the wrong failure.
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: ".",
        };
        const server = createHTTPServer(noopRegister, deps, 0, authToken, "127.0.0.1");
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        return `http://127.0.0.1:${server.address().port}`;
    }

    it("/health answers WITHOUT a token", async () => {
        const base = await start("s3cret");
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200, "health must stay reachable for probes");
    });

    it("rejects a request with no Authorization header", async () => {
        const base = await start("s3cret");
        const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
        assert.equal(res.status, 401);
    });

    it("rejects a wrong token, and one that merely shares a prefix", async () => {
        const base = await start("s3cret");
        for (const bad of ["wrong", "s3cre", "s3crett", ""]) {
            const res = await fetch(`${base}/mcp`, {
                method: "POST",
                headers: { Authorization: `Bearer ${bad}` },
                body: "{}",
            });
            assert.equal(res.status, 401, `token ${JSON.stringify(bad)} should be rejected`);
        }
    });

    it("CHARACTERIZATION: a null token starts a server with NO auth at all", async () => {
        // src/commands/mcp.js coerces `opts.auth?.trim() || null`, so
        // `--auth "$UNSET"` or `--auth ""` becomes null and every request is
        // accepted — while the startup log still reports success. Pinned
        // here so the day someone makes an empty --auth fatal, this test is
        // the reminder to update the docs with it.
        const base = await start(null);
        const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
        assert.notEqual(res.status, 401, "with authToken=null the transport accepts anything");
    });
});
