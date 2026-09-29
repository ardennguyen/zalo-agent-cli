/**
 * Static call-shape analysis for zca-js API calls in `src/`.
 *
 * `zca-api-surface.test.js` asserts that every method we call EXISTS. This
 * asserts that we call it with the right SHAPE — and that gap is where five
 * commands hid, each of which had never worked once:
 *
 *   msg delete    deleteMessage(dest, onlyMe)         called positionally
 *   msg forward   forwardMessage(payload, ids[], type) given a string + string
 *   conv mute     setMute(params, threadID, type)      options object last
 *   conv unmute   same                                  same
 *   conv read     sendSeenEvent(messages, type)         given a bare threadId
 *
 * Every one of them passed the existence test, because the method was real
 * and only the call was wrong. The request went out malformed, Zalo rejected
 * it, the CLI caught the error and printed a clean ✗ with exit 0 — which is
 * indistinguishable from "the server said no" to anyone reading the output.
 *
 * Signatures are read from the `.d.ts` beside each api file, never from a
 * list kept here. A hand-kept list rots at the first zca-js bump and then
 * lies, which is worse than not checking.
 *
 * Derived from agent/docs/audit_zca-call-shapes.md, which established the
 * method against 182 call sites. Read §7 of that document before trusting a
 * green run: this cannot see a transposition of two same-typed arguments
 * held in uninformatively-named variables, and that class needs a live
 * assertion, not static analysis.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** How deep to follow `type A = B` chains before giving up. */
const ALIAS_DEPTH = 6;

// ── signatures ────────────────────────────────────────────────────────────

/**
 * Split a parameter or union list on top-level separators.
 *
 * Bracket- and string-aware, so `{a: string, b: number}` and `Array<A | B>`
 * survive intact.
 *
 * @param {string} text
 * @param {string} sep - "," or "|"
 * @returns {string[]}
 */
export function splitTopLevel(text, sep) {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote && text[i - 1] !== "\\") quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            continue;
        }
        if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
        // The `>` of an arrow closes nothing. `(a: string) => void` inside a
        // parameter list would otherwise drive depth negative and make the
        // next separator look top-level.
        else if (c === ")" || c === "]" || c === "}" || (c === ">" && text[i - 1] !== "=")) depth--;
        else if (c === sep && depth === 0) {
            out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    out.push(text.slice(start));
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Find the index just past the bracket group opening at `from`.
 *
 * @param {string} text
 * @param {number} from - index of the opening bracket
 * @returns {number} index after the matching close, or -1
 */
export function matchBracket(text, from) {
    const open = text[from];
    const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open];
    if (!close) return -1;
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

/**
 * Every `export type` / `export interface` / `export declare enum` under dist.
 *
 * @param {string} distDir
 * @returns {Map<string, {kind: string, body: string, keys?: object}>}
 */
export function buildTypeTable(distDir) {
    const table = new Map();
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
                continue;
            }
            if (!e.name.endsWith(".d.ts")) continue;
            const src = stripComments(readFileSync(p, "utf8"));

            for (const m of src.matchAll(/export\s+type\s+(\w+)\s*=\s*/g)) {
                const start = m.index + m[0].length;
                const semi = findTypeEnd(src, start);
                table.set(m[1], { kind: "alias", body: src.slice(start, semi).trim() });
            }
            for (const m of src.matchAll(/export\s+(?:declare\s+)?enum\s+(\w+)\s*\{/g)) {
                table.set(m[1], { kind: "enum", body: "" });
            }
            for (const m of src.matchAll(/export\s+(?:declare\s+)?interface\s+(\w+)\s*(?:extends[^{]*)?\{/g)) {
                const brace = src.indexOf("{", m.index + m[0].length - 1);
                const end = matchBracket(src, brace);
                table.set(m[1], { kind: "alias", body: src.slice(brace, end) });
            }
        }
    };
    walk(distDir);
    return table;
}

/**
 * Strip block and line comments from a .d.ts.
 *
 * Done before any bracket counting, because zca-js documents these types in
 * prose that contains brackets and arrows. `SendVideoOptions` carries the
 * comment "5.5s => 5.5 * 1000 = 5500"; counting that `>` as a close drove
 * depth negative and truncated the type at `duration`, so `width` and
 * `height` read as undeclared and two correct calls were reported SUSPECT.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * End of a type expression started at `start` (its terminating `;`).
 *
 * Counts only `{}`, `()` and `[]`. Angle brackets are deliberately excluded:
 * a generic never contains a top-level `;`, while `=>` is common and would
 * unbalance the count.
 *
 * @param {string} src
 * @param {number} start
 * @returns {number}
 */
function findTypeEnd(src, start) {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") depth--;
        else if (c === ";" && depth <= 0) return i;
    }
    return src.length;
}

