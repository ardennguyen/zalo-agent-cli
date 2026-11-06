/**
 * Compare what two engines did, field by field, and fail on every difference that is not declared.
 *
 * A difference is `{field, index, zca, own}`: `field` is a dotted path (`service`, `queryOrder`,
 * `params.nretry`, `headers.accept-language`, `parts.0.sha256`, `result.msgId`, `error.code`, `event.args.0.type`),
 * `index` the request (or event, or frame) it is in, null for the call's outcome.
 *
 * An allowed difference is a row `{method, field, zca, own, why, when?, id?}` (tests/helpers/wire-diff/allow.js):
 *
 * - `method` is the method (or listener script) it is for, or `"*"` for a global row. A row for the method shadows
 *   any global row on the same field.
 * - `field` is the path, exactly, or a prefix ending in `.*` (`params.*`).
 * - `zca` and `own` are the two values: a value compared deep and strict (`undefined` = absent), or a predicate
 *   `(value, ctx) => boolean`, where `ctx` is `{zca, own, index}` (the two requests, events or outcomes).
 * - `when(ctx)` limits a row to the requests it is about. A global row must have one.
 *
 * And every declared difference must be there: a method row nothing matched fails, and a global row whose `when`
 * holds for a request fails unless that request shows the difference. So a row cannot go stale silently.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

/** Request fields that are compared whole: a reordering is the difference, not each slot. */
const WHOLE = new Set(["queryOrder", "paramsOrder", "formOrder"]);

/** The request fields, in the order a failure lists them. */
const REQUEST_FIELDS = [
    "method",
    "service",
    "path",
    "queryOrder",
    "query",
    "params",
    "paramsOrder",
    "rawParams",
    "headers",
    "form",
    "formOrder",
    "parts",
    "body",
];

/**
 * True for an object whose fields should be compared one by one.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlain(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Push the leaf differences between `a` and `b` under `path`.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} path
 * @param {number|null} index
 * @param {Array<object>} out
 */
