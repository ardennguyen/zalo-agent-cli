/**
 * The own-profile area on the wire (design 3.1, package PRF): avatar upload, bio, profile, settings, the avatar
 * gallery, online status, language, lost focus and linked devices, zca-js against src/zalo/api/profile.js on one
 * logged-in fake.
 *
 * Each case has the three parts of design 3.1: (1) `assertSameWire` against the rows of tests/helpers/wire-diff/
 * allow/profile.js, which fails on any difference not declared AND on a declared one that is absent; (2) our side
 * against its reviewed golden record; (3) the error answers. The Web-only behavior is also asserted outright, so a
 * case is red if our side drifts back to zca-js's shape even where the golden file were re-recorded.
 *
 * The settings calls go to Zalo Web's auth host (`https://wpa.chat.zalo.me`), which is no service-map host of the
 * fake: this file answers it itself (`answerAuthHost`), opening the sealed params so they are compared decrypted.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { openSession } from "../../src/zalo/kernel/cipher.js";
import { ALLOW, FAKE, assertSameWire, expectGolden, openPair } from "../helpers/wire-diff/index.js";
import { SKIP_GLOBAL } from "../helpers/wire-diff/allow/profile.js";
import { OWN_READY } from "../../src/zalo/api/profile.js";

const AREA = "profile";
const FRIEND = "1000000000000000002";
const FRIEND2 = "1000000000000000005";
const AUTH_HOST = "wpa.chat.zalo.me";

/** A small "image": its bytes only have to arrive unchanged; the size comes from the metadata getter. */
const IMAGE_BYTES = Buffer.from("fake-jpeg-bytes-for-the-avatar-upload-0123456789");
const IMAGE_PATH = join(SANDBOX_HOME, "avatar.jpg");
const IMAGE_META = Object.freeze({ width: 640, height: 480, size: IMAGE_BYTES.length });

/**
 * The allowed differences of one case: the area's rows of that case, plus the global rows the case keeps. D3 is
 * never kept: K1 sends the Accept-Language zca-js sends, so D3 has nothing to show (as in wire-actions.test.js).
 *
 * @param {string} name - the case
 * @returns {object[]}
 */
function allowFor(name) {
    const skip = new Set(["D3", ...(SKIP_GLOBAL[name] ?? [])]);
    return ALLOW[AREA].filter((r) => !skip.has(r.id) && (!r.case || [].concat(r.case).includes(name)));
}

/** The answers every method is run against for part 3, and whether zca-js has the same message for each. */
const ERROR_ANSWERS = [
    { label: "an outer error", error: { outer: { error_code: 102, error_message: "outer failure" } }, sameText: true },
    { label: "an inner error", error: { inner: { error_code: 114, error_message: "inner failure" } }, sameText: true },
    { label: "HTTP 500", error: { status: 500 }, sameText: false },
    { label: "an undecryptable data", error: { undecryptable: true }, sameText: true },
];

