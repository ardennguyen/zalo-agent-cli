# Test Guide

## Running Tests

```bash
npm test       # run all unit + CLI interface tests
npm run lint   # check code style (ESLint)
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

### Testing `db.js` (SQLite layer)

The SQLite layer (`src/core/db.js`) is fully testable without a Zalo session. Use a **temp directory** so tests never write to `~/.zalo-agent-cli/`:

```js
// src/core/db.test.js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { openDb, upsertMessage, getCachedMessages, searchMessages, closeDb } from "./db.js";

// Redirect CONFIG_DIR to a temp dir so db.js writes there
const tmpHome = mkdtempSync(join(tmpdir(), "zalo-db-test-"));
process.env.HOME = tmpHome; // db.js uses homedir() → re-set before import

describe("db.js", () => {
    const ownId = "test-account-123";

    after(() => {
        closeDb(ownId);
        rmSync(tmpHome, { recursive: true, force: true });
    });

    it("openDb creates schema without error", () => {
        assert.doesNotThrow(() => openDb(ownId));
    });

    it("upsertMessage stores a message", () => {
        upsertMessage(ownId, { msgId: "msg1", threadId: "t1", threadType: 0, content: "hello world", timestamp: 1000 });
        const rows = getCachedMessages(ownId, "t1");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "hello world");
    });

    it("upsertMessage is idempotent (ON CONFLICT UPDATE)", () => {
        upsertMessage(ownId, { msgId: "msg1", threadId: "t1", threadType: 0, content: "updated", timestamp: 2000 });
        const rows = getCachedMessages(ownId, "t1");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "updated");
    });

    it("searchMessages finds content via FTS5", () => {
        upsertMessage(ownId, { msgId: "msg2", threadId: "t1", threadType: 0, content: "chúc mừng sinh nhật", timestamp: 3000 });
        const results = searchMessages(ownId, "sinh nhật");
        assert.ok(results.length >= 1);
        assert.ok(results.some((r) => r.content.includes("sinh nhật")));
    });

    it("getCachedMessages returns results newest-first", () => {
        const rows = getCachedMessages(ownId, "t1", { limit: 10 });
        assert.ok(rows[0].timestamp >= rows[rows.length - 1].timestamp);
    });
});
```

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

**3. For SQLite-backed commands** (e.g. `msg search`, `conv recent --no-cache`),
also add a unit test in `src/core/db.test.js` to exercise the cache logic directly.

**4. Manual test** entry in TEST.md E2E checklist (if needs Zalo session).

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

## Lint / Static Analysis

```bash
npm run lint         # check only
npm run lint:fix     # auto-fix safe issues
npm run format       # prettier formatting
npm run format:check # check formatting without writing
```

Lint runs **automatically before every `npm publish`** via the `prepublishOnly` hook:

```json
"prepublishOnly": "npm run lint && npm test"
```

### CI Equivalent

If you add GitHub Actions, the recommended workflow step is:

```yaml
- name: Lint & Test
  run: |
    npm ci
    npm run lint
    npm test
```

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

### Local Cache & Full-Text Search (v1.1.0)

- [ ] `zalo-agent listen` — shows `[db] Local SQLite cache active` message on startup
- [ ] After receiving a message in `listen`, `~/.zalo-agent-cli/accounts/<id>/zalo.db` exists
- [ ] `zalo-agent conv recent` — on second run shows `(from local cache)` in output
- [ ] `zalo-agent conv recent --no-cache` — bypasses cache, fetches live from Zalo
- [ ] `zalo-agent msg history <THREAD_ID>` — on second run reads from cache (instant)
- [ ] `zalo-agent msg history <THREAD_ID> --no-cache` — forces live Zalo fetch + backfills cache
- [ ] `zalo-agent msg search "hello"` — returns cached messages matching the query
- [ ] `zalo-agent msg search "hello" --thread <ID>` — scoped to specific thread
- [ ] `zalo-agent msg search "nonexistent"` — returns "No cached messages matched"
- [ ] `zalo-agent msg search "hello"` with no cache — returns instructive error message
- [ ] Starting two `listen` processes on same account — second one exits with lock error
- [ ] After Ctrl+C on `listen` — `zalo.lock` file is removed
- [ ] `zalo-agent mcp start` — shows `[mcp] Local SQLite cache active` message on startup
- [ ] After receiving a message via MCP, `zalo.db` is populated (verify with `msg history`)
- [ ] `zalo_get_history` MCP tool (no `no_cache`) — returns `"source": "cache"` when cache is seeded
- [ ] `zalo_get_history` MCP tool with `no_cache: true` — returns `"source": "live"` and backfills cache
- [ ] `friend list --no-cache` — bypasses local contacts cache and fetches from Zalo
- [ ] `friend search "Name" --no-cache` — fetches live when cache exists

### Friends

- [ ] `zalo-agent friend list` — lists friends (from cache on second run)
- [ ] `zalo-agent friend list --no-cache` — bypasses cache, fetches live, re-seeds
- [ ] `zalo-agent friend search "Name"` — searches cache if seeded
- [ ] `zalo-agent friend search "Name" --no-cache` — forces live fetch
- [ ] `zalo-agent friend find <phone>` — finds user (always live)
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
