/**
 * `group settings` must change only the settings the user names.
 *
 * It used to build its payload as `opts.X ?? false` for all eight toggles, so
 * `group settings G --join-appr` switched join approval on and every other
 * setting OFF. Below the CLI it was worse: zca-js's `updateGroupSettings`
 * sends `setTopicOnly` (which the CLI never exposed) as 0, leaves out
 * `addMemberOnly`, and hard-codes `bannFeature: 0, dirtyMedia: 0,
 * banDuration: 0, blocked_members: []` on every call.
 *
 * Zalo Web does a read-modify-write (bundle 1.e0ef5e98f8f9d8970e2c.js of the
 * 2026-09-29 capture). Its settings panel keeps the group's whole `setting`
 * object in state and sends `Object.assign({}, state)` with one key flipped;
 * its member-list toggle sends `{...getSettingsGroup(gid), lockViewMember}`,
 * and sends nothing at all when it has no settings to spread.
 *
 * These tests hold the CLI to the same thing. argv goes through the REAL
 * `group settings` flag definitions, then the helper the action calls, the
 * real zca-js `getGroupInfo`, and whatever builds the update, all over
 * `ctx.options.polyfill` (zca-js's own HTTP seam). What reaches the wire is
 * decrypted and checked. So the tests care WHAT is sent, not HOW: the harness
 * also wires zca-js's own `updateGroupSettings`, and code that went back to
 * calling it would put its hard-coded zeros on the wire and fail here.
 */

import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { settingChangesFromOptions, applyGroupSettingChanges } from "../../src/core/group-settings.js";
import { getGroupInfoFactory } from "../../node_modules/zca-js/dist/apis/getGroupInfo.js";
import { updateGroupSettingsFactory } from "../../node_modules/zca-js/dist/apis/updateGroupSettings.js";
import { encodeAES, decodeAES } from "../../node_modules/zca-js/dist/utils.js";

assertSandboxed(CONFIG_DIR);

/** Obviously-fake 16-byte AES key. Never a real session secret — see AGENTS.md §12. */
const SECRET_KEY = Buffer.from("0123456789abcdef").toString("base64");
const IMEI = "test-imei-0000";
const GROUP = "9000000000000000077";
const GROUP_HOST = "https://tt-group-test.invalid";

/**
 * The group's settings as Zalo reports them (zca-js `GroupSetting`, all 13
 * keys). Most toggles are ON, so a writer that zeroes what it was not told
 * about goes red; `lockCreatePoll` is OFF, so one that sets everything ON
 * goes red too. The ban fields are non-zero for the same reason: they are
 * Zalo's media-ban state (`dirtyMedia` 1 or 2 = banned, `banDuration` in
 * seconds, read by the web's banned-group manager), which a client must never
 * reset.
 */
const CURRENT = Object.freeze({
    blockName: 1,
    signAdminMsg: 1,
    addMemberOnly: 1,
    setTopicOnly: 1,
    enableMsgHistory: 1,
    joinAppr: 0,
    lockCreatePost: 1,
    lockCreatePoll: 0,
    lockSendMsg: 1,
    lockViewMember: 1,
    bannFeature: 1,
    dirtyMedia: 2,
    banDuration: 604800,
});

/**
 * Flag -> the GroupSetting key it must change. Written out here rather than
 * imported, so the command's mapping is checked against something other than
 * itself. Sources: each flag's help text, zca-js's UpdateGroupSettingsOptions
 * docs, and Zalo Web's ParamsSettingGroup map (ONLY_ADMIN_SET_TOPIC is
 * `setTopicOnly`).
 */
const EXPECTED_FLAGS = {
    "block-name": "blockName",
    "sign-admin": "signAdminMsg",
    "msg-history": "enableMsgHistory",
    "join-appr": "joinAppr",
    "lock-post": "lockCreatePost",
    "lock-poll": "lockCreatePoll",
    "lock-msg": "lockSendMsg",
    "lock-view-member": "lockViewMember",
    "topic-only": "setTopicOnly",
};

/**
 * A response shaped like Zalo's: outer JSON envelope, AES-encrypted payload.
 *
 * @param {*} data - what zca-js's resolve step should hand back
 * @returns {object} a minimal Response stand-in
 */
