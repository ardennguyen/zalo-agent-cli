/**
 * Log levels, timestamps/JSON and rotation for daemon.log (src/core/log-sink.js).
 *
 * daemon.log used to hold everything a daemon printed, forever: a line per HTTP request, a line per
 * message with its text, no timestamps, and a file that only grew.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import realFs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    DEBUG_MARK,
    DEFAULT_KEEP,
    DEFAULT_MAX_BYTES,
    classifyLine,
    createLogSink,
    createRotatingFile,
    formatLine,
    parseSize,
    resolveLogSettings,
} from "../../src/core/log-sink.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const AT = new Date("2026-10-21T05:30:11.670Z");
const now = () => AT;

/** A sink that collects what it writes. */
function collect(options = {}) {
    const out = [];
    const sink = createLogSink({ write: (t) => out.push(t), now, ...options });
    return { sink, out, lines: () => out.join("").split("\n").filter(Boolean) };
}

describe("classifyLine", () => {
    it("a line that starts with the debug mark is debug", () => {
        assert.equal(classifyLine(`${DEBUG_MARK}[mcp-http] GET /status -> 200`), "debug");
        assert.equal(classifyLine(`${DEBUG_MARK}Failed to be loud`), "debug", "the mark wins over the wording");
    });

    it("failures and refusals are errors", () => {
        for (const l of [
            "[mcp] Failed to start MCP server: EADDRINUSE",
            "  ✗ Invalid port",
            "[listen] Webhook delivery failed (HTTP 503); 3 queued",
            "[mcp] media download failed: timeout",
            "Error: connect ECONNREFUSED 127.0.0.1:1",
            "[accounts] could not update the cached name of 1000",
            "[mcp] Refusing to start: --config names a file it cannot read",
            "[listen] Stop failed: x",
        ]) {
            assert.equal(classifyLine(l), "error", l);
        }
    });

    it("warnings are warnings, with or without colors", () => {
        for (const l of [
            "  ⚠ This tool uses unofficial Zalo APIs",
            "WARNING: webhook backlog: 12 queued",
            "[mcp] WARNING: no --auth token.",
            "\u001b[33m  ⚠ Daemon channel unavailable\u001b[39m",
        ]) {
            assert.equal(classifyLine(l), "warn", l);
        }
    });

    it("everything else is info", () => {
        for (const l of [
            "[mcp] Zalo listener started. MCP server ready.",
            "[mcp] Webhook enabled: http://x (signed), durable outbox",
            "[listen] self-heal: recovered 81 message(s) (0 already cached, 0 removal(s) applied)",
            "  ● Local database initialized at F:\\x",
        ]) {
            assert.equal(classifyLine(l), "info", l);
        }
    });
});

describe("the level filter", () => {
    const sample = [
        `${DEBUG_MARK}[mcp-http] POST /mcp -> 200`,
        `${DEBUG_MARK}[mcp] Buffered group msg from 1`,
        "[mcp] Zalo listener started.",
        "WARNING: coverage: 1 gap(s) not yet recovered",
        "[mcp] Failed to start: boom",
    ];
    const run = (level) => {
        const c = collect({ level });
        c.sink.write(sample.join("\n") + "\n");
        return c.lines().map((l) => l.replace(/^\S+ /, ""));
    };

    it("debug keeps everything", () => assert.equal(run("debug").length, 5));
    it("info (the default) drops the per-request and per-message lines", () => {
        const kept = run("info");
        assert.equal(kept.length, 3);
        assert.ok(kept.every((l) => !l.startsWith(DEBUG_MARK)));
        assert.equal(collect().sink.level(), "info");
    });
    it("warn keeps warnings and errors", () =>
        assert.deepEqual(
            run("warn").map((l) => l.slice(0, 7)),
            ["WARNING", "[mcp] F"],
        ));
    it("error keeps only errors", () => assert.deepEqual(run("error"), ["[mcp] Failed to start: boom"]));

    it("the level can be changed while running", () => {
        const c = collect({ level: "error" });
        c.sink.write("[mcp] started\n");
        c.sink.setLevel("info");
        c.sink.write("[mcp] started again\n");
        assert.equal(c.lines().length, 1);
        c.sink.setLevel("loud"); // not a level: ignored
        assert.equal(c.sink.level(), "info");
    });

    it("a stack trace is kept or dropped with the error above it", () => {
        const trace = "Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)\n";
        const quiet = collect({ level: "error" });
        quiet.sink.write("[mcp] started\n" + trace);
        assert.equal(quiet.lines().length, 3, "the error and both frames");
        const noisy = collect({ level: "warn" });
        noisy.sink.write(`[mcp] started\n${DEBUG_MARK}[mcp] x\n    indented continuation of a debug line\n`);
        assert.equal(noisy.lines().length, 0, "an info line, a debug line and its continuation are all below warn");
    });
});

