/**
 * Disposable-target registry and blast-radius guard for the live E2E suite.
 *
 * The whole safety model of the live tests rests on one rule: a destructive
 * command may only ever be pointed at an id this file has explicitly blessed
 * as disposable. `assertDisposable()` is called by every destructive helper
 * in `live.js`, so a typo'd or drifted thread id fails *before* the network
 * call rather than after it.
 *
 * The denylist exists because the account under test has a real group whose
 * name differs from the disposable one by a four-character suffix
 * ("Việc riêng" vs "Việc riêng - AI test"). Name-based resolution is exactly
 * the kind of thing that silently picks the wrong one, so the precious id is
 * named outright and checked first.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TARGETS_PATH = resolve(import.meta.dirname, "..", "targets.json");
const EXAMPLE_PATH = resolve(import.meta.dirname, "..", "targets.example.json");

const PLACEHOLDER = /^PUT_[A-Z_]+_HERE$|^MEMBER_ID_\d+$/;

function isPlaceholder(v) {
    return typeof v !== "string" || v === "" || PLACEHOLDER.test(v);
}

let _cache = null;

/**
 * Load and validate tests/targets.json.
 * @returns {{configured: boolean, reason?: string, targets?: object}}
 */
export function loadTargets() {
    if (_cache) return _cache;

    if (!existsSync(TARGETS_PATH)) {
        _cache = {
            configured: false,
            reason: `tests/targets.json not found — copy ${EXAMPLE_PATH} to ${TARGETS_PATH} and fill it in`,
        };
        return _cache;
    }

    let raw;
    try {
        raw = JSON.parse(readFileSync(TARGETS_PATH, "utf-8"));
    } catch (e) {
        _cache = { configured: false, reason: `tests/targets.json is not valid JSON: ${e.message}` };
        return _cache;
    }

    const group = raw?.disposable?.group ?? {};
    const dm = raw?.disposable?.dm ?? {};
    const denylist = Array.isArray(raw?.denylist) ? raw.denylist.map(String) : [];

    const problems = [];
    if (isPlaceholder(raw?.accountOwnId)) problems.push("accountOwnId is unset");
    if (isPlaceholder(group.threadId)) problems.push("disposable.group.threadId is unset");
    if (isPlaceholder(group.name)) problems.push("disposable.group.name is unset");

    // An id that is both disposable and denylisted is a configuration bug
    // serious enough to refuse the whole run, not just that one target.
    const blessed = [group.threadId, dm.threadId].filter((x) => !isPlaceholder(x)).map(String);
    for (const id of blessed) {
        if (denylist.includes(id)) problems.push(`${id} is listed as BOTH disposable and denylisted`);
    }
    if (blessed.includes(String(raw?.accountOwnId))) {
        problems.push("a disposable target is the account's own id — self-chat is not a valid Zalo thread");
    }
    if ((group.memberIds || []).map(String).includes(String(raw?.accountOwnId))) {
        problems.push("disposable.group.memberIds contains your own ownId — group create adds the owner implicitly");
    }

    if (problems.length) {
        _cache = { configured: false, reason: problems.join("; ") };
        return _cache;
    }

    _cache = {
        configured: true,
        targets: {
            path: TARGETS_PATH,
            home: raw.home || process.env.USERPROFILE || process.env.HOME,
            accountOwnId: String(raw.accountOwnId),
            group: {
                threadId: String(group.threadId),
                name: String(group.name),
                memberIds: (group.memberIds || []).map(String),
                type: 1,
            },
            dm: isPlaceholder(dm.threadId)
                ? null
                : { threadId: String(dm.threadId), name: String(dm.name || dm.threadId), type: 0 },
            denylist,
        },
    };
    return _cache;
}

/**
 * Throw unless `threadId` is one of the blessed disposable targets.
 * Every destructive helper funnels through this.
 *
 * @param {string} threadId
 * @param {string} [what] - label for the error message, e.g. "conv delete"
 */
export function assertDisposable(threadId, what = "destructive operation") {
    const { configured, reason, targets } = loadTargets();
    if (!configured) throw new Error(`Refusing ${what}: targets not configured (${reason})`);

    const id = String(threadId);

    if (targets.denylist.includes(id)) {
        throw new Error(`Refusing ${what} on ${id}: thread is on the tests/targets.json DENYLIST.`);
    }
    const allowed = [targets.group.threadId, targets.dm?.threadId].filter(Boolean);
    if (!allowed.includes(id)) {
        throw new Error(
            `Refusing ${what} on ${id}: not a disposable target.\n` +
                `Allowed: ${allowed.join(", ")}\n` +
                `If this is intentional, add it to tests/targets.json under "disposable".`,
        );
    }
    return id;
}

/**
 * Persist a new group threadId after the tier-5 disperse/recreate cycle.
 * Rewrites only that one field, preserving formatting-insignificant content.
 * @param {string} newThreadId
 */
export function updateGroupThreadId(newThreadId) {
    const raw = JSON.parse(readFileSync(TARGETS_PATH, "utf-8"));
    const old = raw.disposable.group.threadId;
    raw.disposable.group.threadId = String(newThreadId);
    raw.$rotatedAt = new Date().toISOString();
    raw.$previousGroupThreadId = old;
    writeFileSync(TARGETS_PATH, JSON.stringify(raw, null, 4) + "\n", "utf-8");
    _cache = null; // force reload so assertDisposable() blesses the new id
    return { old, next: String(newThreadId) };
}
