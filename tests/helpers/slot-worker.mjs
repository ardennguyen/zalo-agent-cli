/**
 * A child process for tests/unit/startup-gate.test.js. It behaves like a daemon starting up: it enters the
 * gate, "logs in" for a while, and leaves; and it records, under a lock, how many were inside at once.
 *
 *   hold <configDir> <slots> <holdMs> <ownId>   enter, record, hold, record, leave; print { slot }
 *   die  <configDir> <slots> <ownId>            enter, then exit WITHOUT leaving
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStartupGate } from "../../src/core/startup-gate.js";
import { sleepSync, withFileLock } from "../../src/utils/atomic-file.js";

const [mode, configDir, slotsArg, ...rest] = process.argv.slice(2);
const slots = Number(slotsArg);
const settings = { jitterSec: 0, slots, waitSec: 60, holdSec: 300, warnings: [] };

if (mode === "hold") {
    const [holdMs, ownId] = [Number(rest[0]), rest[1]];
    const gate = createStartupGate({ configDir, ownId, settings });
    const { slot } = await gate.enter();
    const file = join(configDir, "concurrency.json");
    const bump = (d) =>
        withFileLock(`${file}.lock`, () => {
            const s = JSON.parse(readFileSync(file, "utf8"));
            s.active += d;
            s.max = Math.max(s.max, s.active);
            writeFileSync(file, JSON.stringify(s));
        });
    bump(1);
    sleepSync(holdMs);
    bump(-1);
    gate.leave();
    console.log(JSON.stringify({ slot }));
} else if (mode === "die") {
    const gate = createStartupGate({ configDir, ownId: rest[0], settings });
    const { slot } = await gate.enter();
    console.log(JSON.stringify({ slot }));
    process.exit(0); // the daemon's own exit paths end like this; the gate must not leave a slot behind
}
