/**
 * `oa listen` / `oa init`'s webhook and `oa whoami`, against Zalo's OA docs.
 *
 * The webhook vocabulary: every event name the OA and ZBS webhook pages document, and none Zalo never sends
 * (`user_send_gif`, `user_click_button`, `user_click_link` were once listed). Redeliveries carry `num_retry`.
 *
 * The signature: `X-ZEvent-Signature: mac = sha256(appId + data + timeStamp + OAsecretKey)`, with `data` the JSON
 * body as sent and `appId` / `timeStamp` its `app_id` / `timestamp`. It used to be checked as HMAC-SHA256(body,
 * secret), so every genuine event was refused with `--secret` set.
 *
 * `oa whoami` reads getoa's documented fields (`package_valid_through_date`, `is_verified`, `cate_name`, …); the old
 * fixture held `package_validThroughDate`, a name Zalo does not document, so the package date could never print.
 */
import "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    OA_WEBHOOK_EVENTS,
    unknownEvents,
    retryCount,
    zaloSignature,
    verifyZaloSignature,
    signatureFromHeaders,
    eventUser,
    domainVerification,
} from "../../src/commands/oa-listen.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebhookServer } from "../../src/commands/oa-init.js";
import { describeOAProfile } from "../../src/commands/oa.js";

const SECRET = "fake-oa-secret-key";
/** A hand-made event in the shape of the docs' "user_send_text" example (fake ids). */
const BODY =
    '{"app_id":"1000000000000000001","sender":{"id":"1000000000000000002"},"recipient":{"id":"1000000000000000003"},' +
    '"event_name":"user_send_text","message":{"text":"xin chào","msg_id":"m1"},"timestamp":"1700000000000"}';
/** Computed here independently of the code under test: sha256(app_id + body + timestamp + secret), hex. */
const GOOD = createHash("sha256")
    .update("1000000000000000001" + BODY + "1700000000000" + SECRET, "utf8")
    .digest("hex");

describe("oa listen — the webhook vocabulary", () => {
    it("names every event Zalo documents, and none it never sends", () => {
        for (const e of ["user_click_chatnow", "user_send_audio", "user_seen_message", "user_send_group_text"]) {
            assert.ok(OA_WEBHOOK_EVENTS.includes(e), `${e} is documented`);
        }
        // The 22 names the 2026-11-13 audit found missing.
        const added = [
            "oa_send_anonymous_image",
            "oa_send_anonymous_file",
            "oa_send_anonymous_sticker",
            ...["image", "link", "audio", "video", "business_card", "sticker", "gif", "file"].map(
                (t) => `user_send_group_${t}`,
            ),
            ...["text", "image", "link", "audio", "location", "video", "business_card", "sticker", "gif", "file"].map(
                (t) => `oa_send_group_${t}`,
            ),
            "oa_call_user",
        ];
        assert.equal(added.length, 22);
        assert.deepEqual(unknownEvents(added), []);
        for (const e of ["change_template_status", "user_feedback", "event_journey_time_out"]) {
            assert.ok(OA_WEBHOOK_EVENTS.includes(e), `ZBS ${e} is documented`);
        }
        // Red if a name Zalo never sends comes back into the list.
        for (const e of ["user_send_gif", "user_click_button", "user_click_link", "user_send_group_location"]) {
            assert.ok(!OA_WEBHOOK_EVENTS.includes(e), `${e} is not a Zalo event`);
        }
        assert.equal(new Set(OA_WEBHOOK_EVENTS).size, OA_WEBHOOK_EVENTS.length, "no duplicates");
    });

    it("flags an --events filter that can never match", () => {
        assert.deepEqual(unknownEvents(["follow", "user_click_button", "user_send_text"]), ["user_click_button"]);
        assert.deepEqual(unknownEvents(["follow", "user_click_chatnow"]), []);
    });

    it("reads Zalo's num_retry header, so a redelivery is not taken for a new event", () => {
        assert.equal(retryCount({}), 0);
        assert.equal(retryCount({ num_retry: "2" }), 2);
        assert.equal(retryCount({ num_retry: "not-a-number" }), 0);
    });

    it("names the user from follower.id for follow/unfollow and data.user_id for widget events", () => {
        assert.equal(eventUser({ event_name: "follow", follower: { id: "11" }, oa_id: "9" }), "11");
        assert.equal(eventUser({ event_name: "unfollow", follower: { id: "12" } }), "12");
        assert.equal(eventUser({ event_name: "widget_interaction_accepted", data: { user_id: "13" } }), "13");
        assert.equal(eventUser({ event_name: "user_send_text", sender: { id: "14" } }), "14");
        assert.equal(eventUser({ event_name: "user_received_message" }), "N/A");
    });

    it("names the user, not the OA, for what the OA sent or did, and reads users[], tag.user_ids and phone", () => {
        // Docs: for oa_send_*, user_seen_message, user_received_message and oa_reacted_message `sender.id` is the
        // OA and `recipient.id` the user. Red if the OA's id is printed as the user again.
        const oa = { id: "1000000000000000009" };
        for (const event_name of ["oa_send_text", "user_seen_message", "user_received_message", "oa_reacted_message"]) {
            assert.equal(eventUser({ event_name, sender: oa, recipient: { id: "21" } }), "21", event_name);
        }
        assert.equal(eventUser({ event_name: "user_join_group", users: [{ id: "31" }, { id: "32" }] }), "31, 32");
        assert.equal(eventUser({ event_name: "add_user_to_tag", tag: { user_ids: ["41"] } }), "41");
        assert.equal(eventUser({ event_name: "user_submit_call_consent", phone: "84901234567" }), "84901234567");
    });
});