function zaloOk(data) {
    const payload = encodeAES(SECRET_KEY, JSON.stringify({ error_code: 0, error_message: "Successful.", data }));
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ error_code: 0, error_message: "Successful.", data: payload }),
    };
}

/**
 * A Zalo refusal: non-zero error_code in the outer envelope.
 *
 * @param {number} code
 * @param {string} message
 * @returns {object} a minimal Response stand-in
 */
function zaloFail(code, message) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ error_code: code, error_message: message }),
    };
}

/**
 * An api whose group reads and setting writes go through a recording fake Zalo.
 *
 * @param {object} [opts]
 * @param {object} [opts.setting] - the `setting` object the fake Zalo reports for GROUP
 * @param {object} [opts.groupInfo] - replaces the whole getmg-v2 answer
 * @param {{code: number, message: string}} [opts.readError] - make the read fail
 * @returns {{api: object, reads: object[], writes: object[]}}
 */
function harness({ setting = CURRENT, groupInfo, readError } = {}) {
    const reads = [];
    const writes = [];
    const ctx = {
        secretKey: SECRET_KEY,
        imei: IMEI,
        userAgent: "zalo-agent-cli-offline-test",
        API_VERSION: 691,
        API_TYPE: 30,
        options: {
            logging: false,
            async polyfill(url, options) {
                const u = new URL(url);
                if (u.pathname === "/api/group/getmg-v2") {
                    reads.push(JSON.parse(decodeAES(SECRET_KEY, options.body.get("params"))));
                    if (readError) return zaloFail(readError.code, readError.message);
                    return zaloOk(
                        groupInfo ?? {
                            removedsGroup: [],
                            unchangedsGroup: [],
                            gridInfoMap: { [GROUP]: { groupId: GROUP, name: "Nhóm thử", setting: { ...setting } } },
                        },
                    );
                }
                if (u.pathname === "/api/group/setting/update") {
                    writes.push({
                        method: options?.method,
                        url: u,
                        body: options?.body ?? null,
                        params: JSON.parse(decodeAES(SECRET_KEY, u.searchParams.get("params"))),
                    });
                    return zaloOk("");
                }
                throw new Error(`unexpected request to ${u.pathname}`);
            },
        },
    };
    const api = { zpwServiceMap: { group: [GROUP_HOST] }, getContext: () => ctx };
    api.getGroupInfo = getGroupInfoFactory(ctx, api);
    api.updateGroupSettings = updateGroupSettingsFactory(ctx, api);
    return { api, reads, writes };
}

/**
 * The real `group settings` command, from a fresh program.
 *
 * @returns {{program: Command, settings: Command}}
 */
function settingsCommand() {
    const program = new Command();
    program.exitOverride();
    program.option("--json");
    registerGroupCommands(program);
    const settings = program.commands.find((c) => c.name() === "group").commands.find((c) => c.name() === "settings");
    assert.ok(settings, "no `group settings` command registered");
    return { program, settings };
}

/**
 * Parse argv with the real flag definitions and return what the action would receive.
 *
 * @param {string[]} argv - everything after `group settings`
 * @returns {Promise<{groupId: string, opts: object}>}
 */
async function parseSettings(argv) {
    const { program, settings } = settingsCommand();
    let seen = null;
    settings.action((groupId, opts) => {
        seen = { groupId, opts: { ...opts } };
    });
    await program.parseAsync(["group", "settings", ...argv], { from: "user" });
    return seen;
}

/**
 * argv -> real flag definitions -> the helper the action calls -> the wire.
 *
 * @param {string[]} argv - flags after the group id
 * @param {object} [harnessOpts] - see harness()
 * @returns {Promise<{reads: object[], writes: object[], outcome: object, failure: Error}>}
 */
async function run(argv, harnessOpts) {
    const h = harness(harnessOpts);
    const { groupId, opts } = await parseSettings([GROUP, ...argv]);
    let outcome;
    let failure;
    try {
        outcome = await applyGroupSettingChanges(h.api, groupId, settingChangesFromOptions(opts));
    } catch (e) {
        failure = e;
    }
    return { ...h, outcome, failure };
}

