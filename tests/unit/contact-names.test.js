/**
 * The owner's alias first, everywhere a person is named (src/core/contact-names.js): the precedence, the snapshot
 * a daemon keeps, a live alias change, a group message from an aliased friend, and the MCP/webhook payloads.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    aliasFirst,
    aliasFor,
    groupEventNames,
    nameFor,
    personLabel,
    personNameFields,
    pickName,
    resetAliasBook,
    senderNameFields,
    setAliasPersistence,
    startDaemonAliases,
    noteAliasSnapshot,
    onAliasChange,
} from "../../src/core/contact-names.js";
import {
    closeDb,
    getDisplayName,
    getRecentThreads,
    getThreadNames,
    getUserAliases,
    initDb,
    upsertThread,
} from "../../src/core/db.js";
import { recentConversations } from "../../src/core/recent-conversations.js";
import { dispatchCtrl } from "../../src/zalo/listener/dispatch.js";
import { readControls } from "../../src/zalo/queues/control-queue.js";
import { buildMCPWebhookPayload, normalizeMessage } from "../../src/commands/mcp.js";
import { quotedReply } from "../../src/core/cached-message.js";
import { createUnknownActs } from "../../src/core/unknown-acts.js";

const FRIEND = "700000000000000101";
const OTHER = "700000000000000102";
const GROUP = "800000000000000201";

before(() => assertSandboxed(CONFIG_DIR));

let seq = 0;
beforeEach(() => {
    closeDb();
    resetAliasBook();
});

/** A session whose alias list and profiles the test changes. */
function fakeApi(aliases = { [FRIEND]: "Minh Sales" }) {
    const state = { aliases: { ...aliases }, reads: 0, profile: "Zalo Profile" };
    return {
        state,
        getAliasList: async () => {
            state.reads++;
            return {
                items: Object.entries(state.aliases).map(([userId, alias]) => ({ userId, alias })),
                hasMore: false,
            };
        },
        getUserInfo: async (ids) => ({
            changed_profiles: Object.fromEntries([ids].flat().map((id) => [id, { zaloName: state.profile }])),
        }),
    };
}

const until = async (check, ms = 2000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 10));
    }
};

describe("pickName", () => {
    it("is alias, then Zalo name, then display name, then uid", () => {
        assert.deepEqual(pickName("1", { alias: "A", zaloName: "Z", displayName: "D" }), {
            name: "A",
            alias: "A",
            zaloName: "Z",
            displayName: "D",
            source: "alias",
        });
        assert.equal(pickName("1", { alias: null, zaloName: "Z", displayName: "D" }).name, "Z");
        assert.equal(pickName("1", { alias: null, displayName: "D" }).source, "display");
        assert.equal(pickName("1", { alias: null, dName: "Group Member" }).name, "Group Member");
        assert.deepEqual(pickName("1", { alias: null }).source, "uid");
        assert.equal(pickName(null, {}).name, null);
    });

    it("looks the alias up in the held snapshot when none is given", () => {
        noteAliasSnapshot(new Map([[FRIEND, "Minh Sales"]]));
        assert.equal(pickName(FRIEND, { zaloName: "Raw" }).name, "Minh Sales");
        assert.deepEqual(personNameFields(FRIEND, { zaloName: "Raw" }), {
            displayName: "Minh Sales",
            alias: "Minh Sales",
            zaloName: "Raw",
        });
        assert.deepEqual(personNameFields(OTHER, { zaloName: "Raw" }), {
            displayName: "Raw",
            alias: null,
            zaloName: "Raw",
        });
        assert.equal(nameFor(OTHER, "Carried"), "Carried");
        assert.equal(personLabel(FRIEND, "Raw"), `Minh Sales (${FRIEND})`);
        assert.equal(personLabel(OTHER), OTHER);
        assert.deepEqual(aliasFirst({ userId: FRIEND, displayName: "Raw", zaloName: "Raw" }), {
            userId: FRIEND,
            displayName: "Minh Sales",
            zaloName: "Raw",
            alias: "Minh Sales",
        });
    });
});

