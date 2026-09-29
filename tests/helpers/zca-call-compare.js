/**
 * Comparing an observed call against a declared zca-js signature.
 *
 * Two independent detectors, because neither alone is sufficient:
 *
 *   compareCall()  structural — arity and argument kind
 *   nameAffinity() nominal    — argument NAMES against parameter names
 *
 * The second exists because the first is blind to transposition. Nothing
 * structural distinguishes `f(a, b)` from `f(b, a)` when both are strings,
 * and `conv mute` was exactly that plus an arity shift. On the audit's
 * synthetic fixture, a pure two-string swap is rated OK structurally and
 * caught only by name affinity.
 *
 * Both are needed, and together they still cannot see a transposition
 * between same-typed parameters held in uninformatively-named variables.
 * That residual class needs a live assertion that reads the effect back from
 * the server; it is not closeable statically. Stated here rather than left
 * implied, because a test that gives false confidence is worse than none.
 */

/** Kinds that carry no information, so never a mismatch on their own. */
const UNDECIDABLE = new Set(["unknown", "spread"]);

/**
 * Whether an inferred argument kind can satisfy a declared parameter kind.
 *
 * Deliberately permissive: this returns false ONLY when the pairing cannot
 * be right. Every "maybe" is a pass, so a finding is a real finding.
 *
 * @param {string} argKind - from inferKind()
 * @param {object} param - {kind, optional, type}
 * @returns {boolean}
 */
export function kindCompatible(argKind, param) {
    if (UNDECIDABLE.has(argKind)) return true;
    if (argKind === "nullish") return Boolean(param.optional);

    const want = param.kind;
    if (want === "unknown") return true;

    // A union is decidable when its members are. Blanket-passing every union
    // is what hid `conv read`: sendSeenEvent's first parameter is
    // `MessageDescriptor | MessageDescriptor[]`, members [object, array],
    // and the CLI passes a bare threadId string. A primitive satisfies
    // neither member, so it is a real mismatch, not an unknown.
    if (want === "union") {
        const members = param.union || [];
        if (!members.length || members.includes("unknown")) return true;
        return members.some((m) => kindCompatible(argKind, { ...param, kind: m, union: undefined }));
    }

    // A commander flag is a string, a boolean, or string[] for a variadic.
    // It is never a structured object or a callback.
    if (argKind === "cli-flag") return want !== "object" && want !== "function" && want !== "buffer";

    switch (want) {
        case "primitive":
            // Enums are numeric/string at runtime, so a primitive satisfies
            // them; the reverse is also allowed below.
            return argKind === "primitive";
        case "enum":
            return argKind === "primitive" || argKind === "enum";
        case "object":
            return argKind === "object";
        case "array":
            return argKind === "array";
        case "buffer":
            return argKind === "object" || argKind === "buffer";
        case "function":
            return argKind === "function";
        default:
            return true;
    }
}

/**
 * Structural verdict for one call site.
 *
 * @param {object} site - from callSitesIn()
 * @param {object} sig - from extractSignatures()
 * @returns {{verdict: string, reasons: string[]}} verdict is OK|WRONG|SUSPECT|UNVERIFIABLE
 */
export function compareCall(site, sig) {
    const reasons = [];
    const params = sig.params;
    const required = params.filter((p) => !p.optional).length;
    const args = site.args;

    if (args.some((a) => a.kind === "spread")) {
        return { verdict: "UNVERIFIABLE", reasons: ["spread argument"] };
    }
    if (args.length > params.length) {
        reasons.push(
            `passes ${args.length} arguments to a signature taking ${params.length} ` +
                `(${params.map((p) => p.name).join(", ") || "none"}) — the surplus is ignored`,
        );
    }
    if (args.length < required) {
        const missing = params.slice(args.length, required).map((p) => p.name);
        reasons.push(`omits required ${missing.join(", ")} — it arrives undefined`);
    }

    args.forEach((a, i) => {
        const p = params[i];
        if (!p) return;
        if (!kindCompatible(a.kind, p)) {
            reasons.push(`argument ${i + 1} is ${a.kind} but ${p.name} is declared ${p.kind} (${p.type})`);
        }
    });

    if (reasons.length) return { verdict: "WRONG", reasons };

    // Object-literal key checks, only where the declared type resolved keys.
    const suspects = [];
    args.forEach((a, i) => {
        const p = params[i];
        if (!p || !a.literal || p.kind !== "object" || !p.keys || !p.keys.length) return;
        if (!a.literal.spread) {
            const missing = (p.requiredKeys || []).filter((k) => !a.literal.keys.includes(k));
            if (missing.length)
                reasons.push(`argument ${i + 1} (${p.name}) omits required key(s): ${missing.join(", ")}`);
        }
        const extra = a.literal.keys.filter((k) => !p.keys.includes(k));
        if (extra.length) suspects.push(`argument ${i + 1} (${p.name}) carries undeclared key(s): ${extra.join(", ")}`);
    });

    if (reasons.length) return { verdict: "WRONG", reasons };
    if (args.some((a) => UNDECIDABLE.has(a.kind))) {
        return { verdict: "UNVERIFIABLE", reasons: suspects };
    }
    if (suspects.length) return { verdict: "SUSPECT", reasons: suspects };
    return { verdict: "OK", reasons: [] };
}

/**
 * Normalise a name for comparison: case, separators, trailing plural.
 *
 * @param {string} s
 * @returns {string}
 */
export function normaliseName(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[_\-\s]/g, "")
        .replace(/s$/, "");
}

/**
 * Nominal verdict: does an argument's name belong to a DIFFERENT parameter?
 *
 * @param {object} site
 * @param {object} sig
 * @returns {{verdict: string, reasons: string[]}} OK|WRONG|SUSPECT
 */
export function nameAffinity(site, sig) {
    const params = sig.params.map((p) => normaliseName(p.name));
    const args = site.args.map((a) => normaliseName(a.name));
    const reasons = [];

    args.forEach((a, i) => {
        if (!a) return;
        const at = params.indexOf(a);
        if (at >= 0 && at !== i) {
            reasons.push(
                `argument ${i + 1} is named "${site.args[i].name}", which is parameter ` +
                    `${at + 1} of ${sig.params.map((p) => p.name).join(", ")} — arguments look transposed`,
            );
        }
    });
    if (reasons.length) return { verdict: "WRONG", reasons };

    // Would some reordering match strictly more parameter names?
    const score = (order) => order.reduce((n, ai, i) => n + (args[ai] && args[ai] === params[i] ? 1 : 0), 0);
    const asWritten = score(args.map((_, i) => i));
    if (args.filter(Boolean).length >= 2 && asWritten < args.filter(Boolean).length) {
        for (const perm of permutations(args.map((_, i) => i))) {
            if (score(perm) > asWritten) {
                return {
                    verdict: "SUSPECT",
                    reasons: [`a different argument order would match more parameter names`],
                };
            }
        }
    }
    return { verdict: "OK", reasons: [] };
}

/**
 * All permutations of a short index list. Call sites take at most 4-5
 * arguments, so the factorial is bounded and tiny.
 *
 * @param {number[]} xs
 * @returns {number[][]}
 */
export function permutations(xs) {
    if (xs.length <= 1) return [xs];
    if (xs.length > 5) return [xs]; // not worth it, and never happens here
    const out = [];
    for (let i = 0; i < xs.length; i++) {
        const rest = xs.slice(0, i).concat(xs.slice(i + 1));
        for (const p of permutations(rest)) out.push([xs[i], ...p]);
    }
    return out;
}