describe("lines and chunks", () => {
    it("a chunk can hold several lines or half of one", () => {
        const { sink, lines } = collect();
        sink.write("[mcp] one\n[mcp] tw");
        sink.write("o\n[mcp] three");
        sink.write("\n");
        assert.deepEqual(
            lines().map((l) => l.replace(/^\S+ /, "")),
            ["[mcp] one", "[mcp] two", "[mcp] three"],
        );
    });

    it("a partial line is written after a moment, not held for ever", async () => {
        const { sink, lines } = collect({ flushMs: 20 });
        sink.write("[mcp] no newline yet");
        assert.equal(lines().length, 0);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(lines().length, 1);
    });

    it("flush() writes a partial line at once; CRLF and Buffers are fine; blank lines are dropped", () => {
        const { sink, lines } = collect();
        sink.write(Buffer.from("[mcp] a\r\n\r\n\r\n[mcp] b"));
        sink.flush();
        assert.deepEqual(
            lines().map((l) => l.replace(/^\S+ /, "")),
            ["[mcp] a", "[mcp] b"],
        );
    });
});

describe("timestamps and JSON", () => {
    it("text lines start with an ISO timestamp", () => {
        const { sink, lines } = collect();
        sink.write("[mcp] ready\n");
        assert.deepEqual(lines(), ["2026-10-21T05:30:11.670Z [mcp] ready"]);
    });

    it("JSON is one object per line with time, level, account and the message without colors or the debug mark", () => {
        const { sink, lines } = collect({ format: "json", level: "debug", accountId: "A1" });
        sink.write(`${DEBUG_MARK}[mcp] Buffered group msg\n\u001b[36m  ● hello\u001b[39m\n[mcp] Failed: x\n`);
        const objs = lines().map((l) => JSON.parse(l));
        assert.deepEqual(objs, [
            { ts: "2026-10-21T05:30:11.670Z", level: "debug", account: "A1", msg: "[mcp] Buffered group msg" },
            { ts: "2026-10-21T05:30:11.670Z", level: "info", account: "A1", msg: "  ● hello" },
            { ts: "2026-10-21T05:30:11.670Z", level: "error", account: "A1", msg: "[mcp] Failed: x" },
        ]);
    });

    it("a hostile line cannot break the JSON", () => {
        const { sink, lines } = collect({ format: "json" });
        sink.write('[mcp] say "hi"\\ and a tab\there\n');
        assert.equal(JSON.parse(lines()[0]).msg, '[mcp] say "hi"\\ and a tab\there');
    });

    it("formatLine omits the account when there is none", () => {
        assert.equal(JSON.parse(formatLine({ line: "x", level: "info", format: "json", at: AT })).account, undefined);
    });
});

describe("settings", () => {
    it("default to info, text, 50 MB and three rotated files", () => {
        const s = resolveLogSettings({ env: {} });
        assert.deepEqual(
            [s.level, s.format, s.maxBytes, s.keep, s.warnings, s.explicit],
            ["info", "text", DEFAULT_MAX_BYTES, DEFAULT_KEEP, [], false],
        );
    });

    it("flag beats NAME_<ownId> beats NAME", () => {
        const env = { ZALO_LOG_LEVEL: "warn", ZALO_LOG_LEVEL_1001: "debug" };
        assert.equal(resolveLogSettings({ env, ownId: "1001" }).level, "debug");
        assert.equal(resolveLogSettings({ env, ownId: "1002" }).level, "warn");
        assert.equal(resolveLogSettings({ env, ownId: "1001", levelFlag: "error" }).level, "error");
        assert.equal(resolveLogSettings({ env: { ZALO_LOG_LEVEL: "DEBUG" } }).level, "debug", "case does not matter");
    });

    it("anything asked for makes it explicit, so a foreground run knows to filter", () => {
        assert.equal(resolveLogSettings({ env: { ZALO_LOG_FORMAT: "json" } }).explicit, true);
        assert.equal(resolveLogSettings({ env: {}, levelFlag: "info" }).explicit, true);
        assert.equal(resolveLogSettings({ env: { ZALO_LOG_KEEP: "5" } }).explicit, false, "rotation alone does not");
    });

    it("an unusable value falls back to the default and says so", () => {
        const s = resolveLogSettings({
            env: { ZALO_LOG_LEVEL: "loud", ZALO_LOG_FORMAT: "xml", ZALO_LOG_MAX_SIZE: "2k", ZALO_LOG_KEEP: "-1" },
        });
        assert.deepEqual([s.level, s.format, s.maxBytes, s.keep], ["info", "text", DEFAULT_MAX_BYTES, DEFAULT_KEEP]);
        assert.equal(s.warnings.length, 4);
        assert.match(s.warnings.join("\n"), /log level "loud"/);
        assert.match(s.warnings.join("\n"), /at least 4k/);
    });

    it("parses sizes", () => {
        assert.equal(parseSize("20m"), 20 * 1024 * 1024);
        assert.equal(parseSize("500K"), 500 * 1024);
        assert.equal(parseSize("1g"), 1024 ** 3);
        assert.equal(parseSize("1.5m"), Math.floor(1.5 * 1024 * 1024));
        assert.equal(parseSize("4096"), 4096);
        for (const bad of ["", "big", "-1m", "5x", null, undefined]) assert.equal(parseSize(bad), null, String(bad));
    });
});

