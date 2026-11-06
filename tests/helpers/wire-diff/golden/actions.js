/**
 * Golden wire records of the actions area: what our engine sends and returns for each case of
 * tests/unit/wire-actions.test.js. Written by `node tests/helpers/wire-diff/record.mjs actions`, then reviewed by
 * hand. Fake ids only.
 */
export default {
    archived: {
        requests: [
            {
                method: "GET",
                service: "label",
                path: "/api/archivedchat/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    version: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["version", "imei"],
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
            version: 7,
            items: [
                {
                    id: "2000000000000000003",
                    type: 1,
                },
            ],
        },
    },
    "archived-string-version": {
        requests: [
            {
                method: "GET",
                service: "label",
                path: "/api/archivedchat/list",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    version: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["version", "imei"],
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
            version: "7",
            items: [
                {
                    id: "2000000000000000003",
                    type: 1,
                },
            ],
        },
    },
    "delete-chat-dm": {
        requests: [
            {
                method: "POST",
                service: "chat",
                path: "/api/message/deleteconver",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    toid: "1000000000000000002",
                    cliMsgId: "1700000000000",
                    conver: {
                        ownerId: "1000000000000000002",
                        cliMsgId: "1700000000123",
                        globalMsgId: "7000000000000000001",
                    },
                    onlyMe: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["toid", "cliMsgId", "conver", "onlyMe", "imei"],
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
        result: {},
    },
    "delete-chat-group": {
        requests: [
            {
                method: "POST",
                service: "group",
                path: "/api/group/deleteconver",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    grid: "2000000000000000003",
                    cliMsgId: "1700000000000",
                    conver: {
                        ownerId: "1000000000000000002",
                        cliMsgId: "1700000000123",
                        globalMsgId: "7000000000000000001",
                    },
                    onlyMe: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["grid", "cliMsgId", "conver", "onlyMe", "imei"],
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
        result: {},
    },
    "delete-dm-own": {
        requests: [
            {
                method: "POST",
                service: "chat",
                path: "/api/message/delete",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    toid: "1000000000000000002",
                    cliMsgId: 1700000000000,
                    msgs: [
                        {
                            cliMsgId: "1700000000123",
                            globalMsgId: "7000000000000000001",
                            ownerId: "1234567890123456789",
                            destId: "1000000000000000002",
                        },
                    ],
                    onlyMe: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["toid", "cliMsgId", "msgs", "onlyMe", "imei"],
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
        result: {},
    },
    "delete-dm-received": {
        requests: [
            {
                method: "POST",
                service: "chat",
                path: "/api/message/delete",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    toid: "1000000000000000002",
                    cliMsgId: 1700000000000,
                    msgs: [
                        {
                            cliMsgId: "1700000000123",
                            globalMsgId: "7000000000000000001",
                            ownerId: "1000000000000000002",
                            destId: "1234567890123456789",
                        },
                    ],
                    onlyMe: 1,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["toid", "cliMsgId", "msgs", "onlyMe", "imei"],
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
        result: {},
    },
    "delete-group-everyone": {
        requests: [
            {
                method: "POST",
                service: "group",
                path: "/api/group/deletemsg",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    grid: "2000000000000000003",
                    cliMsgId: 1700000000000,
                    msgs: [
                        {
                            cliMsgId: "1700000000123",
                            globalMsgId: "7000000000000000001",
                            ownerId: "1000000000000000002",
                            destId: "2000000000000000003",
                        },
                    ],
                    onlyMe: 0,
                },
                paramsOrder: ["grid", "cliMsgId", "msgs", "onlyMe"],
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
        result: {},
    },
    "delete-group-me": {
        requests: [
            {
                method: "POST",
                service: "group",
                path: "/api/group/deletemsg",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    grid: "2000000000000000003",
                    cliMsgId: 1700000000000,
                    msgs: [
                        {
                            cliMsgId: "1700000000123",
                            globalMsgId: "7000000000000000001",
                            ownerId: "1000000000000000002",
                            destId: "2000000000000000003",
                        },
                    ],
                    onlyMe: 1,
                },
                paramsOrder: ["grid", "cliMsgId", "msgs", "onlyMe"],
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
        result: {},
    },
    "delete-refuse-dm": {
        requests: [],
        error: {
            message: "Can't delete message for everyone in a private chat",
            code: null,
        },
    },
    "delete-refuse-own": {
        requests: [],
        error: {
            message: "To delete your message for everyone, use undo api instead",
            code: null,
        },
    },
    "labels-230": {
        requests: [
            {
                method: "POST",
                service: "label",
                path: "/api/convlabel/update",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    labelData:
                        '[{"id":1,"text":"Work","textKey":"","color":"#0068FF","emoji":"","offset":0,"conversations":["g2000000000000000003"],"createTime":5}]',
                    version: 2,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["labelData", "version", "imei"],
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
            message: "The label list changed since it was read (version conflict): read it again and retry",
            code: 230,
        },
    },
    "labels-get": {
        requests: [
            {
                method: "GET",
                service: "label",
                path: "/api/convlabel/get",
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
            labelData: [
                {
                    id: 1,
                    text: "Work",
                    textKey: "",
                    color: "#0068FF",
                    emoji: "",
                    offset: 0,
                    conversations: ["g2000000000000000003"],
                    createTime: 5,
                },
            ],
            version: 3,
            lastUpdateTime: 9,
        },
    },
    "labels-legacy": {
        requests: [
            {
                method: "POST",
                service: "label",
                path: "/api/convlabel/update",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    labelData:
                        '[{"id":1,"text":"Work","textKey":"","color":"#0068FF","emoji":"","offset":0,"conversations":["g2000000000000000003","1000000000000000002"],"createTime":5}]',
                    version: 3,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["labelData", "version", "imei"],
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
            labelData: [
                {
                    id: 1,
                    text: "Work",
                    textKey: "",
                    color: "#0068FF",
                    emoji: "",
                    offset: 0,
                    conversations: ["g2000000000000000003", "1000000000000000002"],
                    createTime: 5,
                },
            ],
            version: 4,
            lastUpdateTime: 10,
        },
    },
    "labels-v2": {
        requests: [
            {
                method: "GET",
                service: "label",
                path: "/api/convlabel/get",
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
            {
                method: "POST",
                service: "label",
                path: "/api/convlabel/manage/update",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    labelInfo: '{"id":1,"text":"Work","color":"#0068FF","offset":0}',
                    add: ["1000000000000000002"],
                    remove: [],
                },
                paramsOrder: ["labelInfo", "add", "remove"],
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
            labelData: [
                {
                    id: 1,
                    text: "Work",
                    color: "#0068FF",
                    offset: 0,
                    conversations: ["g2000000000000000003", "1000000000000000002"],
                    createTime: 5,
                },
                {
                    id: 2,
                    text: "Old",
                    color: "#D91B1B",
                    offset: 1,
                    conversations: [],
                    createTime: 6,
                },
            ],
            version: 6,
            lastUpdateTime: 11,
        },
    },
    "labels-v2-conflict": {
        requests: [
            {
                method: "GET",
                service: "label",
                path: "/api/convlabel/get",
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
        error: {
            message: "The label list changed since it was read (version conflict): read it again and retry",
            code: 230,
        },
    },
    pins: {
        requests: [
            {
                method: "GET",
                service: "conversation",
                path: "/api/pinconvers/list",
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
            conversations: ["g2000000000000000003", "u1000000000000000002"],
            version: 4,
        },
    },
    "pins-212": {
        requests: [
            {
                method: "GET",
                service: "conversation",
                path: "/api/pinconvers/list",
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
            conversations: [],
            version: 0,
        },
    },
    "react-clear": {
        requests: [
            {
                method: "POST",
                service: "reaction",
                path: "/api/message/reaction",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    react_list: [
                        {
                            message:
                                '{"rMsg":[{"gMsgID":"7000000000000000001","cMsgID":1700000000123,"msgType":1}],"rIcon":"","rType":-1,"source":6}',
                            clientId: 1700000000000,
                        },
                    ],
                    toid: "1000000000000000002",
                },
                paramsOrder: ["react_list", "toid"],
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
            msgIds: [],
        },
    },
    "react-dm": {
        requests: [
            {
                method: "POST",
                service: "reaction",
                path: "/api/message/reaction",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    react_list: [
                        {
                            message:
                                '{"rMsg":[{"gMsgID":"7000000000000000001","cMsgID":1700000000123,"msgType":1}],"rIcon":"/-heart","rType":5,"source":6}',
                            clientId: 1700000000000,
                        },
                    ],
                    toid: "1000000000000000002",
                },
                paramsOrder: ["react_list", "toid"],
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
            msgIds: ["7000000000000000001"],
        },
    },
    "react-group": {
        requests: [
            {
                method: "POST",
                service: "reaction",
                path: "/api/group/reaction",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    react_list: [
                        {
                            message:
                                '{"rMsg":[{"gMsgID":"7000000000000000001","cMsgID":1700000000123,"msgType":1}],"rIcon":":>","rType":0,"source":6}',
                            clientId: 1700000000000,
                        },
                    ],
                    grid: "2000000000000000003",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["react_list", "grid", "imei"],
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
            msgIds: ["7000000000000000001"],
        },
    },
    "react-invalid-type": {
        requests: [],
        error: {
            message: "Thread type is invalid",
            code: null,
        },
    },
    "react-unknown-icon": {
        requests: [
            {
                method: "POST",
                service: "reaction",
                path: "/api/message/reaction",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    react_list: [
                        {
                            message:
                                '{"rMsg":[{"gMsgID":"7000000000000000001","cMsgID":1700000000123,"msgType":1}],"rIcon":"/-nosuch","rType":-1,"source":6}',
                            clientId: 1700000000000,
                        },
                    ],
                    toid: "1000000000000000002",
                },
                paramsOrder: ["react_list", "toid"],
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
            msgIds: [],
        },
    },
    "undo-211": {
        requests: [
            {
                method: "POST",
                service: "chat",
                path: "/api/message/undo",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    msgId: "7000000000000000001",
                    toid: "1000000000000000002",
                    clientId: 1700000000000,
                    cliMsgIdUndo: "1700000000123",
                },
                paramsOrder: ["msgId", "toid", "clientId", "cliMsgIdUndo"],
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
            message: "The recall window for this message has passed",
            code: 211,
        },
    },
    "undo-dm": {
        requests: [
            {
                method: "POST",
                service: "chat",
                path: "/api/message/undo",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    msgId: "7000000000000000001",
                    toid: "1000000000000000002",
                    clientId: 1700000000000,
                    cliMsgIdUndo: "1700000000123",
                },
                paramsOrder: ["msgId", "toid", "clientId", "cliMsgIdUndo"],
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
            status: 0,
        },
    },
    "undo-group": {
        requests: [
            {
                method: "POST",
                service: "group",
                path: "/api/group/undomsg",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    msgId: "7000000000000000001",
                    grid: "2000000000000000003",
                    clientId: 1700000000000,
                    visibility: 0,
                    cliMsgIdUndo: "1700000000123",
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["msgId", "grid", "clientId", "visibility", "cliMsgIdUndo", "imei"],
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
            status: 0,
        },
    },
    "unread-get": {
        requests: [
            {
                method: "GET",
                service: "conversation",
                path: "/api/conv/getUnreadMark",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {},
                paramsOrder: [],
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
            data: {
                convsGroup: [
                    {
                        id: "4123456789012345678",
                        cliMsgId: "1700000000123",
                        fromUid: "4123456789012345679",
                        ts: 5,
                    },
                ],
                convsUser: [],
            },
            status: 0,
        },
    },
    "unread-get-object": {
        requests: [
            {
                method: "GET",
                service: "conversation",
                path: "/api/conv/getUnreadMark",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {},
                paramsOrder: [],
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
            data: {
                convsGroup: [],
                convsUser: [],
            },
            status: 0,
        },
    },
    "unread-remove-dm": {
        requests: [
            {
                method: "POST",
                service: "conversation",
                path: "/api/conv/removeUnreadMark",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    param: '{"convsGroup":[],"convsUser":["1000000000000000002"],"convsGroupData":[],"convsUserData":[{"id":"1000000000000000002","ts":1700000000000}]}',
                },
                paramsOrder: ["param"],
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
            data: {
                status: 1,
            },
            status: 0,
        },
    },
    "unread-remove-group": {
        requests: [
            {
                method: "POST",
                service: "conversation",
                path: "/api/conv/removeUnreadMark",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    param: '{"convsGroup":["2000000000000000003"],"convsUser":[],"convsGroupData":[{"id":"2000000000000000003","ts":1700000000000}],"convsUserData":[]}',
                },
                paramsOrder: ["param"],
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
            data: {
                status: 1,
            },
            status: 0,
        },
    },
};
