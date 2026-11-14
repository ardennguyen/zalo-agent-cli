/**
 * The `za` wrapper (renderZa in src/core/fleet-templates.js), run for real under `sh` with stand-ins for sudo,
 * systemd-run and systemctl on PATH: a Ctrl+C or a stop sent to za reaches the command (systemd-run does not pass a
 * signal on by itself), and the command's exit code is za's.
 *
 * POSIX only: the wrapper is a server script. Skipped on Windows, where `sh` is not the shell it is written for.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { renderZa } from "../../src/core/fleet-templates.js";

assertSandboxed(CONFIG_DIR);

const skip = process.platform === "win32" ? "the wrapper is a POSIX sh script" : false;

let dir;
let za;

/** Write an executable stand-in into `<dir>/bin`. */
function tool(name, body) {
    const file = join(dir, "bin", name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
}

before(() => {
    if (skip) return;
    dir = mkdtempSync(join(tmpdir(), "za-wrapper-"));
    mkdirSync(join(dir, "bin"));
    // sudo runs the command as is.
    tool("sudo", 'exec "$@"');
    // systemd-run: note the unit under its name, then play the command it runs in its own service. The last two
    // arguments are the command's: `exit <n>` ends with that code; anything else runs until a signal reaches the
    // unit (systemctl below drops it in `<unit>.sig`, as systemd delivers it to the service, not to systemd-run)
    // and ends with 128 + its number. Started in the background by a non-interactive sh, the real systemd-run
    // ignores SIGINT itself, which is why a Ctrl+C has to be sent to the unit.
    tool(
        "systemd-run",
        `D=${JSON.stringify(dir)}
unit=; last=; prev=
for a in "$@"; do case "$a" in --unit=*) unit="\${a#--unit=}";; esac; prev="$last"; last="$a"; done
if [ "$prev" = exit ]; then exit "$last"; fi
touch "$D/$unit.active"
i=0
while [ ! -f "$D/$unit.sig" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
sig=$(cat "$D/$unit.sig" 2>/dev/null || echo NONE)
rm -f "$D/$unit.active"
echo "$sig" > "$D/got"
case "$sig" in INT) exit 130 ;; TERM) exit 143 ;; *) exit 99 ;; esac`,
    );
    // systemctl: `kill --signal=X <unit>.service` and `is-active --quiet <unit>.service`.
    tool(
        "systemctl",
        `D=${JSON.stringify(dir)}
case "$1" in
  kill) sig="\${2#--signal=}"; u="\${3%.service}"; echo "$sig" >> "$D/forwarded"; echo "$sig" > "$D/$u.sig" ;;
  is-active) u="\${3%.service}"; [ -f "$D/$u.active" ] ;;
esac`,
    );
    za = join(dir, "za");
    writeFileSync(za, renderZa());
    chmodSync(za, 0o755);
});

after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run za with the stand-ins first on PATH; resolves with its exit code. */
function runZa(args, { signal, afterMs = 400 } = {}) {
    for (const f of ["got", "forwarded"]) rmSync(join(dir, f), { force: true });
    // An unanswered fake ends by itself after 10 s (exit 99), so nothing outlives the test.
    return new Promise((resolve, reject) => {
        const child = spawn("sh", [za, ...args], {
            env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        const killer = signal ? setTimeout(() => child.kill(signal), afterMs) : null;
        const guard = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`za did not finish; stderr: ${err}`));
        }, 15000);
        child.on("exit", (code) => {
            clearTimeout(killer);
            clearTimeout(guard);
            resolve(code);
        });
    });
}

const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim() : null);

describe("the za wrapper", { skip }, () => {
    it("exits with the command's own code (a guarded command still exits 2)", async () => {
        assert.equal(await runZa(["exit", "2"]), 2);
        assert.equal(await runZa(["exit", "0"]), 0);
    });

    it("passes a Ctrl+C on to the command by its unit name", async () => {
        const code = await runZa(["fleet", "status"], { signal: "SIGINT" });
        // Red if za only dies itself: the command never hears of it ("got" stays empty).
        assert.equal(read("got"), "INT");
        assert.equal(read("forwarded"), "INT");
        assert.equal(code, 130, "and za ends with the command's code");
    });

    it("passes a stop (SIGTERM) on the same way", async () => {
        const code = await runZa(["fleet", "status"], { signal: "SIGTERM" });
        assert.equal(read("got"), "TERM");
        assert.equal(code, 143);
    });
});
