/**
 * Finding zca-js call sites in `src/`, and inferring each argument's kind.
 *
 * Companion to zca-call-shapes.js, which reads the declared signatures. This
 * half reads the calls. Split because the commander rule below is the
 * load-bearing, easiest-to-get-wrong part and deserves its own unit tests.
 *
 * Why inference at all, rather than comparing literal types: of the five
 * commands that had never worked, FOUR pass bare identifiers. A checker that
 * only understands literals rates them "unknown" and lets them through — the
 * audit measured exactly that, catching 1 of 4 on its first design. Something
 * that looks like coverage and is not is the same failure this whole exercise
 * has been about, one level up.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import * as acorn from "acorn";

/** Receivers whose `.listen` is an HTTP server, not the zca-js listener. */
export const NOT_ZCA_RECEIVERS = new Set(["server", "app", "webhookServer", "httpServer"]);

/**
 * Every .js file under a directory, recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function jsFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (extname(e.name) === ".js") out.push(p);
        }
    };
    walk(dir);
    return out;
}

/**
 * Visit every node of an acorn AST.
 *
 * acorn-walk is not in this tree and a new dependency is not worth twelve
 * lines.
 *
 * @param {object} node
 * @param {(n: object, parent: object|null) => void} fn
 * @param {object|null} [parent]
 */
export function walkAst(node, fn, parent = null) {
    if (!node || typeof node.type !== "string") return;
    fn(node, parent);
    for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
        const v = node[key];
        if (Array.isArray(v)) {
            for (const c of v) if (c && typeof c.type === "string") walkAst(c, fn, node);
        } else if (v && typeof v.type === "string") {
            walkAst(v, fn, node);
        }
    }
}

/**
 * Positional argument names a commander chain declares, and which are variadic.
 *
 * Commander guarantees every positional CLI argument arrives as a STRING,
 * except a variadic `<x...>` / `[x...]` which arrives as `string[]`. That one
 * guarantee is what makes bare identifiers decidable, and therefore what
 * makes the four known defects catchable at all.
 *
 * @param {object} actionCall - CallExpression whose callee property is `action`
 * @returns {{names: string[], variadic: Set<string>}}
 */
export function commanderPositionals(actionCall) {
    const names = [];
    const variadic = new Set();
    const read = (spec) => {
        for (const m of String(spec).matchAll(/[<[]\s*([\w-]+?)(\.\.\.)?\s*[>\]]/g)) {
            names.push(m[1]);
            if (m[2]) variadic.add(m[1]);
        }
    };
    let node = actionCall.callee && actionCall.callee.object;
    const chain = [];
    while (node) {
        if (node.type === "CallExpression") {
            chain.push(node);
            node = node.callee && node.callee.object;
        } else if (node.type === "MemberExpression") {
            node = node.object;
        } else {
            break;
        }
    }
    for (const call of chain.reverse()) {
        const prop = call.callee && call.callee.property && call.callee.property.name;
        const first = call.arguments && call.arguments[0];
        if ((prop === "command" || prop === "argument") && first && first.type === "Literal") read(first.value);
    }
    return { names, variadic };
}

/**
 * Static kind of an expression given the names in scope.
 *
 * @param {object} n
 * @param {Map<string,string>} scope
 * @returns {string} primitive|object|array|function|nullish|cli-flag|spread|unknown
 */
export function inferKind(n, scope) {
    if (!n) return "unknown";
    switch (n.type) {
        case "Literal":
            return n.value === null ? "nullish" : typeof n.value === "object" ? "unknown" : "primitive";
        case "TemplateLiteral":
            return "primitive";
        case "ObjectExpression":
            return "object";
        case "ArrayExpression":
            return "array";
        case "ArrowFunctionExpression":
        case "FunctionExpression":
            return "function";
        case "NewExpression":
            return "object";
        case "SpreadElement":
            return "spread";
        case "Identifier":
            return n.name === "undefined" ? "nullish" : (scope.get(n.name) ?? "unknown");
        case "AwaitExpression":
            return inferKind(n.argument, scope);
        case "ChainExpression":
            return inferKind(n.expression, scope);
        case "UnaryExpression":
            return n.operator === "void" ? "nullish" : "primitive";
        case "BinaryExpression":
            return "primitive";
        case "ConditionalExpression":
            return mergeKinds(inferKind(n.consequent, scope), inferKind(n.alternate, scope));
        case "LogicalExpression":
            return mergeKinds(inferKind(n.left, scope), inferKind(n.right, scope));
        case "MemberExpression": {
            // `opts.<flag>` is a commander flag: string, boolean, or string[]
            // for a variadic flag — never a structured object. Passing one
            // where an object parameter is declared is a hard mismatch, and
            // that is precisely how `conv mute` read.
            const objName = n.object && n.object.name;
            if (objName && scope.get(objName) === "cli-opts") return "cli-flag";
            return "unknown";
        }
        case "CallExpression":
            return inferCallKind(n, scope);
        default:
            return "unknown";
    }
}