describe("the account's alias snapshot", () => {
    it("is kept in the db by a daemon and read back by a one-shot command, account by account", () => {
        const dbA = join(SANDBOX_CONFIG_DIR, `contact-names-${process.pid}-${seq++}.sqlite`);
        initDb(dbA);
        setAliasPersistence(true);
        noteAliasSnapshot(new Map([[FRIEND, "Minh Sales"]]));
        assert.deepEqual([...getUserAliases()], [[FRIEND, "Minh Sales"]]);
        upsertThread({ threadId: FRIEND, type: "dm", name: "Old Title", lastUpdate: 2 });
        upsertThread({ threadId: GROUP, type: "group", name: "Team", lastUpdate: 1 });

        // A new process: nothing in memory, the stored snapshot names the person.
        closeDb();
        resetAliasBook();
        initDb(dbA);
        assert.equal(aliasFor(FRIEND), "Minh Sales");
        assert.equal(getThreadNames().get(FRIEND).name, "Minh Sales", "a 1-1 is titled by the alias at display time");
        assert.equal(getThreadNames().get(GROUP).name, "Team", "a group is never retitled by an alias");
        assert.equal(recentConversations(10, "dm")[0].name, "Minh Sales");
        assert.equal(getRecentThreads(10, "dm")[0].name, "Old Title", "the stored title is not rewritten by a read");
        assert.equal(getDisplayName(FRIEND), "Minh Sales", "a mention uses the alias");

        // Another account's database holds none of it.
        closeDb();
        initDb(join(SANDBOX_CONFIG_DIR, `contact-names-${process.pid}-${seq++}.sqlite`));
        assert.equal(aliasFor(FRIEND), null);
    });
});

describe("a live alias change", () => {
    it("is a control the listener reports, answered by rereading the alias list", () => {
        const data = { controls: [{ actionId: "1", content: { act_type: "alias", act: "update", data: "{}" } }] };
        const steps = dispatchCtrl("1", 601, data);
        assert.deepEqual(steps, [{ emit: "alias_change", args: [{ act: "update" }] }]);
        assert.equal(readControls(data)[0].handled, true, "no longer noted as an unknown control");
    });

    it("rereads the aliases, renames the sender everywhere and retitles the stored 1-1", async () => {
        initDb(join(SANDBOX_CONFIG_DIR, `contact-names-${process.pid}-${seq++}.sqlite`));
        upsertThread({ threadId: FRIEND, type: "dm", name: "Zalo Profile", lastUpdate: 5 });
        const api = fakeApi();
        const titles = [];
        const listener = {
            handlers: {},
            on(n, fn) {
                this.handlers[n] = fn;
            },
        };
        const daemon = startDaemonAliases({
            getApi: () => api,
            debounceMs: 0,
            intervalMs: 0,
            onRetitled: (t) => titles.push(...t),
        });
        try {
            daemon.attach(listener);
            assert.equal(await daemon.refreshNow("start"), true);
            assert.equal(senderNameFields(FRIEND, "Zalo Profile").senderName, "Minh Sales");
            await until(() => getRecentThreads(10, "dm")[0].name === "Minh Sales");

            // Renamed on the phone: the server sends `alias`, the daemon rereads.
            api.state.aliases[FRIEND] = "Minh Support";
            listener.handlers.alias_change({ act: "update" });
            await until(() => aliasFor(FRIEND) === "Minh Support");
            await until(() => getRecentThreads(10, "dm")[0].name === "Minh Support");
            assert.deepEqual(senderNameFields(FRIEND, "Zalo Profile"), {
                senderName: "Minh Support",
                senderAlias: "Minh Support",
                senderZaloName: "Zalo Profile",
            });
            assert.deepEqual([...getUserAliases()], [[FRIEND, "Minh Support"]], "persisted for one-shot commands");

            // Removed: the stored title goes back to the profile name, read for just that user.
            delete api.state.aliases[FRIEND];
            listener.handlers.alias_change({ act: "update" });
            await until(() => getRecentThreads(10, "dm")[0].name === "Zalo Profile");
            assert.equal(aliasFor(FRIEND), null);
            assert.ok(titles.some(([id, name]) => id === FRIEND && name === "Zalo Profile"));
        } finally {
            daemon.stop();
        }
    });

    it("keeps the snapshot it holds when a reread fails", async () => {
        const api = fakeApi();
        const daemon = startDaemonAliases({ getApi: () => api, debounceMs: 0, intervalMs: 0 });
        try {
            await daemon.refreshNow();
            api.getAliasList = async () => {
                throw new Error("offline");
            };
            assert.equal(await daemon.refreshNow(), false);
            assert.equal(aliasFor(FRIEND), "Minh Sales", "a failed read is not 'every alias removed'");
        } finally {
            daemon.stop();
        }
    });
});

