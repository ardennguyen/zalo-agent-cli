/**
 * Mention offset computation and the quote-payload rebuild.
 *
 * Both exist because two pieces of Zalo state cannot be hand-derived:
 *
 *   · `pos`/`len` on a mention are UTF-16 code-unit offsets into the message
 *     string. On accented Vietnamese — most of what this CLI sends — a
 *     byte-counted offset lands mid-character and the tag paints over the
 *     wrong span. The offsets asserted below are the real failure mode, so
 *     they are pinned numerically, not round-tripped.
 *   · `cliMsgId` and the `property` blob appear in no CLI output; they live
 *     only in `messages.raw_data`. The quote builder's whole job is turning
 *     that row back into a payload, and refusing clearly when it cannot.
 *
 * Pure logic, so no sandbox: neither module touches the filesystem or
 * CONFIG_DIR.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    expandMentions,
    parseMentionSpecs,
    shiftStyles,
    ALL_MENTION_UID,
    ALL_MENTION_LABEL,
} from "../../src/utils/mentions.js";
import { buildQuote } from "../../src/utils/quote.js";

const UID_A = "1000000000000000001";
const UID_B = "1000000000000000002";
const NAMES = {
    [UID_A]: "Trần Bích Ngọc",
    [UID_B]: "Đỗ Quỳnh Như",
};
const resolve = (uid) => NAMES[uid] || null;

describe("expandMentions — offsets on multi-byte text", () => {
    it("computes UTF-16 offsets, not byte offsets", () => {
        const { text, mentions } = expandMentions(`Em ko biết mở ch ạ @[${UID_A}]`, resolve);

        assert.equal(text, "Em ko biết mở ch ạ @Trần Bích Ngọc");
        assert.deepEqual(mentions, [{ pos: 19, uid: UID_A, len: 15 }]);

        // The point of the whole module: the slice Zalo will highlight.
        const m = mentions[0];
        assert.equal(text.slice(m.pos, m.pos + m.len), "@Trần Bích Ngọc");
    });

    it("the same offsets read as bytes would land mid-name", () => {
        const { text, mentions } = expandMentions(`Em ko biết mở ch ạ @[${UID_A}]`, resolve);
        const m = mentions[0];
        const byteSlice = Buffer.from(text, "utf8")
            .subarray(m.pos, m.pos + m.len)
            .toString("utf8");
        assert.notEqual(byteSlice, "@Trần Bích Ngọc", "byte offsets must not accidentally agree here");
    });

    it("keeps later mentions correct after an accented one", () => {
        const { text, mentions } = expandMentions(`@[${UID_A}] ạ, nhờ @[${UID_B}] xem giúp`, resolve);

        assert.equal(text, "@Trần Bích Ngọc ạ, nhờ @Đỗ Quỳnh Như xem giúp");
        assert.deepEqual(mentions, [
            { pos: 0, uid: UID_A, len: 15 },
            { pos: 23, uid: UID_B, len: 13 },
        ]);
        for (const m of mentions) {
            assert.equal(text.slice(m.pos, m.pos + m.len), `@${NAMES[m.uid]}`);
        }
    });

    it("handles emoji before a mention (surrogate pairs are two code units)", () => {
        const { text, mentions } = expandMentions(`🎉 @[${UID_A}]`, resolve);
        // "🎉" is one grapheme but two UTF-16 code units, plus the space.
        assert.deepEqual(mentions, [{ pos: 3, uid: UID_A, len: 15 }]);
        assert.equal(text.slice(mentions[0].pos, mentions[0].pos + mentions[0].len), "@Trần Bích Ngọc");
    });
});

describe("expandMentions — uid handling", () => {
    it("expands @[-1] to @All", () => {
        const { text, mentions } = expandMentions(`@[${ALL_MENTION_UID}] họp lúc 3h`, resolve);
        assert.equal(text, "@All họp lúc 3h");
        // Matches what Zalo's own clients write: uid "-1", len 4.
        assert.deepEqual(mentions, [{ pos: 0, uid: "-1", len: 4 }]);
        assert.equal(ALL_MENTION_LABEL, "All");
    });

    it("lets a resolver override the @All label", () => {
        const { text, mentions } = expandMentions(`@[-1] xin chào`, () => "Tất cả");
        assert.equal(text, "@Tất cả xin chào");
        assert.equal(mentions[0].len, 7);
        assert.equal(text.slice(0, 7), "@Tất cả");
    });

    it("falls back to the uid when no name is cached", () => {
        const { text, mentions } = expandMentions(`@[${UID_A}] hi`, () => null);
        assert.equal(text, `@${UID_A} hi`);
        assert.deepEqual(mentions, [{ pos: 0, uid: UID_A, len: UID_A.length + 1 }]);
    });

    it("works with no resolver at all", () => {
        const { text, mentions } = expandMentions(`@[${UID_A}]`);
        assert.equal(text, `@${UID_A}`);
        assert.equal(mentions.length, 1);
    });

    it("leaves non-uid bracket text alone", () => {
        const src = "see @[TODO] and @[note-1] below";
        const { text, mentions } = expandMentions(src, resolve);
        assert.equal(text, src);
        assert.deepEqual(mentions, []);
    });

    it("returns the text unchanged when there is nothing to expand", () => {
        const { text, mentions, edits } = expandMentions("chào cả nhà", resolve);
        assert.equal(text, "chào cả nhà");
        assert.deepEqual(mentions, []);
        assert.deepEqual(edits, []);
    });

    it("tolerates a null message", () => {
        assert.deepEqual(expandMentions(null, resolve), { text: "", mentions: [], edits: [] });
    });

    it("does not carry regex state between calls", () => {
        const src = `@[${UID_A}] xin chào`;
        const first = expandMentions(src, resolve);
        const second = expandMentions(src, resolve);
        assert.deepEqual(first.mentions, second.mentions);
    });
});

describe("expandMentions — total mention length stays sendable", () => {
    it("never exceeds the message length (zca-js rejects that outright)", () => {
        const { text, mentions } = expandMentions(`@[${UID_A}] @[${UID_B}] @[-1]`, resolve);
        const total = mentions.reduce((n, m) => n + m.len, 0);
        assert.ok(total <= text.length, `${total} mention chars in a ${text.length}-char message`);
    });
});

describe("shiftStyles", () => {
    const edits = [{ start: 10, oldLen: 5, newLen: 12 }]; // +7

    it("moves a style that starts after the expansion", () => {
        assert.deepEqual(shiftStyles([{ start: 20, len: 4, st: "b" }], edits), [{ start: 27, len: 4, st: "b" }]);
    });

    it("leaves a style that ends before the expansion", () => {
        assert.deepEqual(shiftStyles([{ start: 0, len: 5, st: "b" }], edits), [{ start: 0, len: 5, st: "b" }]);
    });

    it("grows a style that spans the expansion", () => {
        assert.deepEqual(shiftStyles([{ start: 0, len: 20, st: "b" }], edits), [{ start: 0, len: 27, st: "b" }]);
    });

    it("is a no-op when nothing expanded", () => {
        const styles = [{ start: 3, len: 4, st: "i" }];
        assert.deepEqual(shiftStyles(styles, []), styles);
    });

    it("keeps bold over a mention it wraps, end to end", () => {
        // What `msg send --md "**chào @[uid]**"` does, in order.
        const plain = `chào @[${UID_A}]`; // markdown markers already stripped
        const styles = [{ start: 0, len: plain.length, st: "b" }];
        const expanded = expandMentions(plain, resolve);
        const shifted = shiftStyles(styles, expanded.edits);

        assert.equal(expanded.text, "chào @Trần Bích Ngọc");
        assert.equal(shifted[0].start, 0);
        assert.equal(shifted[0].len, expanded.text.length, "bold must still cover the whole run");
    });
});

describe("parseMentionSpecs — back-compat", () => {
    it("parses pos:uid:len", () => {
        assert.deepEqual(parseMentionSpecs([`0:${UID_A}:5`, `7:${UID_B}:3`]), [
            { pos: 0, uid: UID_A, len: 5 },
            { pos: 7, uid: UID_B, len: 3 },
        ]);
    });

    it("accepts -1 for @All", () => {
        assert.deepEqual(parseMentionSpecs(["0:-1:4"]), [{ pos: 0, uid: "-1", len: 4 }]);
    });

    it("drops specs that are not three parts rather than sending NaN", () => {
        assert.deepEqual(parseMentionSpecs([`0:${UID_A}`, "garbage", `x:${UID_A}:5`]), []);
    });

    it("returns an empty array when the flag was not passed", () => {
        assert.deepEqual(parseMentionSpecs(undefined), []);
        assert.deepEqual(parseMentionSpecs([]), []);
    });
});

/** A cached row shaped the way the live listener writes one. */
function liveRow(over = {}) {
    const { raw = {}, ...rest } = over;
    return {
        msgId: "8314033169851",
        threadId: "3000000000000000001",
        senderId: UID_A,
        senderName: "Trần Bích Ngọc",
        text: "tưởng nước ngoài",
        timestamp: 1759000000000,
        type: "text",
        raw_data: JSON.stringify({
            msgType: "webchat",
            cliMsgId: 1790585664710,
            content: "tưởng nước ngoài",
            property: { color: -1, size: -1, type: 1, subType: 0, ext: '{"shouldParseLinkOrContact":0}' },
            ...raw,
        }),
        ...rest,
    };
}

