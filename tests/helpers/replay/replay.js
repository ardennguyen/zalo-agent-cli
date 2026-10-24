/**
 * The replay harness: does what our code sent look like what the official Zalo
 * Web client sends?
 *
 * Two kinds of comparison, both against hand-written shapes (see ./shapes.js):
 *
 *   - **A sequence of HTTP requests** (`diffSequence`): the calls our code made
 *     through the fake server, in order, against a list of expected calls. It
 *     reports a missing call, a call out of order, a surplus call on a path the
 *     shape covers, a forbidden call, and per-call differences in method, host,
 *     query keys, query values and form keys.
 *   - **One socket frame body** (`diffBody`): a request our code put on the wire
 *     against the expected key set, level by level.
 *
 * A comparison returns a list of mismatches; an empty list means "conforms".
 * `assertConforms` turns a non-empty list into one failure that names every
 * mismatch, so a drift is read off the failure message instead of debugged.
 *
 * The harness decides nothing about whether a difference is a bug: the shapes
 * say what the official client does, and a test says which differences are
 * known today (pinned) and which must disappear (a `todo` target).
 */
import assert from "node:assert/strict";

/**
 * @typedef {object} CallShape
 * @property {string} id - a stable name, used in mismatch messages
 * @property {string} method - "GET" or "POST"
 * @property {string} host - the exact host, or "service:<key>" for a service-map host (matched by `hostOf`)
 * @property {string} [path] - the exact path
 * @property {string} [pathEndsWith] - a path suffix, for calls whose prefix is not pinned
 * @property {boolean} [repeats] - the call may be made several times in a row (a long poll)
 * @property {{required?: string[], forbidden?: string[], equals?: object}} [query]
 * @property {{required?: string[], forbidden?: string[], equals?: object}} [form]
 */

/**
 * @typedef {object} ObservedCall
 * @property {string} method
 * @property {string} host
 * @property {string} path
 * @property {object} query
 * @property {object|null} [form]
 */

/** Whether an observed call is the call a shape describes (host, method and path; not its fields). */
function sameEndpoint(call, shape, hostOf) {
    if (call.method !== shape.method) return false;
    const host = shape.host.startsWith("service:") ? hostOf(shape.host.slice("service:".length)) : shape.host;
    if (call.host !== host) return false;
    if (shape.path !== undefined) return call.path === shape.path;
    return call.path.endsWith(shape.pathEndsWith);
}

/** Field-level differences between one call and its shape. */
function diffFields(call, shape) {
    const out = [];
    for (const [where, spec, got] of [
        ["query", shape.query, call.query ?? {}],
        ["form", shape.form, call.form ?? {}],
    ]) {
        if (!spec) continue;
        for (const k of spec.required ?? []) {
            if (!(k in got)) out.push(`${shape.id}: ${where} key "${k}" is missing`);
        }
        for (const k of spec.forbidden ?? []) {
            if (k in got) out.push(`${shape.id}: ${where} key "${k}" must not be sent`);
        }
        for (const [k, v] of Object.entries(spec.equals ?? {})) {
            if (!(k in got)) out.push(`${shape.id}: ${where} key "${k}" is missing (expected "${v}")`);
            else if (String(got[k]) !== String(v))
                out.push(`${shape.id}: ${where} "${k}" is "${got[k]}", expected "${v}"`);
        }
    }
    return out;
}

/**
 * Compare observed HTTP calls against the expected sequence.
 *
 * Calls on hosts or paths the shapes do not mention are ignored (the npm
 * version probe, say). A call the shapes DO cover but cannot place is reported:
 * the same call twice where the shape wants it once, or a covered call before
 * the step it belongs to.
 *
 * @param {ObservedCall[]} observed - in the order they were made
 * @param {CallShape[]} sequence - the expected calls, in order
 * @param {object} [opts]
 * @param {(serviceKey: string) => string} [opts.hostOf] - resolves "service:<key>" to a host
 * @param {Array<{host: string, path: string}>} [opts.forbidden] - calls that must not happen at all
 * @returns {string[]} mismatches; empty when the sequence conforms
 */
