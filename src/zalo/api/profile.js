/**
 * The account's own profile: avatar, bio, name/birthday/gender, privacy settings, the avatar gallery, the online
 * status, the language, the "tab lost focus" signal, and the list of linked devices
 * (agent/docs/zca-replace/spec-sweep.md 1.2, "Own profile, avatars, status, settings" and "Account").
 *
 * Every call is one session request on the ordinary envelope (kernel/endpoint.js), shaped the way Zalo Web 26.11.10
 * shapes it (`1.c72c0957b455ab70b73c.js`, the API module; the avatar gallery calls are in
 * `web-startup.a00a02c532982ab4915a.js`). Where the Web differs from what the engine sent before, the Web wins:
 *
 * - `changeAccountAvatar`: `avatarSize` 160 (updateProfileAvatar's callers always pass 160), a 60 s timeout.
 * - `updateProfileBio`: the sealed `params` only in the form body, not in the query too (updateStatus).
 * - `updateProfile`: the inner `profile` JSON in the Web's order `{name, gender, dob}` (the profile editor).
 * - `getSettings`: a GET with the common query only, no `params` (getSettings).
 * - `getAvatarList`, `deleteAvatar`, `reuseAvatar`: no `imei` (getAvatarHistory, deleteAvatarHistory, reuseAvatar).
 * - `getAvatarUrlProfile`: a POST, `avatar_size` 160 by default (getAvatarUrlProfile).
 * - `updateActiveStatus(false)`: `{imei}` only (deactive).
 * - `lostFocus`: a POST with no body at all (lostFocus).
 *
 * The settings calls go to Web's `authDomain` (`https://wpa.chat.zalo.me`), not to a service-map host. Every id
 * stays a string. Nothing here writes to stdout or logs.
 */
import { readFile } from "node:fs/promises";
import { ZaloApiError } from "../errors.js";

/** The avatar size Zalo Web asks for in its own-profile and avatar-url calls. */
export const WEB_AVATAR_SIZE = 160;

/** Zalo Web's timeout for an avatar upload. */
const AVATAR_UPLOAD_TIMEOUT_MS = 60_000;

/** The width and height an avatar's metadata says when the image's own are unknown. */
const DEFAULT_SIDE = 1080;

/**
 * A local time as `HH:MM DD/MM/YYYY`, the stamp Zalo Web puts after the uid in an avatar's `clientId`
 * (getFullTimeFromMilisecond).
 *
 * @param {number} ms - milliseconds since the epoch
 * @returns {string}
 */
