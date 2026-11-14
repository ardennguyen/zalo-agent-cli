/**
 * src/zalo/listener/frames.js and src/zalo/kernel/json-ids.js: the chat socket's frame header, the outgoing encoder,
 * the payload decoder (encrypt 0-3, zlib and gzip, 16- and 32-byte keys), the handshake reader, and the lossless
 * id pass.
 *
 * Every frame here is built by the test from a hand-written body with fake ids.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import {
    CHAT_CMDS,
    CTRL_CMDS,
    ENCRYPT,
    decodeFrame,
    encodeFrame,
    idKeysForCmd,
    parseFrame,
    readAuthFrame,
    readHeader,
} from "../../src/zalo/listener/frames.js";
import { API_ID_KEYS, CHAT_ID_KEYS, CTRL_ID_KEYS, parseWithIds, preParse } from "../../src/zalo/kernel/json-ids.js";

// Fake ids (tests/unit/no-real-ids.test.js): past 2^53, so a lossy parse is visible.
const PEER = "2000000000000000002";
const GROUP = "3000000000000000003";
const BIG = "1234567890123456789";

const KEY16 = crypto.randomBytes(16).toString("base64");
const KEY24 = crypto.randomBytes(24).toString("base64");
const KEY32 = crypto.randomBytes(32).toString("base64");

/** The AES-GCM of a raw key, by its length (what WebCrypto picks from the key it imports). */
const gcmFor = (k) => ({ 16: "aes-128-gcm", 24: "aes-192-gcm", 32: "aes-256-gcm" })[k.length];

/**
 * Build an inbound envelope the way the server does: JSON text -> (zip) -> (seal) -> base64, URI-encoded when
 * sealed. `text` is used as given so a test can put integers JSON.stringify could not write.
 */
function envelope({ text, encrypt, key, zip = "zlib" }) {
    const json = Buffer.from(text, "utf8");
    if (encrypt === 0) return { encrypt: 0, data: text };
    const packed = encrypt === 3 ? json : zip === "gzip" ? zlib.gzipSync(json) : zlib.deflateSync(json);
    if (encrypt === 1) return { encrypt: 1, data: packed.toString("base64") };
    const k = Buffer.from(key, "base64");
    const iv = crypto.randomBytes(16);
    const aad = crypto.randomBytes(16);
    const c = crypto.createCipheriv(gcmFor(k), k, iv);
    c.setAAD(aad);
    const sealed = Buffer.concat([iv, aad, c.update(packed), c.final(), c.getAuthTag()]);
    return { encrypt, data: encodeURIComponent(sealed.toString("base64")) };
}

/** A whole frame: header + envelope JSON. */
function frameBytes(version, cmd, subCmd, env) {
    const head = Buffer.from([version, cmd & 0xff, cmd >> 8, subCmd]);
    return Buffer.concat([head, Buffer.from(JSON.stringify(env), "utf8")]);
}

/** Every encoding the server uses, by name. */
const MATRIX = [
    { name: "encrypt 0", encrypt: 0 },
    { name: "encrypt 1, zlib", encrypt: 1, zip: "zlib" },
    { name: "encrypt 1, gzip", encrypt: 1, zip: "gzip" },
    { name: "encrypt 2, zlib, 16-byte key", encrypt: 2, zip: "zlib", key: KEY16 },
    { name: "encrypt 2, gzip, 16-byte key", encrypt: 2, zip: "gzip", key: KEY16 },
    { name: "encrypt 2, zlib, 32-byte key", encrypt: 2, zip: "zlib", key: KEY32 },
    { name: "encrypt 2, gzip, 32-byte key", encrypt: 2, zip: "gzip", key: KEY32 },
    { name: "encrypt 3, 16-byte key", encrypt: 3, key: KEY16 },
    { name: "encrypt 3, 32-byte key", encrypt: 3, key: KEY32 },
];

/** A push body with Vietnamese text and an emoji, so a wrong text decoding shows. */
const BODY = {
    error_code: 0,
    data: { msgs: [{ msgId: "7000000000001", uidFrom: PEER, idTo: "0", content: "Xin chào 👋", ts: "1700000000000" }] },
};

