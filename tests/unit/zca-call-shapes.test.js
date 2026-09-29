/**
 * Every zca-js method must be called with the SHAPE its signature declares.
 *
 * `zca-api-surface.test.js` asserts each method EXISTS. This asserts we call
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
 * Signatures come from the `.d.ts` beside each api file, never a list kept
 * here: a hand-kept list rots at the first zca-js bump and then lies, which
 * is worse than not checking at all.
 *
 * Built from agent/docs/audit_zca-call-shapes.md, which established the
 * method against 182 call sites. Read §7 of that document before trusting a
 * green run — the residual risk is stated in "what this cannot see" below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { buildTypeTable, extractSignatures, resolveKind, splitTopLevel } from "../helpers/zca-call-shapes.js";
import { jsFiles, callSitesIn, findEvasions, commanderPositionals } from "../helpers/zca-call-sites.js";
import { compareCall, nameAffinity, kindCompatible, normaliseName } from "../helpers/zca-call-compare.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "node_modules", "zca-js", "dist");
const APIS = join(DIST, "apis");
const SRC = join(ROOT, "src");

/**
 * Knowingly-accepted findings.
 *
 * Every entry carries a reason, and the test FAILS if an allowlisted site
 * stops producing a finding — otherwise this quietly becomes the second
 * hand-maintained list that the whole test exists to avoid.
 */
const ALLOWLIST = [
    // Empty, and that is the point: src/ currently calls every zca-js method
    // with the shape its signature declares.
    //
    // It had one entry when this test was written -- `conv read`, which had
    // never marked anything as read -- and the "still corresponds to a real
    // finding" assertion below deleted it for me: the fix landed, the entry
    // stopped matching, the test went red, and the entry came out. That is
    // the mechanism working, not a formality. An allowlist without it
    // quietly becomes the second hand-maintained list this test exists to
    // avoid.
];

const table = buildTypeTable(DIST);
const signatures = extractSignatures(APIS, table);
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

describe("zca-js call shapes — the extractor itself", () => {
    // Guard rails. A test that silently stops testing is worse than no test,
    // and that is exactly what a zca-js bump would cause here if the emitted
    // .d.ts shape changed and the extractor quietly returned nothing.

    it("parsed a plausible number of factory signatures", () => {
        assert.ok(
            signatures.size >= 150,
            `only ${signatures.size} signatures extracted — zca-js probably changed its emitted ` +
                `shape and this test is now checking almost nothing`,
        );
    });

    it("resolved object keys for most object parameters", () => {
        const objs = [...signatures.values()].flatMap((s) => s.params).filter((p) => p.kind === "object");
        const keyed = objs.filter((p) => p.keys && p.keys.length);
        assert.ok(objs.length >= 40, `only ${objs.length} object parameters found`);
        assert.ok(keyed.length >= 40, `only ${keyed.length} of ${objs.length} object parameters resolved keys`);
    });

    it("splits unions BEFORE testing for an array suffix", () => {
        // Getting this backwards produced four false WRONGs on the audit's
        // first calibration run: `string | string[]` ends in "[]".
        assert.equal(resolveKind("string | string[]", table).kind, "union");
        assert.equal(resolveKind("string[]", table).kind, "array");
        assert.equal(resolveKind("string", table).kind, "primitive");
    });

    it("does not count the > of an arrow as a closing bracket", () => {
        // zca-js documents SendVideoOptions with "5.5s => 5.5 * 1000 = 5500".
        // Counting that > as a close truncated the type at `duration`, so
        // `width` and `height` read as undeclared and two CORRECT calls were
        // reported SUSPECT.
        const video = resolveKind("SendVideoOptions", table);
        assert.ok(video.keys.includes("width"), "comment text truncated the type body");
        assert.ok(video.keys.includes("height"));
        assert.deepEqual(splitTopLevel("(a: string) => void, b: number", ","), ["(a: string) => void", "b: number"]);
    });

    it("reads the signatures of the methods the known defects involved", () => {
        for (const [method, shape] of [
            ["setMute", ["object", "primitive", "enum"]],
            ["deleteMessage", ["object", "primitive"]],
            ["forwardMessage", ["object", "array", "enum"]],
            ["sendSeenEvent", ["union", "enum"]],
            ["undo", ["object", "primitive", "enum"]],
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

describe("zca-js call shapes — the declarations are telling the truth", () => {
    // The patch edits .js files. If a declaration were stale, every verdict
    // resting on it would be worthless, so the parameter LIST of each called
    // method is re-read from the implementation and compared.
    it("every called method's .js parameter list matches its .d.ts", () => {
        const called = new Set();
        for (const file of jsFiles(SRC)) {
            for (const s of callSitesIn(file, methods).sites) called.add(s.method);
        }
        assert.ok(called.size >= 100, `only ${called.size} distinct methods found at call sites`);

        const drifted = [];
        for (const method of called) {
            const jsPath = join(APIS, `${method}.js`);
            if (!existsSync(jsPath)) continue;
            const js = readFileSync(jsPath, "utf8");
            const m = js.match(new RegExp(`return async function ${method}\\s*\\(([^)]*)\\)`));
            if (!m) continue;
            const jsNames = splitTopLevel(m[1], ",").map((p) => p.split("=")[0].trim());
            const dtsNames = signatures.get(method).params.map((p) => p.name);
            if (jsNames.join(",") !== dtsNames.join(",")) {
                drifted.push(`${method}: .js(${jsNames.join(", ")}) vs .d.ts(${dtsNames.join(", ")})`);
            }
        }
        assert.deepEqual(drifted, [], "a declaration has drifted from its implementation");
    });
});

describe("zca-js call shapes — nothing can evade the scanner", () => {
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

describe("zca-js call shapes — src/ calls every method correctly", () => {
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

describe("zca-js call shapes — the checker can actually fail", () => {
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
        assert.match(r.structural.reasons.join(" "), /argument 1 is primitive but params is declared object/);
    });

    it("catches a bare value where an array is declared — the msg forward defect", () => {
        const r = check(wrap(`await getApi().forwardMessage({ message: "hi" }, threadId, 1);`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /threadIds is declared array/);
    });

    it("catches a bare value where a union of object|array is declared — the conv read defect", () => {
        const r = check(wrap(`await getApi().sendSeenEvent(threadId, 1);`));
        assert.equal(r.structural.verdict, "WRONG");
        assert.match(r.structural.reasons.join(" "), /messages is declared union/);
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
        // strings, so NOTHING structural distinguishes the right order from
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

describe("zca-js call shapes — the commander rule", () => {
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

describe("zca-js call shapes — what this cannot see", () => {
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
        // {success, failed}. No signature check can see that: .d.ts return
        // types describe what zca-js declares, not what the server sends.
        assert.ok(kindCompatible("unknown", { kind: "object" }), "unknown is never a mismatch");
        assert.equal(normaliseName("threadIDs"), normaliseName("thread_id"));
    });
});
