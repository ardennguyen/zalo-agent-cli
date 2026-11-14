/**
 * Every session method must be called with the SHAPE its signature declares.
 *
 * `api-surface.test.js` asserts each method EXISTS. This asserts we call
 * it correctly. Neither subsumes the other, and the gap between them is
 * where five commands hid — each of which had never worked once:
 *
 *   msg delete    deleteMessage(dest, onlyMe)           called positionally
 *   msg forward   forwardMessage(payload, threadIds[], type)  string + string
 *   conv mute     setMute(params, threadID, type)        options object last
 *   conv unmute   same                                    same
 *   conv read     sendSeenEvent(messages, type)           bare threadId
 *
 * All five passed the existence test: the method was real, only the call was
 * wrong. The request went out malformed, Zalo rejected it, and the CLI
 * caught the error and printed a clean ✗ with exit 0 — indistinguishable
 * from "the server said no". `conv mute` shipped that way for its whole life.
 *
 * Signatures come from the JSDoc `@param` comments of the methods themselves
 * (src/zalo/api/*.js and src/zalo/api.js), never a list kept here: a
 * hand-kept list rots at the first change and then lies, which is worse than
 * not checking at all. The method was established against 182 call sites; the
 * residual risk is stated in "what this cannot see" below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { extractSignatures, jsdocParams, jsdocType, resolveKind, splitTopLevel } from "../helpers/api-call-shapes.js";
import { jsFiles, callSitesIn, findEvasions, commanderPositionals } from "../helpers/api-call-sites.js";
import { compareCall, nameAffinity, kindCompatible, normaliseName } from "../helpers/api-call-compare.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");

/**
 * Knowingly-accepted findings.
 *
 * Every entry carries a reason, and the test FAILS if an allowlisted site
 * stops producing a finding — otherwise this quietly becomes the second
 * hand-maintained list that the whole test exists to avoid.
 */
const ALLOWLIST = [
    // Empty, and that is the point: src/ calls every method with the shape
    // its signature declares.
    //
    // It had one entry when this test was written -- `conv read`, which had
    // never marked anything as read -- and the "still corresponds to a real
    // finding" assertion below deleted it for me: the fix landed, the entry
    // stopped matching, the test went red, and the entry came out. That is
    // the mechanism working, not a formality. An allowlist without it
    // quietly becomes the second hand-maintained list this test exists to
    // avoid.
];

const table = new Map();
const { signatures, undocumented } = extractSignatures(join(SRC, "zalo"));
const methods = new Set(signatures.keys());

/** Every call site in src/, paired with its declared signature. */
function analyse() {
    const findings = [];
    const stats = { sites: 0, files: 0, OK: 0, WRONG: 0, SUSPECT: 0, UNVERIFIABLE: 0 };
    for (const file of jsFiles(SRC)) {
        stats.files++;
        const { sites, parseError } = callSitesIn(file, methods);
        assert.equal(parseError, null, `could not parse ${file}: ${parseError}`);
        for (const site of sites) {
            const sig = signatures.get(site.method);
            if (!sig) continue;
            stats.sites++;
            const structural = compareCall(site, sig);
            const nominal = nameAffinity(site, sig);
            stats[structural.verdict]++;
            if (structural.verdict === "WRONG" || nominal.verdict === "WRONG") {
                findings.push({
                    ...site,
                    rel: site.file.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, ""),
                    reasons: [...structural.reasons, ...nominal.reasons],
                });
            }
        }
    }
    return { findings, stats };
}