describe("group settings changes only what was named", () => {
    it("(a) a toggle the user did not pass keeps the group's current value", async () => {
        // Red if any untouched toggle is defaulted instead of read back: the
        // old `?? false` sent six of these as 0, and `?? true` would flip
        // lockCreatePoll. setTopicOnly is here because zca-js zeroed it.
        const { writes, failure } = await run(["--join-appr"]);
        assert.equal(failure, undefined, `unexpected refusal: ${failure?.message}`);
        assert.equal(writes.length, 1, "exactly one update request");
        const sent = writes[0].params;
        for (const [flag, key] of Object.entries(EXPECTED_FLAGS)) {
            if (flag === "join-appr") continue;
            assert.equal(sent[key], CURRENT[key], `--${flag} was not passed, so ${key} must stay ${CURRENT[key]}`);
        }
    });

    it("(b) the ban fields, addMemberOnly and setTopicOnly go back exactly as Zalo reported them", async () => {
        // Red if the request is built by zca-js's updateGroupSettings (it
        // hard-codes the ban fields to 0, drops addMemberOnly, zeroes
        // setTopicOnly) or by anything that lists fields instead of carrying
        // the read.
        const { writes } = await run(["--join-appr"]);
        assert.equal(writes.length, 1, "exactly one update request");
        const sent = writes[0].params;
        for (const key of ["bannFeature", "dirtyMedia", "banDuration", "addMemberOnly", "setTopicOnly"]) {
            assert.equal(sent[key], CURRENT[key], `${key} must be carried as ${CURRENT[key]}, got ${sent[key]}`);
        }
    });

    it("everything but the named flag is exactly what Zalo reported, even a key this CLI does not know", async () => {
        // The web spreads the whole setting object, so a setting Zalo adds
        // later survives a toggle. Red if any field is added (blocked_members),
        // dropped (addMemberOnly, the unknown key) or altered besides joinAppr.
        const { writes } = await run(["--join-appr"], { setting: { ...CURRENT, futureSetting: 7 } });
        assert.equal(writes.length, 1, "exactly one update request");
        const { grid, imei, ...setting } = writes[0].params;
        assert.deepEqual(setting, { ...CURRENT, futureSetting: 7, joinAppr: 1 });
        assert.equal(grid, GROUP);
        assert.equal(imei, IMEI);
    });

    it("sends no blocked_members at all", async () => {
        // Decision pinned here, evidence in src/core/group-settings.js: the
        // web's member-list toggle omits the key, its settings panel sends
        // `[]`, and nothing in the web ever sends a populated list. Omitting
        // it is safe under every server reading that `[]` is safe under, and
        // under one more. Red if the request goes back to zca-js's
        // hard-coded `blocked_members: []`.
        const { writes } = await run(["--join-appr"]);
        assert.equal(writes.length, 1, "exactly one update request");
        assert.ok(!("blocked_members" in writes[0].params), "blocked_members must not be sent");
    });

    it("is the web's request: GET {group}/api/group/setting/update, AES params in the query", async () => {
        // Red if the endpoint, the method, or where the params travel changes
        // from what zca-js and Zalo Web both send (cmd 11816).
        const { writes } = await run(["--join-appr"]);
        assert.equal(writes.length, 1, "exactly one update request");
        const w = writes[0];
        assert.equal(w.method, "GET");
        assert.equal(`${w.url.origin}${w.url.pathname}`, `${GROUP_HOST}/api/group/setting/update`);
        assert.equal(w.body, null, "no request body");
        assert.equal(w.url.searchParams.get("zpw_ver"), "691", "the common params ride along");
        assert.equal(w.url.searchParams.get("zpw_type"), "30");
    });

    it("reads the group it is about to write", async () => {
        // Red if the read is skipped, or asks about some other group.
        const { reads } = await run(["--join-appr"]);
        assert.equal(reads.length, 1, "exactly one read before the write");
        assert.deepEqual(Object.keys(JSON.parse(reads[0].gridVerMap)), [GROUP]);
    });
});

