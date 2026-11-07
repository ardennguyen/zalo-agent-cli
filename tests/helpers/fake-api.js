/**
 * A fake logged-in session for driving CLI commands offline.
 *
 * The CLI loads this module instead of logging in when `ZALO_TEST_FAKE_API` points here and the process runs in
 * the test sandbox (src/core/test-fake-session.js holds the guard). Every method of the session answers with a
 * canned reply and records nothing on the network: there is no network.
 *
 *   ZALO_TEST_FAKE_API_MODE     `normal` (default): a plausible reply per method -- {@link NORMAL_REPLIES}, else
 *                               {@link DEFAULT_REPLY}. `empty-string` | `null` | `empty-object` | `undefined`:
 *                               every method answers that, the way Zalo answers many writes, so a command that
 *                               passes Zalo's reply through as its own output is caught.
 *   ZALO_TEST_FAKE_API_REPLIES  JSON `{ "<method>": <reply> }`, overriding either mode per method; the key
 *                               `(raw request)` overrides what every raw request answers.
 *   ZALO_TEST_FAKE_API_OWN_ID   the session's own id (default {@link FAKE_OWN_ID}).
 *
 * The few commands that make a raw request instead of calling a session method (src/zalo/session-call.js
 * `customCall`, src/zalo/kernel/bound.js) reach the context's fetch (`options.polyfill`), which answers every
 * request with a sealed Zalo envelope carrying {@link DEFAULT_REPLY}, or the empty mode's value: no request
 * leaves the process either way.
 *
 * Every id here is made up.
 */
import { EventEmitter } from "node:events";
import { sealSession } from "../../src/zalo/kernel/cipher.js";

export const FAKE_OWN_ID = "1000000000000000001";
export const FAKE_PEER_ID = "1000000000000000002";
export const FAKE_GROUP_ID = "1000000000000000003";

/** What a method with no entry in {@link NORMAL_REPLIES} answers in `normal` mode. */
export const DEFAULT_REPLY = Object.freeze({ fake: true });

const EMPTY = { "empty-string": "", null: null, "empty-object": {}, undefined };
export const EMPTY_MODES = Object.freeze(Object.keys(EMPTY));

const profile = (id, name) => ({
    userId: id,
    uid: id,
    displayName: name,
    zaloName: name,
    username: "",
    avatar: "",
    phoneNumber: "",
    gender: 0,
    sdob: "",
    status: "",
    lastActionTime: 0,
});

/** Plausible replies for the methods whose callers read a particular shape. */
export const NORMAL_REPLIES = {
    // A hidden-chat PIN is set (the md5 of "1234", a test value) and nothing is hidden yet, so `conv hide` can act and
    // no other command's conversation is left out.
    getHiddenConversations: { pin: "81dc9bdb52d04dc20036dbd8313ed055", threads: [] },
    getAllFriends: [profile(FAKE_PEER_ID, "Fake Friend")],
    getAllGroups: { version: "1", gridVerMap: { [FAKE_GROUP_ID]: "1" } },
    getGroupInfo: {
        gridInfoMap: {
            [FAKE_GROUP_ID]: {
                groupId: FAKE_GROUP_ID,
                name: "Fake Group",
                creatorId: FAKE_OWN_ID,
                adminIds: [],
                memberIds: [FAKE_OWN_ID, FAKE_PEER_ID],
                memVerList: [`${FAKE_OWN_ID}_0`, `${FAKE_PEER_ID}_0`],
                totalMember: 2,
                // Every field a settings update must resend (src/zalo/custom/group-settings.js).
                setting: {
                    blockName: 0,
                    signAdminMsg: 0,
                    addMemberOnly: 0,
                    setTopicOnly: 0,
                    enableMsgHistory: 1,
                    joinAppr: 0,
                    lockCreatePost: 0,
                    lockCreatePoll: 0,
                    lockSendMsg: 0,
                    lockViewMember: 0,
                    bannFeature: 0,
                    dirtyMedia: 0,
                    banDuration: 0,
                },
            },
        },
        unchangedsGroup: [],
    },
    getUserInfo: {
        changed_profiles: { [FAKE_PEER_ID]: profile(FAKE_PEER_ID, "Fake Friend") },
        unchanged_profiles: {},
    },
    fetchAccountInfo: { profile: profile(FAKE_OWN_ID, "Fake Self") },
    findUser: { ...profile(FAKE_PEER_ID, "Fake Friend"), uid: FAKE_PEER_ID },
    searchSticker: [{ sticker_id: 1, cate_id: 1, type: 7 }],
    getArchivedChatList: { version: 1, items: [] },
    getListBankAccount: {
        myBanks: [{ account_id: 1, bin_bank: 970436, account_number: "0123456789" }],
        hasMore: false,
    },
};