describe("readHeader", () => {
    it("reads version, a little-endian u16 cmd and subCmd", () => {
        // 3000 = 0x0BB8: a cmd above 255 is red if the cmd is read as one byte or big-endian.
        assert.deepEqual(readHeader(Buffer.from([1, 0xb8, 0x0b, 0, 0x7b])), { version: 1, cmd: 3000, subCmd: 0 });
        assert.deepEqual(readHeader(Buffer.from([1, 0xf5, 0x01, 2])), { version: 1, cmd: 501, subCmd: 2 });
    });

    it("reads a plain Uint8Array view at an offset", () => {
        const backing = new Uint8Array([9, 9, 1, 0x59, 0x02, 0]);
        assert.deepEqual(readHeader(backing.subarray(2)), { version: 1, cmd: 601, subCmd: 0 });
    });

    it("returns null for fewer than four bytes or a non-buffer", () => {
        assert.equal(readHeader(Buffer.from([1, 0xf5, 0x01])), null);
        assert.equal(readHeader("1234"), null);
        assert.equal(readHeader(null), null);
    });
});

describe("encodeFrame", () => {
    it("writes the header and the UTF-8 JSON of data", () => {
        const data = { first: true, reqId: "req_1", lastId: "0", preIds: [], note: "chào" };
        const buf = encodeFrame({ version: 1, cmd: 510, subCmd: 1, data });
        assert.deepEqual([...buf.subarray(0, 4)], [1, 0xfe, 0x01, 1]);
        assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf8")), data);
        assert.deepEqual(readHeader(buf), { version: 1, cmd: 510, subCmd: 1 });
    });

    it("defaults version to 1", () => {
        assert.equal(encodeFrame({ cmd: 2, subCmd: 1, data: { eventId: 1 } })[0], 1);
    });

    it("sends the header alone when data is not a plain object", () => {
        for (const data of [undefined, null, "x", 5, [1, 2]]) {
            assert.equal(encodeFrame({ cmd: 2, subCmd: 1, data }).length, 4, `data ${JSON.stringify(data)}`);
        }
    });

    it("refuses a missing subCmd instead of defaulting it", () => {
        assert.throws(() => encodeFrame({ cmd: 2, data: {} }), /subCmd/);
    });

    it("refuses values that do not fit their field", () => {
        assert.throws(() => encodeFrame({ cmd: 65536, subCmd: 0 }), /cmd/);
        assert.throws(() => encodeFrame({ cmd: -1, subCmd: 0 }), /cmd/);
        assert.throws(() => encodeFrame({ cmd: 1.5, subCmd: 0 }), /cmd/);
        assert.throws(() => encodeFrame({ cmd: 1, subCmd: 256 }), /subCmd/);
        assert.throws(() => encodeFrame({ version: 300, cmd: 1, subCmd: 0 }), /version/);
    });
});

