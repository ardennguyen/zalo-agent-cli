/**
 * Golden wire records of the kernel area: what our engine sends and returns for each case of
 * tests/unit/wire-kernel.test.js. Written by `node tests/helpers/wire-diff/record.mjs kernel`, then reviewed by
 * hand. Fake ids only.
 */
export default {
    fetchAccountInfo: {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/profile/me-v2",
                queryOrder: ["zpw_ver", "zpw_type", "params", "os", "browser"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                    os: "0",
                    browser: "0",
                },
                params: {
                    avatar_size: 160,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["avatar_size", "imei"],
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
            profile: {
                userId: "1000000000000000001",
            },
        },
    },
    "fetchAccountInfo/inner-error": {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/profile/me-v2",
                queryOrder: ["zpw_ver", "zpw_type", "params", "os", "browser"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                    os: "0",
                    browser: "0",
                },
                params: {
                    avatar_size: 160,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["avatar_size", "imei"],
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
            message: "fake inner",
            code: 114,
        },
    },
    "fetchAccountInfo/undecryptable": {
        requests: [
            {
                method: "GET",
                service: "profile",
                path: "/api/social/profile/me-v2",
                queryOrder: ["zpw_ver", "zpw_type", "params", "os", "browser"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                    os: "0",
                    browser: "0",
                },
                params: {
                    avatar_size: 160,
                    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
                },
                paramsOrder: ["avatar_size", "imei"],
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
            message: "Failed to parse response data",
            code: null,
        },
    },
    keepAlive: {
        requests: [
            {
                method: "GET",
                service: "chat",
                path: "/keepalive",
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
            config_vesion: 7,
        },
    },
    "keepAlive/http-500": {
        requests: [
            {
                method: "GET",
                service: "chat",
                path: "/keepalive",
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
            message: "HTTP 500",
            code: null,
        },
    },
    "keepAlive/outer-error": {
        requests: [
            {
                method: "GET",
                service: "chat",
                path: "/keepalive",
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
            message: "session timeout",
            code: 102,
        },
    },
    makeURL: {
        requests: [],
        error: null,
        result: {
            order: "zpw_ver,zpw_type,params,grid",
            query: {
                zpw_ver: "695",
                zpw_type: "30",
                params: "a+b/c=",
                grid: "fake",
            },
        },
    },
    "request/get": {
        requests: [
            {
                method: "GET",
                service: "group",
                path: "/api/group/fake",
                queryOrder: ["zpw_ver", "zpw_type", "params"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    grid: "fake-grid",
                },
                paramsOrder: ["grid"],
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
            echo: {
                grid: "fake-grid",
            },
        },
    },
    "request/post": {
        requests: [
            {
                method: "POST",
                service: "group",
                path: "/api/group/fake",
                queryOrder: ["zpw_ver", "zpw_type"],
                query: {
                    zpw_ver: "695",
                    zpw_type: "30",
                },
                params: {
                    a: 1,
                },
                paramsOrder: ["a"],
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
            echo: {
                a: 1,
            },
        },
    },
    "resolve/not-json": {
        requests: [],
        error: {
            message: "Failed to parse response data",
            code: null,
        },
    },
    "resolve/undecryptable": {
        requests: [],
        error: {
            message: "Failed to parse response data",
            code: null,
        },
    },
};
