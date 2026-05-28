# Test Guide

## Running Tests

```bash
npm test
```

Runs unit tests (core/utils) + CLI interface tests. No Zalo session needed.

---

## Writing Tests — Contributor Guide

### Framework

We use **Node.js built-in test runner** (`node:test` + `node:assert`). No external test framework.

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
```

### File Naming

| Pattern | Example | Location |
|---------|---------|----------|
| Unit tests | `*.test.js` | Same dir as source: `src/utils/proxy-helpers.test.js` |
| CLI tests | `cli.test.js` | `src/cli.test.js` |

Test file must sit **next to** the module it tests:

```
src/utils/
├── bank-helpers.js          # Source
├── bank-helpers.test.js     # Tests for bank-helpers.js
├── proxy-helpers.js
└── proxy-helpers.test.js
```

### Test Structure

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { myFunction } from "./my-module.js";

describe("myFunction", () => {
    it("does the expected thing", () => {
        assert.equal(myFunction("input"), "expected");
    });

    it("handles edge case", () => {
        assert.equal(myFunction(null), null);
    });

    it("throws on invalid input", () => {
        assert.throws(() => myFunction(undefined), /error message/);
    });
});
```

### Assertions Cheat Sheet

```js
assert.equal(actual, expected);           // strict equality
assert.deepEqual(actual, expected);       // deep object equality
assert.ok(value);                         // truthy
assert.match(string, /regex/);            // regex match
assert.throws(() => fn(), /msg/);         // expect throw
assert.doesNotThrow(() => fn());          // expect no throw
assert.equal(typeof result, "string");    // type check
```

### Testing File I/O (credentials, accounts)

For modules that read/write files (`credentials.js`, `accounts.js`), use a **temp directory** to avoid touching the real `~/.zalo-agent-cli/`:

```js
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("credentials", () => {
    let tmpDir;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "zalo-test-"));
        // Override CONFIG_DIR if module supports it,
        // or test functions that accept path params
    });

    after(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("saves and loads credentials", () => {
        // test using tmpDir...
    });
});
```

### Testing CLI Commands

Use `execFileSync` to run CLI commands and check output:

```js
import { execFileSync } from "child_process";
import { resolve } from "path";

const CLI = resolve(import.meta.dirname, "index.js");

function run(...args) {
    return execFileSync("node", [CLI, ...args], {
        encoding: "utf-8",
        timeout: 10000,
        // Use fake HOME to avoid touching real credentials
        env: { ...process.env, HOME: "/tmp/zalo-agent-cli-test-home" },
    });
}

it("--help shows msg command", () => {
    const out = run("--help");
    assert.match(out, /msg/);
});
```

**Important:** Set `HOME` to a temp path so tests never read/write real credentials.

### What to Test vs What NOT to Test

**DO test:**
- Pure functions (bank BIN resolution, proxy masking, output formatting)
- File I/O logic (save/load/delete credentials, account registry CRUD)
- CLI argument parsing (--help, --version, subcommand listing)
- Input validation (content length limits, unknown bank names)
- Edge cases (null, undefined, empty strings, special characters)

**DO NOT test (in automated tests):**
- Anything requiring a real Zalo session (login, send message, friend list)
- Network calls to external APIs (qr.sepay.vn, Zalo servers)
- QR code scanning flow

These belong in the [Manual E2E Checklist](#manual-e2e-checklist) below.

### Adding Tests for a New Command

When you add a new command, add tests at **two levels**:

**1. Unit test** for the core logic (if any new utility functions):
```js
// src/utils/my-new-helper.test.js
describe("myNewHelper", () => { ... });
```

**2. CLI interface test** in `src/cli.test.js`:
```js
it("my-new-command --help shows expected options", () => {
    const out = run("my-new-command", "--help");
    assert.match(out, /--expected-flag/);
});
```

**3. Manual test** entry in TEST.md E2E checklist (if needs Zalo session).

### Running a Single Test File

```bash
node --test src/utils/proxy-helpers.test.js
```

### Security in Tests

- **NEVER** use real credentials, user IDs, or phone numbers in test code
- **NEVER** commit test output that contains sensitive data
- **ALWAYS** use temp directories for file-based tests
- **ALWAYS** set `HOME` to temp path in CLI tests

---

## Manual E2E Checklist

These tests require a real Zalo account and phone for QR scanning.

### Login

- [ ] `zalo-agent login` — QR appears in terminal ASCII, scan works, credentials saved
- [ ] `zalo-agent login --proxy http://user:pass@host:port` — login via proxy, QR works
- [ ] `zalo-agent login --qr-url` — HTTP server starts, QR viewable at localhost URL
- [ ] `zalo-agent login --credentials ./creds.json` — skip QR, login from exported file
- [ ] Auto-login on subsequent commands (no manual login needed)

### Logout

- [ ] `zalo-agent logout` — session cleared, credentials kept, auto-login works next time
- [ ] `zalo-agent logout --purge` — credentials deleted, account removed, QR file removed
- [ ] After purge: `~/.zalo-agent-cli/credentials/` is empty, `accounts.json` is `[]`

### Account Management

- [ ] `zalo-agent account list` — shows all accounts with masked proxy
- [ ] `zalo-agent account info` — shows active account details
- [ ] `zalo-agent account login --proxy URL --name "Shop"` — adds new account
- [ ] `zalo-agent account switch <ID>` — switches active, re-logins with correct proxy
- [ ] `zalo-agent account export -o ./creds.json` — file created with 0600 perms
- [ ] `zalo-agent account remove <ID>` — account + credentials deleted

### Messaging

- [ ] `zalo-agent msg send <ID> "text"` — message delivered
- [ ] `zalo-agent msg send -t 1 <GROUP_ID> "text"` — group message delivered
- [ ] `zalo-agent msg send-image <ID> ./photo.jpg` — image delivered
- [ ] `zalo-agent msg send-file <ID> ./doc.pdf` — file delivered
- [ ] `zalo-agent msg send-card <ID> <USER_ID>` — contact card sent
- [ ] `zalo-agent msg send-bank <ID> 79797 -b ocb` — bank card sent
- [ ] `zalo-agent msg send-qr-transfer <ID> 79797 -b ocb -a 100000 -m "test"` — QR image sent
- [ ] `zalo-agent msg send-qr-transfer` with `--template qronly` — bare QR
- [ ] `zalo-agent msg send-qr-transfer` with content > 50 chars — rejected with error

### Friends

- [ ] `zalo-agent friend list` — lists friends
- [ ] `zalo-agent friend find <phone>` — finds user
- [ ] `zalo-agent friend info <ID>` — shows profile

### Groups

- [ ] `zalo-agent group list` — lists groups

### JSON Output

- [ ] `zalo-agent --json account list` — valid JSON output
- [ ] `zalo-agent --json status` — valid JSON output

### Security Verification

- [ ] Proxy passwords never visible in any command output (always `***`)
- [ ] `ls -la ~/.zalo-agent-cli/credentials/` — all files show `-rw-------` (0600)
- [ ] `ls -la ~/.zalo-agent-cli/accounts.json` — shows `-rw-------` (0600)
- [ ] After `logout --purge`: grep for imei/cookie in `~/.zalo-agent-cli/` returns nothing

### Cross-Platform (if testing on multiple OS)

- [ ] QR ASCII renders correctly in terminal
- [ ] `~/.zalo-agent-cli/` directory created automatically
- [ ] File permissions set correctly (Unix: 0600, Windows: inherited)
