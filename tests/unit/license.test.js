/**
 * The license: CC BY-NC-SA 4.0 from 2.0.1 on, with the MIT notice of what the
 * package derives from kept alongside it, and a credit to the endpoint library
 * the protocol layer replaced.
 *
 * Releases up to 2.0.0 were MIT. MIT requires the upstream copyright and
 * permission notice to travel with any substantial portion of that code, so the
 * relicensing is only sound while NOTICE keeps them, and only visible to
 * users and tooling while the package metadata, LICENSE and the published
 * file list agree. A drift in any of those is silent, so these pin it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json"));

describe("license", () => {
    it("package.json, LICENSE and the published files agree", () => {
        // Red if one of the three is changed without the others.
        assert.equal(pkg.license, "CC-BY-NC-SA-4.0");
        assert.ok(pkg.files.includes("LICENSE") && pkg.files.includes("NOTICE"), "NOTICE must ship with LICENSE");
        const license = read("LICENSE");
        assert.match(license, /^zalo-agent-cli\nCopyright \(c\) 2026 /);
        assert.match(license, /Attribution-NonCommercial-ShareAlike 4\.0 International Public License/);
        const notice = read("NOTICE");
        for (const heading of [
            "1. Summary",
            "2. How to credit this project",
            "3. Contributing improvements back",
            "4. Material not covered by CC BY-NC-SA 4.0",
            "5. Third-party notices",
        ]) {
            assert.ok(notice.includes(heading), `NOTICE lost its section "${heading}"`);
        }
    });

    it("keeps the MIT notice the package is required to carry, and its credits", () => {
        const notice = read("NOTICE");
        // The upstream this project is derived from.
        assert.match(
            notice,
            /https:\/\/github\.com\/PhucMPham\/zalo-agent-cli\n\n {4}MIT License\n\n {4}Copyright \(c\) 2026\n/,
        );
        // No file of the replaced endpoint library ships any more, so no license of it travels with the package;
        // the owner's ruling keeps a short credit line to it in NOTICE.
        assert.match(notice, /zca-js/, "NOTICE keeps its credit line");
    });

    it("tells people how to get a commercial license, and that earlier versions stay MIT", () => {
        const notice = read("NOTICE");
        assert.match(
            notice,
            /commercial license, open an issue at:\n {2}https:\/\/github\.com\/ardennguyen\/zalo-agent-cli\/issues/,
        );
        assert.match(notice, /published before this license change[\s\S]*were released under the MIT License/);
        assert.match(
            read("README.md"),
            /\[CC BY-NC-SA 4\.0\]\(https:\/\/creativecommons\.org\/licenses\/by-nc-sa\/4\.0\/\)/,
        );
    });
});
