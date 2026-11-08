/**
 * src/core/control-events.js — three `601` controls about changes made on another device: a product catalog changed
 * (`prod_catalog`), a DM reminder removed (`oneone/remove_reminder11`), the device list changed
 * (`user_devices/update_user_devices`).
 *
 * Only the key names of these controls were ever seen live (never values), so every payload here is synthetic, built
 * from those key names and from what Zalo Web's handlers read; ids are throwaway constants.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { walkAst } from "../helpers/api-call-sites.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getReminders, upsertReminder, removeReminder } from "../../src/core/db.js";
import { readControls } from "../../src/zalo/queues/control-queue.js";
import {
    applyControlEvents,
    attachControlEvents,
    reminderThreadOf,
    withoutSecrets,
} from "../../src/core/control-events.js";

const OWN = "1001";
const PEER = "1002";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-control-events-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

/** A 601 frame's data carrying the given controls; `data` is sent as JSON text, as the server sends it. */
const frameData = (...controls) => ({
    controls: controls.map(([actionId, act_type, act, data, ts = 1_790_000_000_000]) => ({
        actionId,
        controlId: actionId,
        content: { act_type, act, data: JSON.stringify(data), ts },
    })),
});

const reminderData = (over = {}) => ({
    toUid: PEER,
    creatorUid: PEER,
    editorUid: PEER,
    reminderId: "r-1",
    emoji: "⏰",
    color: 1,
    editTime: 1,
    repeatRule: [],
    params: JSON.stringify({ title: "standup" }),
    type: 0,
    onlyMe: 0,
    createTime: 1,
    ...over,
});

describe("control events — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("the three controls are known", () => {
    it("names them handled, so the self-heal and unknown-acts.json stop reporting them", () => {
        const out = readControls(
            frameData(
                ["1", "prod_catalog", "edit_catalog", {}],
                ["2", "prod_catalog", "del_catalog", {}],
                ["3", "prod_catalog", "edit_prod", {}],
                ["4", "oneone", "remove_reminder11", {}],
                ["5", "user_devices", "update_user_devices", {}],
                ["6", "oneone", "create_reminder11", {}],
                ["7", "oneone", "update_reminder11", {}],
                ["8", "oneone", "remind_reminder11", {}],
            ),
        );
        assert.deepEqual(
            out.map((c) => [c.act, c.kind, c.handled]),
            [
                ["edit_catalog", "catalog", true],
                ["del_catalog", "catalog", true],
                ["edit_prod", "catalog", true],
                ["remove_reminder11", "reminder", true],
                ["update_user_devices", "devices", true],
                ["create_reminder11", "reminder", true],
                ["update_reminder11", "reminder", true],
                // Another act of the `oneone` family is still named as unhandled.
                ["remind_reminder11", "unknown", false],
            ],
        );
        assert.equal(out[0].ts, 1_790_000_000_000, "the control's own time is kept");
    });
});

describe("a catalog changed on another device", () => {
    it("reports the ids the Web reads for each act, and the control's data whole", () => {
        const events = applyControlEvents({
            data: frameData(
                ["1", "prod_catalog", "edit_catalog", { item: { id: "c-1", name: "Shop" }, version_catalog: 3 }],
                ["2", "prod_catalog", "del_catalog", { catalog_id: "c-2" }],
                ["3", "prod_catalog", "edit_prod", { item: { product_id: "p-1", catalog_id: "c-1" } }],
                ["4", "prod_catalog", "del_list_prod", { catalog_id: "c-1", product_ids: ["p-2", "p-3"] }],
            ),
        });
        assert.deepEqual(
            events.map((e) => [e.event, e.act, e.catalogId, e.productIds]),
            [
                ["catalog_changed", "edit_catalog", "c-1", []],
                ["catalog_changed", "del_catalog", "c-2", []],
                ["catalog_changed", "edit_prod", "c-1", ["p-1"]],
                ["catalog_changed", "del_list_prod", "c-1", ["p-2", "p-3"]],
            ],
        );
        assert.deepEqual(events[0].control, { item: { id: "c-1", name: "Shop" }, version_catalog: 3 });
    });
});

