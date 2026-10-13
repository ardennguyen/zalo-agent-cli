/**
 * The license: CC BY-NC-SA 4.0 from 2.0.1 on, with the MIT notices of what the
 * package derives from and bundles kept alongside it.
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

    it("keeps the MIT notices the package is required to carry", () => {
        const notice = read("NOTICE");
        // The upstream this project is derived from.
        assert.match(
            notice,
            /https:\/\/github\.com\/PhucMPham\/zalo-agent-cli\n\n {4}MIT License\n\n {4}Copyright \(c\) 2026\n/,
        );
        // zca-js is bundled, patched, in the tarball: its copyright line must be the one it ships with.
        const zcaLicense = readFileSync(join(ROOT, "node_modules", "zca-js", "LICENSE"), "utf8");
        const holder = zcaLicense.match(/^Copyright \(c\) (.+)$/m)?.[1]?.trim();
        assert.ok(holder, "could not read the bundled zca-js copyright line");
        // Red if zca-js changes hands or years and NOTICE keeps quoting the old line.
        assert.ok(notice.includes(`Copyright (c) ${holder}`), `NOTICE must quote zca-js's "${holder}"`);
        assert.match(notice, /https:\/\/github\.com\/RFS-ADRENO\/zca-js/);
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