/**
 * Resolve a type expression to a structural kind.
 *
 * ORDER MATTERS: the union split must run BEFORE the `[]` suffix test.
 * `string | string[]` ends in `[]` and is not an array — getting this
 * backwards produced four false WRONGs on the audit's first calibration run,
 * and `assertUnionBeforeArray()` below pins it.
 *
 * @param {string} expr
 * @param {Map} table
 * @param {number} [depth]
 * @returns {{kind: string, keys?: string[], requiredKeys?: string[]}}
 */
export function resolveKind(expr, table, depth = 0) {
    let t = String(expr || "").trim();
    if (!t || depth > ALIAS_DEPTH) return { kind: "unknown" };

    t = t.replace(/^\(\s*(.*)\s*\)$/s, "$1").trim();

    // Unions FIRST — see the note above.
    const parts = splitTopLevel(t, "|").filter((p) => p !== "undefined" && p !== "null");
    if (parts.length > 1) {
        const kinds = [...new Set(parts.map((p) => resolveKind(p, table, depth + 1).kind))];
        return { kind: kinds.length === 1 ? kinds[0] : "union", union: kinds };
    }
    if (parts.length === 1) t = parts[0];

    if (/\[\]$/.test(t) || /^(?:Array|ReadonlyArray)\s*</.test(t)) return { kind: "array" };
    if (/^(?:string|number|boolean|bigint|symbol)$/.test(t)) return { kind: "primitive" };
    if (/^(?:['"`]).*/.test(t)) return { kind: "primitive" }; // string literal type
    if (/^-?\d+$/.test(t)) return { kind: "primitive" };
    if (/^(?:Buffer|Uint8Array|Blob|ArrayBuffer)$/.test(t)) return { kind: "buffer" };
    if (/^(?:any|unknown)$/.test(t)) return { kind: "unknown" };
    if (/^\(.*\)\s*=>/.test(t)) return { kind: "function" };
    if (t.startsWith("{")) {
        const keys = objectKeys(t);
        return { kind: "object", keys: keys.all, requiredKeys: keys.required };
    }

    const bare = t.replace(/<.*>$/s, "").trim();
    const entry = table.get(bare);
    if (entry) {
        if (entry.kind === "enum") return { kind: "enum" };
        return resolveKind(entry.body, table, depth + 1);
    }
    return { kind: "unknown" };
}

/**
 * Top-level keys of an object type literal.
 *
 * @param {string} body - including the braces
 * @returns {{all: string[], required: string[]}}
 */
export function objectKeys(body) {
    const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
    const stripped = inner.replace(/\/\*[\s\S]*?\*\//g, "");
    const all = [];
    const required = [];
    for (const member of splitTopLevel(stripped.replace(/\n/g, " "), ";")) {
        const m = member.match(/^\s*(?:readonly\s+)?\[?["']?([A-Za-z_$][\w$]*)["']?\]?\s*(\?)?\s*:/);
        if (!m) continue;
        all.push(m[1]);
        if (!m[2]) required.push(m[1]);
    }
    return { all, required };
}

/**
 * Extract every factory signature from `dist/apis/*.d.ts`.
 *
 * @param {string} apisDir
 * @param {Map} table
 * @returns {Map<string, {params: object[], source: string}>}
 */
export function extractSignatures(apisDir, table) {
    const sigs = new Map();
    for (const f of readdirSync(apisDir)) {
        if (!f.endsWith(".d.ts")) continue;
        const src = stripComments(readFileSync(join(apisDir, f), "utf8"));
        const m = src.match(/export\s+declare\s+const\s+(\w+)Factory\s*:\s*\(/);
        if (!m) continue;

        // Skip the (ctx, api) group, then take the inner parameter list.
        const ctxOpen = src.indexOf("(", m.index + m[0].length - 1);
        const afterCtx = matchBracket(src, ctxOpen);
        if (afterCtx < 0) continue;
        const arrow = src.indexOf("=>", afterCtx);
        if (arrow < 0) continue;
        const innerOpen = src.indexOf("(", arrow);
        if (innerOpen < 0) continue;
        const innerClose = matchBracket(src, innerOpen);
        if (innerClose < 0) continue;

        const list = src.slice(innerOpen + 1, innerClose - 1);
        const params = splitTopLevel(list, ",").map((p) => {
            const c = p.indexOf(":");
            const rawName = (c < 0 ? p : p.slice(0, c)).trim();
            const type = c < 0 ? "" : p.slice(c + 1).trim();
            const optional = rawName.endsWith("?") || /\bundefined\b/.test(type) || /=/.test(rawName);
            const name = rawName
                .replace(/\?$/, "")
                .replace(/\s*=.*$/, "")
                .trim();
            return { name, optional, type, ...resolveKind(type, table) };
        });
        sigs.set(m[1], { params, source: f });
    }
    return sigs;
}
