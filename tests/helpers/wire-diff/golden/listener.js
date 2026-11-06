/**
 * Golden wire records of the listener area: what our engine sends and returns for each case of
 * tests/unit/wire-listener.test.js. Written by `node tests/helpers/wire-diff/record.mjs listener`, then reviewed by
 * hand. Fake ids only.
 */
export default {
    controls: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "upload_attachment",
                    args: [
                        {
                            fileUrl: "https://f.invalid/f.bin",
                            fileId: "6000000001",
                        },
                    ],
                },
                {
                    name: "group_event",
                    args: [
                        {
                            type: "update",
                            act: "update",
                            data: {
                                groupId: "3000000000000000003",
                                groupName: "Fake group",
                                sourceId: "2000000000000000002",
                                updateMembers: [],
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "group_event",
                    args: [
                        {
                            type: "join",
                            act: "join",
                            data: {
                                groupId: "3000000000000000003",
                                sourceId: "2000000000000000002",
                                updateMembers: [
                                    {
                                        id: "1234567890123456789",
                                        dName: "Me",
                                    },
                                ],
                            },
                            threadId: "3000000000000000003",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "group_event",
                    args: [
                        {
                            type: "update_board",
                            act: "update_board",
                            data: {
                                groupId: "3000000000000000003",
                                sourceId: "1234567890123456789",
                                groupTopic: {
                                    type: 0,
                                },
                            },
                            threadId: "3000000000000000003",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "group_event",
                    args: [
                        {
                            type: "unknown",
                            act: "join_accept",
                            data: {
                                groupId: "3000000000000000003",
                                sourceId: "2000000000000000002",
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "friend_event",
                    args: [
                        {
                            type: 2,
                            data: {
                                fromUid: "2000000000000000002",
                                toUid: "1234567890123456789",
                                message: "hi",
                            },
                            threadId: "1234567890123456789",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "friend_event",
                    args: [
                        {
                            type: 0,
                            data: "2000000000000000004",
                            threadId: "2000000000000000004",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "friend_event",
                    args: [
                        {
                            type: 11,
                            data: {
                                actorId: "1234567890123456789",
                                conversationId: "2000000000000000002",
                                topic: {
                                    type: 2,
                                    params: {
                                        title: "pinned",
                                    },
                                },
                            },
                            threadId: "2000000000000000002",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "friend_event",
                    args: [
                        {
                            type: 12,
                            data: '{"x":1}',
                            threadId: "",
                            isSelf: false,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    e2ee: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000001",
                                msgId: "5000000000000000001",
                                cliMsgId: "1700000000001",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 1",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000002",
                                msgId: "5000000000000000002",
                                cliMsgId: "1700000000002",
                                msgType: "chat.e2ee.text",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                                undecryptable: true,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000003",
                                msgId: "5000000000000000003",
                                cliMsgId: "1700000000003",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 3",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000004",
                                msgId: "5000000000000000004",
                                cliMsgId: "1700000000004",
                                msgType: "chat.e2ee.text",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                                undecryptable: true,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000005",
                                msgId: "5000000000000000005",
                                cliMsgId: "1700000000005",
                                msgType: "chat.e2ee.text",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                                undecryptable: true,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    handshake: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "connected",
                    args: [],
                },
                {
                    name: "cipher_key",
                    args: ["CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk="],
                },
            ],
            sent: [
                {
                    version: 1,
                    cmd: 510,
                    sub: 1,
                    data: {
                        first: true,
                        reqId: "req_<n>",
                        lastId: null,
                        preIds: [],
                    },
                    head: "01fe0101",
                    body: '{"first":true,"reqId":"req_<n>","lastId":null,"preIds":[]}',
                },
            ],
            upgrade: {
                url: "/?zpw_ver=<ver>&zpw_type=30&t=%3Ct%3E",
                headers: {
                    pragma: "no-cache",
                    "cache-control": "no-cache",
                    "user-agent": "Mozilla/5.0 (offline test)",
                    origin: "https://chat.zalo.me",
                    "accept-encoding": "gzip, deflate, br, zstd",
                    "accept-language": "en-US,en;q=0.9",
                    cookie: "zpw_sek=offline-test-cookie",
                    "sec-websocket-version": "13",
                    connection: "Upgrade",
                    upgrade: "websocket",
                    "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
                },
                names: [
                    "Pragma",
                    "Cache-Control",
                    "User-Agent",
                    "Origin",
                    "Accept-Encoding",
                    "Accept-Language",
                    "Cookie",
                    "Sec-WebSocket-Version",
                    "Connection",
                    "Upgrade",
                    "Sec-WebSocket-Extensions",
                ],
            },
        },
    },
    "ids-and-errors": {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                msgId: "5",
                                cliMsgId: 6,
                                uidFrom: "1234567890123456789",
                                idTo: "2000000000000000002",
                                ts: "1",
                                msgType: "webchat",
                                content: "small ids",
                                quote: {
                                    ownerId: "2000000000000000004",
                                    globalMsgId: "5000000000000000001",
                                    cliMsgId: 7,
                                    msg: "q",
                                },
                            },
                            threadId: "2000000000000000002",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "error",
                    args: [
                        {
                            message: "cmd 501: the server answered error_code 102",
                            code: 102,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    messages: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000001",
                                msgId: "5000000000000000001",
                                cliMsgId: "1700000000001",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 1",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000002",
                                msgId: "5000000000000000002",
                                cliMsgId: "1700000000002",
                                msgType: "webchat",
                                uidFrom: "1234567890123456789",
                                idTo: "2000000000000000002",
                                dName: "Me",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 2",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000003",
                                msgId: "5000000000000000003",
                                cliMsgId: "1700000000003",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 3",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                                quote: {
                                    ownerId: "2000000000000000004",
                                    globalMsgId: "5000000000000000001",
                                    cliMsgId: "1",
                                    msg: "q",
                                },
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000004",
                                msgId: "5000000000000000004",
                                cliMsgId: "1700000000004",
                                msgType: "chat.photo",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: {
                                    title: "",
                                    href: "https://f.invalid/p.jpg",
                                    thumb: "https://f.invalid/t.jpg",
                                },
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000005",
                                msgId: "5000000000000000005",
                                cliMsgId: "1700000000005",
                                msgType: "chat.delete",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: {
                                    action: "delete",
                                },
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000006",
                                msgId: "5000000000000000006",
                                cliMsgId: "1700000000006",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "@Two hi",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                                mentions: [
                                    {
                                        uid: "2000000000000000004",
                                        pos: 0,
                                        len: 4,
                                        type: 0,
                                    },
                                ],
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000007",
                                msgId: "5000000000000000007",
                                cliMsgId: "1700000000007",
                                msgType: "webchat",
                                uidFrom: "1234567890123456789",
                                idTo: "3000000000000000003",
                                dName: "Me",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 7",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: true,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000008",
                                msgId: "5000000000000000008",
                                cliMsgId: "1700000000008",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 8",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000009",
                                msgId: "5000000000000000009",
                                cliMsgId: "1700000000009",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 9",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    "mixed-pushes": {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000001",
                                msgId: "5000000000000000001",
                                cliMsgId: "1700000000001",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 1",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000002",
                                msgId: "5000000000000000002",
                                cliMsgId: "1700000000002",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 2",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000003",
                                msgId: "5000000000000000003",
                                cliMsgId: "1700000000003",
                                msgType: "webchat",
                                uidFrom: "2000000000000000004",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 3",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000004",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000004",
                                msgId: "5000000000000000004",
                                cliMsgId: "1700000000004",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 4",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000005",
                                msgId: "5000000000000000005",
                                cliMsgId: "1700000000005",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 5",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000006",
                                msgId: "5000000000000000006",
                                cliMsgId: "1700000000006",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 6",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    "old-messages": {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "old_messages",
                    args: [
                        [
                            {
                                type: 0,
                                data: {
                                    actionId: "7000000000000000001",
                                    msgId: "5000000000000000001",
                                    cliMsgId: "1700000000001",
                                    msgType: "webchat",
                                    uidFrom: "2000000000000000002",
                                    idTo: "1234567890123456789",
                                    dName: "Fake Peer",
                                    ts: "1700000000000",
                                    status: 1,
                                    content: "hello 1",
                                    notify: "1",
                                    ttl: 0,
                                    cmd: 501,
                                    st: 3,
                                    at: 5,
                                },
                                threadId: "2000000000000000002",
                                isSelf: false,
                            },
                            {
                                type: 0,
                                data: {
                                    actionId: "7000000000000000002",
                                    msgId: "5000000000000000002",
                                    cliMsgId: "1700000000002",
                                    msgType: "webchat",
                                    uidFrom: "2000000000000000002",
                                    idTo: "1234567890123456789",
                                    dName: "Fake Peer",
                                    ts: "1700000000000",
                                    status: 1,
                                    content: {
                                        deleteMsg: 1,
                                    },
                                    notify: "1",
                                    ttl: 0,
                                    cmd: 501,
                                    st: 3,
                                    at: 5,
                                },
                                threadId: "2000000000000000002",
                                isSelf: false,
                            },
                        ],
                        0,
                    ],
                },
                {
                    name: "old_messages",
                    args: [
                        [
                            {
                                type: 1,
                                data: {
                                    actionId: "7000000000000000003",
                                    msgId: "5000000000000000003",
                                    cliMsgId: "1700000000003",
                                    msgType: "webchat",
                                    uidFrom: "2000000000000000002",
                                    idTo: "3000000000000000003",
                                    dName: "Fake Peer",
                                    ts: "1700000000000",
                                    status: 1,
                                    content: "hello 3",
                                    notify: "1",
                                    ttl: 0,
                                    cmd: 521,
                                    st: 3,
                                    at: 5,
                                },
                                threadId: "3000000000000000003",
                                isSelf: false,
                            },
                        ],
                        1,
                    ],
                },
            ],
            sent: [],
        },
    },
    reactions: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "reaction",
                    args: [
                        {
                            data: {
                                actionId: "9000000000000000001",
                                msgId: "9100000000000000001",
                                cliMsgId: "1710000000001",
                                msgType: "chat.reaction",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000500",
                                ttl: 0,
                                content: {
                                    rMsg: [
                                        {
                                            gMsgID: "5000000000000000001",
                                            cMsgID: "1700000000001",
                                            msgType: 1,
                                        },
                                    ],
                                    rIcon: "/-heart",
                                    rType: 5,
                                    source: 6,
                                },
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                            isGroup: false,
                        },
                    ],
                },
                {
                    name: "reaction",
                    args: [
                        {
                            data: {
                                actionId: "9000000000000000002",
                                msgId: "9100000000000000002",
                                cliMsgId: "1710000000002",
                                msgType: "chat.reaction",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000500",
                                ttl: 0,
                                content: {
                                    rMsg: [
                                        {
                                            gMsgID: "5000000000000000002",
                                            cMsgID: "1700000000002",
                                            msgType: 1,
                                        },
                                    ],
                                    rIcon: "",
                                    rType: -1,
                                    source: 6,
                                },
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                            isGroup: false,
                        },
                    ],
                },
                {
                    name: "error",
                    args: [
                        {
                            message: "cmd 612 reacts: one item not readable (SyntaxError)",
                            code: null,
                        },
                    ],
                },
                {
                    name: "reaction",
                    args: [
                        {
                            data: {
                                actionId: "9000000000000000004",
                                msgId: "9100000000000000004",
                                cliMsgId: "1710000000004",
                                msgType: "chat.reaction",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000500",
                                ttl: 0,
                                content: {
                                    rMsg: [
                                        {
                                            gMsgID: "5000000000000000004",
                                            cMsgID: "1700000000004",
                                            msgType: 1,
                                        },
                                    ],
                                    rIcon: "/-heart",
                                    rType: 5,
                                    source: 6,
                                },
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                            isGroup: true,
                        },
                    ],
                },
                {
                    name: "old_reactions",
                    args: [
                        [
                            {
                                data: {
                                    actionId: "9000000000000000005",
                                    msgId: "9100000000000000005",
                                    cliMsgId: "1710000000005",
                                    msgType: "chat.reaction",
                                    uidFrom: "2000000000000000002",
                                    idTo: "1234567890123456789",
                                    dName: "Fake Peer",
                                    ts: "1700000000500",
                                    ttl: 0,
                                    content:
                                        '{"rMsg":[{"gMsgID":"5000000000000000005","cMsgID":"1700000000005","msgType":1}],"rIcon":"/-heart","rType":5,"source":6}',
                                },
                                threadId: "2000000000000000002",
                                isSelf: false,
                                isGroup: false,
                            },
                        ],
                        false,
                    ],
                },
                {
                    name: "old_reactions",
                    args: [
                        [
                            {
                                data: {
                                    actionId: "9000000000000000006",
                                    msgId: "9100000000000000006",
                                    cliMsgId: "1710000000006",
                                    msgType: "chat.reaction",
                                    uidFrom: "2000000000000000002",
                                    idTo: "3000000000000000003",
                                    dName: "Fake Peer",
                                    ts: "1700000000500",
                                    ttl: 0,
                                    content:
                                        '{"rMsg":[{"gMsgID":"5000000000000000006","cMsgID":"1700000000006","msgType":1}],"rIcon":"/-heart","rType":5,"source":6}',
                                },
                                threadId: "3000000000000000003",
                                isSelf: false,
                                isGroup: true,
                            },
                        ],
                        true,
                    ],
                },
                {
                    name: "reaction",
                    args: [
                        {
                            data: {
                                actionId: "9000000000000000007",
                                msgId: "9100000000000000007",
                                cliMsgId: "1710000000007",
                                msgType: "chat.reaction",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000500",
                                ttl: 0,
                                content: {
                                    rMsg: [
                                        {
                                            gMsgID: "5000000000000000007",
                                            cMsgID: "1700000000007",
                                            msgType: 1,
                                        },
                                    ],
                                    rIcon: "/-heart",
                                    rType: 5,
                                    source: 6,
                                },
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                            isGroup: true,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    repush: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "message",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000001",
                                msgId: "5000000000000000001",
                                cliMsgId: "1700000000001",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 1",
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "message",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000002",
                                msgId: "5000000000000000002",
                                cliMsgId: "1700000000002",
                                msgType: "webchat",
                                uidFrom: "2000000000000000002",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: "hello 2",
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
    "typing-receipts": {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "typing",
                    args: [
                        {
                            type: 0,
                            data: {
                                uid: "2000000000000000002",
                                ts: "1700000000000",
                                isPC: 0,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "typing",
                    args: [
                        {
                            type: 1,
                            data: {
                                uid: "2000000000000000002",
                                gid: "3000000000000000003",
                                ts: "1700000000001",
                                isPC: 1,
                            },
                            threadId: "3000000000000000003",
                            isSelf: false,
                        },
                    ],
                },
                {
                    name: "delivered_messages",
                    args: [
                        [
                            {
                                type: 0,
                                data: {
                                    msgId: "5000000000000000001",
                                    seen: 0,
                                    deliveredUids: ["2000000000000000002"],
                                    seenUids: [],
                                    mSTs: "1",
                                },
                                threadId: "2000000000000000002",
                                isSelf: false,
                            },
                        ],
                    ],
                },
                {
                    name: "seen_messages",
                    args: [
                        [
                            {
                                type: 0,
                                data: {
                                    idTo: "2000000000000000002",
                                    msgId: "5000000000000000001",
                                    realMsgId: "0",
                                },
                                threadId: "2000000000000000002",
                                isSelf: false,
                            },
                        ],
                    ],
                },
                {
                    name: "delivered_messages",
                    args: [
                        [
                            {
                                type: 1,
                                data: {
                                    msgId: "5000000000000000002",
                                    groupId: "3000000000000000003",
                                    seen: 0,
                                    deliveredUids: ["2000000000000000002"],
                                    seenUids: [],
                                },
                                threadId: "3000000000000000003",
                                isSelf: false,
                            },
                        ],
                    ],
                },
                {
                    name: "seen_messages",
                    args: [
                        [
                            {
                                type: 1,
                                data: {
                                    msgId: "5000000000000000002",
                                    groupId: "3000000000000000003",
                                    seenUids: ["2000000000000000002", "1234567890123456789"],
                                },
                                threadId: "3000000000000000003",
                                isSelf: true,
                            },
                        ],
                    ],
                },
            ],
            sent: [],
        },
    },
    undo: {
        requests: [],
        error: null,
        result: {
            events: [
                {
                    name: "undo",
                    args: [
                        {
                            type: 0,
                            data: {
                                actionId: "7000000000000000001",
                                msgId: "5000000000000000001",
                                cliMsgId: "1700000000001",
                                msgType: "chat.undo",
                                uidFrom: "2000000000000000002",
                                idTo: "1234567890123456789",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: {
                                    globalMsgId: "5000000000000000009",
                                    cliMsgId: "1",
                                    deleteMsg: 1,
                                },
                                notify: "1",
                                ttl: 0,
                                cmd: 501,
                                st: 3,
                                at: 5,
                            },
                            threadId: "2000000000000000002",
                            isSelf: false,
                            isGroup: false,
                        },
                    ],
                },
                {
                    name: "undo",
                    args: [
                        {
                            type: 1,
                            data: {
                                actionId: "7000000000000000002",
                                msgId: "5000000000000000002",
                                cliMsgId: "1700000000002",
                                msgType: "chat.undo",
                                uidFrom: "1234567890123456789",
                                idTo: "3000000000000000003",
                                dName: "Fake Peer",
                                ts: "1700000000000",
                                status: 1,
                                content: {
                                    globalMsgId: "5000000000000000008",
                                    cliMsgId: "2",
                                    deleteMsg: 1,
                                },
                                notify: "1",
                                ttl: 0,
                                cmd: 521,
                                st: 3,
                                at: 5,
                            },
                            threadId: "3000000000000000003",
                            isSelf: true,
                            isGroup: true,
                        },
                    ],
                },
            ],
            sent: [],
        },
    },
};