describe("decodeFrame", () => {
    it("knows the four encodings by their wire numbers", () => {
        assert.deepEqual({ ...ENCRYPT }, { PLAIN: 0, ZIPPED: 1, SEALED_ZIPPED: 2, SEALED: 3 });
    });

    for (const row of MATRIX) {
        it(`decodes ${row.name}`, () => {
            const env = envelope({ text: JSON.stringify(BODY), ...row });
            assert.deepEqual(decodeFrame(env, row.key ?? null), BODY);
        });
    }

    it("inflates raw deflate as a last resort", () => {
        const env = { encrypt: 1, data: zlib.deflateRawSync(Buffer.from(JSON.stringify(BODY))).toString("base64") };
        assert.deepEqual(decodeFrame(env, null), BODY);
    });

    it("does not need a key for encrypt 0 and 1", () => {
        assert.deepEqual(decodeFrame(envelope({ text: '{"a":1}', encrypt: 1 }), undefined), { a: 1 });
    });

    it("throws on a sealed payload shorter than 48 bytes", () => {
        // 47 bytes: iv + aad + a 15-byte tag. Red if the length check is dropped (GCM would fail differently) or
        // set at the wrong size.
        const short = { encrypt: 2, data: encodeURIComponent(crypto.randomBytes(47).toString("base64")) };
        assert.throws(() => decodeFrame(short, KEY16), /short frame/);
        assert.throws(() => decodeFrame({ ...short, encrypt: 3 }, KEY16), /short frame/);
    });

    it("throws on a missing key for encrypt 2 and 3", () => {
        for (const encrypt of [2, 3]) {
            const env = envelope({ text: "{}", encrypt, key: KEY16 });
            assert.throws(() => decodeFrame(env, null), /missing cipher key/);
            assert.throws(() => decodeFrame(env, ""), /missing cipher key/);
        }
    });

    it("throws on a wrong key, of either size", () => {
        for (const key of [KEY16, KEY32]) {
            const env = envelope({ text: JSON.stringify(BODY), encrypt: 2, key });
            const wrong = crypto.randomBytes(Buffer.from(key, "base64").length).toString("base64");
            assert.throws(() => decodeFrame(env, wrong), /unable to authenticate|auth/i);
        }
    });

    it("opens a 24-byte key as AES-192-GCM, both sealed encodings", () => {
        // Zalo's key can be any AES size. Red if the decoder only knew 16 and 32 bytes
        // (it would refuse the key) or picked the cipher by a fixed size (the tag would not verify).
        for (const encrypt of [2, 3]) {
            const env = envelope({ text: JSON.stringify(BODY), encrypt, key: KEY24 });
            assert.deepEqual(decodeFrame(env, KEY24), BODY, `encrypt ${encrypt}`);
            const wrong = crypto.randomBytes(24).toString("base64");
            assert.throws(() => decodeFrame(env, wrong), /unable to authenticate|auth/i);
        }
    });

    it("throws on a key of an AES-impossible size", () => {
        const env = envelope({ text: "{}", encrypt: 2, key: KEY16 });
        assert.throws(() => decodeFrame(env, crypto.randomBytes(20).toString("base64")), /20 bytes/);
    });

    it("throws on an unknown encrypt type or non-string data", () => {
        assert.throws(() => decodeFrame({ encrypt: 4, data: "{}" }, KEY16), /encrypt type 4/);
        assert.throws(() => decodeFrame({ encrypt: "2", data: "{}" }, KEY16), /encrypt type/);
        assert.throws(() => decodeFrame({ data: "{}" }, KEY16), /encrypt type/);
        assert.throws(() => decodeFrame({ encrypt: 0, data: { a: 1 } }, KEY16), /must be a string/);
    });

    it("parses plainly unless id keys are given", () => {
        const text = `{"data":{"msgs":[{"msgId":${BIG},"uidFrom":${PEER}}]}}`;
        for (const row of MATRIX) {
            const env = envelope({ text, ...row });
            const plain = decodeFrame(env, row.key).data.msgs[0];
            assert.equal(typeof plain.msgId, "number", `${row.name}: plain parse`);
            const kept = decodeFrame(env, row.key, { idKeys: CHAT_ID_KEYS }).data.msgs[0];
            // Red if the decoder ignores idKeys on any encoding (the digits would round past 2^53).
            assert.equal(kept.msgId, BIG, `${row.name}: msgId`);
            assert.equal(kept.uidFrom, PEER, `${row.name}: uidFrom`);
        }
    });
});

describe("parseFrame", () => {
    it("splits the header from the envelope, leaving data encoded", () => {
        const env = envelope({ text: JSON.stringify(BODY), encrypt: 2, key: KEY16 });
        const f = parseFrame(frameBytes(1, 501, 0, env));
        assert.deepEqual(f, { version: 1, cmd: 501, subCmd: 0, envelope: env });
        assert.deepEqual(decodeFrame(f.envelope, KEY16), BODY);
    });

    it("returns null for a short buffer, a body that is not JSON, or a non-object body", () => {
        assert.equal(parseFrame(Buffer.from([1, 2])), null);
        assert.equal(parseFrame(Buffer.concat([Buffer.from([1, 2, 0, 1]), Buffer.from("not json")])), null);
        assert.equal(parseFrame(Buffer.concat([Buffer.from([1, 2, 0, 1]), Buffer.from("[1]")])), null);
        assert.equal(parseFrame(Buffer.concat([Buffer.from([1, 2, 0, 1]), Buffer.from("null")])), null);
    });
});

