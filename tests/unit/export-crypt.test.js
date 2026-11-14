/**
 * The password-encrypted export file (src/core/export-crypt.js): it opens with the right password and with nothing
 * else, the header names the scrypt parameters and salt (never the password), and any change to the file, a chunk
 * moved or dropped, or a file cut at a chunk boundary, fails to open and leaves nothing behind.
 *
 * Red if the plaintext shows in the file, if a wrong password or a changed byte yields output, or if truncation at a
 * chunk boundary (the attack the "final" flag closes) goes unnoticed.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    EXPORT_MAGIC,
    ExportCryptError,
    decryptExportFile,
    encryptExportFile,
    passwordProblem,
    readExportHeader,
} from "../../src/core/export-crypt.js";

const KDF = { N: 1024, r: 8, p: 1 };
const PASSWORD = "correct horse battery";
const dir = join(SANDBOX_HOME, "export-crypt");
let n = 0;
const path = (name) => join(dir, `${n++}-${name}`);

/** A plaintext of `size` bytes with a marker, encrypted with 4 KiB chunks. */
async function sealed(size = 10_000, { chunkSize = 4096 } = {}) {
    const src = path("plain.bin");
    const body = Buffer.concat([Buffer.from("MARKER-in-the-plaintext"), randomBytes(Math.max(0, size - 23))]).subarray(
        0,
        size,
    );
    writeFileSync(src, body);
    const out = path("file.zaexport");
    const r = await encryptExportFile(src, out, PASSWORD, { kdf: KDF, chunkSize });
    return { src, out, body, r };
}

before(() => {
    assertSandboxed(CONFIG_DIR);
    mkdirSync(dir, { recursive: true });
});

describe("password-encrypted export file", () => {
    it("opens with the right password, byte for byte; the file holds no plaintext and no password", async () => {
        const { out, body, r } = await sealed(10_000);
        const bytes = readFileSync(out);
        assert.deepEqual(bytes.subarray(0, 8), EXPORT_MAGIC);
        assert.equal(bytes.includes(Buffer.from("MARKER-in-the-plaintext")), false);
        assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
        assert.equal(r.plaintextBytes, 10_000);
        const { header } = await readExportHeader(out);
        assert.equal(header.cipher, "aes-256-gcm");
        assert.deepEqual(
            { name: header.kdf.name, N: header.kdf.N, r: header.kdf.r, p: header.kdf.p },
            { name: "scrypt", ...KDF },
        );
        assert.equal(Buffer.from(header.kdf.salt, "base64").length, 16);
        const back = path("back.bin");
        await decryptExportFile(out, back, PASSWORD);
        assert.deepEqual(readFileSync(back), body);
    });

    it("an empty file and an exact multiple of the chunk size both round-trip", async () => {
        for (const size of [0, 8192]) {
            const { out, body } = await sealed(size);
            const back = path("back.bin");
            await decryptExportFile(out, back, PASSWORD);
            assert.deepEqual(readFileSync(back), body, `size ${size}`);
        }
    });

    it("a wrong password yields nothing", async () => {
        const { out } = await sealed();
        const back = path("back.bin");
        await assert.rejects(decryptExportFile(out, back, "not the password"), (e) => {
            assert.ok(e instanceof ExportCryptError);
            assert.equal(e.code, "WRONG_PASSWORD_OR_DAMAGED");
            return true;
        });
        assert.equal(existsSync(back), false);
    });

    it("a changed header, a flipped byte, a dropped last chunk or swapped chunks fail to open", async () => {
        const { out } = await sealed(12_000);
        const bytes = readFileSync(out);
        const hlen = bytes.readUInt32BE(8);
        const data = 12 + hlen;
        const step = 4096 + 16;
        const variants = {
            header: (() => {
                const b = Buffer.from(bytes);
                const text = b.subarray(12, data).toString("utf8").replace('"createdAt":"', '"createdAt":"X');
                const h = Buffer.from(text, "utf8");
                const out2 = Buffer.alloc(12 + h.length);
                bytes.copy(out2, 0, 0, 8);
                out2.writeUInt32BE(h.length, 8);
                h.copy(out2, 12);
                return Buffer.concat([out2, b.subarray(data)]);
            })(),
            flipped: (() => {
                const b = Buffer.from(bytes);
                b[data + 100] ^= 1;
                return b;
            })(),
            // Two full chunks and a short final one: dropping the final chunk leaves a file cut at a chunk boundary.
            truncated: bytes.subarray(0, data + 2 * step),
            swapped: Buffer.concat([
                bytes.subarray(0, data),
                bytes.subarray(data + step, data + 2 * step),
                bytes.subarray(data, data + step),
                bytes.subarray(data + 2 * step),
            ]),
        };
        for (const [name, b] of Object.entries(variants)) {
            const f = path(`${name}.zaexport`);
            writeFileSync(f, b);
            const back = path("back.bin");
            await assert.rejects(decryptExportFile(f, back, PASSWORD), ExportCryptError, name);
            assert.equal(existsSync(back), false, `${name}: nothing left behind`);
        }
    });

    it("refuses a short password, a non-export file, and never overwrites", async () => {
        assert.match(passwordProblem("short"), /at least 8/);
        assert.equal(passwordProblem(PASSWORD), null);
        const src = path("p.bin");
        writeFileSync(src, "x");
        await assert.rejects(encryptExportFile(src, path("o"), "short", { kdf: KDF }), /at least 8/);
        await assert.rejects(readExportHeader(src), /not a password-encrypted export/);
        const { out } = await sealed(100);
        await assert.rejects(encryptExportFile(src, out, PASSWORD, { kdf: KDF }), (e) => e.code === "EEXIST");
        const { header } = await readExportHeader(out);
        assert.equal(header.plaintextBytes, 100, "the existing file is untouched");
    });
});
