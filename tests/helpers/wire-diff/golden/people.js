/**
 * Golden wire records of the people area: what our engine sends and returns for each case of
 * tests/unit/wire-people.test.js. Written by `node tests/helpers/wire-diff/record.mjs people`, then reviewed by
 * hand. Fake ids only.
 */
export default {
    acceptFriendRequest: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/accept",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    language: "vi",
                },
                paramsOrder: ["fid", "language"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    blockUser: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/block",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    blockViewFeed: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/feed/block",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    isBlockFeed: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "isBlockFeed", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    "blockViewFeed/unblock": {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/feed/block",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    isBlockFeed: 0,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "isBlockFeed", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    changeFriendAlias: {
        requests: [
            {
                method: "GET",
                service: "alias",
                path: "/api/alias/update",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    friendId: "4123456789012345678",
                    alias: "Fake Nick",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["friendId", "alias", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    findUser: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/get",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phone: "84901234567",
                    avatar_size: 240,
                    language: "vi",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    reqSrc: 40,
                },
                paramsOrder: ["phone", "avatar_size", "language", "imei", "reqSrc"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            uid: "4123456789012345678",
            display_name: "Fake Peer",
            zalo_name: "Fake",
            avatar: "https://fake.invalid/a",
        },
    },
    "findUser/216": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/get",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phone: "84901234567",
                    avatar_size: 240,
                    language: "vi",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    reqSrc: 40,
                },
                paramsOrder: ["phone", "avatar_size", "language", "imei", "reqSrc"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: {
            message: "fake not found",
            code: 216,
        },
    },
    "findUser/313": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/get",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phone: "84901234567",
                    avatar_size: 240,
                    language: "vi",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    reqSrc: 40,
                },
                paramsOrder: ["phone", "avatar_size", "language", "imei", "reqSrc"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: {
            message: "Phone search limit reached, try again later: fake limit",
            code: 313,
        },
    },
    "findUser/lang-en": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/get",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phone: "84901234567",
                    avatar_size: 240,
                    language: "en",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    reqSrc: 40,
                },
                paramsOrder: ["phone", "avatar_size", "language", "imei", "reqSrc"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            uid: "4123456789012345678",
            display_name: "Fake Peer",
            zalo_name: "Fake",
            avatar: "https://fake.invalid/a",
        },
    },
    "findUser/missing": {
        requests: [],
        error: {
            message: "Missing phoneNumber",
            code: null,
        },
    },
    findUserByUsername: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/search/by-user-name",
                queryOrder: ["params", "zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    user_name: "fake.user",
                    avatar_size: 240,
                },
                paramsOrder: ["user_name", "avatar_size"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            uid: "4123456789012345678",
            display_name: "Fake Peer",
            zalo_name: "Fake",
        },
    },
    getAliasList: {
        requests: [
            {
                method: "GET",
                service: "alias",
                path: "/api/alias/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    page: 1,
                    count: 100,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["page", "count", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            items: [
                {
                    userId: "1000000000000000010",
                    alias: "a0",
                },
                {
                    userId: "1000000000000000011",
                    alias: "a1",
                },
                {
                    userId: "1000000000000000012",
                    alias: "a2",
                },
            ],
            updateTime: 5,
        },
    },
    "getAliasList/212-first": {
        requests: [
            {
                method: "GET",
                service: "alias",
                path: "/api/alias/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    page: 1,
                    count: 100,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["page", "count", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: {
            message: "fake end of list",
            code: 212,
        },
    },
    "getAliasList/212-later": {
        requests: [
            {
                method: "GET",
                service: "alias",
                path: "/api/alias/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    page: 2,
                    count: 100,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["page", "count", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            items: [],
        },
    },
    getAllFriends: {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/friend/getfriends",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    incInvalid: 1,
                    page: 1,
                    count: 20000,
                    avatar_size: 160,
                    actiontime: 0,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["incInvalid", "page", "count", "avatar_size", "actiontime", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: [
            {
                userId: "4123456789012345678",
                displayName: "Fake A",
                zaloName: "A",
                globalId: "G1",
                lastActionTime: 1700000000000,
            },
            {
                userId: "1000000000000000002",
                displayName: "Fake B",
                zaloName: "B",
                globalId: "G2",
                lastActionTime: 1700000000001,
            },
        ],
    },
    getBizAccount: {
        requests: [
            {
                method: "POST",
                service: "profile",
                path: "/api/social/friend/get-bizacc",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                },
                paramsOrder: ["fid"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    getCloseFriends: {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/friend/getclosedfriends",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: null,
                paramsOrder: null,
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: [],
    },
    getFriendBoardList: {
        requests: [
            {
                method: "GET",
                service: "friend_board",
                path: "/api/friendboard/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    conversationId: "4123456789012345678",
                    version: 0,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["conversationId", "version", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            data: [
                {
                    type: 1,
                    params: "{}",
                },
                {
                    type: 2,
                    params: '{"msgId":"7000000000000000001"}',
                },
            ],
            version: 3,
        },
    },
    getFriendOnlines: {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/friend/onlines",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            predefine: [],
            ownerStatus: "",
            onlines: [
                {
                    userId: "4123456789012345678",
                    status: "fake busy",
                },
                {
                    userId: "1000000000000000002",
                },
            ],
        },
    },
    getFriendRecommendations: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/recommendsv2/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            expiredDuration: 1,
            collapseMsgListConfig: {},
            recommItems: [
                {
                    recommItemType: 1,
                    dataInfo: {
                        recommType: 2,
                        userId: "4123456789012345678",
                        displayName: "Fake",
                    },
                },
            ],
        },
    },
    getFriendRequestStatus: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/reqstatus",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            addFriendPrivacy: 1,
            isSeenFriendReq: 0,
            is_friend: 0,
            is_requested: 1,
            is_requesting: 0,
        },
    },
    getMultiUsersByPhones: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/multiget",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phones: ["84901234567", "84987654321"],
                    avatar_size: 240,
                    language: "vi",
                },
                paramsOrder: ["phones", "avatar_size", "language"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    "getMultiUsersByPhones/lang-en": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/profile/multiget",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phones: ["84901234567"],
                    avatar_size: 240,
                    language: "en",
                },
                paramsOrder: ["phones", "avatar_size", "language"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {},
    },
    "getMultiUsersByPhones/missing": {
        requests: [],
        error: {
            message: "Missing phoneNumbers",
            code: null,
        },
    },
    getQR: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/mget-qr",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fids: ["4123456789012345678", "1000000000000000002"],
                },
                paramsOrder: ["fids"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    getRelatedFriendGroup: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/group/related",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    friend_ids: '["4123456789012345678","1000000000000000002"]',
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["friend_ids", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    getSentFriendRequest: {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/requested/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                userId: "4123456789012345678",
                displayName: "Fake",
                fReqInfo: {
                    message: "hi",
                    src: 30,
                    time: 1,
                },
            },
            "1000000000000000002": {
                userId: "1000000000000000002",
                displayName: "Fake 2",
                fReqInfo: {
                    message: "",
                    src: 40,
                    time: 2,
                },
            },
        },
    },
    "getSentFriendRequest/112": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/requested/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {},
    },
    "getSentFriendRequest/112-outer": {
        requests: [
            {
                method: "GET",
                service: "friend",
                path: "/api/friend/requested/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {},
    },
    getUserInfo: {
        requests: [
            {
                method: "POST",
                service: "profile",
                path: "/api/social/friend/getprofiles/v2",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phonebook_version: 7,
                    friend_pversion_map: ["4123456789012345678_0", "1000000000000000002_3"],
                    avatar_size: 160,
                    language: "vi",
                    show_online_status: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: [
                    "phonebook_version",
                    "friend_pversion_map",
                    "avatar_size",
                    "language",
                    "show_online_status",
                    "imei",
                ],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            changed_profiles: {
                "4123456789012345678": {
                    userId: "4123456789012345678",
                    displayName: "Fake Peer",
                    zaloName: "Fake",
                },
            },
            unchanged_profiles: {
                "1000000000000000002": {
                    userId: "1000000000000000002",
                },
            },
            phonebook_version: 7,
        },
    },
    "getUserInfo/lang-en": {
        requests: [
            {
                method: "POST",
                service: "profile",
                path: "/api/social/friend/getprofiles/v2",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phonebook_version: 7,
                    friend_pversion_map: ["4123456789012345678_0"],
                    avatar_size: 160,
                    language: "vi",
                    show_online_status: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: [
                    "phonebook_version",
                    "friend_pversion_map",
                    "avatar_size",
                    "language",
                    "show_online_status",
                    "imei",
                ],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            changed_profiles: {
                "4123456789012345678": {
                    userId: "4123456789012345678",
                    displayName: "Fake Peer",
                    zaloName: "Fake",
                },
            },
            unchanged_profiles: {
                "1000000000000000002": {
                    userId: "1000000000000000002",
                },
            },
            phonebook_version: 7,
        },
    },
    "getUserInfo/missing": {
        requests: [],
        error: {
            message: "Missing user id",
            code: null,
        },
    },
    "getUserInfo/no-phonebook": {
        requests: [
            {
                method: "POST",
                service: "profile",
                path: "/api/social/friend/getprofiles/v2",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    phonebook_version: 0,
                    friend_pversion_map: ["4123456789012345678_0"],
                    avatar_size: 160,
                    language: "vi",
                    show_online_status: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: [
                    "phonebook_version",
                    "friend_pversion_map",
                    "avatar_size",
                    "language",
                    "show_online_status",
                    "imei",
                ],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            changed_profiles: {
                "4123456789012345678": {
                    userId: "4123456789012345678",
                    displayName: "Fake Peer",
                    zaloName: "Fake",
                },
            },
            unchanged_profiles: {
                "1000000000000000002": {
                    userId: "1000000000000000002",
                },
            },
            phonebook_version: 7,
        },
    },
    lastOnline: {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/profile/lastOnline",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    uid: "4123456789012345678",
                    conv_type: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["uid", "conv_type", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    rejectFriendRequest: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/reject",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                },
                paramsOrder: ["fid"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    removeFriend: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/remove",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    removeFriendAlias: {
        requests: [
            {
                method: "GET",
                service: "alias",
                path: "/api/alias/remove",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    friendId: "4123456789012345678",
                },
                paramsOrder: ["friendId"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: null,
                formOrder: null,
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    sendFriendRequest: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/sendreq",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    toid: "4123456789012345678",
                    msg: "hello",
                    reqsrc: 30,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    language: "vi",
                    srcParams: '{"uidTo":"4123456789012345678"}',
                },
                paramsOrder: ["toid", "msg", "reqsrc", "imei", "language", "srcParams"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
    "sendFriendRequest/225": {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/sendreq",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    toid: "4123456789012345678",
                    msg: "",
                    reqsrc: 30,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                    language: "vi",
                    srcParams: '{"uidTo":"4123456789012345678"}',
                },
                paramsOrder: ["toid", "msg", "reqsrc", "imei", "language", "srcParams"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: {
            message: "fake already friends",
            code: 225,
        },
    },
    unblockUser: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/unblock",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["fid", "imei"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: {
            "4123456789012345678": {
                fake: 1,
            },
        },
    },
    undoFriendRequest: {
        requests: [
            {
                method: "POST",
                service: "friend",
                path: "/api/friend/undo",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    fid: "4123456789012345678",
                },
                paramsOrder: ["fid"],
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: "wire=fake-w",
                    origin: "https://chat.zalo.me",
                    referer: "https://chat.zalo.me/",
                    "user-agent": "Mozilla/5.0 (offline test)",
                },
                form: {},
                formOrder: ["params"],
                parts: null,
                body: null,
            },
        ],
        error: null,
        result: "",
    },
};