/**
 * Merge two branch kinds, treating nullish as "no information".
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function mergeKinds(a, b) {
    if (a === b) return a;
    if (a === "nullish") return b;
    if (b === "nullish") return a;
    return "unknown";
}

/**
 * Kind of a call expression's result, for the handful of shapes that matter.
 *
 * @param {object} n
 * @param {Map<string,string>} scope
 * @returns {string}
 */
function inferCallKind(n, scope) {
    const callee = n.callee || {};
    const fname = callee.type === "Identifier" ? callee.name : callee.property && callee.property.name;
    if (["String", "Number", "parseInt", "parseFloat", "parseIntOption"].includes(fname)) return "primitive";
    if (["join", "trim", "toString", "toUpperCase", "toLowerCase", "padStart", "padEnd"].includes(fname)) {
        return "primitive";
    }
    if (["map", "filter", "split", "flat", "flatMap"].includes(fname)) return "array";
    if (fname === "from" && callee.object && callee.object.name === "Array") return "array";
    // slice/concat are array-or-string depending on the receiver.
    if (["slice", "concat"].includes(fname)) {
        return inferKind(callee.object, scope) === "array" ? "array" : "unknown";
    }
    return "unknown";
}

/**
 * A name for an argument, used by the name-affinity pass.
 *
 * @param {object} a
 * @returns {string|null}
 */
export function argName(a) {
    if (!a) return null;
    if (a.type === "Identifier") return a.name;
    if (a.type === "MemberExpression" && !a.computed) return (a.property && a.property.name) || null;
    if (a.type === "CallExpression" && a.arguments && a.arguments.length === 1) {
        const f = a.callee && a.callee.name;
        if (f === "String" || f === "Number") return argName(a.arguments[0]);
    }
    if (a.type === "AwaitExpression") return argName(a.argument);
    return null;
}

/**
 * Top-level keys of an object literal argument.
 *
 * @param {object} a - ObjectExpression
 * @returns {{keys: string[], spread: boolean}}
 */
export function literalKeys(a) {
    const keys = [];
    let spread = false;
    for (const p of a.properties) {
        if (p.type === "SpreadElement") {
            spread = true;
            continue;
        }
        if (p.computed) {
            spread = true; // a computed key is an unknown key
            continue;
        }
        keys.push(String(p.key.type === "Identifier" ? p.key.name : p.key.value));
    }
    return { keys, spread };
}

/**
 * Every zca-js api call site in one file, with each argument's inferred kind.
 *
 * @param {string} file
 * @param {Set<string>} methods - known zca-js method names
 * @param {string} [source] - file contents, read from disk when omitted
 * @returns {{sites: object[], parseError: string|null}}
 */
