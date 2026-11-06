/**
 * The cookie jar (src/zalo/kernel/cookies.js) against zca-js's `parseCookies` and its request helper's cookie
 * handling: a saved login in any of the three shapes on disk must load to the same cookies, and the `Cookie` header
 * must be what zca-js sent except where the browser rule differs (D5: the full URL's path counts; D6: a host-only
 * `Set-Cookie` is kept for its host). Every value is fake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Zalo } from "zca-js";
import { cookieHeader, loadJar, saveJar, setCookiesOf, storeSetCookies } from "../../src/zalo/kernel/cookies.js";

const SERIALIZED = {
    version: "tough-cookie@5.1.2",
    storeType: "MemoryCookieStore",
    rejectPublicSuffixes: true,
    cookies: [
        {
            key: "zpw_sek",
            value: "fake-sek",
            domain: "chat.zalo.me",
            path: "/",
            secure: true,
            httpOnly: true,
            hostOnly: false,
            creation: "2026-11-01T00:00:00.000Z",
            lastAccessed: "2026-11-01T00:00:00.000Z",
        },
        {
            key: "zpsid",
            value: "fake-zpsid",
            domain: "zalo.me",
            path: "/",
            expires: "2099-01-01T00:00:00.000Z",
            hostOnly: false,
            creation: "2026-11-01T00:00:00.000Z",
        },
        { key: "only_api", value: "fake-api", domain: "chat.zalo.me", path: "/api", hostOnly: false },
    ],
};

const BARE_ARRAY = SERIALIZED.cookies.map((c) => ({ ...c }));

const BROWSER_EXPORT = [
    { name: "zpw_sek", value: "fake-sek", domain: ".chat.zalo.me", path: "/", secure: true, httpOnly: true },
    { name: "zpsid", value: "fake-zpsid", domain: ".zalo.me", path: "/" },
    { name: "only_api", value: "fake-api", domain: ".chat.zalo.me", path: "/api" },
];

const URLS = [
    "https://chat.zalo.me/",
    "https://tt-chat1-wpa.chat.zalo.me/api/x",
    "https://id.zalo.me/account",
    "https://jr.zaloapp.com/jr/syncsession",
];

/** What zca-js put in the Cookie header: the jar's answer for the URL's origin (its request helper). */
const zcaHeader = (jar, url) => jar.getCookieStringSync(new URL(url).origin);

describe("loading a saved jar", () => {
    for (const [shape, saved] of Object.entries({
        serialized: SERIALIZED,
        "bare array": BARE_ARRAY,
        "browser export": BROWSER_EXPORT,
    })) {
        it(`loads the ${shape} shape to the cookies zca-js loads, without touching the input`, () => {
            const before = structuredClone(saved);
            const ours = loadJar(saved);
            assert.deepEqual(saved, before, "the saved credentials are not modified (zca-js strips the dots)");
            const theirs = new Zalo().parseCookies(structuredClone(saved));
            for (const url of URLS) {
                const path = new URL(url).pathname;
                if (path.startsWith("/api")) {
                    // D5: a browser sends a /api cookie to /api/x; zca-js asked for the origin and never did.
                    assert.match(cookieHeader(ours, url), /only_api=fake-api/, url);
                    assert.doesNotMatch(zcaHeader(theirs, url), /only_api/, url);
                    const strip = (s) =>
                        s
                            .split("; ")
                            .filter((c) => !c.startsWith("only_api="))
                            .sort()
                            .join("; ");
                    assert.equal(strip(cookieHeader(ours, url)), strip(zcaHeader(theirs, url)), url);
                } else {
                    const sorted = (s) => s.split("; ").filter(Boolean).sort().join("; ");
                    assert.equal(sorted(cookieHeader(ours, url)), sorted(zcaHeader(theirs, url)), url);
                }
            }
            assert.match(cookieHeader(ours, "https://chat.zalo.me/"), /zpw_sek=fake-sek/);
            assert.match(cookieHeader(ours, "https://id.zalo.me/"), /zpsid=fake-zpsid/);
            assert.doesNotMatch(cookieHeader(ours, "https://id.zalo.me/"), /zpw_sek/, "chat.zalo.me's stays there");
            assert.equal(cookieHeader(ours, "https://jr.zaloapp.com/"), "", "another site gets nothing");
        });
    }

    it("saves in tough-cookie's serialized form, which loads back to the same jar", () => {
        const saved = saveJar(loadJar(SERIALIZED));
        assert.ok(Array.isArray(saved.cookies));
        assert.deepEqual(saved.cookies.map((c) => c.key).sort(), ["only_api", "zpsid", "zpw_sek"]);
        const zpsid = saved.cookies.find((c) => c.key === "zpsid");
        assert.equal(zpsid.domain, "zalo.me");
        assert.equal(zpsid.expires, "2099-01-01T00:00:00.000Z");
        const again = loadJar(JSON.parse(JSON.stringify(saved)));
        for (const url of URLS) assert.equal(cookieHeader(again, url), cookieHeader(loadJar(SERIALIZED), url));
    });

    it("skips an entry it cannot read, and loads nothing from nothing", () => {
        const jar = loadJar([null, 7, { value: "no-name" }, BROWSER_EXPORT[0]]);
        assert.equal(cookieHeader(jar, "https://chat.zalo.me/"), "zpw_sek=fake-sek");
        assert.equal(cookieHeader(loadJar(undefined), "https://chat.zalo.me/"), "");
        assert.equal(cookieHeader(loadJar({}), "https://chat.zalo.me/"), "");
    });
});