const SESSION_KEY = Buffer.alloc(16, 7).toString("base64");

/** Every service a raw request may name; each gets a host that cannot resolve. */
const SERVICES = [
    "aext",
    "alias",
    "auto_reply",
    "catalog",
    "chat",
    "conversation",
    "file",
    "friend",
    "friend_board",
    "group",
    "group_board",
    "group_cloud_message",
    "group_poll",
    "label",
    "profile",
    "quick_message",
    "reaction",
    "sticker",
    "zavi",
    "zcloud",
    "zimsg",
];
const SERVICE_MAP = Object.fromEntries(SERVICES.map((k) => [k, [`https://${k.replace(/_/g, "-")}.zalo.invalid`]]));

/** The fetch raw requests reach: a sealed success envelope around `data`. */
const rawFetch = (dataFor) => async () => {
    const data = dataFor();
    const inner = { error_code: 0, error_message: "Successful.", ...(data === undefined ? {} : { data }) };
    return new Response(
        JSON.stringify({
            error_code: 0,
            error_message: "Successful.",
            data: sealSession(SESSION_KEY, JSON.stringify(inner)),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
};

const fakeContext = (ownId, dataFor) => ({
    uid: ownId,
    imei: "fake-imei",
    userAgent: "fake-agent",
    language: "vi",
    secretKey: SESSION_KEY,
    loginInfo: { send2me_id: ownId },
    settings: {},
    options: { polyfill: rawFetch(dataFor) },
});

/** A listener that connects and closes on cue and never receives anything. */
class FakeListener extends EventEmitter {
    start() {
        setImmediate(() => {
            this.emit("connected");
            // The server's hello, which a connect waits for before it sends anything.
            this.emit("cipher_key", "fake-key");
        });
    }
    stop() {
        setImmediate(() => this.emit("closed", 1000, ""));
    }
    sendWs() {}
    /** The old-message stream: one empty page, i.e. nothing older. */
    requestOldMessages(threadType) {
        setImmediate(() => this.emit("old_messages", [], threadType));
    }
}

/**
 * Make the fake session.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{api: object, ownId: string}}
 */
export function createFakeSession(env = process.env) {
    const mode = env.ZALO_TEST_FAKE_API_MODE || "normal";
    if (mode !== "normal" && !(mode in EMPTY)) throw new Error(`fake-api: unknown mode ${mode}`);
    const ownId = env.ZALO_TEST_FAKE_API_OWN_ID || FAKE_OWN_ID;
    const listener = new FakeListener();
    // Read per call, not once: a batch worker (tests/helpers/cli-batch-worker.mjs) sets it per case.
    const overrides = () => (env.ZALO_TEST_FAKE_API_REPLIES ? JSON.parse(env.ZALO_TEST_FAKE_API_REPLIES) : {});
    const replyFor = (name) => {
        const o = overrides();
        if (Object.hasOwn(o, name)) return o[name];
        if (mode !== "normal") return EMPTY[mode];
        return Object.hasOwn(NORMAL_REPLIES, name) ? NORMAL_REPLIES[name] : DEFAULT_REPLY;
    };
    // A fresh copy per call, so a command that mutates its reply cannot change the next one.
    const copy = (v) => (v === undefined ? undefined : structuredClone(v));
    const context = fakeContext(ownId, () => copy(replyFor("(raw request)")));
    const fixed = {
        listener,
        zpwServiceMap: SERVICE_MAP,
        getOwnId: () => ownId,
        getContext: () => context,
    };
    const api = new Proxy(Object.create(null), {
        get(_, prop) {
            if (typeof prop !== "string") return undefined;
            // Not a promise: `await api` must not call a `then`.
            if (prop === "then" || prop === "toJSON") return undefined;
            if (Object.hasOwn(fixed, prop)) return fixed[prop];
            return async () => copy(replyFor(prop));
        },
        has: () => true,
    });
    return { api, ownId };
}