describe("a DM reminder removed on another device", () => {
    it("drops the reminder sync-boards stored, and reports it with the conversation and title", () => {
        upsertReminder({ reminderId: "r-1", threadId: PEER, threadType: "user", title: "standup" });
        upsertReminder({ reminderId: "r-2", threadId: PEER, threadType: "user", title: "keep me" });
        const [ev] = applyControlEvents({
            data: frameData(["9", "oneone", "remove_reminder11", reminderData()]),
            ownId: OWN,
        });
        assert.deepEqual(
            getReminders(PEER).map((r) => r.reminderId),
            ["r-2"],
            "only the named reminder goes",
        );
        assert.equal(ev.event, "reminder_removed");
        assert.equal(ev.threadId, PEER);
        assert.equal(ev.reminderId, "r-1");
        assert.equal(ev.title, "standup");
        assert.equal(ev.stored, true);
    });

    it("finds the conversation from either end: the one that is not this account", () => {
        assert.equal(reminderThreadOf({ toUid: OWN, creatorUid: PEER }, OWN), PEER);
        assert.equal(reminderThreadOf({ toUid: PEER, creatorUid: OWN }, OWN), PEER);
        upsertReminder({ reminderId: "r-1", threadId: PEER, threadType: "user" });
        const [ev] = applyControlEvents({
            data: frameData(["9", "oneone", "remove_reminder11", reminderData({ toUid: OWN, creatorUid: PEER })]),
            ownId: OWN,
        });
        assert.equal(ev.stored, true);
        assert.equal(getReminders().length, 0);
    });

    it("reports a reminder it never stored, without touching another conversation's", () => {
        upsertReminder({ reminderId: "r-1", threadId: "1009", threadType: "user" });
        const [ev] = applyControlEvents({
            data: frameData(["9", "oneone", "remove_reminder11", reminderData()]),
            ownId: OWN,
        });
        assert.equal(ev.stored, false);
        assert.equal(getReminders().length, 1, "the same id under another conversation stays");
    });

    it("removeReminder removes by id only within the conversations named", () => {
        upsertReminder({ reminderId: "r-1", threadId: PEER });
        assert.deepEqual(removeReminder("r-1", []), { removed: 0, threadIds: [] });
        assert.deepEqual(removeReminder("r-1", [PEER, null]), { removed: 1, threadIds: [PEER] });
    });
});

describe("a DM reminder created or edited on another device", () => {
    it("stores a created reminder under the other end of the DM, as sync-boards would, and reports it", () => {
        const [ev] = applyControlEvents({
            data: frameData([
                "11",
                "oneone",
                "create_reminder11",
                reminderData({ toUid: OWN, creatorUid: PEER, startTime: 1_790_000_100_000, repeat: 1 }),
            ]),
            ownId: OWN,
        });
        // Red if a reminder created on the phone stays missing from the cache until the next sync-boards.
        const [row] = getReminders(PEER);
        assert.equal(row.reminderId, "r-1");
        assert.equal(row.title, "standup");
        assert.equal(row.threadType, "dm");
        assert.equal(row.creatorId, PEER);
        assert.equal(row.startTime, 1_790_000_100_000);
        assert.equal(row.repeatMode, 1);
        assert.equal(ev.event, "reminder_created");
        assert.equal(ev.threadId, PEER);
        assert.equal(ev.by, PEER);
        assert.equal(ev.title, "standup");
        assert.equal(ev.stored, true);
    });

    it("updates the stored row in place on an edit, and names the editor", () => {
        upsertReminder({ reminderId: "r-1", threadId: PEER, threadType: "dm", title: "old", startTime: 5 });
        const [ev] = applyControlEvents({
            data: frameData([
                "12",
                "oneone",
                "update_reminder11",
                reminderData({
                    toUid: PEER,
                    creatorUid: PEER,
                    editorUid: OWN,
                    params: JSON.stringify({ title: "moved" }),
                    startTime: 9,
                    editTime: 2,
                }),
            ]),
            ownId: OWN,
        });
        const rows = getReminders(PEER);
        assert.equal(rows.length, 1, "an edit is not a second reminder");
        assert.equal(rows[0].title, "moved");
        assert.equal(rows[0].startTime, 9);
        assert.equal(ev.event, "reminder_updated");
        assert.equal(ev.by, OWN);
    });

    it("reports, stores nothing, and says why when the control has no id", () => {
        const lines = [];
        const writes = [];
        const [ev] = applyControlEvents({
            data: frameData(["13", "oneone", "create_reminder11", reminderData({ reminderId: undefined })]),
            ownId: OWN,
            upsert: (row) => writes.push(row),
            say: (l) => lines.push(l),
        });
        assert.equal(writes.length, 0);
        assert.equal(ev.stored, false);
        assert.equal(ev.reminderId, null);
    });

    it("a failed write is said, not thrown, and the event still goes out", () => {
        const lines = [];
        const [ev] = applyControlEvents({
            data: frameData(["14", "oneone", "update_reminder11", reminderData()]),
            ownId: OWN,
            upsert: () => {
                throw new Error("disk full");
            },
            say: (l) => lines.push(l),
        });
        assert.equal(ev.stored, false);
        assert.match(lines.join("\n"), /could not store reminder r-1: disk full/);
    });
});