describe("the rotating file", () => {
    let dir;
    let file;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-logrot-"));
        file = join(dir, "daemon.log");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const names = () => readdirSync(dir).sort();

    it("rotates daemon.log to .1, .2, ... and drops the oldest beyond keep", () => {
        const rot = createRotatingFile({ file, maxBytes: 1000, keep: 2 });
        for (let i = 0; i < 100; i++) rot.write(`line ${String(i).padStart(3, "0")} ${"x".repeat(40)}\n`);
        rot.close();
        assert.deepEqual(names(), ["daemon.log", "daemon.log.1", "daemon.log.2"], "never a .3");
        for (const f of names()) assert.ok(statSync(join(dir, f)).size < 1200, `${f} stays about the limit`);
        const all = names()
            .map((n) => readFileSync(join(dir, n), "utf8"))
            .join("");
        assert.ok(all.includes("line 099"), "the newest line is kept");
        assert.ok(!all.includes("line 000"), "the oldest rotated out");
    });

    it("the new file says it was rotated, and the previous one is the .1", () => {
        const rot = createRotatingFile({ file, maxBytes: 500, keep: 1 });
        for (let i = 0; i < 12; i++) rot.write(`line ${i} ${"x".repeat(60)}\n`);
        rot.close();
        assert.match(readFileSync(file, "utf8"), /^--- \[\S+\] log rotated: the previous file is daemon\.log\.1 ---/);
        assert.ok(readFileSync(`${file}.1`, "utf8").startsWith("line 0 "));
    });

    it("keep 0 starts over instead of keeping a copy", () => {
        const rot = createRotatingFile({ file, maxBytes: 500, keep: 0 });
        for (let i = 0; i < 20; i++) rot.write(`line ${i} ${"x".repeat(60)}\n`);
        rot.close();
        assert.deepEqual(names(), ["daemon.log"]);
        assert.match(readFileSync(file, "utf8"), /log was discarded/);
    });

    it("picks up the size of a file that already exists", () => {
        writeFileSync(file, "y".repeat(900));
        const rot = createRotatingFile({ file, maxBytes: 1000, keep: 1 });
        rot.write("z".repeat(200) + "\n");
        rot.close();
        assert.ok(existsSync(`${file}.1`), "900 bytes of history plus 200 crossed the limit");
    });

    it("a refused rename (a tail has the file open on Windows) is retried later and nothing is lost", () => {
        let renames = 0;
        const flaky = {
            openSync: (...a) => realFs.openSync(...a),
            closeSync: (...a) => realFs.closeSync(...a),
            writeSync: (...a) => realFs.writeSync(...a),
            fstatSync: (...a) => realFs.fstatSync(...a),
            unlinkSync: (...a) => realFs.unlinkSync(...a),
            renameSync: () => {
                renames++;
                throw Object.assign(new Error("busy"), { code: "EBUSY" });
            },
        };
        const rot = createRotatingFile({ file, maxBytes: 600, keep: 2, fsImpl: flaky });
        for (let i = 0; i < 30; i++)
            rot.write(`line ${String(i).padStart(2, "0")} ${"x".repeat(50)}
`);
        rot.close();
        assert.ok(renames >= 1, "it tried");
        const text = readFileSync(file, "utf8");
        assert.ok(text.includes("line 00") && text.includes("line 29"), "every line is still in the one file");
        assert.deepEqual(names(), ["daemon.log"]);
    });

    it("a log that cannot be written never throws into the daemon", () => {
        const rot = createRotatingFile({ file: join(dir, "no", "such", "dir", "daemon.log"), maxBytes: 1000, keep: 1 });
        assert.doesNotThrow(() => rot.write("x\n"));
    });

    it("a sink in front of a rotating file writes filtered, timestamped lines and rotates", () => {
        const rot = createRotatingFile({ file, maxBytes: 4096, keep: 2 });
        const sink = createLogSink({ write: rot.write, level: "info", now });
        for (let i = 0; i < 200; i++) {
            sink.write(`${DEBUG_MARK}[mcp] Buffered group msg ${i}\n`);
            sink.write(`[mcp] state change ${i} ${"x".repeat(30)}\n`);
        }
        rot.close();
        const all = names()
            .map((n) => readFileSync(join(dir, n), "utf8"))
            .join("");
        assert.ok(!all.includes("Buffered"), "debug lines never reached the file");
        assert.ok(all.includes("2026-10-21T05:30:11.670Z [mcp] state change 199"));
        assert.ok(names().length >= 2, "and it rotated");
    });
});

