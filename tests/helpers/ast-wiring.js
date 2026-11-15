/**
 * Read how a source file wires its parts together, from its syntax tree rather than its text.
 *
 * Some rules live inside action handlers that only run with a live login (the `listen` and `mcp start` daemons), so
 * no offline test can drive them. Matching an exact source line is the wrong check for those: it goes red on a
 * reformat or a rename and stays green when the line is dead code. These helpers check the data flow instead: which
 * value a call receives, which function a callback calls, which variable a constructor's result is bound to. A rename
 * of a local variable does not break them; wiring the wrong value does.
 */
import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { walkAst } from "./api-call-sites.js";

/**
 * Parse a module.
 *
 * @param {string} file - absolute path
 * @returns {object} the Program node
 */
export function parseModule(file) {
    return acorn.parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
}

/**
 * Every node under `root` that matches `pred`, in source order.
 *
 * @param {object} root
 * @param {(node: object, parent: object|null) => boolean} pred
 * @returns {object[]}
 */
export function findAll(root, pred) {
    const out = [];
    walkAst(root, (n, p) => {
        if (pred(n, p)) out.push(n);
    });
    return out;
}

/** The name a call or `new` is made by: `f(...)` -> "f", `a.b.f(...)` -> "f". */
export function calleeName(node) {
    const c = node?.callee;
    if (!c) return null;
    if (c.type === "Identifier") return c.name;
    if (c.type === "MemberExpression" && !c.computed) return c.property.name;
    return null;
}

/** Every call (or `new`, with `isNew`) made by `name` under `root`. */
export function callsTo(root, name, { isNew = false } = {}) {
    const type = isNew ? "NewExpression" : "CallExpression";
    return findAll(root, (n) => n.type === type && calleeName(n) === name);
}

/** `obj.method(...)` calls under `root` whose object is the identifier `obj`. */
export function methodCalls(root, obj, method) {
    return findAll(
        root,
        (n) =>
            n.type === "CallExpression" &&
            n.callee.type === "MemberExpression" &&
            !n.callee.computed &&
            n.callee.object.type === "Identifier" &&
            n.callee.object.name === obj &&
            n.callee.property.name === method,
    );
}

/**
 * The variables bound to the result of `init`-matching expressions: `const x = f(...)`, `x = f(...)` and
 * `let x = new F(...)`.
 *
 * @param {object} root
 * @param {(init: object) => boolean} pred
 * @returns {string[]} the variable names
 */
export function boundTo(root, pred) {
    const names = [];
    walkAst(root, (n) => {
        if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && pred(n.init))
            names.push(n.id.name);
        if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && pred(n.right)) names.push(n.left.name);
    });
    return names;
}

/** The variables bound to `name(...)` (or `new name(...)`). */
export function boundToCall(root, name, { isNew = false } = {}) {
    const type = isNew ? "NewExpression" : "CallExpression";
    return boundTo(root, (init) => init.type === type && calleeName(init) === name);
}

/** The value node of property `key` in an object expression, or null. */
export function prop(obj, key) {
    if (obj?.type !== "ObjectExpression") return null;
    const p = obj.properties.find((x) => x.type === "Property" && !x.computed && (x.key.name ?? x.key.value) === key);
    return p ? p.value : null;
}

/** Whether `node` is the identifier `name`. */
export const isId = (node, name) => node?.type === "Identifier" && node.name === name;

/**
 * Whether `fn` is a one-expression arrow that calls `obj.method` with exactly its own parameters, in order:
 * `(a, b) => obj.method(a, b)`.
 */
export function forwardsTo(fn, obj, method) {
    if (fn?.type !== "ArrowFunctionExpression" || fn.body.type !== "CallExpression") return false;
    const call = fn.body;
    const params = fn.params.map((p) => p.name);
    return (
        call.callee.type === "MemberExpression" &&
        isId(call.callee.object, obj) &&
        call.callee.property.name === method &&
        call.arguments.length === params.length &&
        call.arguments.every((a, i) => isId(a, params[i]))
    );
}