describe("(d) the flags the user passes are applied", () => {
    it("--join-appr and --no-sign-admin, together", async () => {
        // Passes on the old code too: it applied the flags it was given. Red
        // if a fix drops or inverts them, e.g. overlays the read on top of the
        // change instead of the change on top of the read.
        const { writes } = await run(["--join-appr", "--no-sign-admin"]);
        assert.equal(writes.length, 1, "exactly one update request");
        assert.equal(writes[0].params.joinAppr, 1);
        assert.equal(writes[0].params.signAdminMsg, 0);
    });

    for (const [flag, key] of Object.entries(EXPECTED_FLAGS)) {
        it(`--${flag} sets ${key} to 1, --no-${flag} sets it to 0`, async () => {
            // Red if the flag maps to the wrong key, is inverted, or is not
            // registered. Each run starts from the opposite value so the
            // change is real and cannot be skipped as a no-op.
            const on = await run([`--${flag}`], { setting: { ...CURRENT, [key]: 0 } });
            assert.equal(on.failure, undefined, `unexpected refusal: ${on.failure?.message}`);
            assert.equal(on.writes.length, 1, `--${flag} must send one update`);
            assert.equal(on.writes[0].params[key], 1);

            const off = await run([`--no-${flag}`], { setting: { ...CURRENT, [key]: 1 } });
            assert.equal(off.failure, undefined, `unexpected refusal: ${off.failure?.message}`);
            assert.equal(off.writes.length, 1, `--no-${flag} must send one update`);
            assert.equal(off.writes[0].params[key], 0);
        });
    }
});

describe("(c) it refuses rather than guesses, and then sends nothing", () => {
    it("no setting flag at all", async () => {
        // Red if an empty invocation still writes: the old code sent all
        // eight toggles as OFF. It must not even need the read to refuse.
        const { reads, writes, failure } = await run([]);
        assert.ok(failure, "an invocation with no setting flag must be refused");
        assert.match(failure.message, /nothing to change/i);
        assert.equal(writes.length, 0, "no update may be sent");
        assert.equal(reads.length, 0, "refusing needs no read");
    });

    it("Zalo refuses the read", async () => {
        // Red if a failed read falls back to defaults and writes anyway.
        const { writes, failure } = await run(["--join-appr"], {
            readError: { code: 166, message: "Không có quyền" },
        });
        assert.ok(failure, "a failed read must refuse the write");
        assert.match(failure.message, /could not read/i);
        assert.equal(writes.length, 0, "no update may be sent");
    });

    it("the group is missing from Zalo's answer", async () => {
        // Red if an absent group is treated as "all settings off".
        const { writes, failure } = await run(["--join-appr"], {
            groupInfo: { removedsGroup: [GROUP], unchangedsGroup: [], gridInfoMap: {} },
        });
        assert.ok(failure, "no group in the answer must refuse the write");
        assert.equal(writes.length, 0, "no update may be sent");
    });

    it("the group has no setting object", async () => {
        const { writes, failure } = await run(["--join-appr"], {
            groupInfo: { removedsGroup: [], unchangedsGroup: [], gridInfoMap: { [GROUP]: { groupId: GROUP } } },
        });
        assert.ok(failure, "a group without settings must refuse the write");
        assert.equal(writes.length, 0, "no update may be sent");
    });

    it("any one of the 13 GroupSetting fields is missing", async () => {
        // Each is sent back verbatim, so each has to have been read. Red if a
        // missing field is silently dropped or defaulted. If a live read
        // shows Zalo legitimately omits one, relax it here AND in the helper.
        for (const key of Object.keys(CURRENT)) {
            const setting = { ...CURRENT };
            delete setting[key];
            const { writes, failure } = await run(["--join-appr"], { setting });
            assert.ok(failure, `a setting without ${key} must refuse the write`);
            assert.match(failure.message, new RegExp(key), `the refusal must name ${key}`);
            assert.equal(writes.length, 0, `no update may be sent without ${key}`);
        }
    });
});