describe("readAuthFrame", () => {
    const auth = { qCmds: [{ cmd: 510, subCmd: 1 }], ctrl_qCmds: [{ cmd: 603, subCmd: 1 }], bk_cmds: {} };

    it("decodes the handshake's data under the key the same frame carries", () => {
        for (const key of [KEY16, KEY32]) {
            const env = { key, ...envelope({ text: JSON.stringify({ error_code: 0, data: auth }), encrypt: 2, key }) };
            assert.deepEqual(readAuthFrame(env), { key, auth });
        }
    });

    it("hands back the key alone when the handshake has no data", () => {
        assert.deepEqual(readAuthFrame({ key: KEY16 }), { key: KEY16, auth: null });
    });

    it("accepts a decoded handshake with no error_code at all (a pinned leniency)", () => {
        // The strict rule is error_code === 0. This client accepts an absent code on purpose (see readAuthFrame): the previous engine
        // never read this payload, and tests/unit/sync-v2-zalo-lifecycle.test.js sends exactly such a key frame
        // (`{}` as data). Red if the check becomes the strict one; then that file's key frame needs the field.
        assert.deepEqual(readAuthFrame({ key: KEY16, encrypt: 0, data: "{}" }), { key: KEY16, auth: null });
        const sealed = envelope({ text: JSON.stringify({ data: auth }), encrypt: 2, key: KEY16 });
        assert.deepEqual(readAuthFrame({ key: KEY16, ...sealed }), { key: KEY16, auth });
    });

    it("refuses a handshake without a key, with a refusing error_code, or with data under another key", () => {
        assert.throws(() => readAuthFrame({ encrypt: 0, data: "{}" }), /no cipher key/);
        const refused = envelope({ text: JSON.stringify({ error_code: 5007 }), encrypt: 2, key: KEY16 });
        assert.throws(() => readAuthFrame({ key: KEY16, ...refused }), /5007/);
        const other = envelope({ text: JSON.stringify({ error_code: 0, data: auth }), encrypt: 2, key: KEY32 });
        assert.throws(() => readAuthFrame({ key: KEY16, ...other }));
    });
});

describe("idKeysForCmd", () => {
    it("names the chat list for chat cmds and the control list for control cmds", () => {
        for (const cmd of [501, 521, 502, 522, 504, 534, 551, 510, 511, 3000])
            assert.equal(idKeysForCmd(cmd), CHAT_ID_KEYS);
        for (const cmd of [601, 602, 603, 610, 611, 612, 613]) assert.equal(idKeysForCmd(cmd), CTRL_ID_KEYS);
        assert.ok(CHAT_CMDS.length > 0 && CTRL_CMDS.length > 0);
    });

    it("parses the handshake, the ping and unknown cmds plainly", () => {
        for (const cmd of [1, 2, 4, 590, 591, 9999]) assert.equal(idKeysForCmd(cmd), null, `cmd ${cmd}`);
    });

    it("adds the handshake's queue cmds to their family", () => {
        const auth = { qCmds: [{ cmd: 515, subCmd: 0 }, null], ctrl_qCmds: [{ cmd: 713, subCmd: 0 }] };
        assert.equal(idKeysForCmd(515), null);
        assert.equal(idKeysForCmd(515, auth), CHAT_ID_KEYS);
        assert.equal(idKeysForCmd(713, auth), CTRL_ID_KEYS);
        assert.equal(idKeysForCmd(515, { qCmds: "junk" }), null);
    });
});

