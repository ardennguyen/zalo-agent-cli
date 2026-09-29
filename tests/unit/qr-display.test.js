/**
 * Tests for QR display utility — JSON mode structured output for AI agents.
 *
 * Lived at src/utils/qr-display.test.js until 2026-09-29, where it had no
 * sandbox and so created, wrote and unlinked inside the DEVELOPER'S REAL
 * ~/.zalo-agent-cli/. qr-display.js freezes QR_PATH from CONFIG_DIR at
 * module-eval time, and CONFIG_DIR is frozen from os.homedir(), so the only
 * way to redirect it is to set HOME/USERPROFILE before the first import --
 * which is exactly what helpers/sandbox.js does, and why it must come first.
 *
 * The residue was real: an empty .zalo-agent-cli existed in the developer's
 * home directory purely because `npm test` had run. Running the pre-commit
 * gate while a `zalo-agent login` QR was pending would unlink qr.png out
 * from under the login flow.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { displayQR, getQRPath } from "../../src/utils/qr-display.js";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";

it("operates inside the test sandbox", () => {
    assertSandboxed(SANDBOX_CONFIG_DIR);
    assert.ok(
        getQRPath().startsWith(SANDBOX_CONFIG_DIR),
        `qr.png would be written outside the sandbox: ${getQRPath()}`,
    );
});

// Tiny valid 1x1 white PNG as base64 (for testing without real QR)
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("displayQR", () => {
    let originalLog;
    let captured;

    beforeEach(() => {
        // Capture console.log output
        originalLog = console.log;
        captured = [];
        console.log = (...args) => captured.push(args.join(" "));

        // Ensure config dir exists for file save
        const qrDir = dirname(getQRPath());
        mkdirSync(qrDir, { recursive: true });
    });

    afterEach(() => {
        console.log = originalLog;
        delete process.env.ZALO_JSON_MODE;

        // Clean up saved QR file
        try {
            unlinkSync(getQRPath());
        } catch {}
    });

    it("JSON mode outputs structured event with all fields", () => {
        process.env.ZALO_JSON_MODE = "1";
        displayQR({ data: { image: TINY_PNG_B64 } });

        assert.equal(captured.length, 1, "should output exactly one JSON line");
        const parsed = JSON.parse(captured[0]);
        assert.equal(parsed.event, "qr");
        assert.equal(parsed.image, TINY_PNG_B64);
        assert.ok(parsed.file.endsWith("qr.png"), "file path should end with qr.png");
        assert.ok(parsed.dataUrl.startsWith("data:image/png;base64,"), "dataUrl should be a data URL");
        assert.ok(parsed.dataUrl.includes(TINY_PNG_B64), "dataUrl should contain full base64");
    });

    it("JSON mode does not output terminal escape sequences", () => {
        process.env.ZALO_JSON_MODE = "1";

        // Also capture stdout.write
        const stdoutWrites = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = (data) => stdoutWrites.push(data);

        displayQR({ data: { image: TINY_PNG_B64 } });

        process.stdout.write = originalWrite;

        // No iTerm2 escape sequences
        const hasEscape = stdoutWrites.some((w) => typeof w === "string" && w.includes("\x1b]1337"));
        assert.ok(!hasEscape, "JSON mode should not output terminal escape sequences");
    });

    it("saves QR PNG file in both modes", () => {
        process.env.ZALO_JSON_MODE = "1";
        displayQR({ data: { image: TINY_PNG_B64 } });
        assert.ok(existsSync(getQRPath()), "QR PNG should be saved to disk");
    });

    it("handles empty image gracefully in JSON mode", () => {
        process.env.ZALO_JSON_MODE = "1";
        displayQR({ data: {} });
        assert.equal(captured.length, 0, "should not output anything for empty image");
    });

    it("human mode outputs data URL with full base64 (not truncated)", () => {
        // No ZALO_JSON_MODE set = human mode
        // Suppress stdout.write (terminal escapes)
        const originalWrite = process.stdout.write;
        process.stdout.write = () => true;

        displayQR({ data: { image: TINY_PNG_B64 } });

        process.stdout.write = originalWrite;

        // Find the data URL line in captured output
        const dataUrlLine = captured.find((line) => line.startsWith("data:image/png;base64,"));
        assert.ok(dataUrlLine, "should output a data URL line");
        assert.ok(dataUrlLine.includes(TINY_PNG_B64), "data URL should contain full base64, not truncated");
        assert.ok(!dataUrlLine.includes("..."), "data URL should not be truncated with ...");
    });
});
