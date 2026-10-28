/**
 * A child process for the registry and lock tests: it does one kind of work against a throwaway config
 * directory and prints one JSON line. Not a test file; `tests/unit/registry-safety.test.js` spawns it.
 *
 *   writer <dir> <firstId> <count> <ms> [min]   rename accounts firstId..firstId+count-1 over and over, for <ms> and
 *                                               for at least [min] renames however long that takes
 *   reader <dir> <ms> <expectedCount>      read the registry over and over, count the bad reads
 *   adder  <dir> <id>                      addAccount(id)
 *   counter <dir> <file> <n>               add 1 to a number in <file>, n times, under the registry's lock helper
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [role, dir, ...rest] = process.argv.slice(2);
process.env.ZALO_CONFIG_DIR = dir;
process.env.ZALO_SANDBOX_ACTIVE = "1";

const accounts = await import("../../src/core/accounts.js");
const { withFileLock, sleepSync } = await import("../../src/utils/atomic-file.js");

if (role === "writer") {
    const [first, count, ms, min = 0] = rest.map(Number);
    const last = {};
    let writes = 0;
    let failed = 0;
    const deadline = Date.now() + ms;
    // For the time asked and for at least `min` writes: a machine under load must not decide how much work a test does.
    while (Date.now() < deadline || writes < min) {
        const id = String(first + (writes % count));
        const name = `w${first}-${writes}`;
        // `false` means it was not written (a busy registry, say); only a write that happened is recorded.
        // A writer may wait as long as it takes: this test is about renames lost or a registry corrupted, and a
        // machine under load (a gate run beside other work) must not turn a long wait for the lock into a failure.
        if (accounts.updateAccountName(id, name, { lockTimeoutMs: 120_000 })) last[id] = name;
        else failed++;
        writes++;
        sleepSync(2); // a daemon refreshes a name now and then; this is that, a thousand times faster
    }
    console.log(JSON.stringify({ role, writes, failed, last }));
} else if (role === "reader") {
    const [ms, expected] = rest.map(Number);
    let reads = 0;
    let bad = 0;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        reads++;
        try {
            if (accounts.listAccounts().length !== expected) bad++;
            sleepSync(1); // a CLI command reads the registry once; this is a thousand of them a second
        } catch {
            bad++;
        }
    }
    console.log(JSON.stringify({ role, reads, bad }));
} else if (role === "adder") {
    accounts.addAccount(rest[0], `n${rest[0]}`, null);
    console.log(JSON.stringify({ role }));
} else if (role === "counter") {
    const file = rest[0];
    const n = Number(rest[1]);
    for (let i = 0; i < n; i++) {
        withFileLock(
            join(dir, "counter.lock"),
            () => {
                const v = Number(readFileSync(file, "utf8"));
                // A real read-modify-write has a gap between the read and the write; so does this one.
                sleepSync(1);
                writeFileSync(file, String(v + 1));
            },
            // About lost updates, not timing: a loaded machine may make a process wait far longer than the default.
            { timeoutMs: 120_000 },
        );
    }
    console.log(JSON.stringify({ role, n }));
}