export function diffSequence(observed, sequence, { hostOf = (k) => k, forbidden = [] } = {}) {
    const out = [];
    const used = new Set();
    let cursor = 0;

    for (const shape of sequence) {
        // First look for the call at or after the cursor, then anywhere (out of order).
        let at = -1;
        for (let i = cursor; i < observed.length; i++) {
            if (!used.has(i) && sameEndpoint(observed[i], shape, hostOf)) {
                at = i;
                break;
            }
        }
        if (at === -1) {
            const early = observed.findIndex((c, i) => !used.has(i) && sameEndpoint(c, shape, hostOf));
            const wrongHost = observed.findIndex(
                (c, i) =>
                    !used.has(i) &&
                    c.method === shape.method &&
                    (shape.path !== undefined ? c.path === shape.path : c.path.endsWith(shape.pathEndsWith)),
            );
            if (early === -1 && wrongHost !== -1) {
                const want = shape.host.startsWith("service:")
                    ? hostOf(shape.host.slice("service:".length))
                    : shape.host;
                out.push(`${shape.id}: sent to ${observed[wrongHost].host}, expected ${want}`);
                used.add(wrongHost);
            } else if (early === -1) out.push(`${shape.id}: the call was never made`);
            else {
                out.push(`${shape.id}: made out of order (call #${early + 1}, before its place in the sequence)`);
                used.add(early);
                out.push(...diffFields(observed[early], shape));
            }
            continue;
        }
        used.add(at);
        cursor = at + 1;
        out.push(...diffFields(observed[at], shape));
    }

    // A call on a path the sequence covers that no step claimed is a surplus.
    for (let i = 0; i < observed.length; i++) {
        if (used.has(i)) continue;
        const covered = sequence.find(
            (s) =>
                (s.path !== undefined ? observed[i].path === s.path : observed[i].path.endsWith(s.pathEndsWith)) &&
                observed[i].method === s.method,
        );
        if (!covered) continue;
        // A long poll is asked again until it answers: allowed, but each ask must still be well formed.
        if (covered.repeats) out.push(...diffFields(observed[i], covered));
        else out.push(`${covered.id}: made again (call #${i + 1}), the sequence has it once per step`);
    }

    for (const f of forbidden) {
        const n = observed.filter((c) => c.host === f.host && c.path === f.path).length;
        if (n > 0) out.push(`forbidden call ${f.host}${f.path} was made ${n} time(s)`);
    }
    return out;
}

/**
 * @typedef {object} BodyShape
 * @property {string[]} [required] - keys that must be present
 * @property {string[]} [forbidden] - keys that must be absent
 * @property {object} [equals] - keys that must equal these values
 * @property {Record<string, BodyShape>} [nested] - shapes for object-valued keys
 */

/**
 * Compare one frame body against its expected key set, level by level.
 *
 * @param {object} body - what our code sent
 * @param {BodyShape} shape
 * @param {string} [label] - names the frame in messages, e.g. "590"
 * @returns {string[]} mismatches; empty when the body conforms
 */
export function diffBody(body, shape, label = "body") {
    const out = [];
    const got = body && typeof body === "object" ? body : {};
    for (const k of shape.required ?? []) {
        if (!(k in got)) out.push(`${label}: key "${k}" is missing`);
    }
    for (const k of shape.forbidden ?? []) {
        if (k in got) out.push(`${label}: key "${k}" must not be sent`);
    }
    for (const [k, v] of Object.entries(shape.equals ?? {})) {
        if (!(k in got)) out.push(`${label}: key "${k}" is missing (expected ${JSON.stringify(v)})`);
        else if (got[k] !== v) out.push(`${label}: "${k}" is ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`);
    }
    for (const [k, sub] of Object.entries(shape.nested ?? {})) {
        if (k in got) out.push(...diffBody(got[k], sub, `${label}.${k}`));
    }
    return out;
}

/**
 * Fail with every mismatch at once.
 *
 * @param {string[]} mismatches - from diffSequence or diffBody
 * @param {string} [what] - what was compared, for the failure message
 */
export function assertConforms(mismatches, what = "the requests") {
    assert.deepEqual(mismatches, [], `${what} do not conform to the official shape:\n  - ${mismatches.join("\n  - ")}`);
}