describe("the X-ZEvent-Signature check", () => {
    it("computes sha256(app_id + body + timestamp + secret) as hex", () => {
        assert.equal(zaloSignature("1000000000000000001", BODY, "1700000000000", SECRET), GOOD);
        assert.equal(zaloSignature("1000000000000000001", Buffer.from(BODY), "1700000000000", SECRET), GOOD);
    });

    it("accepts the right signature, in either hex case, with or without the mac= prefix", () => {
        assert.deepEqual(verifyZaloSignature(Buffer.from(BODY), GOOD, SECRET), { ok: true });
        assert.equal(verifyZaloSignature(BODY, GOOD.toUpperCase(), SECRET).ok, true);
        assert.equal(signatureFromHeaders({ "x-zevent-signature": `mac=${GOOD}` }), GOOD);
        assert.equal(signatureFromHeaders({ "x-zevent-signature": `mac = ${GOOD}` }), GOOD);
        assert.equal(signatureFromHeaders({ "x-zevent-signature": GOOD }), GOOD);
    });

    it("refuses a wrong signature, another secret, a changed body, and the old HMAC", async () => {
        const { createHmac } = await import("node:crypto");
        const hmac = createHmac("sha256", SECRET).update(BODY).digest("hex");
        assert.equal(verifyZaloSignature(BODY, hmac, SECRET).ok, false, "HMAC-SHA256(body) is not Zalo's MAC");
        assert.equal(verifyZaloSignature(BODY, GOOD, "another-secret").ok, false);
        assert.equal(verifyZaloSignature(BODY.replace("xin chào", "xin chao"), GOOD, SECRET).ok, false);
        assert.equal(verifyZaloSignature(BODY, "0".repeat(64), SECRET).reason, "signature mismatch");
    });

    it("never throws on odd input: wrong length, non-hex, non-ASCII, no app_id, not JSON", () => {
        const odd = [
            ["", "missing signature"],
            ["abc", "malformed signature"],
            ["é".repeat(64), "malformed signature"],
            ["g".repeat(64), "malformed signature"],
        ];
        for (const [mac, reason] of odd)
            assert.deepEqual(verifyZaloSignature(BODY, mac, SECRET), { ok: false, reason });
        assert.equal(verifyZaloSignature('{"timestamp":"1"}', GOOD, SECRET).ok, false);
        assert.equal(verifyZaloSignature("not json", GOOD, SECRET).reason, "body is not JSON");
    });

    it("an event whose body has no app_id is checked with the app's own id", () => {
        // Docs: extension_purchased, change_template_quality and change_oa_daily_quota carry no app_id, yet give
        // the same formula. Red if such an event is refused when the app id is known (Zalo would redeliver it and
        // in the end disable the webhook).
        const body = '{"event_name":"change_oa_daily_quota","oa_id":"1000000000000000004","timestamp":"1700000000001"}';
        const mac = createHash("sha256")
            .update("1000000000000000001" + body + "1700000000001" + SECRET, "utf8")
            .digest("hex");
        assert.deepEqual(verifyZaloSignature(body, mac, SECRET, { appId: "1000000000000000001" }), { ok: true });
        assert.match(verifyZaloSignature(body, mac, SECRET).reason, /--app-id/);
        // The body's own app_id still wins over the one given.
        assert.equal(verifyZaloSignature(BODY, GOOD, SECRET, { appId: "1000000000000000099" }).ok, true);
    });
});