describe("buildQuote", () => {
    it("rebuilds the payload zca-js needs", () => {
        const { quote, error } = buildQuote(liveRow());
        assert.equal(error, undefined);
        assert.deepEqual(quote, {
            content: "tưởng nước ngoài",
            msgType: "webchat",
            propertyExt: { color: -1, size: -1, type: 1, subType: 0, ext: '{"shouldParseLinkOrContact":0}' },
            uidFrom: UID_A,
            msgId: "8314033169851",
            cliMsgId: "1790585664710",
            ts: "1759000000000",
            ttl: 0,
        });
    });

    it("stringifies cliMsgId, msgId and ts — Zalo rejects the numbers", () => {
        const { quote } = buildQuote(liveRow());
        assert.equal(typeof quote.cliMsgId, "string");
        assert.equal(typeof quote.msgId, "string");
        assert.equal(typeof quote.ts, "string");
    });

    it("normalizes the sync path's numeric msgType to webchat", () => {
        // A text row restored by transfer-sync-v2 records msgType 0, not "webchat".
        const { quote } = buildQuote(liveRow({ raw: { msgType: 0 } }));
        assert.equal(quote.msgType, "webchat");
    });

    it("reads raw_data nested under .data", () => {
        const row = liveRow();
        row.raw_data = JSON.stringify({ data: JSON.parse(row.raw_data) });
        const { quote } = buildQuote(row);
        assert.equal(quote.cliMsgId, "1790585664710");
    });

    it("drops propertyExt rather than inventing one when the row has none", () => {
        const row = liveRow();
        const raw = JSON.parse(row.raw_data);
        delete raw.property;
        row.raw_data = JSON.stringify(raw);
        const { quote } = buildQuote(row);
        assert.equal(quote.propertyExt, undefined);
        assert.equal(quote.content, "tưởng nước ngoài");
    });

    it("falls back to the row's text column when raw content is absent", () => {
        const row = liveRow();
        const raw = JSON.parse(row.raw_data);
        delete raw.content;
        row.raw_data = JSON.stringify(raw);
        assert.equal(buildQuote(row).quote.content, "tưởng nước ngoài");
    });

    it("survives raw_data that is not JSON, if the row has what it needs", () => {
        const row = liveRow({ raw_data: "tưởng nước ngoài" });
        // No cliMsgId recoverable → a clear refusal, not a crash.
        assert.match(buildQuote(row).error, /cliMsgId/);
    });
});