describe("the HTTP request line", () => {
    it("is a debug line, so the default level leaves it out of daemon.log", async () => {
        const lines = [];
        const real = console.error;
        console.error = (...a) => lines.push(a.join(" "));
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: ".",
        };
        const server = createHTTPServer(() => {}, deps, 0, "T0KEN", "127.0.0.1");
        try {
            if (!server.listening) await once(server, "listening");
            await fetch(`http://127.0.0.1:${server.address().port}/health`);
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            console.error = real;
            server.close();
        }
        const request = lines.find((l) => l.includes("[mcp-http] GET /health"));
        assert.ok(request, "the request is logged");
        assert.ok(request.startsWith(DEBUG_MARK), "as a debug line");
        assert.equal(classifyLine(request), "debug");
    });
});

describe("configureLogging in a foreground run", () => {
    const channel = new URL("../../src/core/daemon-channel.js", import.meta.url).href;
    /** Run a script that configures logging, writes to stderr, and report what stderr got. */
    function run(options, env = {}) {
        const script = `
            import { configureLogging } from ${JSON.stringify(channel)};
            configureLogging(${JSON.stringify(options)});
            console.error("[mcp] started fine");
            console.error("[mcp] Failed to do a thing");
            console.error(${JSON.stringify(`${DEBUG_MARK}[mcp-http] GET /x -> 200`)});
            process.stdout.write("stdout is the output and is never filtered\\n");
        `;
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            env: { ...process.env, ZALO_LOG_LEVEL: "", ZALO_LOG_FORMAT: "", ...env },
        });
        return { stdout: r.stdout, lines: r.stderr.split("\n").filter(Boolean) };
    }

    it("with nothing asked for, stderr is left exactly as it was", () => {
        const r = run({ ownId: "1" });
        assert.deepEqual(r.lines, [
            "[mcp] started fine",
            "[mcp] Failed to do a thing",
            `${DEBUG_MARK}[mcp-http] GET /x -> 200`,
        ]);
    });

    it("--log-level error filters stderr and timestamps what is left, and never touches stdout", () => {
        const r = run({ ownId: "1", levelFlag: "error" });
        assert.equal(r.lines.length, 1);
        assert.match(r.lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z \[mcp\] Failed to do a thing$/);
        assert.equal(r.stdout, "stdout is the output and is never filtered\n");
    });

    it("ZALO_LOG_LEVEL=debug in the environment keeps the per-request lines, with timestamps", () => {
        const r = run({ ownId: "1" }, { ZALO_LOG_LEVEL: "debug" });
        assert.equal(r.lines.length, 3);
        assert.match(r.lines[2], /\[debug\] \[mcp-http\] GET \/x -> 200$/);
    });

    it("the process that only launches a daemon is not filtered: it talks to the user", () => {
        const r = run({ ownId: "1", levelFlag: "error", filterStderr: false });
        assert.equal(r.lines.length, 3);
        assert.ok(
            r.lines.every((l) => !/^\d{4}-/.test(l)),
            "no timestamps either",
        );
    });
});
