/**
 * `msg send` of a text Zalo would refuse as one message: it goes out as several, the way Zalo Web sends it.
 *
 * Measured live (2026-10-29): plain text past 3000 UTF-16 units is refused with 114, and a styled message past
 * roughly 3.1 KB of text plus style JSON with 112 — 1200 Chinese characters with one bold word already is. Web
 * budgets each message at 3000 bytes of text plus styles, cuts at a newline or a sentence end, and sends the parts
 * 300 ms apart.
 *
 * Each test drives the real CLI offline and reads the decrypted requests.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { seedAccount, seedThread, runOffline, requestsTo } from "./support/offline-cli.js";

const PEER = "300000000000000041";
const bytes = (s) => Buffer.byteLength(s, "utf8");

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(PEER, "dm");
});

const sends = (r) => requestsTo(r.requests, "/api/message/sms");

describe("msg send of a long text", () => {
    it("a Chinese text of 1500 characters (4500 bytes) goes out as two messages, none over 3000 bytes", async () => {
        const text = "这是一个用来检查切分的句子，请忽略它。".repeat(80);
        assert.ok(bytes(text) > 3000);
        const r = await runOffline(["msg", "send", PEER, text]);
        const q = sends(r);
        // Red if the text goes out whole (one request, which Zalo would refuse) or is cut anywhere but at a sentence end.
        assert.equal(q.length, 2, r.all);
        for (const hit of q) assert.ok(bytes(hit.params.message) <= 3000, `part is ${bytes(hit.params.message)} bytes`);
        assert.equal(q.map((hit) => hit.params.message).join(""), text);
        assert.match(q[0].params.message, /。$/);
    });

    it("keeps the order, and the parts add up to the text that was written", async () => {
        const paragraphs = Array.from({ length: 5 }, (_, i) => `Đoạn ${i} ${"chữ Việt có dấu ".repeat(60)}`.trim());
        const r = await runOffline(["msg", "send", PEER, paragraphs.join("\n\n")]);
        const q = sends(r);
        assert.ok(q.length >= 2, r.all);
        const joined = q.map((hit) => hit.params.message).join("\n\n");
        assert.equal(joined, paragraphs.join("\n\n"));
        for (const hit of q) assert.ok(bytes(hit.params.message) <= 3000);
    });

    it("a text that fits is one request, byte for byte as written", async () => {
        const r = await runOffline(["msg", "send", PEER, "  chào bạn 😀\n\n  "]);
        const q = sends(r);
        assert.equal(q.length, 1);
        assert.equal(q[0].params.message, "  chào bạn 😀\n\n  ");
    });

    it("--markdown: ninety bullets are over the budget because of their styles, and split with styles per part", async () => {
        // Starts with a line of text: an argument beginning with "- " would be read as an option.
        const md = `Danh sách\n${Array.from({ length: 90 }, (_, i) => `- mục số ${i}`).join("\n")}`;
        const r = await runOffline(["msg", "send", PEER, md, "--markdown"]);
        const q = sends(r);
        assert.ok(q.length >= 2, r.all);
        let lines = 0;
        for (const hit of q) {
            const props = JSON.parse(hit.params.textProperties);
            assert.ok(bytes(hit.params.message) + bytes(JSON.stringify(props.styles)) <= 3000);
            for (const s of props.styles) {
                assert.equal(s.st, "lst_1");
                assert.match(hit.params.message.slice(s.start, s.start + s.len), /^mục số \d+$/);
                lines++;
            }
        }
        assert.equal(lines, 90, "no bullet lost or cut");
    });

    it("--urgency marks the first part only", async () => {
        const r = await runOffline(["msg", "send", PEER, "word ".repeat(1500), "--urgency", "urgent"]);
        const q = sends(r);
        assert.ok(q.length >= 2, r.all);
        assert.deepEqual(q[0].params.metaData, { urgency: 2 });
        for (const hit of q.slice(1)) assert.equal("metaData" in hit.params, false);
    });

    it("--json lists every part's ids", async () => {
        const r = await runOffline(["--json", "msg", "send", PEER, "word ".repeat(1500)]);
        const out = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
        assert.equal(out.splitInto, sends(r).length);
        assert.equal(out.parts.length, out.splitInto);
    });
});