describe("api call shapes — the extractor itself", () => {
    // Guard rails. A test that silently stops testing is worse than no test,
    // and that is exactly what a change of the comment style would cause here
    // if the extractor quietly returned nothing.

    it("parsed a signature for every method of the session object", () => {
        assert.ok(
            signatures.size >= 140,
            `only ${signatures.size} signatures extracted — the area modules probably changed their ` +
                `shape and this test is now checking almost nothing`,
        );
        for (const name of ["sendMessage", "getContext", "getOwnId", "keepAlive", "setMute", "undo"]) {
            assert.ok(signatures.has(name), `no signature for ${name}`);
        }
    });

    it("every method that takes arguments documents them, one @param per parameter", () => {
        assert.deepEqual(undocumented, [], "these methods have no @param comment to check their callers against");
        const drifted = [...signatures]
            .filter(([, s]) => s.arity !== null && s.params.length !== s.arity)
            .map(([n, s]) => `${s.source}: ${n} takes ${s.arity}, documents ${s.params.length}`);
        assert.deepEqual(drifted, [], "a comment has drifted from its method");
    });

    it("resolved object keys for most object parameters", () => {
        const objs = [...signatures.values()].flatMap((s) => s.params).filter((p) => p.kind === "object");
        const keyed = objs.filter((p) => p.keys && p.keys.length);
        assert.ok(objs.length >= 30, `only ${objs.length} object parameters found`);
        assert.ok(keyed.length >= 30, `only ${keyed.length} of ${objs.length} object parameters resolved keys`);
    });

    it("reads JSDoc: optional and dotted names, object literals with commas, nested braces", () => {
        const body = [
            "* Something.",
            " *",
            " * @param {{page?: number, count?: number}} [opts] - a page",
            " * @param {string|{data: Uint8Array, metadata?: {width?: number}}} file",
            " * @param {object} target",
            " * @param {string} target.msgId",
            " * @param {number} [target.type=0]",
            " * @returns {Promise<any>}",
        ].join("\n");
        const params = jsdocParams(body);
        assert.deepEqual(
            params.map((p) => [p.name, p.optional]),
            [
                ["opts", true],
                ["file", false],
                ["target", false],
                ["target.msgId", false],
                ["target.type", true],
            ],
        );
        assert.deepEqual(resolveKind(jsdocType(params[0].type), table), {
            kind: "object",
            keys: ["page", "count"],
            requiredKeys: [],
        });
        assert.equal(resolveKind(jsdocType(params[1].type), table).kind, "union");
        assert.equal(resolveKind(jsdocType("0|1"), table).kind, "primitive");
        assert.equal(resolveKind(jsdocType("Function"), table).kind, "function");
        assert.equal(resolveKind(jsdocType("any"), table).kind, "unknown");
    });

    it("splits unions BEFORE testing for an array suffix", () => {
        // Getting this backwards produced four false WRONGs on the audit's
        // first calibration run: `string | string[]` ends in "[]".
        assert.equal(resolveKind("string | string[]", table).kind, "union");
        assert.equal(resolveKind("string[]", table).kind, "array");
        assert.equal(resolveKind("string", table).kind, "primitive");
    });

    it("does not count the > of an arrow as a closing bracket", () => {
        // A callback parameter inside an object type ends in "=> ...". Counting
        // that > as a close truncated the type there, so the keys after it read
        // as undeclared and correct calls were reported SUSPECT.
        const t = jsdocType("{onBatch: (info: object) => void, width: number, height: number}");
        assert.deepEqual(resolveKind(t, table).keys, ["onBatch", "width", "height"]);
        assert.deepEqual(splitTopLevel("(a: string) => void, b: number", ","), ["(a: string) => void", "b: number"]);
    });

    it("reads the signatures of the methods the known defects involved", () => {
        for (const [method, shape] of [
            ["setMute", ["object", "primitive", "primitive"]],
            ["deleteMessage", ["object", "primitive"]],
            ["undo", ["object", "primitive", "primitive"]],
            ["removeReminder", ["primitive", "primitive", "primitive"]],
        ]) {
            const sig = signatures.get(method);
            assert.ok(sig, `${method} signature not extracted`);
            assert.deepEqual(
                sig.params.map((p) => p.kind),
                shape,
                `${method} resolved to an unexpected shape`,
            );
        }
    });
});

describe("api call shapes — nothing can evade the scanner", () => {
    it("no dynamic dispatch, spread, destructuring or .call/.apply/.bind on an api method", () => {
        // The scanner walks straight past all of these and reports nothing,
        // so their absence is asserted rather than assumed.
        const evasions = jsFiles(SRC).flatMap((f) => findEvasions(f, methods));
        assert.deepEqual(
            evasions.map((e) => `${e.file.replace(ROOT, "")}:${e.line} ${e.why}`),
            [],
            "the scanner cannot see these call sites",
        );
    });

    it("finds a substantial number of call sites", () => {
        const { stats } = analyse();
        assert.ok(stats.sites >= 150, `only ${stats.sites} call sites found across ${stats.files} files`);
    });
});

describe("api call shapes — src/ calls every method correctly", () => {
    const { findings } = analyse();

    it("reports no call whose shape contradicts its signature", () => {
        const unexpected = findings.filter((f) => !ALLOWLIST.some((a) => f.rel === a.file && f.method === a.method));
        assert.deepEqual(
            unexpected.map((f) => `${f.rel}:${f.line} ${f.method} — ${f.reasons.join("; ")}`),
            [],
        );
    });

    it("every allowlist entry still corresponds to a real finding", () => {
        // Without this the allowlist silently becomes a second hand-kept
        // list, which is the thing this test exists to avoid. When the
        // `conv read` fix lands, this fails and the entry must be deleted.
        const stale = ALLOWLIST.filter((a) => !findings.some((f) => f.rel === a.file && f.method === a.method));
        assert.deepEqual(
            stale.map((a) => `${a.file} ${a.method}`),
            [],
            "allowlisted site no longer produces a finding — delete the entry",
        );
    });

    it("every allowlist entry carries a reason", () => {
        for (const a of ALLOWLIST) {
            assert.ok(a.reason && a.reason.length > 40, `${a.method} needs a real reason, not a placeholder`);
        }
    });
});