function deepDiff(a, b, path, index, out) {
    if (isDeepStrictEqual(a, b)) return;
    if (isPlain(a) && isPlain(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        for (const k of keys) deepDiff(a[k], b[k], `${path}.${k}`, index, out);
        return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        a.forEach((x, i) => deepDiff(x, b[i], `${path}.${i}`, index, out));
        return;
    }
    out.push({ field: path, index, zca: a, own: b });
}

/**
 * The differences between two normalized requests.
 *
 * @param {object} a - zca's request (tests/helpers/wire-diff/normalize.js `normalizeRequest`)
 * @param {object} b - ours
 * @param {number} index
 * @returns {Array<object>}
 */
export function diffRequests(a, b, index) {
    const out = [];
    for (const f of REQUEST_FIELDS) {
        // The encrypted bytes are compared only when the decrypted params and their key order agree: then any
        // byte difference is one nothing else shows (a nested key order, the encoding). Otherwise it would only
        // repeat the params difference.
        if (
            f === "rawParams" &&
            !(isDeepStrictEqual(a.params, b.params) && isDeepStrictEqual(a.paramsOrder, b.paramsOrder))
        ) {
            continue;
        }
        if (WHOLE.has(f)) {
            if (!isDeepStrictEqual(a[f], b[f])) out.push({ field: f, index, zca: a[f], own: b[f] });
        } else {
            deepDiff(a[f], b[f], f, index, out);
        }
    }
    return out;
}

/**
 * Every difference between the two sides of a {@link import("./index.js").openPair} `run` record.
 *
 * @param {{zca: {requests: object[], result?: unknown, error: object|null},
 *   own: {requests: object[], result?: unknown, error: object|null}}} rec
 * @returns {Array<{field: string, index: number|null, zca: unknown, own: unknown}>}
 */
export function diffRecords(rec) {
    const out = [];
    const za = rec.zca.requests;
    const ow = rec.own.requests;
    if (za.length !== ow.length) out.push({ field: "requests.length", index: null, zca: za.length, own: ow.length });
    const n = Math.min(za.length, ow.length);
    for (let i = 0; i < n; i++) out.push(...diffRequests(za[i], ow[i], i));
    deepDiff(rec.zca.result, rec.own.result, "result", null, out);
    deepDiff(rec.zca.error ?? null, rec.own.error ?? null, "error", null, out);
    return out;
}

/**
 * Pair two sequences by their longest common run of equal items; what is left between two anchors is paired by
 * position while both sides have one, and is extra on one side after that.
 *
 * @param {unknown[]} a
 * @param {unknown[]} b
 * @returns {Array<[number|null, number|null]>} index pairs; null where a side has nothing
 */
function align(a, b) {
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = isDeepStrictEqual(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    let gapA = [];
    let gapB = [];
    const flush = () => {
        const k = Math.min(gapA.length, gapB.length);
        for (let x = 0; x < k; x++) pairs.push([gapA[x], gapB[x]]);
        for (let x = k; x < gapA.length; x++) pairs.push([gapA[x], null]);
        for (let x = k; x < gapB.length; x++) pairs.push([null, gapB[x]]);
        gapA = [];
        gapB = [];
    };
    while (i < n && j < m) {
        if (isDeepStrictEqual(a[i], b[j])) {
            flush();
            pairs.push([i++, j++]);
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            gapA.push(i++);
        } else {
            gapB.push(j++);
        }
    }
    while (i < n) gapA.push(i++);
    while (j < m) gapB.push(j++);
    flush();
    return pairs;
}

/**
 * The differences between two sequences (events, frames), aligned by {@link align}: an item on one side only is
 * a difference on `field` itself, with `undefined` on the other side.
 *
 * @param {unknown[]} a
 * @param {unknown[]} b
 * @param {string} field
 * @param {(x: unknown, y: unknown, index: number, out: object[]) => void} [pairDiff] - for a paired item
 * @returns {Array<object>}
 */
function diffSequences(a, b, field, pairDiff) {
    const out = [];
    for (const [i, j] of align(a, b)) {
        const index = i ?? j;
        const before = out.length;
        if (i === null || j === null) {
            out.push({ field, index, zca: i === null ? undefined : a[i], own: j === null ? undefined : b[j] });
        } else if (pairDiff) {
            pairDiff(a[i], b[j], index, out);
        } else {
            deepDiff(a[i], b[j], field, index, out);
        }
        // What a row's predicates see for these differences: the two items themselves.
        const ctx = { zca: i === null ? undefined : a[i], own: j === null ? undefined : b[j], index };
        for (let k = before; k < out.length; k++) Object.defineProperty(out[k], "ctx", { value: ctx });
    }
    return out;
}

/**
 * Every difference between the two sides of an {@link import("./listener-pair.js").openListenerPair} `play`.
 *
 * @param {{zca: object[], own: object[], zcaSent: object[], ownSent: object[],
 *   headers: {zca: object|null, own: object|null}}} played
 * @returns {Array<{field: string, index: number|null, zca: unknown, own: unknown}>}
 */
export function diffListener(played) {
    const out = [];
    out.push(...diffSequences(played.zca, played.own, "event"));
    out.push(
        ...diffSequences(played.zcaSent, played.ownSent, "sent", (x, y, index, acc) => {
            // Bytes only when the parsed frames agree, as for rawParams.
            const { bytes: bx, ...px } = x;
            const { bytes: by, ...py } = y;
            const before = acc.length;
            deepDiff(px, py, "sent", index, acc);
            if (acc.length === before && bx !== by) acc.push({ field: "sent.bytes", index, zca: bx, own: by });
        }),
    );
    deepDiff(played.headers?.zca ?? null, played.headers?.own ?? null, "upgrade", null, out);
    return out;
}

/**
 * True when a row's field covers a difference's field.
 *
 * @param {string} rowField
 * @param {string} field
 * @returns {boolean}
 */
function covers(rowField, field) {
    if (rowField === field) return true;
    return rowField.endsWith(".*") && field.startsWith(rowField.slice(0, -1));
}

/**
 * True when a declared value (a value or a predicate) matches what was seen.
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {object} ctx
 * @returns {boolean}
 */
function matches(expected, actual, ctx) {
    return typeof expected === "function" ? !!expected(actual, ctx) : isDeepStrictEqual(expected, actual);
}

/**
 * Refuse a malformed row: a typo in one would silently allow nothing or everything.
 *
 * @param {object} row
 */
function checkRow(row) {
    const where = `allow row ${JSON.stringify({ method: row?.method, field: row?.field })}`;
    assert.ok(row && typeof row.method === "string" && row.method, `${where}: no method`);
    assert.ok(typeof row.field === "string" && row.field, `${where}: no field`);
    assert.ok("zca" in row && "own" in row, `${where}: must declare both the zca and the own value`);
    assert.ok(typeof row.why === "string" && row.why.trim(), `${where}: must say why`);
    if (row.method === "*") assert.equal(typeof row.when, "function", `${where}: a global row needs when()`);
}

/**
 * Short text of a value for a failure message.
 *
 * @param {unknown} v
 * @returns {string}
 */
function show(v) {
    if (v === undefined) return "(absent)";
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * Check a list of differences against the allowed rows; throw one AssertionError naming every unexplained
 * difference and every declared difference that is not there.
 *
 * @param {object} p
 * @param {string} p.name - the method or script name the rows are matched on
 * @param {Array<object>} p.diffs
 * @param {Array<object>} p.allow
 * @param {(index: number|null) => object} p.contextOf - the `ctx` a row sees for a difference at `index`
 * @param {number[]} p.indexes - every index a global row's `when` is asked about
 */
export function checkAllowed({ name, diffs, allow, contextOf, indexes }) {
    for (const row of allow) checkRow(row);
    const own = allow.filter((r) => r.method === name);
    const shadowed = new Set(own.map((r) => r.field));
    const active = [...own, ...allow.filter((r) => r.method === "*" && !shadowed.has(r.field))];
    const used = new Map();
    const problems = [];

    for (const d of diffs) {
        const ctx = d.ctx ?? contextOf(d.index);
        const row = active.find(
            (r) =>
                covers(r.field, d.field) &&
                (!r.when || r.when(ctx)) &&
                matches(r.zca, d.zca, ctx) &&
                matches(r.own, d.own, ctx),
        );
        if (!row) {
            const at = d.index === null ? "" : ` [${d.index}]`;
            problems.push(`differs: ${d.field}${at}: zca ${show(d.zca)}, own ${show(d.own)}`);
            continue;
        }
        if (!used.has(row)) used.set(row, new Set());
        used.get(row).add(d.index);
    }

    for (const row of active) {
        if (row.method !== "*") {
            if (!used.has(row)) problems.push(`declared but absent: ${row.field} (${row.why})`);
            continue;
        }
        for (const i of indexes) {
            if (row.when(contextOf(i)) && !used.get(row)?.has(i)) {
                problems.push(`declared but absent: ${row.field} [${i}] (global row ${row.id ?? ""}: ${row.why})`);
            }
        }
    }

    if (problems.length) {
        throw new assert.AssertionError({
            message: `${name}: zca and own differ beyond what is allowed:\n  ${problems.join("\n  ")}`,
            actual: problems,
            expected: [],
            operator: "assertSameWire",
        });
    }
}

/**
 * Assert that the zca and own sides of one `pair.run` record made the same requests and came to the same outcome,
 * apart from the differences `allow` declares, every one of which must be present.
 *
 * @param {{name: string, zca: object, own: object}} rec
 * @param {Array<object>} [allow]
 */
export function assertSameWire(rec, allow = []) {
    const n = Math.min(rec.zca.requests.length, rec.own.requests.length);
    checkAllowed({
        name: rec.name,
        diffs: diffRecords(rec),
        allow,
        contextOf: (i) =>
            i === null
                ? { zca: rec.zca, own: rec.own, index: null }
                : { zca: rec.zca.requests[i], own: rec.own.requests[i], index: i },
        indexes: [...Array(n).keys()],
    });
}

/**
 * Assert that two listeners, fed one script, emitted the same events, sent the same frames and upgraded with the
 * same headers, apart from what `allow` declares (rows are matched on `name`, the script's name).
 *
 * @param {{zca: object[], own: object[], zcaSent: object[], ownSent: object[], headers: object}} played
 * @param {Array<object>} [allow]
 * @param {{name?: string}} [opts]
 */
export function assertSameListener(played, allow = [], { name = "listener" } = {}) {
    checkAllowed({
        name,
        diffs: diffListener(played),
        allow,
        // Event and frame differences carry their own context (the two items); this is the upgrade's.
        contextOf: () => ({ zca: played.headers?.zca, own: played.headers?.own, index: null }),
        indexes: [],
    });
}
