/**
 * OA fixes 0.2 and 0.4 from the 2.0.0 API triage.
 *
 * 0.2 — the webhook vocabulary. `oa listen` advertised 10 event names, three
 * of which Zalo never sends (`user_send_gif`, `user_click_button`,
 * `user_click_link`), and missed most of what Zalo documents, among them
 * the real "chat now" click, `user_click_chatnow`. It also ignored the
 * `num_retry` header, so a redelivery looked like a new event.
 *
 * 0.4 — `oa whoami` fetched the package tier and threw it away, though the tier
 * is what decides which OA APIs answer.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OA_WEBHOOK_EVENTS, unknownEvents, retryCount } from "../../src/commands/oa-listen.js";
import { describeOAProfile } from "../../src/commands/oa.js";

describe("oa listen — the webhook vocabulary", () => {
    it("names the events Zalo documents, and none it never sends", () => {
        for (const e of ["user_click_chatnow", "user_send_audio", "user_seen_message", "user_send_group_text"]) {
            assert.ok(OA_WEBHOOK_EVENTS.includes(e), `${e} is documented`);
        }
        // Red if a name Zalo never sends comes back into the list.
        for (const e of ["user_send_gif", "user_click_button", "user_click_link"]) {
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
});

describe("oa whoami — the package tier", () => {
    it("prints the OA's type and package, which decide which APIs work", () => {
        const lines = describeOAProfile({
            name: "Test OA",
            oa_id: "123",
            num_follower: 5,
            oa_type: 2,
            package_name: "Premium",
            package_validThroughDate: "2027-01-01",
            linked_zca: false,
        });
        // Red if whoami goes back to discarding what getoa returned.
        assert.ok(lines.includes("Type: 2"));
        assert.ok(lines.includes("Package: Premium (valid through 2027-01-01)"));
        assert.ok(lines.includes("Linked ZCA: false"));
    });

    it("leaves out what getoa did not send", () => {
        const lines = describeOAProfile({ name: "Bare OA", oa_id: "9" });
        assert.deepEqual(lines, ["OA: Bare OA (ID: 9)"]);
    });
});