describe("buildQuote — refusals", () => {
    it("explains an uncached msgId and names the fix", () => {
        const { error, quote } = buildQuote(null, { msgId: "123" });
        assert.equal(quote, undefined);
        assert.match(error, /123 is not in the local cache/);
        assert.match(error, /msg history/);
    });

    for (const kind of ["photo", "sticker", "file", "video", "link"]) {
        it(`refuses a ${kind} instead of letting the ZaloApiError surface`, () => {
            // The sync path stores a placeholder STRING here ("[Sticker]"), so a
            // typeof-content check would wave this through; the type column is
            // what actually distinguishes it.
            const row = liveRow({ type: kind, text: "[Sticker]", raw: { content: "[Sticker]" } });
            const { error } = buildQuote(row);
            assert.match(error, new RegExp(`only supports quote-replies to text messages`));
            assert.match(error, new RegExp(`is a ${kind}`));
        });
    }

    it("refuses an attachment whose content is an object", () => {
        const row = liveRow({ type: null, text: null, raw: { content: { href: "https://x", thumb: "https://y" } } });
        assert.match(buildQuote(row).error, /not text/);
    });

    it("refuses a row with no cliMsgId", () => {
        const row = liveRow();
        const raw = JSON.parse(row.raw_data);
        delete raw.cliMsgId;
        row.raw_data = JSON.stringify(raw);
        assert.match(buildQuote(row).error, /cliMsgId was never cached/);
    });

    it("refuses a row with no sender", () => {
        const row = liveRow({ senderId: null });
        const raw = JSON.parse(row.raw_data);
        row.raw_data = JSON.stringify(raw);
        assert.match(buildQuote(row).error, /sender is unknown/);
    });

    it("refuses a row with no timestamp", () => {
        assert.match(buildQuote(liveRow({ timestamp: null })).error, /timestamp is unknown/);
    });

    it("refuses a msgId that belongs to another thread", () => {
        const { error } = buildQuote(liveRow(), { threadId: "3000000000000000999" });
        assert.match(error, /belongs to thread 3000000000000000001, not 3000000000000000999/);
    });

    it("accepts a msgId in the thread being sent to", () => {
        const { quote, error } = buildQuote(liveRow(), { threadId: "3000000000000000001" });
        assert.equal(error, undefined);
        assert.equal(quote.msgId, "8314033169851");
    });
});

describe("buildQuote — sync-restored rows", () => {
    it("still builds, but flags a noised sender for resolving", () => {
        // transfer-sync-v2 stores these instead of the numeric uid the live
        // listener records. Measured 2026-09-28: Zalo puts it on the wire as
        // qmsgOwner and REJECTS the send with code 114 — this is not the
        // cosmetic loss of attribution the first version of this test assumed.
        // It is recoverable, so buildQuote reports it and the caller resolves.
        const { quote, warning, error, opaqueSender } = buildQuote(
            liveRow({ senderId: "VNOISED0000000000000000000000091" }),
        );
        assert.equal(error, undefined, "recoverable, so not a hard stop here");
        assert.equal(opaqueSender, true, "the caller needs a flag, not just prose");
        assert.equal(quote.uidFrom, "VNOISED0000000000000000000000091");
        assert.match(warning, /114/, "name the actual failure, not a vague attribution risk");
        assert.match(warning, /msg history/, "should name the command that repairs it");
    });

    it("says nothing for a normal numeric sender", () => {
        assert.equal(buildQuote(liveRow()).warning, undefined);
    });
});