describe("it reports what it did", () => {
    it("sends nothing when every named setting already has that value", async () => {
        // CURRENT.joinAppr is 0. Red if a no-op is written anyway: the write
        // would be harmless only if every carried value round-trips, which is
        // exactly what the live check has yet to prove.
        const { writes, outcome, failure } = await run(["--no-join-appr"]);
        assert.equal(failure, undefined, `unexpected refusal: ${failure?.message}`);
        assert.equal(writes.length, 0, "a no-op must not be sent");
        assert.equal(outcome.sent, false);
        assert.deepEqual(outcome.changed, {});
        assert.deepEqual(outcome.unchanged, { joinAppr: 0 });
    });

    it("says what changed, from what, and what was already so, without the imei", async () => {
        // joinAppr 0 -> 1 changes; lockSendMsg is already 1. The outcome is
        // printed as-is under --json, so red if it carries the request params
        // (the imei) or misreports the change.
        const { outcome, writes } = await run(["--join-appr", "--lock-msg"]);
        assert.equal(writes.length, 1, "exactly one update request");
        assert.equal(outcome.groupId, GROUP);
        assert.equal(outcome.sent, true);
        assert.deepEqual(outcome.changed, { joinAppr: { from: 0, to: 1 } });
        assert.deepEqual(outcome.unchanged, { lockSendMsg: 1 });
        assert.deepEqual(outcome.settings, { ...CURRENT, joinAppr: 1 });
        assert.ok(!JSON.stringify(outcome).includes(IMEI), "the printed outcome must never carry the imei");
    });
});

describe("Commander hands the action only the flags that were typed", () => {
    it("an untyped toggle is absent, so it cannot be confused with --no-X", async () => {
        // The premise of the whole fix. Red if a flag gains a default, or if
        // `--no-X` is ever declared before `--X` (Commander then defaults the
        // value to true).
        const { opts } = await parseSettings([GROUP]);
        assert.deepEqual(opts, {});
        assert.deepEqual((await parseSettings([GROUP, "--join-appr"])).opts, { joinAppr: true });
        assert.deepEqual((await parseSettings([GROUP, "--no-join-appr"])).opts, { joinAppr: false });
    });

    it("an absent flag is no change; --X is 1 and --no-X is 0", () => {
        // Red if an absent flag turns into a value — the old mapping turned
        // `{}` into eight OFFs.
        assert.deepEqual(settingChangesFromOptions({}), {});
        assert.deepEqual(settingChangesFromOptions({ joinAppr: true }), { joinAppr: 1 });
        assert.deepEqual(settingChangesFromOptions({ signAdmin: false }), { signAdminMsg: 0 });
    });

    it("every flag on the command changes a setting, and every setting flag has both forms", () => {
        // Red if a flag is registered that the mapping ignores (it would be a
        // silent no-op), or a setting loses its --X or --no-X form.
        const longs = settingsCommand().settings.options.map((o) => o.long);
        for (const flag of Object.keys(EXPECTED_FLAGS)) {
            assert.ok(longs.includes(`--${flag}`), `--${flag} is not registered`);
            assert.ok(longs.includes(`--no-${flag}`), `--no-${flag} is not registered`);
        }
        const stray = longs.filter(
            (l) => !Object.keys(EXPECTED_FLAGS).some((f) => l === `--${f}` || l === `--no-${f}`),
        );
        assert.deepEqual(stray, [], "flags with no setting behind them");
    });
});

describe("the command goes through the read-modify-write", () => {
    // Wiring only. The tests above prove what the helper sends; this proves
    // the command uses it. It reads only the `settings` action in group.js,
    // with comments stripped, so the helper existing elsewhere cannot satisfy
    // it. Red if the action goes back to zca-js's updateGroupSettings, back to
    // `?? false`, or maps the flags itself.
    it("the settings action maps flags with settingChangesFromOptions and writes with applyGroupSettingChanges", () => {
        const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "group.js"), "utf8");
        const start = src.indexOf('.command("settings <groupId>")');
        assert.ok(start >= 0, "could not find `group settings`");
        const end = src.indexOf(".command(", start + 1);
        const body = src
            .slice(start, end === -1 ? undefined : end)
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
        assert.match(body, /settingChangesFromOptions\(opts\)/);
        assert.match(body, /applyGroupSettingChanges\(/);
        assert.doesNotMatch(body, /\.updateGroupSettings\(/, "zca-js's updateGroupSettings resets fields");
        assert.doesNotMatch(body, /\?\?\s*false/, "`?? false` turns an absent flag into OFF");
    });
});