describe("the device list changed", () => {
    it("logs it every time, reports it, and never passes on the signed identity material", () => {
        const lines = [];
        const data = {
            devices: {
                masterId: 1,
                companions: [
                    { id: 7, platform: 2, status: 1, encIdentity: "SECRET", encAccSign: "SECRET" },
                    { id: 8, platform: 3, status: 1, encIdentity: "SECRET" },
                ],
            },
        };
        const [ev] = applyControlEvents({
            data: frameData(["5", "user_devices", "update_user_devices", data]),
            say: (l) => lines.push(l),
        });
        assert.equal(ev.event, "devices_changed");
        assert.equal(ev.companions, 2);
        assert.ok(!JSON.stringify(ev).includes("SECRET"), JSON.stringify(ev));
        assert.equal(ev.control.devices.companions[0].id, 7, "the rest of the list is passed on whole");
        assert.ok(lines.some((l) => /device list changed/.test(l)));
    });

    it("a replay of several device-list controls in one frame is one log line with a count", () => {
        const lines = [];
        const data = { devices: { masterId: 1, companions: [{ id: 7 }] } };
        const events = applyControlEvents({
            data: frameData(
                ["5", "user_devices", "update_user_devices", data],
                ["6", "user_devices", "update_user_devices", data],
                ["7", "user_devices", "update_user_devices", data],
            ),
            say: (l) => lines.push(l),
        });
        assert.equal(events.length, 3, "every control is still reported");
        const said = lines.filter((l) => /device list changed/.test(l));
        assert.equal(said.length, 1);
        assert.match(said[0], /\(3 controls\)/);
    });

    it("withoutSecrets copies, leaving the original alone", () => {
        const o = { a: [{ encAccSign: 1, b: 2 }] };
        assert.deepEqual(withoutSecrets(o), { a: [{ b: 2 }] });
        assert.equal(o.a[0].encAccSign, 1);
    });
});

describe("from the socket tap", () => {
    function fakeTap() {
        const subs = new Map();
        return { subs, on: (cmd, fn) => (subs.set(cmd, fn), () => subs.delete(cmd)) };
    }

    it("reports each control once, though a replayed page brings it again", () => {
        const tap = fakeTap();
        const events = [];
        const h = attachControlEvents({ tap, onEvent: (e) => events.push(e), log: () => {} });
        const data = frameData(["11", "prod_catalog", "del_catalog", { catalog_id: "c-2" }]);
        tap.subs.get(601)({ cmd: 601, data });
        tap.subs.get(601)({ cmd: 601, data });
        assert.equal(events.length, 1);
        h.stop();
        assert.equal(tap.subs.has(601), false);
    });

    it("ignores the controls other handlers own, and survives a throwing event handler", () => {
        const tap = fakeTap();
        const lines = [];
        attachControlEvents({
            tap,
            log: (l) => lines.push(l),
            onEvent: () => {
                throw new Error("boom");
            },
        });
        tap.subs.get(601)({ cmd: 601, data: frameData(["1", "mark_unread", "mark_unread", {}]) });
        assert.equal(lines.length, 0);
        tap.subs.get(601)({ cmd: 601, data: frameData(["2", "prod_catalog", "edit_prod", {}]) });
        assert.ok(lines.some((l) => /event handler failed: boom/.test(l)));
    });
});

describe("`listen` and `mcp start` both handle them from their socket tap", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const taps = [];
            const calls = [];
            walkAst(ast, (node) => {
                if (node.type === "VariableDeclarator" && node.init?.callee?.name === "createSocketTap") {
                    taps.push(node.id.name);
                }
                if (node.type === "CallExpression" && node.callee?.name === "attachControlEvents") calls.push(node);
            });
            // Red if one entry point stops removing a reminder deleted elsewhere: AGENTS.md §13 calls that a defect.
            assert.equal(calls.length, 1, `${file} must attach the control events once`);
            const prop = (name) => calls[0].arguments[0]?.properties?.find((p) => p.key?.name === name);
            assert.equal(prop("tap")?.value?.name, taps[0], "it must ride the daemon's socket tap");
            assert.ok(prop("ownId"), "it must know the account, to tell the ends of a DM apart");
        });
    }
});

describe("`listen` prints them only when asked", () => {
    const FILE = join(import.meta.dirname, "..", "..", "src", "commands", "listen.js");
    const SRC = readFileSync(FILE, "utf8");

    it("keeps catalog, reminder and devices out of the default --events", () => {
        const def = /"-e, --events <types>",[\s\S]*?,\s*"([a-z,]+)",\s*\)/.exec(SRC)?.[1];
        assert.equal(def, "message,friend,group,reaction,read");
    });

    it("gates every event it prints on its own --events name", () => {
        const ast = acorn.parse(SRC, { ecmaVersion: "latest", sourceType: "module" });
        let onEvent = null;
        walkAst(ast, (node) => {
            if (node.type === "CallExpression" && node.callee?.name === "attachControlEvents") {
                onEvent = node.arguments[0].properties.find((p) => p.key?.name === "onEvent")?.value;
            }
        });
        const body = SRC.slice(onEvent.start, onEvent.end);
        // Red if the handler printed without asking --events, or lost one of the three names.
        assert.match(body, /enabledEvents\.has\(/);
        for (const name of ['"catalog"', '"reminder"', '"devices"']) assert.ok(body.includes(name), name);
        // Red if a created or edited reminder were printed without a name of its own, or under another one.
        for (const ev of ["reminder_created", "reminder_updated", "reminder_removed"]) {
            assert.ok(new RegExp(`${ev}: "reminder"`).test(body), ev);
        }
    });
});