export function callSitesIn(file, methods, source) {
    const src = source === undefined ? readFileSync(file, "utf8") : source;
    let ast;
    try {
        ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (e) {
        return { sites: [], parseError: e.message };
    }

    // Any name assigned anywhere in the file is demoted to unknown: one pass
    // cannot know which assignment reaches the call.
    const reassigned = new Set();
    walkAst(ast, (n) => {
        if (n.type === "AssignmentExpression" && n.left && n.left.type === "Identifier") reassigned.add(n.left.name);
        if (n.type === "UpdateExpression" && n.argument && n.argument.type === "Identifier") {
            reassigned.add(n.argument.name);
        }
    });

    const scope = new Map();

    // Commander bindings first, so declarations below cannot shadow them.
    walkAst(ast, (n) => {
        if (n.type !== "CallExpression") return;
        if (!n.callee || !n.callee.property || n.callee.property.name !== "action") return;
        const cb = n.arguments && n.arguments[0];
        if (!cb || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) return;
        const { names, variadic } = commanderPositionals(n);
        cb.params.forEach((p, i) => {
            if (p.type !== "Identifier") return;
            // The options object is identified BY NAME, never by position. A
            // handler that ignores its tail arguments otherwise makes the
            // checker mistake a positional for opts, which produced two false
            // positives during the audit.
            if (p.name === "opts" || p.name === "options") {
                scope.set(p.name, "cli-opts");
                return;
            }
            const declared = names[i];
            if (declared !== undefined) scope.set(p.name, variadic.has(declared) ? "array" : "primitive");
        });
    });

    walkAst(ast, (n) => {
        if (n.type !== "VariableDeclarator") return;
        if (!n.id || n.id.type !== "Identifier" || !n.init) return;
        if (scope.has(n.id.name)) return;
        scope.set(n.id.name, reassigned.has(n.id.name) ? "unknown" : inferKind(n.init, scope));
    });

    const sites = [];
    walkAst(ast, (n) => {
        if (n.type !== "CallExpression") return;
        const callee = n.callee;
        if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property && callee.property.name;
        if (!method || !methods.has(method)) return;

        const recv = callee.object;
        let recvName = null;
        if (recv) {
            if (recv.type === "Identifier") recvName = recv.name;
            else if (recv.type === "CallExpression") recvName = recv.callee && recv.callee.name;
            else if (recv.type === "MemberExpression") recvName = recv.property && recv.property.name;
        }
        if (recvName && NOT_ZCA_RECEIVERS.has(recvName)) return;

        sites.push({
            file,
            line: n.loc.start.line,
            method,
            receiver: recvName,
            args: n.arguments.map((a) => {
                const lit = a.type === "ObjectExpression" ? literalKeys(a) : null;
                return { kind: inferKind(a, scope), name: argName(a), literal: lit };
            }),
        });
    });
    return { sites, parseError: null };
}

/**
 * Shapes that would make the scanner silently stop seeing call sites.
 *
 * Dynamic dispatch, spreads and `.call`/`.apply`/`.bind` are all absent from
 * this codebase today. If one appears the scanner walks straight past it and
 * reports nothing, so their continued absence is asserted rather than assumed
 * — a scanner that quietly stops scanning is the failure mode this whole test
 * exists to prevent.
 *
 * @param {string} file
 * @param {Set<string>} methods
 * @param {string} [source]
 * @returns {object[]} evasions found
 */
export function findEvasions(file, methods, source) {
    const src = source === undefined ? readFileSync(file, "utf8") : source;
    let ast;
    try {
        ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch {
        return [];
    }
    const found = [];
    walkAst(ast, (n) => {
        if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression") {
            const prop = n.callee.property;
            // api.someMethod.call(...) / .apply / .bind
            if (!n.callee.computed && ["call", "apply", "bind"].includes(prop && prop.name)) {
                const inner = n.callee.object;
                if (inner && inner.type === "MemberExpression" && methods.has(inner.property && inner.property.name)) {
                    found.push({ file, line: n.loc.start.line, why: `${prop.name} on an api method` });
                }
            }
            // api[name](...) dynamic dispatch
            if (n.callee.computed && n.callee.object && n.callee.object.name === "api") {
                found.push({ file, line: n.loc.start.line, why: "computed api member" });
            }
            // spread into a known method
            if (!n.callee.computed && methods.has(prop && prop.name)) {
                if (n.arguments.some((a) => a.type === "SpreadElement")) {
                    found.push({ file, line: n.loc.start.line, why: `spread argument to ${prop.name}` });
                }
            }
        }
        // const { sendMessage } = getApi()
        if (n.type === "VariableDeclarator" && n.id && n.id.type === "ObjectPattern" && n.init) {
            const init = n.init;
            const from = init.type === "CallExpression" ? init.callee && init.callee.name : init.name;
            if (from === "getApi") {
                for (const p of n.id.properties) {
                    const key = p.key && p.key.name;
                    if (methods.has(key)) found.push({ file, line: n.loc.start.line, why: `destructured ${key}` });
                }
            }
        }
    });
    return found;
}
