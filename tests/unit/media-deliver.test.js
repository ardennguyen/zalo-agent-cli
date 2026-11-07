/**
 * Media delivery core (src/core/media-deliver.js) and its policy (src/core/deploy-policy.js): how the mode is chosen
 * (per call > env per account > env > account block > media.deliver > default, capped by allowDeliver), what cannot
 * work and moves (inline over the size cutoff, a tempfile for a client on another machine, open over HTTP), the
 * tempfile manager (private folder, TTL sweep), and the link store (TTL, the capability client window, revocation).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { scopeOfDir } from "../../src/core/keystore/keyring.js";
import { writeSealedMedia } from "../../src/core/keystore/media-seal.js";
import { rekeyAccount } from "../../src/core/keystore/index.js";
import {
    DEFAULT_MEDIA_DELIVER,
    MEDIA_DEFAULTS,
    durationMs,
    resolveMediaDelivery,
    resolveMediaLinkAuth,
    resolveTrustedProxies,
} from "../../src/core/deploy-policy.js";
import {
    MEDIA_PATH_PREFIX,
    MediaLinks,
    chooseDelivery,
    decryptToTempfile,
    getMediaLinks,
    inlineContent,
    maskMediaPath,
    mediaMime,
    mediaTempRoot,
    safeMediaName,
    setMediaLinks,
    sweepMediaTemp,
} from "../../src/core/media-deliver.js";
import { getDefaultConfig, mergeMCPConfigLayer, resolveAccountMCPConfig } from "../../src/mcp/mcp-config.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const ID = "100000000000000611";

describe("resolveMediaDelivery: precedence per kind", () => {
    it("defaults: pictures and voice inline, video and files as a link, 5 MB, 10 minutes", () => {
        const p = resolveMediaDelivery({ config: getDefaultConfig(), env: {} });
        assert.deepEqual(p.deliver, DEFAULT_MEDIA_DELIVER);
        assert.equal(p.inlineMaxBytes, 5_242_880);
        assert.equal(p.linkTtlMs, 600_000);
        assert.equal(p.tempfileTtlMs, 600_000);
        assert.equal(p.linkRateLimit, 60);
        assert.deepEqual(p.allowDeliver, ["inline", "link", "tempfile"]);
        assert.equal(p.autoOpen, null, "unset: the transport decides");
    });

    it("env per account > env > account block > media.deliver > default, kind by kind", () => {
        const config = {
            media: { deliver: { photo: "link", video: "tempfile", file: "tempfile" } },
            accounts: { [ID]: { media: { deliver: { video: "inline" } } } },
        };
        const env = {
            ZALO_MCP_MEDIA_DELIVER: "file=link,voice=link",
            [`ZALO_MCP_MEDIA_DELIVER_${ID}`]: "voice=tempfile",
        };
        const p = resolveMediaDelivery({ config, env, accountId: ID });
        assert.equal(p.deliver.photo, "link");
        assert.equal(p.deliverSource.photo, "media.deliver");
        assert.equal(p.deliver.video, "inline");
        assert.equal(p.deliverSource.video, `accounts.${ID}.media.deliver`);
        assert.equal(p.deliver.file, "link");
        assert.equal(p.deliverSource.file, "ZALO_MCP_MEDIA_DELIVER");
        assert.equal(p.deliver.voice, "tempfile");
        assert.equal(p.deliverSource.voice, `ZALO_MCP_MEDIA_DELIVER_${ID}`);
        assert.equal(p.deliver.gif, "inline", "a kind no layer names keeps its default");
        // Another account sees only the shared layers.
        const other = resolveMediaDelivery({ config, env, accountId: "100000000000000612" });
        assert.equal(other.deliver.video, "tempfile");
        assert.equal(other.deliver.voice, "link");
    });

    it("one bare mode in the env covers every kind; a bad value is skipped", () => {
        const all = resolveMediaDelivery({ config: {}, env: { ZALO_MCP_MEDIA_DELIVER: "link" } });
        assert.ok(Object.values(all.deliver).every((m) => m === "link"));
        const bad = resolveMediaDelivery({ config: {}, env: { ZALO_MCP_MEDIA_DELIVER: "photo=fax,teleport" } });
        assert.deepEqual(bad.deliver, DEFAULT_MEDIA_DELIVER);
    });

    it("allowDeliver keeps known modes only, and the limits fall back when unusable", () => {
        const p = resolveMediaDelivery({
            config: {
                media: { allowDeliver: ["link", "fax"], inlineMaxBytes: -1, linkTtl: "2m", tempfileTtl: "nope" },
            },
            env: {},
        });
        assert.deepEqual(p.allowDeliver, ["link"]);
        assert.equal(p.inlineMaxBytes, MEDIA_DEFAULTS.inlineMaxBytes);
        assert.equal(p.linkTtlMs, 120_000);
        assert.equal(p.tempfileTtlMs, MEDIA_DEFAULTS.tempfileTtlMs);
    });

    it("durationMs reads the config's units", () => {
        assert.equal(durationMs("15m"), 900_000);
        assert.equal(durationMs("30s"), 30_000);
        assert.equal(durationMs(500), 500);
        assert.equal(durationMs("soon"), null);
    });
});

describe("resolveMediaLinkAuth", () => {
    it("auto is bearer for a public host and capability on this machine or with no publicUrl", () => {
        assert.equal(resolveMediaLinkAuth({ env: {}, publicUrl: "https://zalo.example.com" }).linkAuth, "bearer");
        assert.equal(resolveMediaLinkAuth({ env: {}, publicUrl: "http://127.0.0.1:3847" }).linkAuth, "capability");
        assert.equal(resolveMediaLinkAuth({ env: {}, publicUrl: null }).linkAuth, "capability");
    });

    it("an explicit setting wins over auto, env over config, and the account's capability limits over the shared", () => {
        const config = {
            media: { linkAuth: "capability", capability: { maxClients: 5, ttl: "20m" } },
            accounts: { [ID]: { media: { capability: { maxClients: 50 } } } },
        };
        const shared = resolveMediaLinkAuth({ config, env: {}, publicUrl: "https://zalo.example.com" });
        assert.deepEqual(
            [shared.linkAuth, shared.source, shared.maxClients, shared.clientTtlMs],
            ["capability", "media.linkAuth", 5, 1_200_000],
        );
        const own = resolveMediaLinkAuth({
            config,
            env: { [`ZALO_MCP_MEDIA_LINK_AUTH_${ID}`]: "bearer" },
            accountId: ID,
        });
        assert.deepEqual([own.linkAuth, own.maxClients, own.clientTtlMs], ["bearer", 50, 1_200_000]);
    });

    it("defaults to 3 client addresses for 15 minutes", () => {
        const p = resolveMediaLinkAuth({ env: {} });
        assert.deepEqual([p.maxClients, p.clientTtlMs], [3, 900_000]);
    });

    it("trusts no proxy unless told", () => {
        assert.deepEqual(resolveTrustedProxies({ env: {} }), []);
        assert.deepEqual(resolveTrustedProxies({ config: { trustedProxies: ["127.0.0.1"] }, env: {} }), ["127.0.0.1"]);
        assert.deepEqual(resolveTrustedProxies({ env: { ZALO_MCP_TRUSTED_PROXIES: "10.0.0.2, loopback" } }), [
            "10.0.0.2",
            "loopback",
        ]);
    });
});

describe("mcp-config: the media block merges per kind and per limit", () => {
    it("an account block overrides one kind and one limit, keeping the shared rest", () => {
        const base = mergeMCPConfigLayer(getDefaultConfig(), {
            media: { deliver: { photo: "link", video: "link" }, capability: { maxClients: 3, ttl: "15m" } },
            accounts: { [ID]: { media: { deliver: { video: "inline" }, capability: { maxClients: 9 } } } },
        });
        const { config } = resolveAccountMCPConfig(base, { accountId: ID });
        assert.deepEqual(config.media.deliver, { photo: "link", video: "inline" });
        assert.deepEqual(config.media.capability, { maxClients: 9, ttl: "15m" });
    });
});

describe("chooseDelivery", () => {
    const policy = (over = {}) => ({ ...resolveMediaDelivery({ config: {}, env: {} }), ...over });

    it("follows the policy per kind", () => {
        const pick = (kind, size = 1000, mime = null) =>
            chooseDelivery({ kind, size, mime, policy: policy(), stdio: false, clientLoopback: false }).mode;
        assert.equal(pick("photo", 1000, "image/jpeg"), "inline");
        assert.equal(pick("voice", 1000, "audio/aac"), "inline");
        assert.equal(pick("video"), "link");
        assert.equal(pick("file"), "link");
    });

    it("sends a picture over the size cutoff, or of a type a client cannot render, as a link", () => {
        const big = chooseDelivery({
            kind: "photo",
            size: 5_242_881,
            mime: "image/jpeg",
            policy: policy(),
            stdio: false,
        });
        assert.equal(big.mode, "link");
        assert.match(big.notes[0], /inlineMaxBytes/);
        const at = chooseDelivery({
            kind: "photo",
            size: 5_242_880,
            mime: "image/jpeg",
            policy: policy(),
            stdio: false,
        });
        assert.equal(at.mode, "inline", "exactly the cutoff still goes inline");
        const odd = chooseDelivery({ kind: "photo", size: 10, mime: "application/octet-stream", policy: policy() });
        assert.equal(odd.mode, "link");
    });

    it("refuses a per-call mode allowDeliver does not list, and moves a default it forbids", () => {
        const p = policy({ allowDeliver: ["inline", "link"] });
        const asked = chooseDelivery({ kind: "file", size: 1, requested: "tempfile", policy: p, stdio: true });
        assert.match(asked.error, /not allowed/);
        const moved = chooseDelivery({
            kind: "file",
            size: 1,
            policy: { ...p, deliver: { ...p.deliver, file: "tempfile" } },
            stdio: true,
        });
        assert.equal(moved.mode, "link");
        assert.match(moved.notes.join(" "), /not allowed/);
    });

    it("never hands a tempfile path to a client on another machine", () => {
        const remote = chooseDelivery({
            kind: "video",
            size: 1,
            requested: "tempfile",
            policy: policy(),
            stdio: false,
            clientLoopback: false,
        });
        assert.equal(remote.mode, "link");
        assert.match(remote.notes[0], /another machine/);
        const local = chooseDelivery({
            kind: "video",
            size: 1,
            requested: "tempfile",
            policy: policy(),
            stdio: false,
            clientLoopback: true,
        });
        assert.equal(local.mode, "tempfile");
    });

    it("opens the viewer only on stdio, through a tempfile; autoOpen unset is on for stdio, off over HTTP", () => {
        const stdio = chooseDelivery({ kind: "photo", size: 1, mime: "image/png", policy: policy(), stdio: true });
        assert.deepEqual([stdio.mode, stdio.open], ["tempfile", true]);
        const http = chooseDelivery({ kind: "photo", size: 1, mime: "image/png", policy: policy(), stdio: false });
        assert.deepEqual([http.mode, http.open], ["inline", false]);
        const askedOverHttp = chooseDelivery({
            kind: "photo",
            size: 1,
            mime: "image/png",
            open: true,
            policy: policy(),
            stdio: false,
        });
        assert.equal(askedOverHttp.open, false);
        assert.match(askedOverHttp.notes[0], /stdio/);
        const explicit = chooseDelivery({
            kind: "photo",
            size: 1,
            mime: "image/png",
            requested: "inline",
            policy: policy(),
            stdio: true,
        });
        assert.deepEqual([explicit.mode, explicit.open], ["inline", false], "a chosen mode is not overridden");
        const off = chooseDelivery({
            kind: "photo",
            size: 1,
            mime: "image/png",
            policy: policy({ autoOpen: false }),
            stdio: true,
        });
        assert.equal(off.mode, "inline");
    });
});

describe("helpers", () => {
    it("mediaMime prefers the header, then the extension", () => {
        assert.equal(mediaMime({ mime: "image/png; q=1" }), "image/png");
        assert.equal(mediaMime({ ext: "m4a" }), "audio/mp4");
        assert.equal(mediaMime({}, "a.JPG"), "image/jpeg");
        assert.equal(mediaMime({}, "a.exe"), "application/octet-stream");
    });

    it("inlineContent is MCP image or audio content", () => {
        assert.deepEqual(inlineContent(Buffer.from("hi"), "voice", "audio/aac"), {
            type: "audio",
            data: "aGk=",
            mimeType: "audio/aac",
        });
        assert.equal(inlineContent(Buffer.from("x"), "photo", "image/png").type, "image");
    });

    it("safeMediaName drops paths and reserved characters", () => {
        assert.equal(safeMediaName("../../etc/pa:ss?.txt"), "pa_ss_.txt");
        assert.equal(safeMediaName(""), "media");
    });

    it("maskMediaPath hides the token", () => {
        assert.equal(maskMediaPath("GET /zalo/media/abcDEF123_-xyzXYZ0123456?x=1"), "GET /zalo/media/***?x=1");
    });
});

describe("tempfiles", () => {
    const sealed = (name, plain) => {
        const dir = getAccountDir(ID);
        const file = join(dir, "media", "t1", name);
        mkdirSync(dirname(file), { recursive: true });
        writeSealedMedia(file, scopeOfDir(dir), { msgId: "m1" }, plain);
        return { file, scope: scopeOfDir(dir) };
    };

    it("decrypt to a private folder, and the sweep removes only expired ones", () => {
        const plain = Buffer.from("PLAIN-TEMPFILE-BYTES");
        const { file, scope } = sealed("a.jpg", plain);
        const fresh = decryptToTempfile(file, scope, { msgId: "m1" });
        const stale = decryptToTempfile(file, scope, { msgId: "m1", keepOnExit: true, name: "../x.jpg" });
        assert.ok(fresh.path.startsWith(mediaTempRoot()));
        assert.equal(dirname(stale.path), stale.dir, "a name cannot leave its folder");
        assert.deepEqual(readFileSync(fresh.path), plain);
        if (process.platform !== "win32") assert.equal(statSync(fresh.path).mode & 0o777, 0o600);
        const old = new Date(Date.now() - 11 * 60_000);
        utimesSync(stale.dir, old, old);
        assert.equal(sweepMediaTemp(10 * 60_000), 1);
        assert.equal(existsSync(stale.dir), false, "the expired copy is gone");
        assert.equal(existsSync(fresh.path), true, "a live copy stays");
    });
});

describe("MediaLinks", () => {
    const fileSpec = {
        accountId: ID,
        msgId: "m1",
        threadId: "t1",
        file: "/x",
        scope: {},
        mime: "image/png",
        name: "a.png",
    };

    it("issues links on publicUrl (never another base) and forgets them after their TTL", () => {
        let t = 1_000_000;
        const links = new MediaLinks({ now: () => t }).configure({
            publicUrl: "https://zalo.example.com/base",
            localBaseUrl: "http://127.0.0.1:9",
            ttlMs: 600_000,
        });
        const { token, url, expiresAt } = links.issue(fileSpec);
        assert.equal(url, `https://zalo.example.com/base${MEDIA_PATH_PREFIX}${token}`);
        assert.match(token, /^[A-Za-z0-9_-]{22}$/);
        assert.equal(expiresAt, t + 600_000);
        assert.ok(links.lookup(token).link);
        t += 600_001;
        assert.equal(links.lookup(token).gone, "expired");
        assert.equal(links.lookup("A".repeat(22)).unknown, true);
    });

    it("refuses an http link to another host", () => {
        const links = new MediaLinks().configure({ localBaseUrl: "http://192.168.1.20:3847" });
        assert.throws(() => links.issue(fileSpec), /needs https/);
    });

    it("a capability link off loopback admits maxClients addresses per window; on loopback any", () => {
        let t = 0;
        const links = new MediaLinks({ now: () => t }).configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "capability",
            maxClients: 3,
            clientTtlMs: 15 * 60_000,
            ttlMs: 60 * 60_000,
        });
        const { link } = links.lookup(links.issue(fileSpec).token);
        assert.equal(links.admit(link, "203.0.113.1"), true);
        assert.equal(links.admit(link, "203.0.113.2"), true);
        assert.equal(links.admit(link, "203.0.113.3"), true);
        assert.equal(links.admit(link, "203.0.113.4"), false, "a fourth address is refused");
        assert.equal(links.admit(link, "203.0.113.2"), true, "an admitted one keeps coming back");
        t += 15 * 60_000;
        assert.equal(links.admit(link, "203.0.113.4"), true, "after the window a new address fits");

        const local = new MediaLinks().configure({ localBaseUrl: "http://127.0.0.1:9", maxClients: 1 });
        const l2 = local.lookup(local.issue(fileSpec).token).link;
        assert.equal(local.admit(l2, "a"), true);
        assert.equal(local.admit(l2, "b"), true);
    });

    it("bearer only when the server checks a token; otherwise the link is a capability link", () => {
        const logs = [];
        const without = new MediaLinks().configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "bearer",
            bearerAvailable: false,
            log: (l) => logs.push(l),
        });
        assert.equal(without.issue(fileSpec).auth, "capability");
        assert.match(logs[0], /no --auth token/);
        const withAuth = new MediaLinks().configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "bearer",
            bearerAvailable: true,
        });
        assert.equal(withAuth.issue(fileSpec).auth, "bearer");
    });

    it("revokes by thread, all at once, and on a rekey", () => {
        const links = new MediaLinks().configure({ localBaseUrl: "http://127.0.0.1:9" });
        const a = links.issue(fileSpec).token;
        const b = links.issue({ ...fileSpec, threadId: "t2" }).token;
        assert.equal(links.revokeThread("t1"), 1);
        assert.match(links.lookup(a).gone, /hidden/);
        assert.ok(links.lookup(b).link);
        assert.equal(links.revokeAll("logged out"), 1);
        assert.equal(links.lookup(b).gone, "logged out");

        setMediaLinks(new MediaLinks().configure({ localBaseUrl: "http://127.0.0.1:9" }));
        try {
            const c = getMediaLinks().issue(fileSpec).token;
            const dir = getAccountDir(ID);
            mkdirSync(dir, { recursive: true });
            scopeOfDir(dir);
            rekeyAccount(ID);
            assert.match(getMediaLinks().lookup(c).gone, /rekeyed/);
        } finally {
            setMediaLinks(null);
        }
    });
});
