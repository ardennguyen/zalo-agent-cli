/**
 * A sync-restored message carries a NOISED sender id, and Zalo rejects it as
 * `qmsgOwner` with code 114 — measured live 2026-09-28, and confirmed by
 * substituting a real numeric uid into an otherwise identical quote, which
 * went through immediately.
 *
 * `buildQuote` previously called this a non-fatal "may lose its attribution"
 * warning and returned the quote anyway, so every quote of a restored message
 * failed at the server. These guards pin the corrected behaviour: report the
 * need, and resolve it through the same /api/gid/decrypt the sync path already
 * uses for conversation ids.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildQuote, resolveQuoteSender } from "../../src/utils/quote.js";

/** A cached row shaped like the live listener writes one. */
function liveRow(overrides = {}) {
    return {
        msgId: "8290878947922",
        threadId: "3000000000000000001",
        senderId: "6000000000000000001",
        type: "text",
        text: "Xong nhắn tin riêng",
        timestamp: 1790048509340,
        raw_data: JSON.stringify({
            src: "listen",
            msgType: "webchat",
            cliMsgId: "1790048509227",
            content: "Xong nhắn tin riêng",
            property: { color: -1, size: -1, type: -1, subType: 0, ext: "{}" },
        }),
        ...overrides,
    };
}

/** The same message as transfer-sync-v2 restores it: noised sender. */
const NOISED = "VNOISED0000000000000000000000081";

describe("buildQuote reports a noised sender rather than hiding it", () => {
    it("flags opaqueSender on a sync-restored row", () => {
        const built = buildQuote(liveRow({ senderId: NOISED }));
        assert.equal(built.error, undefined, "a noised sender is recoverable, not a hard stop");
        assert.equal(built.opaqueSender, true);
        assert.match(built.warning, /114/, "the warning must name the actual failure, not 'may lose attribution'");
    });

    it("leaves a live row alone", () => {
        const built = buildQuote(liveRow());
        assert.equal(built.opaqueSender, false);
        assert.equal(built.warning, undefined);
        assert.equal(built.quote.uidFrom, "6000000000000000001");
    });
});

describe("resolveQuoteSender turns a noised id into the real uid", () => {
    it("is a no-op when the uid is already numeric", async () => {
        const quote = { uidFrom: "6000000000000000001" };
        const out = await resolveQuoteSender(quote, {});
        assert.equal(out.error, undefined);
        assert.equal(out.quote.uidFrom, "6000000000000000001");
        assert.equal(out.resolved, undefined, "nothing was resolved, so say nothing");
    });

    it("refuses a quote with no sender at all", async () => {
        const out = await resolveQuoteSender({}, {});
        assert.match(out.error, /no sender/i);
    });

    it("reports what to do when the id cannot be decoded", async () => {
        // getAllFriends/getAllGroups are what resolveNonFriendDms reaches for;
        // an api that answers nothing makes the lookup come back empty.
        const api = {
            zpwServiceMap: { profile: ["https://example.invalid"] },
            getAllFriends: async () => [],
            getAllGroups: async () => ({ gridVerMap: {} }),
            getUserInfo: async () => ({}),
        };
        const quote = { uidFrom: NOISED };
        const out = await resolveQuoteSender(quote, api);
        assert.ok(out.error, "an unresolvable sender must not be sent — the server rejects it");
        assert.match(out.error, /msg history/, "the error has to name the way out");
        assert.equal(quote.uidFrom, NOISED, "a failed resolve must leave the quote untouched");
    });
});