export function avatarClockText(ms) {
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, "0");
    return `${two(d.getHours())}:${two(d.getMinutes())} ${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** `POST {file}/api/profile/upavatar`: multipart, sealed params in the query (updateProfileAvatar, 11819). */
export const AVATAR_UPLOAD = Object.freeze({
    host: "file",
    path: "/api/profile/upavatar",
    cmd: 11819,
    method: "multipart",
    body: (a, ctx) => ({
        avatarSize: WEB_AVATAR_SIZE,
        clientId: `${ctx.uid}${avatarClockText(a.at)}`,
        language: ctx.language,
        metaData: JSON.stringify({
            origin: { width: a.width, height: a.height },
            processed: { width: a.width, height: a.height, size: a.size },
        }),
    }),
    file: (a) => ({ field: "fileContent", filename: "blob", type: "image/jpeg", bytes: a.bytes }),
    timeoutMs: AVATAR_UPLOAD_TIMEOUT_MS,
    reply: "session",
});

/** `POST {profile}/api/social/profile/status` (updateStatus, 11291). */
export const PROFILE_STATUS = Object.freeze({
    host: "profile",
    path: "/api/social/profile/status",
    cmd: 11291,
    method: "post",
    body: (a) => ({ status: a.status }),
    reply: "session",
});

/** `POST {profile}/api/social/profile/update` (updateProfileMe, 12075). */
export const PROFILE_UPDATE = Object.freeze({
    host: "profile",
    path: "/api/social/profile/update",
    cmd: 12075,
    method: "post",
    body: (a, ctx) => ({ profile: JSON.stringify(a.profile), biz: JSON.stringify(a.biz), language: ctx.language }),
    reply: "session",
});

/** `GET {auth}/api/setting/me`, no params (getSettings, 12113). */
export const SETTINGS_GET = Object.freeze({
    host: "auth",
    path: "/api/setting/me",
    cmd: 12113,
    method: "get",
    body: () => null,
    reply: "session",
});

/** `GET {auth}/api/setting/update` (setSettings, 12033). */
export const SETTINGS_UPDATE = Object.freeze({
    host: "auth",
    path: "/api/setting/update",
    cmd: 12033,
    method: "get",
    body: (a) => ({ [a.key]: a.value }),
    reply: "session",
});

/** `GET {profile}/api/social/avatar-list` (getAvatarHistory, 12451). */
export const AVATAR_LIST = Object.freeze({
    host: "profile",
    path: "/api/social/avatar-list",
    cmd: 12451,
    method: "get",
    body: (a) => ({ page: a.page, albumId: "0", count: a.count }),
    reply: "session",
});

/** `GET {profile}/api/social/profile/avatar` (getFullAvatar, 11860). */
export const FULL_AVATAR = Object.freeze({
    host: "profile",
    path: "/api/social/profile/avatar",
    cmd: 11860,
    method: "get",
    body: (a, ctx) => ({ fid: a.friendId, imei: ctx.imei }),
    reply: "session",
});

/** `POST {profile}/api/social/profile/avatar-url` (getAvatarUrlProfile, 12153). */
export const AVATAR_URL = Object.freeze({
    host: "profile",
    path: "/api/social/profile/avatar-url",
    cmd: 12153,
    method: "post",
    body: (a) => ({ friend_ids: a.friendIds, avatar_size: a.avatarSize, srcReq: -1 }),
    reply: "session",
});

/** `GET {profile}/api/social/del-avatars` (deleteAvatarHistory, 12452). */
export const AVATAR_DELETE = Object.freeze({
    host: "profile",
    path: "/api/social/del-avatars",
    cmd: 12452,
    method: "get",
    body: (a) => ({ delPhotos: JSON.stringify(a.photoIds.map((photoId) => ({ photoId }))) }),
    reply: "session",
});

/** `GET {profile}/api/social/reuse-avatar` (reuseAvatar, 12453). */
export const AVATAR_REUSE = Object.freeze({
    host: "profile",
    path: "/api/social/reuse-avatar",
    cmd: 12453,
    method: "get",
    body: (a) => ({ photoId: a.photoId, isPostSocial: 0 }),
    reply: "session",
});

/** `GET {profile}/api/social/profile/ping` (active, 11142). */
export const STATUS_ACTIVE = Object.freeze({
    host: "profile",
    path: "/api/social/profile/ping",
    cmd: 11142,
    method: "get",
    body: (_a, ctx) => ({ status: 1, imei: ctx.imei }),
    reply: "session",
});

/** `GET {profile}/api/social/profile/deactive` (deactive, 11143): the imei only. */
export const STATUS_INACTIVE = Object.freeze({
    host: "profile",
    path: "/api/social/profile/deactive",
    cmd: 11143,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
    reply: "session",
});

/** `GET {profile}/api/social/profile/updatelang` (updateLanguage, 11289). */
export const UPDATE_LANGUAGE = Object.freeze({
    host: "profile",
    path: "/api/social/profile/updatelang",
    cmd: 11289,
    method: "get",
    body: (a) => ({ language: a.language }),
    reply: "session",
});

/** `POST {profile}/api/social/profile/changefgtobg` with no body (lostFocus, 12135). */
export const LOST_FOCUS = Object.freeze({
    host: "profile",
    path: "/api/social/profile/changefgtobg",
    cmd: 12135,
    method: "post",
    body: () => null,
    reply: "session",
});

/** `GET {aext}/api/devices/linked` (getDevicesList, 15302). */
export const LINKED_DEVICES = Object.freeze({
    host: "aext",
    path: "/api/devices/linked",
    cmd: 15302,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
    reply: "session",
});

/**
 * An avatar image's bytes and size: a file path (read here, measured by the session's `imageMetadataGetter`) or an
 * attachment `{data, metadata: {width, height, totalSize}}`.
 *
 * @param {object} ctx - the session
 * @param {string|{data: Uint8Array, metadata?: {width?: number, height?: number, totalSize?: number}}} source
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number, size: number}>}
 * @throws {ZaloApiError} when a path is given and the session cannot measure images, or measuring fails
 */
async function avatarImage(ctx, source) {
    let meta;
    let bytes;
    if (typeof source === "string") {
        const measure = ctx.options?.imageMetadataGetter;
        if (typeof measure !== "function") {
            throw new ZaloApiError("Cannot read the image's size: the session has no imageMetadataGetter");
        }
        const got = await measure(source);
        if (!got) throw new ZaloApiError("Failed to get image metadata");
        meta = { width: got.width, height: got.height, totalSize: got.size };
        bytes = await readFile(source);
    } else {
        meta = source?.metadata ?? {};
        bytes = source?.data;
    }
    return {
        bytes,
        width: meta.width || DEFAULT_SIDE,
        height: meta.height || DEFAULT_SIDE,
        size: meta.totalSize || 0,
    };
}

/**
 * The own-profile calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function profileMethods(s) {
    return {
        /**
         * Change the account's avatar.
         *
         * @param {string|{data: Uint8Array, metadata?: object}} avatarSource - an image file path, or an attachment
         * @returns {Promise<object>}
         */
        changeAccountAvatar: async (avatarSource) => {
            const image = await avatarImage(s.ctx, avatarSource);
            return s.call(AVATAR_UPLOAD, { ...image, at: s.now() });
        },

        /**
         * Set the account's bio (status line).
         *
         * @param {string} status - the new bio
         * @returns {Promise<object>}
         */
        updateProfileBio: (status) => s.call(PROFILE_STATUS, { status }),

        /**
         * Change the account's name, birthday and gender (all three are required by Zalo), and for a business
         * account its business details.
         *
         * @param {{profile: {name: string, dob: string, gender: number},
         *   biz?: {description?: string, cate?: number|string, address?: string, website?: string, email?: string}}} payload
         * @returns {Promise<object>}
         */
        updateProfile: (payload) =>
            s.call(PROFILE_UPDATE, {
                profile: { name: payload.profile.name, gender: payload.profile.gender, dob: payload.profile.dob },
                biz: {
                    desc: payload.biz?.description,
                    cate: payload.biz?.cate,
                    addr: payload.biz?.address,
                    website: payload.biz?.website,
                    email: payload.biz?.email,
                },
            }),

        /**
         * The account's privacy settings.
         *
         * @returns {Promise<object>}
         */
        getSettings: () => s.call(SETTINGS_GET, {}),

        /**
         * Change one privacy setting.
         *
         * @param {string} settingKey - Zalo's name of the setting (`show_online_status`, `view_birthday`, ...)
         * @param {number} value - the setting's new value
         * @returns {Promise<object>}
         */
        updateSettings: (settingKey, value) => s.call(SETTINGS_UPDATE, { key: settingKey, value }),

        /**
         * One page of the account's avatar gallery.
         *
         * @param {number} [count] - avatars per page (50)
         * @param {number} [page] - the page, from 1
         * @returns {Promise<object>}
         */
        getAvatarList: (count = 50, page = 1) => s.call(AVATAR_LIST, { count, page }),

        /**
         * A user's full-size avatar.
         *
         * @param {string} friendId - the user's id
         * @returns {Promise<object>}
         */
        getFullAvatar: (friendId) => s.call(FULL_AVATAR, { friendId: String(friendId) }),

        /**
         * Avatar URLs of users.
         *
         * @param {string|string[]} friendIds - one id or several
         * @param {number} [avatarSize] - the size asked for (160, as Zalo Web asks)
         * @returns {Promise<object>}
         */
        getAvatarUrlProfile: (friendIds, avatarSize = WEB_AVATAR_SIZE) =>
            s.call(AVATAR_URL, { friendIds: [].concat(friendIds).map(String), avatarSize }),

        /**
         * Delete avatars from the gallery.
         *
         * @param {string|string[]} photoIds - one photo id or several
         * @returns {Promise<object>}
         */
        deleteAvatar: (photoIds) => s.call(AVATAR_DELETE, { photoIds: [].concat(photoIds).map(String) }),

        /**
         * Make an earlier avatar of the gallery the current one.
         *
         * @param {string} photoId - the photo's id
         * @returns {Promise<object>}
         */
        reuseAvatar: (photoId) => s.call(AVATAR_REUSE, { photoId }),

        /**
         * Turn the account's online (active) status on or off.
         *
         * @param {boolean} active - true: on (`ping`), false: off (`deactive`)
         * @returns {Promise<object>}
         */
        updateActiveStatus: (active) => s.call(active ? STATUS_ACTIVE : STATUS_INACTIVE, {}),

        /**
         * Set the account's language.
         *
         * @param {"VI"|"EN"} [language] - "VI" by default
         * @returns {Promise<object>}
         */
        updateLang: (language = "VI") => s.call(UPDATE_LANGUAGE, { language }),

        /**
         * Tell Zalo this client went to the background (what Zalo Web sends when its tab loses focus).
         *
         * @returns {Promise<object>}
         */
        lostFocus: () => s.call(LOST_FOCUS, {}),

        /**
         * The devices linked to the account (`.devices`).
         *
         * @returns {Promise<object>}
         */
        getListDevice: () => s.call(LINKED_DEVICES, {}),
    };
}

/** Methods whose wire-profile.test.js comparison passes: the switch answers these from our code. */
export const OWN_READY = new Set([
    "changeAccountAvatar",
    "updateProfileBio",
    "updateProfile",
    "getSettings",
    "updateSettings",
    "getAvatarList",
    "getFullAvatar",
    "getAvatarUrlProfile",
    "deleteAvatar",
    "reuseAvatar",
    "updateLang",
    "updateActiveStatus",
    "lostFocus",
    "getListDevice",
]);
