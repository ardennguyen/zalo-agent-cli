/**
 * `conv recent` (its cache path) and `group members`, pinned as they print.
 *
 * Both commands' logic is shared with an MCP tool: `conv recent` with
 * `zalo_list_conversations` (src/core/recent-conversations.js) and `group
 * members` with `zalo_get_group_members` (src/core/group-members.js). Neither
 * command had a test that looked at what it printed, so moving the logic out
 * of the command could have changed the output with every test still green.
 * These were written against the commands before the move and must pass
 * unchanged after it.
 *
 * Each test drives the real CLI against the offline session
 * (./support/offline-session.js): zalo.db is seeded in the sandbox, and Zalo's
 * answer to getGroupInfo is canned.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { upsertThread } from "../../src/core/db.js";
import { seedAccount, runOffline, requestsTo } from "./support/offline-cli.js";

const DM_OLD = "300000000000000081";
const DM_NEW = "300000000000000082";
const GROUP_OLD = "200000000000000081";
const GROUP_MID = "200000000000000082";
const GROUP_NEW = "200000000000000083";

/** lastUpdate per thread; the newest is DM_NEW, the oldest DM_OLD. */
const SEEN = {
    [DM_OLD]: 1700000001000,
    [GROUP_OLD]: 1700000002000,
    [GROUP_MID]: 1700000003000,
    [GROUP_NEW]: 1700000004000,
    [DM_NEW]: 1700000005000,
};

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    upsertThread({ threadId: DM_OLD, type: "dm", name: "Chị Lan", lastUpdate: SEEN[DM_OLD] });
    upsertThread({ threadId: GROUP_MID, type: "group", name: "Nhóm B", lastUpdate: SEEN[GROUP_MID] });
    upsertThread({ threadId: DM_NEW, type: "dm", name: "Anh Minh", lastUpdate: SEEN[DM_NEW] });
    upsertThread({ threadId: GROUP_NEW, type: "group", name: "Nhóm C", lastUpdate: SEEN[GROUP_NEW] });
    upsertThread({ threadId: GROUP_OLD, type: "group", name: "Nhóm A", lastUpdate: SEEN[GROUP_OLD] });
});

/** One `conv recent --json` row, exactly as the command builds it. */
function row(threadId, name, kind) {
    return {
        threadId,
        name,
        type: kind === "group" ? "Group" : "User",
        typeFlag: kind === "group" ? 1 : 0,
        lastActive: new Date(SEEN[threadId]).toLocaleString(),
    };
}

/** Parse a `--json` run's stdout, failing with the whole output when it is not JSON. */
function jsonOf(r) {
    try {
        return JSON.parse(r.stdout.trim());
    } catch {
        assert.fail(`not JSON (exit ${r.code}):\n${r.all}`);
    }
}

describe("conv recent answers from the cache", () => {
    it("-n is per kind: up to n DMs and n groups, merged newest first", async () => {
        const r = await runOffline(["--json", "conv", "recent", "-n", "2"]);
        // Red if -n becomes a global cap (2 rows), if the merge stops sorting
        // by lastUpdate, or if the third-newest group slips in.
        assert.deepEqual(jsonOf(r), [
            row(DM_NEW, "Anh Minh", "dm"),
            row(GROUP_NEW, "Nhóm C", "group"),
            row(GROUP_MID, "Nhóm B", "group"),
            row(DM_OLD, "Chị Lan", "dm"),
        ]);
        assert.deepEqual(r.requests, [], "a cache answer asks Zalo for nothing");
    });

    it("--groups-only returns the n newest groups, not the groups among the n newest threads", async () => {
        const r = await runOffline(["--json", "conv", "recent", "--groups-only", "-n", "2"]);
        assert.deepEqual(jsonOf(r), [row(GROUP_NEW, "Nhóm C", "group"), row(GROUP_MID, "Nhóm B", "group")]);
    });

    it("--friends-only returns DMs only", async () => {
        const r = await runOffline(["--json", "conv", "recent", "--friends-only"]);
        assert.deepEqual(jsonOf(r), [row(DM_NEW, "Anh Minh", "dm"), row(DM_OLD, "Chị Lan", "dm")]);
    });
});

describe("group members lists the uids in memVerList", () => {
    const GROUP = "200000000000000084";
    /** Zalo's getmg-v2 answer: member uids ride in memVerList as "uid_version". */
    const answer = (entry) => ({
        responses: {
            "/api/group/getmg-v2": {
                removedsGroup: [],
                unchangedsGroup: [],
                gridInfoMap: entry ? { [GROUP]: entry } : {},
            },
        },
    });
    const MEMBERS = ["500000000000000081", "500000000000000082", "500000000000000083"];
    const LISTED = { groupId: GROUP, name: "Nhóm D", memberIds: [], memVerList: MEMBERS.map((u, i) => `${u}_${i}`) };

    it("--json prints the uids, version suffixes stripped", async () => {
        const r = await runOffline(["--json", "group", "members", GROUP], answer({ ...LISTED, totalMember: 3 }));
        assert.deepEqual(jsonOf(r), MEMBERS);
        // getGroupInfo takes an array: the request asks for this one group at version 0.
        const [q] = requestsTo(r.requests, "/api/group/getmg-v2");
        assert.deepEqual(JSON.parse(q.params.gridVerMap), { [GROUP]: 0 });
    });

    it("the count line is Zalo's totalMember, then one uid per line", async () => {
        const r = await runOffline(["group", "members", GROUP], answer({ ...LISTED, totalMember: 5 }));
        assert.match(r.stdout, /5 member\(s\):/, r.all);
        for (const uid of MEMBERS) assert.match(r.stdout, new RegExp(`^ {2}${uid}$`, "m"));
    });

    it("a group missing from Zalo's answer prints 0 members", async () => {
        const r = await runOffline(["--json", "group", "members", GROUP], answer(null));
        assert.deepEqual(jsonOf(r), []);
        const human = await runOffline(["group", "members", GROUP], answer(null));
        assert.match(human.stdout, /0 members/, human.all);
    });
});
