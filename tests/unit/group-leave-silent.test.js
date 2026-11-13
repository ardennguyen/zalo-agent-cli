/**
 * `group leave` and `group disperse`, driven end to end offline over the session's HTTP seam.
 *
 * - `-s/--silent` reaches Zalo as `silent: 1` (the previous engine's command never passed it on).
 * - Leave as Zalo PC 26.11.11 does: a member leaves; the owner of a group with other members must name the next
 *   owner (`--new-owner`: change-owner, then leave) or let Zalo pick one (`--random-owner`), else nothing is sent.
 * - Disperse deletes the group for everyone, so only the owner can; anyone else is refused before anything is sent.
 *
 * Each reads what went out on the wire. The group's info is a hand-written getmg-v2 answer.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serviceHost } from "./fake-zalo-session.js";

const GID = "7000000000000000001";
const OTHER = "2000000000000000002";
const THIRD = "2000000000000000003";
const STRANGER = "2000000000000000009";

/** Zalo's getmg-v2 answer for GID: who created it, the deputies, and the members ("uid_version"). */
function groupInfo({ creatorId, adminIds = [], members }) {
    return {
        removedsGroup: [],
        unchangedsGroup: [],
        gridInfoMap: {
            [GID]: {
                groupId: GID,
                name: "Nhóm thử",
                creatorId,
                adminIds,
                totalMember: members.length,
                memVerList: members.map((u) => `${u}_0`),
            },
        },
    };
}

