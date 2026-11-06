/**
 * Intended differences between zca-js and our engine for the profile area: one row per difference, each also recorded
 * in golden/profile.js. Owned by package PRF; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-profile.test.js it is about (`case`): a method row must be
 * present in every run it is checked against, and one method has runs with and without a given difference
 * (updateActiveStatus on and off), so the test checks each run against the rows of its own case only.
 *
 * Offsets are in Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` unless they name `web-startup.a00a02c532982ab4915a.js`
 * (agent/work/zalo-web-capture-2026-11-06/bundles/).
 */
import { isDeepStrictEqual } from "node:util";

/** A JSON string's value, or undefined when it is not one. */
const parsed = (v) => {
    try {
        return JSON.parse(v);
    } catch {
        return undefined;
    }
};

/**
 * Global rows a case leaves out because the case has nothing for them to show. `avatar-url`: zca-js GETs with its
 * form content type (D2's shape), and we POST a form, so both send the same content type and D2 is not there.
 */
export const SKIP_GLOBAL = Object.freeze({
    "avatar-url": ["D2"],
    "avatar-url-one": ["D2"],
});

const AVATAR_URL_WHY = "Web getAvatarUrlProfile (@11701478) posts {friend_ids, avatar_size, srcReq} as a form";
const SETTINGS_WHY = "Web getSettings (@11579190) GETs authDomain/api/setting/me with the common params only";
const LOST_FOCUS_WHY = "Web lostFocus (@11699101) is _post(url, null): no params and no body";
const NO_IMEI_WHY = (m, at) => `Web ${m} (web-startup @${at}) seals no imei`;

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // changeAccountAvatar: avatarSize 160, as every Web caller of updateProfileAvatar passes it.
    {
        method: "changeAccountAvatar",
        case: ["avatar", "avatar-attachment"],
        field: "params.avatarSize",
        zca: 120,
        own: 160,
        why: "Web's avatar editor (@5172772) and network manager (web-startup @1220788) call updateProfileAvatar with 160",
    },

    // updateProfileBio: the sealed params in the form only (updateStatus @11610256).
    {
        method: "updateProfileBio",
        case: "bio",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: "Web updateStatus (@11610256) posts params in the body; its URL carries the common params only",
    },

    // updateProfile: the inner profile JSON in the editor's order (@5171435: {name, gender, dob}).
    {
        method: "updateProfile",
        case: ["profile-update", "profile-update-biz"],
        field: "params.profile",
        zca: (v) => isDeepStrictEqual(Object.keys(parsed(v) ?? {}), ["name", "dob", "gender"]),
        own: (v, { zca }) =>
            isDeepStrictEqual(Object.keys(parsed(v) ?? {}), ["name", "gender", "dob"]) &&
            isDeepStrictEqual(parsed(v), parsed(zca.params.profile)),
        why: "Web's profile editor (@5171435) calls updateProfileMe({name, gender, dob}) (@11698768)",
    },

    // getSettings: no params at all.
    {
        method: "getSettings",
        case: "settings-get",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: SETTINGS_WHY,
    },
    { method: "getSettings", case: "settings-get", field: "params", zca: {}, own: null, why: SETTINGS_WHY },
    { method: "getSettings", case: "settings-get", field: "paramsOrder", zca: [], own: null, why: SETTINGS_WHY },

    // The avatar gallery: no imei (web-startup's avatar network manager).
    {
        method: "getAvatarList",
        case: ["avatar-list", "avatar-list-default"],
        field: "params.imei",
        zca: (v) => typeof v === "string" && v.length > 0,
        own: undefined,
        why: NO_IMEI_WHY("getAvatarHistory", 1221161),
    },
    {
        method: "getAvatarList",
        case: ["avatar-list", "avatar-list-default"],
        field: "paramsOrder",
        zca: ["page", "albumId", "count", "imei"],
        own: ["page", "albumId", "count"],
        why: NO_IMEI_WHY("getAvatarHistory", 1221161),
    },
    {
        method: "deleteAvatar",
        case: "avatar-delete",
        field: "params.imei",
        zca: (v) => typeof v === "string" && v.length > 0,
        own: undefined,
        why: NO_IMEI_WHY("deleteAvatarHistory", 1221426),
    },
    {
        method: "deleteAvatar",
        case: "avatar-delete",
        field: "paramsOrder",
        zca: ["delPhotos", "imei"],
        own: ["delPhotos"],
        why: NO_IMEI_WHY("deleteAvatarHistory", 1221426),
    },
    {
        method: "reuseAvatar",
        case: "avatar-reuse",
        field: "params.imei",
        zca: (v) => typeof v === "string" && v.length > 0,
        own: undefined,
        why: NO_IMEI_WHY("reuseAvatar", 1220907),
    },
    {
        method: "reuseAvatar",
        case: "avatar-reuse",
        field: "paramsOrder",
        zca: ["photoId", "isPostSocial", "imei"],
        own: ["photoId", "isPostSocial"],
        why: NO_IMEI_WHY("reuseAvatar", 1220907),
    },

    // getAvatarUrlProfile: a POST, avatar_size 160 (the API module's `le = 160` @11568587).
    {
        method: "getAvatarUrlProfile",
        case: ["avatar-url", "avatar-url-one"],
        field: "method",
        zca: "GET",
        own: "POST",
        why: AVATAR_URL_WHY,
    },
    {
        method: "getAvatarUrlProfile",
        case: ["avatar-url", "avatar-url-one"],
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: AVATAR_URL_WHY,
    },
    {
        method: "getAvatarUrlProfile",
        case: ["avatar-url", "avatar-url-one"],
        field: "form",
        zca: null,
        own: {},
        why: AVATAR_URL_WHY,
    },
    {
        method: "getAvatarUrlProfile",
        case: ["avatar-url", "avatar-url-one"],
        field: "formOrder",
        zca: null,
        own: ["params"],
        why: AVATAR_URL_WHY,
    },
    {
        method: "getAvatarUrlProfile",
        case: ["avatar-url", "avatar-url-one"],
        field: "params.avatar_size",
        zca: 240,
        own: 160,
        why: "Web getAvatarUrlProfile (@11701478) defaults avatar_size to the module's 160 (@11568587)",
    },

    // updateActiveStatus(false): {imei} only (deactive @11683759; deactiveV2 is the one with a status).
    {
        method: "updateActiveStatus",
        case: "active-off",
        field: "params.status",
        zca: 0,
        own: undefined,
        why: "Web deactive (@11683759) seals {imei} only",
    },
    {
        method: "updateActiveStatus",
        case: "active-off",
        field: "paramsOrder",
        zca: ["status", "imei"],
        own: ["imei"],
        why: "Web deactive (@11683759) seals {imei} only",
    },

    // lostFocus: a POST with no body.
    { method: "lostFocus", case: "lost-focus", field: "params", zca: {}, own: null, why: LOST_FOCUS_WHY },
    { method: "lostFocus", case: "lost-focus", field: "paramsOrder", zca: [], own: null, why: LOST_FOCUS_WHY },
    { method: "lostFocus", case: "lost-focus", field: "form", zca: {}, own: null, why: LOST_FOCUS_WHY },
    { method: "lostFocus", case: "lost-focus", field: "formOrder", zca: ["params"], own: null, why: LOST_FOCUS_WHY },
    {
        method: "lostFocus",
        case: "lost-focus",
        field: "headers.content-type",
        zca: "application/x-www-form-urlencoded",
        own: undefined,
        why: `${LOST_FOCUS_WHY}: with no body there is no content type`,
    },
];