describe("preParse (the lossless id pass)", () => {
    it("pins the three key lists", () => {
        // Red if a key is added, dropped or misspelled: each list is Zalo's (chat handler, control handler,
        // request/response handler), and a changed list changes which ids arrive as strings.
        assert.deepEqual(
            [...CHAT_ID_KEYS],
            "uidFrom uidTo uid ownerId destId srcId fromUid threadId globalMsgId globalDelMsgId msgId refMessageId actionId lastActionIdOther lastActionId resetLastActionId lastId ids".split(
                " ",
            ),
        );
        assert.deepEqual(
            [...CTRL_ID_KEYS],
            "uid group_id owner_id groupId msgId refMessageId actionId lastActionIdOther lastActionId resetLastActionId lastId ids".split(
                " ",
            ),
        );
        assert.deepEqual(
            [...API_ID_KEYS],
            "uidFrom uidTo uid ownerId destId srcId fromUid threadId msgId refMessageId actionId lastActionIdOther lastActionId resetLastActionId lastId ids".split(
                " ",
            ),
        );
        assert.ok(Object.isFrozen(CHAT_ID_KEYS) && Object.isFrozen(CTRL_ID_KEYS) && Object.isFrozen(API_ID_KEYS));
    });

    it("quotes a listed key's integer and leaves an unlisted key's alone", () => {
        const out = parseWithIds(`{"uidFrom":${BIG},"ts":${BIG},"msgId":5}`, CHAT_ID_KEYS);
        assert.equal(out.uidFrom, BIG);
        assert.equal(out.msgId, "5", "a small integer under a listed key becomes a string too");
        assert.equal(typeof out.ts, "number", "ts is not listed: lossy");
        assert.notEqual(String(out.ts), BIG);
    });

    it("reaches the same keys inside JSON held escaped in a string", () => {
        const inner = JSON.stringify({ uid: Number.MAX_SAFE_INTEGER, name: "x" }).replace(
            String(Number.MAX_SAFE_INTEGER),
            GROUP,
        );
        const text = `{"content":${JSON.stringify(inner)},"deeper":${JSON.stringify(JSON.stringify({ wrap: inner }))}}`;
        const out = parseWithIds(text, CTRL_ID_KEYS);
        assert.equal(JSON.parse(out.content).uid, GROUP, "one level of escaping");
        assert.equal(JSON.parse(JSON.parse(out.deeper).wrap).uid, GROUP, "two levels of escaping");
    });

    it("quotes the integer items of an array under a listed key", () => {
        const out = parseWithIds(`{"ids":[${BIG}, ${PEER},"7"],"other":[${BIG}]}`, CHAT_ID_KEYS);
        assert.deepEqual(out.ids, [BIG, PEER, "7"]);
        assert.equal(typeof out.other[0], "number");
        const escaped = parseWithIds(JSON.stringify({ s: `{"ids":[${BIG}]}` }), CHAT_ID_KEYS);
        assert.deepEqual(JSON.parse(escaped.s).ids, [BIG]);
    });

    it("leaves negatives, decimals, exponents, strings and nested containers as they are", () => {
        const text = '{"msgId":-5,"uid":1.5,"lastId":2e3,"actionId":"9","ids":[{"a":1}],"uidTo":null,"threadId":true}';
        assert.equal(preParse(text, CHAT_ID_KEYS), text);
    });

    it("matches whole keys only", () => {
        const text = `{"uidFromX":${BIG},"xuid":${BIG},"name":"uid","note":"msgId"}`;
        assert.equal(preParse(text, CHAT_ID_KEYS), text);
    });

    it("keeps the text valid JSON with spacing around the colon", () => {
        assert.deepEqual(parseWithIds(`{ "uid" : ${BIG} , "ids" : [ ${BIG} ] }`, CHAT_ID_KEYS), {
            uid: BIG,
            ids: [BIG],
        });
    });

    it("hands back what it cannot work on", () => {
        assert.equal(preParse("", CHAT_ID_KEYS), "");
        assert.equal(preParse(`{"uid":1}`, []), `{"uid":1}`);
        assert.equal(preParse(`{"uid":1}`, null), `{"uid":1}`);
        const obj = { uid: 1 };
        assert.equal(preParse(obj, CHAT_ID_KEYS), obj);
    });

    it("keeps one compiled pattern per key list", () => {
        // uidFrom is on the chat list and not on the control list. Red if the pattern cache hands the first list's
        // pattern to the second call.
        const text = `{"uidFrom":${BIG}}`;
        assert.equal(preParse(text, CHAT_ID_KEYS), `{"uidFrom":"${BIG}"}`);
        assert.equal(preParse(text, CTRL_ID_KEYS), text);
        assert.equal(preParse(text, CHAT_ID_KEYS), `{"uidFrom":"${BIG}"}`);
    });
});

describe("decodeFrame: refusals and the id pass", () => {
    it("fails on a short payload, a missing key, a wrong key and an unknown encrypt", () => {
        const cases = [
            { encrypt: 2, data: encodeURIComponent(crypto.randomBytes(47).toString("base64")), key: KEY16 },
            { ...envelope({ text: "{}", encrypt: 2, key: KEY16 }), key: null },
            { ...envelope({ text: "{}", encrypt: 3, key: KEY32 }), key: crypto.randomBytes(32).toString("base64") },
            { encrypt: 4, data: "{}", key: KEY16 },
        ];
        for (const { key, ...env } of cases) {
            assert.throws(() => decodeFrame(env, key), `accepted ${JSON.stringify(env)}`);
        }
    });

    it("reads ids: listed keys as strings, every digit kept; unlisted big integers lossy", () => {
        const text = `{"data":{"msgId":5,"uidFrom":${BIG},"ts":${BIG}}}`;
        const env = envelope({ text, encrypt: 2, key: KEY16 });
        const own = decodeFrame(env, KEY16, { idKeys: CHAT_ID_KEYS }).data;
        assert.equal(own.uidFrom, BIG, "a big id under a listed key keeps every digit");
        assert.equal(own.msgId, "5", "a small integer under a listed key is a string");
        assert.equal(typeof own.ts, "number", "a big integer under an unlisted key is a number");
        assert.notEqual(String(own.ts), BIG, "and lossy");
    });
});