describe("group messages and payloads", () => {
    const groupMessage = () => ({
        type: 1,
        threadId: GROUP,
        isSelf: false,
        data: { msgId: "9001", uidFrom: FRIEND, dName: "Zalo Profile", content: "hello", msgType: "webchat", ts: "1" },
    });

    it("name an aliased friend's group message by the alias, keeping the name Zalo sent", () => {
        noteAliasSnapshot(new Map([[FRIEND, "Minh Sales"]]));
        const m = normalizeMessage(groupMessage());
        assert.equal(m.threadType, "group");
        assert.equal(m.senderName, "Minh Sales");
        assert.equal(m.senderAlias, "Minh Sales");
        assert.equal(m.senderZaloName, "Zalo Profile");
        const payload = buildMCPWebhookPayload(m, { accountId: "1" });
        assert.equal(payload.senderName, "Minh Sales");
        assert.equal(payload.senderZaloName, "Zalo Profile");
    });

    it("leave a sender without an alias as Zalo named them", () => {
        const m = normalizeMessage(groupMessage());
        assert.equal(m.senderName, "Zalo Profile");
        assert.equal(m.senderAlias, null);
    });

    it("name a group event's members and actor alias first, on a copy", () => {
        noteAliasSnapshot(new Map([[FRIEND, "Minh Sales"]]));
        const data = {
            sourceId: FRIEND,
            updateMembers: [
                { id: FRIEND, dName: "Zalo Profile" },
                { id: OTHER, dName: "Someone" },
            ],
        };
        const named = groupEventNames(data);
        assert.equal(named.sourceName, "Minh Sales");
        assert.deepEqual(named.updateMembers[0], {
            id: FRIEND,
            dName: "Minh Sales",
            alias: "Minh Sales",
            zaloName: "Zalo Profile",
        });
        assert.equal(named.updateMembers[1].dName, "Someone");
        assert.equal(data.updateMembers[0].dName, "Zalo Profile", "the event itself is unchanged");
    });
});

describe("what is also named alias first", () => {
    it("a quoted message's author, keeping the name the quote carried", () => {
        noteAliasSnapshot(new Map([[FRIEND, "Minh Sales"]]));
        const reply = quotedReply({ globalMsgId: "5", ownerId: FRIEND, fromD: "Zalo Profile", msg: "x" });
        assert.equal(reply.senderName, "Minh Sales");
        assert.equal(reply.senderZaloName, "Zalo Profile");
        assert.equal(quotedReply({ globalMsgId: "5", ownerId: OTHER, fromD: "Other" }).senderName, "Other");
    });

    it("puts a phonebook name after the alias and before the Zalo name", () => {
        assert.equal(pickName("1", { alias: "A", pbName: "P", zaloName: "Z" }).name, "A");
        assert.deepEqual(
            [pickName("1", { alias: null, pbName: "P", zaloName: "Z" })].map((p) => [p.name, p.source]),
            [["P", "phonebook"]],
        );
    });

    it("rereads the account's own name on a profile control from another device", async () => {
        const data = { controls: [{ content: { act_type: "profile", act: "update", data: "{}" } }] };
        assert.deepEqual(dispatchCtrl("1", 601, data), [{ emit: "profile_change", args: [{ act: "update" }] }]);
        assert.equal(readControls(data)[0].handled, true);
        const names = [];
        const listener = {
            handlers: {},
            on(n, fn) {
                this.handlers[n] = fn;
            },
        };
        const api = { fetchAccountInfo: async () => ({ profile: { zaloName: "Owner Renamed" } }) };
        const daemon = startDaemonAliases({ getApi: () => api, intervalMs: 0, onOwnName: (n) => names.push(n) });
        try {
            daemon.attach(listener);
            listener.handlers.profile_change({ act: "update_status" });
            listener.handlers.profile_change({ act: "update" });
            await until(() => names.length === 1);
            assert.deepEqual(names, ["Owner Renamed"]);
        } finally {
            daemon.stop();
        }
    });

    it("does not note a 602 online_status as an unknown action (last-online reads it)", () => {
        const acts = createUnknownActs({ file: join(SANDBOX_CONFIG_DIR, `unknown-${process.pid}-${seq++}.json`) });
        const frame = (act_type, act) => ({ actions: [{ act_type, act, data: "{}" }] });
        assert.equal(acts.observe(602, frame("profile", "online_status")), 0);
        assert.equal(acts.observe(602, frame("profile", "something_new")), 1, "another profile act still is");
    });
});

describe("the first alias snapshot is a load, not a change", () => {
    it("tells its listeners first: true once, then first: false for a real change", () => {
        const seen = [];
        const off = onAliasChange((ids, _aliases, info) => seen.push([ids.length, info?.first]));
        try {
            noteAliasSnapshot(
                new Map([
                    ["1000000000000000801", "Ana"],
                    ["1000000000000000802", "Ben"],
                ]),
            );
            noteAliasSnapshot(
                new Map([
                    ["1000000000000000801", "Ana"],
                    ["1000000000000000802", "Benny"],
                ]),
            );
        } finally {
            off();
        }
        assert.deepEqual(seen, [
            [2, true],
            [1, false],
        ]);
    });
});