describe("wire: profile (zca-js against src/zalo/api/profile.js)", () => {
    let pair;
    /** What the auth host answers in the current run: the run's `error`, else its `reply` sealed. */
    let authAnswer = { data: null };

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        writeFileSync(IMAGE_PATH, IMAGE_BYTES);
        pair = await openPair({ zaloOptions: { imageMetadataGetter: async () => ({ ...IMAGE_META }) } });
        // zca-js writes an empty Cookie header for an empty jar and fetch writes none: give every host a cookie.
        pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
        pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.me; Path=/", "https://chat.zalo.me/");
        // Every run clears the fake's routes; put the auth host's answer back each time, ahead of the run's own.
        const { fake } = pair;
        const clear = fake.clearRoutes;
        fake.clearRoutes = () => {
            clear();
            fake.rawRoute(
                (r) => r.host === AUTH_HOST,
                (r) => {
                    // The fake opens params only for its own hosts; open them here so they are compared decrypted.
                    if (r.rawParams) r.params = JSON.parse(openSession(FAKE.sessionKey, r.rawParams));
                    return fake.answer(authAnswer, r);
                },
            );
        };
    });
    after(() => pair?.close());

    /**
     * `pair.run`, with the run's `reply` or `error` also answering the auth host.
     *
     * @param {string} method
     * @param {unknown[]} args
     * @param {object} fixture
     */
    async function run(method, args, fixture) {
        authAnswer = fixture.error ?? { data: fixture.reply ?? null };
        return pair.run(method, args, fixture);
    }

    /**
     * Run one case through both engines, check it against its rows and its golden record.
     *
     * @param {string} name - the case (golden entry and `case` of its rows)
     * @param {string} method
     * @param {unknown[]} args
     * @param {object} fixture
     */
    async function check(name, method, args, fixture) {
        const rec = await run(method, args, fixture);
        assertSameWire(rec, allowFor(name));
        await expectGolden(AREA, name, rec.own);
        assert.equal(rec.own.error, null, `${name}: our side threw ${JSON.stringify(rec.own.error)}`);
        return rec;
    }

    describe("changeAccountAvatar", () => {
        it("multipart to {file}/api/profile/upavatar: the image as fileContent, avatarSize 160", async () => {
            const rec = await check("avatar", "changeAccountAvatar", [IMAGE_PATH], { reply: { avatar: "a" } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.service, "file");
            assert.equal(req.path, "/api/profile/upavatar");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            // Red if the clientId lost the uid, or its stamp were not the local HH:MM DD/MM/YYYY of the frozen clock
            // (1700000000000 is 05:13 on 15/11/2023 in Asia/Ho_Chi_Minh).
            assert.deepEqual(req.params, {
                avatarSize: 160,
                clientId: `${FAKE.ownId}05:13 15/11/2023`,
                language: "vi",
                metaData: JSON.stringify({
                    origin: { width: 640, height: 480 },
                    processed: { width: 640, height: 480, size: IMAGE_BYTES.length },
                }),
            });
            assert.equal(req.parts.length, 1);
            assert.deepEqual(
                { name: req.parts[0].name, filename: req.parts[0].filename, type: req.parts[0].type },
                { name: "fileContent", filename: "blob", type: "image/jpeg" },
            );
            assert.equal(req.parts[0].size, IMAGE_BYTES.length);
            assert.deepEqual(rec.own.result, { avatar: "a" });
        });

        it("an attachment object: its bytes and metadata, 1080 when the size is unknown", async () => {
            const source = { data: IMAGE_BYTES, metadata: { totalSize: 7 } };
            const rec = await check("avatar-attachment", "changeAccountAvatar", [source], { reply: {} });
            const meta = JSON.parse(rec.own.requests[0].params.metaData);
            assert.deepEqual(meta, {
                origin: { width: 1080, height: 1080 },
                processed: { width: 1080, height: 1080, size: 7 },
            });
        });

        it("refuses a path when the session cannot measure images, before any request", async () => {
            const getter = pair.ctx.options.imageMetadataGetter;
            delete pair.ctx.options.imageMetadataGetter;
            try {
                const from = pair.fake.requests.length;
                await assert.rejects(pair.own.changeAccountAvatar(IMAGE_PATH), /imageMetadataGetter/);
                assert.equal(pair.fake.requests.length, from, "no request was made");
            } finally {
                pair.ctx.options.imageMetadataGetter = getter;
            }
        });
    });

    describe("bio, profile", () => {
        it("updateProfileBio: POST {status} in the form body only", async () => {
            const rec = await check("bio", "updateProfileBio", ["a new bio"], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/social/profile/status");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.deepEqual(req.params, { status: "a new bio" });
        });

        it("updateProfile: profile JSON in the Web's order {name, gender, dob}, biz {} for a personal account", async () => {
            const payload = { profile: { name: "Test Name", dob: "2000-01-02", gender: 1 } };
            const rec = await check("profile-update", "updateProfile", [payload], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/social/profile/update");
            assert.equal(req.params.profile, '{"name":"Test Name","gender":1,"dob":"2000-01-02"}');
            assert.equal(req.params.biz, "{}");
            assert.equal(req.params.language, "vi");
        });

        it("updateProfile: a business account's details under the Web's short keys", async () => {
            const payload = {
                profile: { name: "Shop Name", dob: "1990-03-04", gender: 0 },
                biz: { description: "d", cate: 3, address: "a", website: "w", email: "e" },
            };
            const rec = await check("profile-update-biz", "updateProfile", [payload], { reply: {} });
            assert.deepEqual(JSON.parse(rec.own.requests[0].params.biz), {
                desc: "d",
                cate: 3,
                addr: "a",
                website: "w",
                email: "e",
            });
        });
    });

    describe("settings (on the auth host)", () => {
        it("getSettings: GET https://wpa.chat.zalo.me/api/setting/me with no params", async () => {
            const rec = await check("settings-get", "getSettings", [], { reply: { show_online_status: 1 } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, AUTH_HOST);
            assert.equal(req.path, "/api/setting/me");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.deepEqual(rec.own.result, { show_online_status: 1 });
        });

        it("updateSettings: GET .../api/setting/update with the one setting", async () => {
            const rec = await check("settings-update", "updateSettings", ["show_online_status", 0], { reply: "" });
            const [req] = rec.own.requests;
            assert.equal(req.service, AUTH_HOST);
            assert.equal(req.path, "/api/setting/update");
            assert.deepEqual(req.params, { show_online_status: 0 });
        });
    });

    describe("avatar gallery", () => {
        it("getAvatarList: {page, albumId, count}, no imei", async () => {
            const rec = await check("avatar-list", "getAvatarList", [20, 2], { reply: { photos: [] } });
            assert.deepEqual(rec.own.requests[0].params, { page: 2, albumId: "0", count: 20 });
            assert.deepEqual(rec.own.requests[0].paramsOrder, ["page", "albumId", "count"]);
        });

        it("getAvatarList: defaults count 50, page 1", async () => {
            const rec = await check("avatar-list-default", "getAvatarList", [], { reply: { photos: [] } });
            assert.deepEqual(rec.own.requests[0].params, { page: 1, albumId: "0", count: 50 });
        });

        it("getFullAvatar: GET {fid, imei}", async () => {
            const rec = await check("full-avatar", "getFullAvatar", [FRIEND], { reply: { avatar: "u" } });
            assert.equal(rec.own.requests[0].method, "GET");
            assert.deepEqual(rec.own.requests[0].params, { fid: FRIEND, imei: FAKE.imei });
        });

        it("getAvatarUrlProfile: POST {friend_ids, avatar_size 160, srcReq -1}", async () => {
            const rec = await check("avatar-url", "getAvatarUrlProfile", [[FRIEND, FRIEND2]], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/social/profile/avatar-url");
            assert.deepEqual(req.params, { friend_ids: [FRIEND, FRIEND2], avatar_size: 160, srcReq: -1 });
        });

        it("getAvatarUrlProfile: one id becomes a list", async () => {
            const rec = await check("avatar-url-one", "getAvatarUrlProfile", [FRIEND], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params.friend_ids, [FRIEND]);
        });

        it("deleteAvatar: delPhotos as a JSON string of {photoId}, no imei", async () => {
            const rec = await check("avatar-delete", "deleteAvatar", [["11", "12"]], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params, {
                delPhotos: JSON.stringify([{ photoId: "11" }, { photoId: "12" }]),
            });
        });

        it("reuseAvatar: {photoId, isPostSocial 0}, no imei", async () => {
            const rec = await check("avatar-reuse", "reuseAvatar", ["11"], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params, { photoId: "11", isPostSocial: 0 });
        });
    });

    describe("status, language, focus, devices", () => {
        it("updateActiveStatus(true): GET ping {status 1, imei}", async () => {
            const rec = await check("active-on", "updateActiveStatus", [true], { reply: { status: true } });
            assert.equal(rec.own.requests[0].path, "/api/social/profile/ping");
            assert.deepEqual(rec.own.requests[0].params, { status: 1, imei: FAKE.imei });
        });

        it("updateActiveStatus(false): GET deactive with {imei} only", async () => {
            const rec = await check("active-off", "updateActiveStatus", [false], { reply: { status: true } });
            assert.equal(rec.own.requests[0].path, "/api/social/profile/deactive");
            // Red if the zca-js status: 0 came back.
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
        });

        it("updateLang: GET {language}", async () => {
            const rec = await check("lang", "updateLang", ["EN"], { reply: "" });
            assert.deepEqual(rec.own.requests[0].params, { language: "EN" });
        });

        it("lostFocus: POST with no body", async () => {
            const rec = await check("lost-focus", "lostFocus", [], { reply: { status: true } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/social/profile/changefgtobg");
            assert.equal(req.params, null);
            assert.equal(req.form, null);
            assert.equal(req.body, null);
        });

        it("getListDevice: GET {aext}/api/devices/linked {imei}", async () => {
            const rec = await check("devices", "getListDevice", [], { reply: { devices: [] } });
            assert.equal(rec.own.requests[0].service, "aext");
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
            assert.deepEqual(rec.own.result, { devices: [] });
        });
    });

    describe("error answers", () => {
        const CALLS = [
            ["changeAccountAvatar", [IMAGE_PATH]],
            ["updateProfileBio", ["x"]],
            ["updateProfile", [{ profile: { name: "N", dob: "2000-01-01", gender: 0 } }]],
            ["getSettings", []],
            ["updateSettings", ["view_birthday", 1]],
            ["getAvatarList", []],
            ["getFullAvatar", [FRIEND]],
            ["getAvatarUrlProfile", [FRIEND]],
            ["deleteAvatar", ["11"]],
            ["reuseAvatar", ["11"]],
            ["updateActiveStatus", [true]],
            ["updateActiveStatus", [false]],
            ["updateLang", ["VI"]],
            ["lostFocus", []],
            ["getListDevice", []],
        ];
        for (const [method, args] of CALLS) {
            it(`${method}(${args.map((a) => (a === IMAGE_PATH ? "<image>" : JSON.stringify(a))).join(", ")}): same code, same text where zca-js has it`, async () => {
                for (const answer of ERROR_ANSWERS) {
                    const rec = await run(method, args, { error: answer.error });
                    const where = `${method}, ${answer.label}`;
                    assert.ok(rec.own.error, `${where}: our side did not throw`);
                    assert.ok(rec.zca.error, `${where}: zca-js did not throw`);
                    assert.equal(rec.own.error.code, rec.zca.error.code, where);
                    if (answer.sameText) assert.equal(rec.own.error.message, rec.zca.error.message, where);
                    else assert.equal(rec.own.error.message, "HTTP 500", where);
                }
            });
        }
    });

    it("OWN_READY lists the methods this file compares, except the two an older test still pins to zca-js", () => {
        // Red if a method was flipped to our engine without a comparison here, or one compared here was left on
        // zca-js. updateActiveStatus and lostFocus pass here but stay on zca-js until tests/unit/zca-gap-commands
        // .test.js stops asserting zca-js's {status: 0} and sealed {} (not this package's file).
        assert.deepEqual(
            [...OWN_READY].sort(),
            [
                "changeAccountAvatar",
                "deleteAvatar",
                "getAvatarList",
                "getAvatarUrlProfile",
                "getFullAvatar",
                "getListDevice",
                "getSettings",
                "reuseAvatar",
                "updateLang",
                "updateProfile",
                "updateProfileBio",
                "updateSettings",
            ].sort(),
        );
    });
});
