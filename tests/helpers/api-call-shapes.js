/**
 * Static call-shape analysis for the session calls in `src/`.
 *
 * `api-surface.test.js` asserts that every method we call EXISTS. This
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
 * Signatures are read from the JSDoc `@param` comments of the session's own
 * methods (src/zalo/api/*.js and src/zalo/api.js), never from a list kept
 * here. A hand-kept list rots at the first change and then lies, which is
 * worse than not checking.
 *
 * This cannot see a transposition of two same-typed arguments held in
 * uninformatively-named variables; that class needs a live assertion, not
 * static analysis.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { walkAst } from "./api-call-sites.js";

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
 * The `@param` entries of a JSDoc comment body, in order: `{name, type, optional}`. A name in brackets is
 * optional (`[name]`, `[name=default]`); a dotted name (`options.page`) is a key of the parameter before the dot.
 *
 * @param {string} body - the comment text between the delimiters
 * @returns {Array<{name: string, type: string, optional: boolean}>}
 */
export function jsdocParams(body) {
    const text = body
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, ""))
        .join("\n");
    const out = [];
    const re = /@param\s+\{/g;
    let m;
    while ((m = re.exec(text))) {
        const open = m.index + m[0].length - 1;
        const close = matchBracket(text, open);
        if (close < 0) continue;
        const type = text
            .slice(open + 1, close - 1)
            .replace(/\s+/g, " ")
            .trim();
        const rest = /^\s*(\[[^\]]+\]|[\w$.]+)/.exec(text.slice(close));
        if (!rest) continue;
        let name = rest[1];
        const optional = name.startsWith("[");
        if (optional) name = name.slice(1, -1).split("=")[0].trim();
        out.push({ name, type, optional });
    }
    return out;
}

/**
 * A JSDoc type in the shape {@link resolveKind} reads: an object literal's members separated by `;` as in
 * TypeScript (JSDoc writes `,`), a nullable `?T` or optional `T=` reduced to `T`, `object` and `Object` as the empty
 * object type, and `Function` as a function.
 *
 * @param {string} type
 * @returns {string}
 */
export function jsdocType(type) {
    const t = String(type ?? "")
        .trim()
        .replace(/^\?/, "")
        .replace(/=$/, "");
    if (/^(?:object|Object)$/.test(t)) return "{}";
    if (t === "Function") return "() => void";
    if (t === "*") return "any";
    // Every object literal, innermost first: its top-level commas become semicolons.
    let out = "";
    for (let i = 0; i < t.length; i++) {
        if (t[i] !== "{") {
            out += t[i];
            continue;
        }
        const end = matchBracket(t, i);
        if (end < 0) {
            out += t.slice(i);
            break;
        }
        const inner = jsdocType(t.slice(i + 1, end - 1));
        out += `{${splitTopLevel(inner, ",").join("; ")}}`;
        i = end - 1;
    }
    return out;
}

/**
 * One parameter of a signature, its kind resolved; an object parameter documented by dotted entries
 * (`@param {object} options` then `@param {number} [options.page]`) gets those keys.
 *
 * @param {{name: string, type: string, optional: boolean}} p
 * @param {Array<{name: string, type: string, optional: boolean}>} all - every entry of the comment
 * @param {Map} table
 * @returns {object}
 */
function paramOf(p, all, table) {
    const resolved = resolveKind(jsdocType(p.type), table);
    const dotted = all.filter((q) => q.name.startsWith(`${p.name}.`) && !q.name.slice(p.name.length + 1).includes("."));
    if (resolved.kind === "object" && dotted.length && !resolved.keys?.length) {
        resolved.keys = dotted.map((q) => q.name.slice(p.name.length + 1));
        resolved.requiredKeys = dotted.filter((q) => !q.optional).map((q) => q.name.slice(p.name.length + 1));
    }
    return { name: p.name, optional: p.optional, type: p.type, ...resolved };
}

/**
 * The JSDoc comment that ends right before `pos` (only whitespace between), or null.
 *
 * @param {string} src
 * @param {Array<{type: string, value: string, start: number, end: number}>} comments
 * @param {number} pos
 * @returns {string|null}
 */
function docBefore(src, comments, pos) {
    let best = null;
    for (const c of comments) if (c.type === "Block" && c.value.startsWith("*") && c.end <= pos) best = c;
    return best && /^\s*$/.test(src.slice(best.end, pos)) ? best.value : null;
}

/**
 * Every method of the session object and its declared signature, read from the JSDoc of the area modules
 * (`src/zalo/api/*.js`: the `@param` comment over each method the `<area>Methods(s)` factory returns) and of the
 * session object itself (`src/zalo/api.js`: the `api.<name> = ...` assignments).
 *
 * @param {string} zaloDir - src/zalo
 * @returns {{signatures: Map<string, {params: object[], source: string, arity: number|null}>, undocumented: string[]}}
 *   `undocumented`: methods with no `@param` comment to read (a method with no parameters needs none)
 */
export function extractSignatures(zaloDir) {
    const table = new Map();
    const signatures = new Map();
    const undocumented = [];
    const files = [
        ...readdirSync(join(zaloDir, "api"))
            .filter((f) => f.endsWith(".js"))
            .map((f) => join(zaloDir, "api", f)),
        join(zaloDir, "api.js"),
    ];
    for (const file of files) {
        const src = readFileSync(file, "utf8");
        const comments = [];
        const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", onComment: comments });
        const source = file.slice(zaloDir.length + 1).replace(/\\/g, "/");
        const add = (name, doc, fn) => {
            const arity = fn && Array.isArray(fn.params) ? fn.params.length : null;
            const entries = doc ? jsdocParams(doc) : [];
            if (arity && !entries.length) undocumented.push(`${source}: ${name}`);
            const params = entries.filter((p) => !p.name.includes(".")).map((p) => paramOf(p, entries, table));
            signatures.set(name, { params, source, arity });
        };
        walkAst(ast, (node) => {
            // An area factory: `export function <area>Methods(s) { ...; return {...}; }`.
            if (node.type === "FunctionDeclaration" && /Methods$/.test(node.id?.name ?? "")) {
                const locals = new Map();
                for (const st of node.body.body) {
                    if (st.type === "VariableDeclaration") {
                        for (const d of st.declarations) {
                            if (/Function/.test(d.init?.type ?? "")) {
                                locals.set(d.id.name, { doc: docBefore(src, comments, st.start), fn: d.init });
                            }
                        }
                    } else if (st.type === "FunctionDeclaration") {
                        locals.set(st.id.name, { doc: docBefore(src, comments, st.start), fn: st });
                    } else if (st.type === "ReturnStatement" && st.argument?.type === "ObjectExpression") {
                        for (const p of st.argument.properties) {
                            if (p.type !== "Property") continue;
                            const name = p.key.name ?? p.key.value;
                            const local = p.value.type === "Identifier" ? locals.get(p.value.name) : null;
                            const doc = docBefore(src, comments, p.start) ?? local?.doc ?? null;
                            add(name, doc, local ? local.fn : p.value);
                        }
                    }
                }
            }
            // The session object's own: `api.<name> = (...) => ...`.
            if (
                node.type === "ExpressionStatement" &&
                node.expression.type === "AssignmentExpression" &&
                node.expression.left.type === "MemberExpression" &&
                node.expression.left.object.name === "api" &&
                /Function/.test(node.expression.right.type)
            ) {
                add(node.expression.left.property.name, docBefore(src, comments, node.start), node.expression.right);
            }
        });
    }
    return { signatures, undocumented };
}