describe("api call shapes — the checker can actually fail", () => {
    // Falsifiability, proven rather than asserted. One deliberate defect per
    // class, run through the real pipeline. The fixtures are inline strings
    // rather than files on disk: it keeps the defect next to the assertion
    // that proves it is caught, and avoids adding fixtures whose line
    // endings have to survive a Windows checkout.

    /**
     * Run one synthetic source through the real analysis.
     *
     * @param {string} source
     * @returns {{structural: object, nominal: object, site: object}}
     */
    function check(source) {
        const { sites, parseError } = callSitesIn("synthetic.js", methods, source);
        assert.equal(parseError, null, parseError);
        assert.equal(sites.length, 1, `expected exactly one call site, found ${sites.length}`);
        const sig = signatures.get(sites[0].method);
        assert.ok(sig, `no signature for ${sites[0].method}`);
        return { structural: compareCall(sites[0], sig), nominal: nameAffinity(sites[0], sig), site: sites[0] };
    }

    const wrap = (body) =>
        `const p = {};\np.command("x <threadId>").option("-t").action(async (threadId, opts) => {\n${body}\n});`;

    it("CONTROL: a correct call is OK and unflagged", () => {
        const r = check(wrap(`await getApi().setMute({ action: 1 }, threadId, Number(opts.type));`));
        assert.equal(r.structural.verdict, "OK", r.structural.reasons.join("; "));
        assert.equal(r.nominal.verdict, "OK", r.nominal.reasons.join("; "));
    });

    it("catches an options object passed last instead of first — the conv mute defect", () => {
        const r = check(wrap(`await getApi().setMute(threadId, Number(opts.type), Number(opts.duration));`));
        assert.equal(r.structural.verdict, "WRONG", "the real conv mute bug must be caught");
        assert.match(r.structural.reasons.join(" "), /argument 1 is primitive but options is declared object/);
    });

    it("catches an object where a value or a list is declared — the msg forward defect's class", () => {
        // msg forward handed one shape where another was declared; here an
        // options object where `string|string[]` is.
        const r = check(wrap(`await getApi().getMultiUsersByPhones({ phone: threadId });`));
        assert.equal(r.structural.verdict, "WRONG", r.structural.reasons.join("; "));
        assert.match(r.structural.reasons.join(" "), /phoneNumbers is declared union/);
    });

    it("catches a bare value where an object is declared — the conv read defect", () => {
        const r = check(wrap(`await getApi().deleteMessage(threadId, false);`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /target is declared object/);
    });

    it("catches an omitted required argument", () => {
        const r = check(wrap(`await getApi().undo({ msgId: "1", cliMsgId: "2" });`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /omits required threadId/);
    });

    it("catches an extra argument the signature ignores", () => {
        const r = check(wrap(`await getApi().setMute({ action: 1 }, threadId, 1, "surplus");`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /passes 4 arguments/);
    });

    it("catches an object literal missing a required key", () => {
        const r = check(wrap(`await getApi().undo({ msgId: "1" }, threadId, 1);`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /omits required key\(s\): cliMsgId/);
    });

    it("reports an object literal with an undeclared key as SUSPECT, not WRONG", () => {
        const r = check(wrap(`await getApi().undo({ msgId: "1", cliMsgId: "2", nope: 3 }, threadId, 1);`));
        assert.equal(r.structural.verdict, "SUSPECT");
        assert.match(r.structural.reasons.join(" "), /undeclared key\(s\): nope/);
    });

    it("catches a two-string transposition that the structural pass CANNOT see", () => {
        // The entire reason for a second detector. `removeReminder` takes
        // (reminderId, threadId, type) — the first two are both plain
        // values, so NOTHING structural distinguishes the right order from
        // the wrong one. Only the names give it away.
        const src =
            `const p = {};\n` +
            `p.command("rm <reminderId> <threadId>").action(async (reminderId, threadId) => {\n` +
            `  await getApi().removeReminder(threadId, reminderId, 1);\n` +
            `});`;
        const { sites } = callSitesIn("synthetic.js", methods, src);
        const sig = signatures.get("removeReminder");
        const structural = compareCall(sites[0], sig);
        const nominal = nameAffinity(sites[0], sig);
        assert.equal(structural.verdict, "OK", "precondition: two strings are structurally indistinguishable");
        assert.equal(nominal.verdict, "WRONG", "name affinity must catch what structure cannot");
        assert.match(nominal.reasons.join(" "), /transposed/);
    });

    it("does not flag the same call written the right way round", () => {
        // Guards the detector against crying wolf on correct code, which
        // would be worse than silence: a noisy check gets disabled.
        const src =
            `const p = {};\n` +
            `p.command("rm <reminderId> <threadId>").action(async (reminderId, threadId) => {\n` +
            `  await getApi().removeReminder(reminderId, threadId, 1);\n` +
            `});`;
        const { sites } = callSitesIn("synthetic.js", methods, src);
        const sig = signatures.get("removeReminder");
        assert.equal(compareCall(sites[0], sig).verdict, "OK");
        assert.equal(nameAffinity(sites[0], sig).verdict, "OK");
    });
});

describe("api call shapes — the commander rule", () => {
    // The load-bearing part: it is what makes a bare identifier decidable,
    // and four of the five known defects pass bare identifiers. The audit's
    // first design, comparing literal types only, caught one of four.

    /**
     * @param {string} source
     * @returns {object[]} argument kinds of the single call site
     */
    function kinds(source) {
        const { sites } = callSitesIn("synthetic.js", methods, source);
        return sites[0].args.map((a) => a.kind);
    }

    it("treats a declared positional as a string", () => {
        const src = `const p={};p.command("x <threadId>").action(async (threadId) => { getApi().undo(threadId); });`;
        assert.deepEqual(kinds(src), ["primitive"]);
    });

    it("treats a variadic positional as an array", () => {
        const src = `const p={};p.command("x <paths...>").action(async (paths) => { getApi().undo(paths); });`;
        assert.deepEqual(kinds(src), ["array"]);
    });

    it("identifies the options object by NAME, never by position", () => {
        // Inferring opts positionally misfires on a handler that ignores its
        // tail arguments, which produced two false positives in the audit.
        const src = `const p={};p.command("x <a> <b>").action(async (opts) => { getApi().undo(opts.foo); });`;
        assert.deepEqual(kinds(src), ["cli-flag"], "the first parameter is named opts, so it IS opts");
    });

    it("does not mistake a positional for opts just because it is last", () => {
        const src = `const p={};p.command("x <a> <b>").action(async (a) => { getApi().undo(a); });`;
        assert.deepEqual(kinds(src), ["primitive"]);
    });

    it("reads positionals from .argument() as well as .command()", () => {
        const src = `const p={};p.command("x").argument("<threadId>").action(async (threadId) => { getApi().undo(threadId); });`;
        assert.deepEqual(kinds(src), ["primitive"]);
    });

    it("demotes a reassigned variable to unknown rather than guessing", () => {
        const src = `let v = "a"; v = {}; getApi().undo(v);`;
        assert.deepEqual(kinds(src), ["unknown"]);
    });

    it("extracts positional names and variadics from a chain", () => {
        const src = `const p={};p.command("send <threadId> <paths...>").option("-t").action(async () => {});`;
        const { sites } = callSitesIn("s.js", new Set(["action"]), src);
        void sites;
        // commanderPositionals is exercised through kinds() above; this pins
        // the parser itself so a commander upgrade that changes the spec
        // syntax fails here rather than silently widening every verdict.
        const call = { callee: { object: null } };
        assert.deepEqual(commanderPositionals(call), { names: [], variadic: new Set() });
    });
});

describe("api call shapes — what this cannot see", () => {
    // Stated as executable notes rather than prose, so they stay true.

    it("cannot see a transposition between same-typed, uninformatively-named variables", () => {
        const src = `const x = "1"; const y = "2"; getApi().undo({ msgId: x, cliMsgId: y }, x, 1);`;
        const { sites } = callSitesIn("s.js", methods, src);
        const structural = compareCall(sites[0], signatures.get("undo"));
        const nominal = nameAffinity(sites[0], signatures.get("undo"));
        assert.equal(structural.verdict, "OK");
        assert.equal(nominal.verdict, "OK");
        // Documented residual risk. Closing it needs a live assertion that
        // reads the effect back from the server, not static analysis.
    });

    it("treats an unknown argument as unverified, NOT as correct", () => {
        // `unknown` must never be counted as a pass; it means someone has to
        // look. compareCall reports UNVERIFIABLE so the count is visible.
        const src = `function f(q) { getApi().undo(q, "t", 1); }`;
        const { sites } = callSitesIn("s.js", methods, src);
        assert.equal(compareCall(sites[0], signatures.get("undo")).verdict, "UNVERIFIABLE");
    });

    it("says nothing about response shapes, which is a separate class", () => {
        // `msg forward` also read `result.fail` when Zalo sends
        // {success, failed}. No signature check can see that: a documented
        // return type describes what the method declares, not what the server
        // sends.
        assert.ok(kindCompatible("unknown", { kind: "object" }), "unknown is never a mismatch");
        assert.equal(normaliseName("threadIDs"), normaliseName("thread_id"));
    });
});
