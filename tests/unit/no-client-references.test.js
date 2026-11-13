/**
 * Public files never cite Zalo's own clients as a source.
 *
 * How this project studies Zalo is private: which client a rule was read from, its build numbers, its internal
 * module names and capture files stay in the gitignored `agent/` folder. Code, help text, tests, docs and the
 * CHANGELOG say what Zalo does, or "as Zalo does", never which client showed it (owner's rule, 2026-11-13).
 *
 * Reads what tests/unit/no-real-ids.test.js reads: every file git tracks, plus every untracked file git does not
 * ignore, so a new file is caught before it is staged. The words are assembled below so this file does not match
 * itself.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoFiles } from "../helpers/id-scan.js";

const ROOT = join(import.meta.dirname, "..", "..");
const Z = "Zalo";
const W = "Web";

/** What a public file must not say, each with what it is. */
const FORBIDDEN = [
    [new RegExp(`\\b${Z} (${W}|PC)\\b`, "i"), `"${Z} ${W}" / "${Z} PC" named as a client`],
    [new RegExp(`\\b(${W}/PC|PC/${W})\\b`), "the two clients named together"],
    [
        new RegExp(`\\bthe ${W.toLowerCase()} (sends|does|client|app|asks|reads|shows|uses|keeps|calls)\\b`, "i"),
        "a client's behavior cited",
    ],
    [new RegExp(`\\b(${W.toLowerCase()}|pc)'s\\b`, "i"), "a client's internals cited"],
    [/\bz[s]ymb\b/, "a client's internal logging call"],
    [new RegExp(`zalo-(${W.toLowerCase()}|pc)-captu[r]e|zalo-pc-\\d`, "i"), "a capture folder"],
    [/\bapp\.as[a]r\b/, "a desktop app's package"],
    [/\b26\.1[0-2]\.\d{1,2}\b/, "a client build number"],
];

/** Text formats worth reading; everything else (images, fonts, archives) is skipped. */
const TEXT = /\.(m?js|cjs|json|md|txt|ya?ml|sh|ps1|env|example|mdc|html|css)$|(^|\/)(\.[a-z]+rules|\.env[^/]*|[A-Z]+)$/;

describe("no client references in public files", () => {
    it("no tracked or committable file cites Zalo's own clients", () => {
        const files = repoFiles(ROOT).filter(({ path }) => TEXT.test(path));
        assert.ok(files.length >= 100, `only ${files.length} files were read -- is this a git checkout?`);
        const hits = [];
        for (const { path } of files) {
            let text;
            try {
                text = readFileSync(join(ROOT, path), "utf8");
            } catch {
                continue; // listed but gone (a delete not yet staged)
            }
            const lines = text.split("\n");
            lines.forEach((line, i) => {
                for (const [rx, what] of FORBIDDEN) {
                    if (rx.test(line)) hits.push(`${path}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
                }
            });
        }
        assert.deepEqual(hits, [], `say what Zalo does, not which client showed it:\n${hits.join("\n")}`);
    });

    it("catches what it is meant to catch", () => {
        const caught = (s) => FORBIDDEN.some(([rx]) => rx.test(s));
        for (const bad of [
            `as ${Z} ${W} does`,
            `${Z} PC shows it`,
            `${W}/PC send`,
            `the ${W.toLowerCase()} sends cMsgID`,
            `the ${W.toLowerCase()}'s reader`,
            `build 26.11.${"11"}`,
        ]) {
            assert.ok(caught(bad), bad);
        }
        // Red if a wire value, the socket, our webhook or an operational sentence trips it.
        for (const fine of [
            `the ${Z} WebSocket`,
            'COMPUTER_NAME = "Web"',
            "https://chat.zalo.me",
            "ZALO_WEBHOOK_URL",
            "another browser took the web login",
            "as Zalo does",
            "2026-11-13",
        ]) {
            assert.equal(caught(fine), false, fine);
        }
    });
});