describe("Set-Cookie", () => {
    const REQUEST = "https://wpa.chat.zalo.me/api/login/getServerInfo";
    const answer = (...cookies) => {
        const headers = new Headers();
        for (const c of cookies) headers.append("set-cookie", c);
        return new Response("{}", { status: 200, headers });
    };

    it("stores Domain=.zalo.me, Domain=chat.zalo.me and host-only cookies the way a browser does", () => {
        const jar = loadJar([]);
        const stored = storeSetCookies(
            jar,
            REQUEST,
            answer(
                "wide=fake-1; Domain=.zalo.me; Path=/; Secure",
                "chat=fake-2; Domain=chat.zalo.me; Path=/; Secure",
                "hostonly=fake-3; Path=/; Secure",
            ),
        );
        assert.equal(stored, 3);
        assert.match(cookieHeader(jar, "https://id.zalo.me/"), /wide=fake-1/);
        assert.doesNotMatch(cookieHeader(jar, "https://id.zalo.me/"), /chat=|hostonly=/);
        assert.match(cookieHeader(jar, "https://tt-chat1-wpa.chat.zalo.me/api/x"), /chat=fake-2/);
        // D6: zca-js filed a cookie without Domain under host "null" and never sent it again.
        assert.match(cookieHeader(jar, "https://wpa.chat.zalo.me/api/x"), /hostonly=fake-3/);
        assert.doesNotMatch(cookieHeader(jar, "https://chat.zalo.me/"), /hostonly/, "host-only means that host only");
    });

    it("refuses a cookie for another site, as a browser does", () => {
        const jar = loadJar([]);
        assert.equal(storeSetCookies(jar, REQUEST, answer("evil=fake; Domain=example.com; Path=/")), 0);
        assert.equal(cookieHeader(jar, "https://example.com/"), "");
    });

    it("splits a joined Set-Cookie header between cookies, never inside an Expires date", () => {
        const joined = "a=fake-a; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/, b=fake-b; Path=/; Secure";
        const fake = { headers: { get: (n) => (n === "set-cookie" ? joined : null) } };
        assert.deepEqual(setCookiesOf(fake), [
            "a=fake-a; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/",
            "b=fake-b; Path=/; Secure",
        ]);
        const jar = loadJar([]);
        assert.equal(storeSetCookies(jar, REQUEST, fake), 2);
        const a = saveJar(jar).cookies.find((c) => c.key === "a");
        assert.equal(a.expires, "2099-01-01T00:00:00.000Z", "the comma in the date did not cut the cookie");
    });

    it("reads nothing from a response without headers", () => {
        assert.deepEqual(setCookiesOf({}), []);
        assert.deepEqual(setCookiesOf({ headers: { get: () => null } }), []);
    });
});