describe("oa init's webhook server", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    async function start(opts) {
        const server = createWebhookServer("default", opts);
        servers.push(server);
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        return `http://127.0.0.1:${server.address().port}/webhook`;
    }

    it("with the OA secret key: 200 for a signed event, 401 for a forged one", async () => {
        const url = await start({ oaSecret: SECRET });
        const ok = await fetch(url, { method: "POST", body: BODY, headers: { "X-ZEvent-Signature": `mac=${GOOD}` } });
        assert.equal(ok.status, 200);
        const forged = await fetch(url, {
            method: "POST",
            body: BODY,
            headers: { "X-ZEvent-Signature": "f".repeat(64) },
        });
        assert.equal(forged.status, 401);
    });

    it("caps the body at 1 MB", async () => {
        const url = await start({});
        const big = await fetch(url, { method: "POST", body: "x".repeat(1024 * 1024 + 10) }).catch((e) => e);
        // The server answers 413 and drops the connection; either is a refusal, never a 200.
        assert.ok(big instanceof Error || big.status === 413, `got ${big.status}`);
    });
});

describe("domain verification serves what Zalo handed out, unchanged", () => {
    /** A fake request/response pair: what the handler wrote. */
    function hit(handler, url, method = "GET") {
        const res = {
            status: 0,
            body: "",
            writeHead(code) {
                this.status = code;
            },
            end(b) {
                this.body = String(b ?? "");
            },
        };
        return { handled: handler({ method, url }, res), ...res };
    }

    it("the downloaded file, byte for byte, at its own name under any path; nothing else", () => {
        const dir = mkdtempSync(join(tmpdir(), "zv-"));
        const file = join(dir, "zalo_verifierFAKE123.html");
        writeFileSync(file, "<html>exactly what Zalo gave</html>");
        const h = domainVerification({ file });
        assert.equal(hit(h, "/zalo_verifierFAKE123.html").body, "<html>exactly what Zalo gave</html>");
        assert.equal(hit(h, "/party/zalo_verifierFAKE123.html").handled, true, "URL-prefix verification");
        // Red if any zalo_verifier* name answers (the old made-up page did).
        assert.equal(hit(h, "/zalo_verifierOTHER.html").handled, false);
        assert.equal(hit(h, "/zalo_verifierFAKE123.html", "POST").handled, false);
    });

    it("the meta tag Zalo shows, in the head of / and of a URL prefix's home page", () => {
        const tag = '<meta name="fake-verification" content="FAKE123" />';
        const h = domainVerification({ meta: tag });
        assert.ok(hit(h, "/").body.includes(`<head>${tag}</head>`));
        assert.equal(hit(h, "/party/").handled, true);
        assert.equal(hit(h, "/webhook").handled, false);
    });

    it("nothing set is null; a bad tag or a missing file is refused, never served", () => {
        assert.equal(domainVerification({}), null);
        assert.throws(() => domainVerification({ meta: "FAKE123" }), /<meta/);
        assert.throws(() => domainVerification({ meta: '<meta a="1"><script>' }), /<meta/);
        assert.throws(() => domainVerification({ file: join(tmpdir(), "no-such-zv-file.html") }), /Cannot read/);
    });
});

describe("oa whoami — getoa's documented fields", () => {
    it("prints verification, type, category and the package with its documented date field", () => {
        const lines = describeOAProfile({
            oa_id: "1000000000000000001",
            name: "Test OA",
            oa_alias: "testoa",
            is_verified: true,
            oa_type: 2,
            cate_name: "Food",
            num_follower: 5,
            package_name: "Premium",
            package_valid_through_date: "13/12/2027",
            package_auto_renew_date: "14/12/2027",
            linked_zca: "ZBA-0000000000",
        });
        // Red if whoami goes back to discarding what getoa returned, or reads an undocumented name.
        assert.ok(lines.includes("Verified: yes"));
        assert.ok(lines.includes("Type: 2 (business)"));
        assert.ok(lines.includes("Category: Food"));
        assert.ok(lines.includes("Package: Premium (valid through 13/12/2027)"));
        assert.ok(lines.includes("Auto-renews: 14/12/2027"));
        assert.ok(lines.includes("Linked ZCA: ZBA-0000000000"));
    });

    it("reads the docs' example spellings too (oaid, linked_ZCA) and an unverified OA", () => {
        const lines = describeOAProfile({ oaid: "9", name: "X", is_verified: false, linked_ZCA: "ZBA-1" });
        assert.deepEqual(lines, ["OA: X (ID: 9)", "Verified: no", "Linked ZCA: ZBA-1"]);
    });

    it("leaves out what getoa did not send", () => {
        assert.deepEqual(describeOAProfile({ name: "Bare OA", oa_id: "9" }), ["OA: Bare OA (ID: 9)"]);
    });
});
