/**
 * src/core/control-events.js — three `601` controls about changes made on another device: a product catalog changed
 * (`prod_catalog`), a DM reminder removed (`oneone/remove_reminder11`), the device list changed
 * (`user_devices/update_user_devices`).
 *
 * Only the key names of these controls were ever seen live (never values), so every payload here is synthetic, built
 * from those key names and from the fields each control carries; ids are throwaway constants.
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
    CONTROL_EVENT_KINDS,
    applyControlEvents,
    attachControlEvents,
    describeControlEvent,
    muteEvents,
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
    it("reports the ids each act carries, and the control's data whole", () => {
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
        // Red if the handler printed without asking --events, or stopped reading each event's own kind.
        assert.match(body, /enabledEvents\.has\(kind\)/);
        assert.match(body, /CONTROL_EVENT_KINDS\[ev\.event\]/);
        // Red if an event were printed under another name, or lost its name.
        assert.deepEqual(CONTROL_EVENT_KINDS, {
            catalog_changed: "catalog",
            reminder_created: "reminder",
            reminder_updated: "reminder",
            reminder_removed: "reminder",
            devices_changed: "devices",
            settings_changed: "settings",
            mute_changed: "conversation",
            labels_changed: "conversation",
            archived_changed: "conversation",
            auto_delete_changed: "conversation",
            quick_messages_changed: "quick-message",
        });
    });

    it("names the two new kinds in the --events help", () => {
        const help = /"-e, --events <types>",\s*"([^"]+)"/.exec(SRC)?.[1] ?? "";
        assert.match(help, /conversation \(/);
        assert.match(help, /quick-message \(/);
    });
});

describe("a conversation muted or unmuted on another device", () => {
    const NOW = 1_790_000_000_000;
    const sec = Math.round(NOW / 1000);

    it("reports one event per conversation, the last control winning, DM or group by muteType", () => {
        const events = applyControlEvents({
            now: () => NOW,
            data: frameData(
                ["1", "mute", "set", { toId: PEER, muteType: 1, duration: 3600, startTime: sec, systemTime: sec }],
                ["2", "mute", "set", { toId: "g-1", muteType: 2, duration: -1, startTime: sec, systemTime: sec }],
                ["3", "mute", "unset", { toId: PEER, muteType: 1 }],
            ),
        });
        assert.deepEqual(
            events.map((e) => [e.event, e.threadId, e.threadType, e.muted, e.duration, e.until]),
            [
                // PEER was muted, then unmuted in the same frame: only the unmute is reported.
                ["mute_changed", PEER, "dm", false, null, null],
                ["mute_changed", "g-1", "group", true, -1, null],
            ],
        );
    });

    it("gives a timed mute its end, and drops a set whose time already ran out", () => {
        const [timed] = muteEvents(
            [{ act: "set", data: { toId: PEER, muteType: 1, duration: 3600, startTime: sec, systemTime: sec } }],
            NOW,
        );
        assert.equal(timed.until, (sec + 3600) * 1000);
        const stale = muteEvents(
            [
                {
                    act: "set",
                    data: { toId: PEER, muteType: 1, duration: 60, startTime: sec - 600, systemTime: sec - 600 },
                },
            ],
            NOW,
        );
        assert.deepEqual(stale, []);
    });

    it("skips a mute control with no conversation or an act it does not know", () => {
        assert.deepEqual(
            muteEvents(
                [
                    { act: "set", data: {} },
                    { act: "other", data: { toId: PEER } },
                ],
                NOW,
            ),
            [],
        );
    });
});

describe("labels, the archived list, quick messages and auto-delete changed on another device", () => {
    it("reports each with the fields it carries", () => {
        const events = applyControlEvents({
            data: frameData(
                ["1", "label_convers", "update", {}],
                [
                    "2",
                    "archived_chat",
                    "update",
                    {
                        version: 7,
                        actionType: 0,
                        items: [
                            { id: PEER, type: 0 },
                            { id: "g-1", type: 1 },
                        ],
                    },
                ],
                ["3", "quick_message", "delete", { items: [{ id: 11 }, { id: 12 }], version: 4 }],
                [
                    "4",
                    "conv_settings",
                    "update_ttl",
                    { threadId: "g-1", ttl: 86400000, fromId: PEER, isGroup: 1, ts: 5 },
                ],
            ),
        });
        assert.deepEqual(events[0], { event: "labels_changed", ts: 1_790_000_000_000 });
        assert.equal(events[1].event, "archived_changed");
        assert.equal(events[1].archived, true, "actionType 0 is a move to Other");
        assert.equal(events[1].version, 7);
        assert.deepEqual(events[1].threads, [
            { threadId: PEER, threadType: "dm" },
            { threadId: "g-1", threadType: "group" },
        ]);
        assert.equal(events[2].event, "quick_messages_changed");
        assert.equal(events[2].act, "delete");
        assert.deepEqual(events[2].quickMessageIds, ["11", "12"]);
        assert.equal(events[2].version, 4);
        assert.deepEqual(
            { ...events[3], control: undefined },
            {
                event: "auto_delete_changed",
                threadId: "g-1",
                threadType: "group",
                ttl: 86400000,
                by: PEER,
                ts: 5,
                control: undefined,
            },
        );
    });

    it("reads actionType 1 as back from Other, and an unknown one as neither", () => {
        const [back, other] = applyControlEvents({
            data: frameData(
                ["1", "archived_chat", "update", { version: 8, actionType: 1, items: [] }],
                ["2", "archived_chat", "update", { version: 9, items: [] }],
            ),
        });
        assert.equal(back.archived, false);
        assert.equal(other.archived, null);
    });

    it("skips one it cannot read, and a control seen twice", () => {
        const seen = new Set();
        const first = applyControlEvents({
            seen,
            data: frameData(
                ["1", "quick_message", "create", { items: [{ id: 1 }], version: 1 }],
                ["2", "label_convers", "other", {}],
            ),
        });
        assert.equal(first.length, 1, "label_convers acts other than update are not reported");
        const again = applyControlEvents({
            seen,
            data: frameData(["1", "quick_message", "create", { items: [], version: 1 }]),
        });
        assert.deepEqual(again, []);
    });

    it("prints a line for each, and names the command that reads them", () => {
        const lines = applyControlEvents({
            now: () => 0,
            data: frameData(
                ["1", "label_convers", "update", {}],
                ["2", "archived_chat", "update", { version: 1, actionType: 1, items: [{ id: PEER, type: 0 }] }],
                ["3", "quick_message", "create", { items: [{ id: 5 }], version: 1 }],
                ["4", "conv_settings", "update_ttl", { threadId: PEER, ttl: 0 }],
                ["5", "mute", "unset", { toId: PEER, muteType: 1 }],
            ),
        }).map(describeControlEvent);
        assert.deepEqual(lines, [
            "Conversation labels changed on another device — see `zalo-agent label list`",
            `Moved back from Other: ${PEER}`,
            "Quick message created: 5 — see `zalo-agent quick-msg list`",
            `Auto-delete in ${PEER} set to off`,
            `Unmuted: ${PEER}`,
        ]);
    });
});