describe("group leave and disperse reach Zalo as Zalo PC does", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1"; // what `--json` sets in src/index.js
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    /** Route the group's info, and a quiet answer for every write. */
    function setGroup(spec) {
        fake.requests.length = 0;
        fake.clearRoutes();
        fake.route("/api/group/getmg-v2", () => groupInfo(spec));
        fake.route("/api/group/leave", () => ({ memberError: [] }));
        fake.route("/api/group/change-owner", () => ({}));
        fake.route("/api/group/disperse", () => ({}));
    }

    const run = (...args) => runCommand(registerGroupCommands, ["--json", "group", ...args]);
    const writes = () =>
        fake.requests
            .filter((r) => ["/api/group/leave", "/api/group/change-owner", "/api/group/disperse"].includes(r.path))
            .map((r) => r.path);

    describe("a member", () => {
        beforeEach(() => setGroup({ creatorId: OTHER, members: [OTHER, FAKE.ownId, THIRD] }));

        it("without --silent leaves out loud (silent: 0)", async () => {
            const r = await run("leave", GID, "--yes");
            assert.equal(r.exitCode, null, `leave failed: ${r.stdout} ${r.stderr}`);
            const [req] = fake.calls("/api/group/leave");
            assert.equal(req.host, serviceHost("group"));
            assert.deepEqual(req.params, { grids: [GID], imei: FAKE.imei, silent: 0, language: req.params.language });
            assert.deepEqual(writes(), ["/api/group/leave"]);
        });

        for (const flag of ["-s", "--silent"]) {
            it(`${flag} leaves silently (silent: 1)`, async () => {
                const r = await run("leave", GID, flag, "--yes");
                assert.equal(r.exitCode, null, `leave failed: ${r.stdout} ${r.stderr}`);
                // Red if the flag is parsed but not passed on: the wire would still say silent: 0.
                assert.equal(fake.calls("/api/group/leave")[0].params.silent, 1);
            });
        }

        it("is asked first: without --yes nothing is sent (exit 2)", async () => {
            const r = await run("leave", GID);
            assert.equal(r.exitCode, 2, r.stdout);
            assert.equal(JSON.parse(r.stdout).confirmationRequired, true);
            assert.deepEqual(writes(), []);
        });

        it("cannot choose the next owner (only the owner does)", async () => {
            const r = await run("leave", GID, "--new-owner", THIRD, "--yes");
            assert.equal(r.exitCode, 1);
            assert.match(r.stdout + r.stderr, /Only the owner/);
            assert.deepEqual(writes(), []);
        });

        it("cannot disband the group for everyone (only the owner can)", async () => {
            const r = await run("disperse", GID, "--yes");
            assert.equal(r.exitCode, 1);
            assert.match(r.stdout + r.stderr, /Only the owner/);
            assert.deepEqual(writes(), []);
        });
    });

    describe("a deputy", () => {
        beforeEach(() => setGroup({ creatorId: OTHER, adminIds: [FAKE.ownId], members: [OTHER, FAKE.ownId] }));

        it("leaves like a member, and cannot disband", async () => {
            assert.equal((await run("leave", GID, "--yes")).exitCode, null);
            assert.deepEqual(writes(), ["/api/group/leave"]);
            setGroup({ creatorId: OTHER, adminIds: [FAKE.ownId], members: [OTHER, FAKE.ownId] });
            const r = await run("disperse", GID, "--yes");
            assert.equal(r.exitCode, 1);
            assert.match(r.stdout + r.stderr, /a deputy/);
            assert.deepEqual(writes(), []);
        });
    });

    describe("the owner", () => {
        beforeEach(() => setGroup({ creatorId: FAKE.ownId, members: [FAKE.ownId, OTHER, THIRD] }));

        it("is refused a plain leave: it must say who owns the group next, and nothing is sent", async () => {
            const r = await run("leave", GID, "--yes");
            assert.equal(r.exitCode, 1);
            const msg = JSON.parse(r.stdout).error;
            assert.match(msg, /owns group "Nhóm thử".*2 other member/);
            assert.match(msg, /--new-owner <userId> or --random-owner/);
            assert.deepEqual(writes(), []);
        });

        it("--new-owner hands the group over first, then leaves", async () => {
            const r = await run("leave", GID, "--new-owner", OTHER, "--yes");
            assert.equal(r.exitCode, null, `${r.stdout} ${r.stderr}`);
            // Red if it leaves first (Zalo would pick a random owner) or never hands over.
            assert.deepEqual(writes(), ["/api/group/change-owner", "/api/group/leave"]);
            const [change] = fake.calls("/api/group/change-owner");
            assert.equal(change.params.grid, GID);
            assert.equal(change.params.newAdminId, OTHER);
            const out = JSON.parse(r.stdout);
            assert.equal(out.handOver, "chosen");
            assert.equal(out.newOwner, OTHER);
        });

        it("--new-owner must be a current member, and not this account", async () => {
            for (const who of [STRANGER, FAKE.ownId]) {
                setGroup({ creatorId: FAKE.ownId, members: [FAKE.ownId, OTHER, THIRD] });
                const r = await run("leave", GID, "--new-owner", who, "--yes");
                assert.equal(r.exitCode, 1, who);
                assert.deepEqual(writes(), [], who);
            }
        });

        it("--random-owner leaves, and Zalo picks the next owner", async () => {
            const r = await run("leave", GID, "--random-owner", "--yes");
            assert.equal(r.exitCode, null, `${r.stdout} ${r.stderr}`);
            assert.deepEqual(writes(), ["/api/group/leave"]);
            assert.equal(JSON.parse(r.stdout).handOver, "random");
        });

        it("cannot give both a new owner and a random one", async () => {
            const r = await run("leave", GID, "--new-owner", OTHER, "--random-owner", "--yes");
            assert.equal(r.exitCode, 1);
            assert.deepEqual(writes(), []);
        });

        it("--dry-run names the hand-over and sends nothing", async () => {
            const r = await run("leave", GID, "--new-owner", OTHER, "--dry-run");
            assert.equal(r.exitCode, 0, r.stdout);
            assert.match(JSON.parse(r.stdout).wouldDo, new RegExp(`handing ownership to ${OTHER} first`));
            assert.deepEqual(writes(), []);
        });

        it("disbands the group for everyone, asked first", async () => {
            const asked = await run("disperse", GID);
            assert.equal(asked.exitCode, 2, asked.stdout);
            assert.match(JSON.parse(asked.stdout).wouldDo, /for every member \(2 other member\(s\) lose it too\)/);
            assert.deepEqual(writes(), []);
            const r = await run("disperse", GID, "--yes");
            assert.equal(r.exitCode, null, `${r.stdout} ${r.stderr}`);
            assert.deepEqual(writes(), ["/api/group/disperse"]);
        });
    });

    it("the owner alone in the group just leaves", async () => {
        setGroup({ creatorId: FAKE.ownId, members: [FAKE.ownId] });
        const r = await run("leave", GID, "--yes");
        assert.equal(r.exitCode, null, `${r.stdout} ${r.stderr}`);
        assert.deepEqual(writes(), ["/api/group/leave"]);
    });

    it("a group this account is not in is refused before anything is sent", async () => {
        fake.requests.length = 0;
        fake.clearRoutes();
        fake.route("/api/group/getmg-v2", () => ({ removedsGroup: [], unchangedsGroup: [], gridInfoMap: {} }));
        for (const cmd of ["leave", "disperse"]) {
            const r = await run(cmd, GID, "--yes");
            assert.equal(r.exitCode, 1, cmd);
            assert.match(r.stdout + r.stderr, /not in group/, cmd);
        }
        assert.deepEqual(writes(), []);
    });
});
