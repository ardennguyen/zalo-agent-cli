/**
 * The account status report (src/core/account-status.js): the zBusiness package, the zCloud plan and its usage, what
 * each allows, what this machine's index holds. Every network call is replaced, every number here is invented, and the
 * secrets of the real answers (the key backup's emails, the subscription's ids and price) are in the fixtures so that
 * the report can be shown not to carry them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    daysUntil,
    describeAccountStatus,
    readAccountStatus,
    resolveBizLimits,
    summarizeSubscription,
    zcloudState,
    zcloudTierName,
} from "../../src/core/account-status.js";

const NOW = Date.UTC(2026, 9, 28);
const DAY = 86_400_000;
const GIB = 1024 ** 3;

/** A small copy of the server's table, with invented numbers: `<feature>.config.<limit>.{<package>: value}`. */
const TABLE = {
    search: {
        fea_id: 9,
        enable: { 0: 1, 1: 1 },
        config: { limit_search_me_by_phone_per_month: { 0: 10, 1: 20 } },
    },
    ar: {
        fea_id: 4,
        enable: { 0: 0, 1: 1 },
        config: { limit_template_create: { 0: 0, 1: 3 }, limit_template_active: { 0: 0, 1: 2 } },
    },
    note: "not a feature",
};

const PAID_PROFILE = {
    profile: {
        userId: "u1",
        displayName: "Fake Owner",
        isEnterpriseAccount: 0,
        bizPkg: {
            label: { VI: "Business", EN: "Business" },
            pkgName: { VI: "zBusiness Basic", EN: "zBusiness Basic" },
            expired: NOW + 20 * DAY + 3600_000,
            pkgId: 1,
        },
    },
};
const FREE_PROFILE = {
    profile: { userId: "u2", displayName: "Fake Free", isEnterpriseAccount: 0, bizPkg: { label: null, pkgId: 0 } },
};
const PAID_USAGE = {
    plan: 0,
    quota: 100 * GIB,
    usage: 25 * GIB,
    service_usage: { my_cloud: 1000, cloud_media: 24 * GIB, message_backup: 5000 },
};
const FREE_USAGE = { plan: -1, quota: 0, usage: 0, service_usage: { my_cloud: 0, message_backup: 0 } };
const PAID_SETTINGS = {
    cloud_media_file_size_limit: 2147483640,
    my_cloud_file_size_limit: 2147483640,
    enable_community: 0,
    opt_in: 7,
    enable_offload: 1,
    key_export: { drive: { email: "secret-mail@example.invalid" }, icloud: { identity: "secret-identity-string" } },
};
const FREE_SETTINGS = {
    cloud_media_file_size_limit: 100,
    my_cloud_file_size_limit: 100,
    enable_community: 0,
    opt_in: 4,
    enable_offload: 0,
    key_export: {},
};
const SUBSCRIPTION = {
    subscription_info: {
        product_id: "secret-product",
        auto_renew_product_id: "secret-renew-product",
        trans_id: "secret-transaction",
        origin_trans_id: "secret-origin",
        subscription_time: NOW - 10 * DAY,
        expire_time: NOW + 350 * DAY,
        subscription_gw: 3,
        status: 1,
        total_cloud: 100 * GIB,
        duration_months: 12,
        price: 999999,
        billing_gp_original_expired_time: 0,
        cancelled_renew: false,
    },
    migrate_info: { status: 3 },
};

/** An api stub: only what readAccountStatus reaches for. */
const fakeApi = (table = TABLE) => ({
    getContext: () => ({ settings: { features: { ba_config: { ba_pkg_config: table } } } }),
});

/** The readers, recording which were called. */
const readers = ({ profile, usage, settings, subscription = SUBSCRIPTION }) => {
    const called = [];
    const make = (name, value) => async () => {
        called.push(name);
        if (value instanceof Error) throw value;
        return value;
    };
    return {
        called,
        read: {
            profile: make("profile", profile),
            usage: make("usage", usage),
            settings: make("settings", settings),
            subscription: make("subscription", subscription),
        },
    };
};

describe("the plan numbers", () => {
    it("names the zCloud states the client knows, and calls any other number unknown", () => {
        assert.equal(zcloudState(-1), "free");
        assert.equal(zcloudState(0), "paid");
        assert.equal(zcloudState(100), "grace");
        assert.equal(zcloudState(69), "after-grace");
        assert.equal(zcloudState(42), "unknown");
        assert.equal(zcloudState(null), "unknown");
        assert.equal(zcloudState(undefined), "unknown");
    });

    it("pairs a paid size with its tier name, and leaves an odd size unnamed", () => {
        assert.equal(zcloudTierName(10 * GIB), "zCloud Mini");
        assert.equal(zcloudTierName(100 * GIB), "zCloud Standard");
        assert.equal(zcloudTierName(500 * GIB), "zCloud Family");
        assert.equal(zcloudTierName(1024 * GIB), "zCloud Advanced");
        assert.equal(zcloudTierName(37 * GIB), null);
        assert.equal(zcloudTierName(null), null);
    });

    it("counts whole days to a time, negative once it has passed, null for no time", () => {
        assert.equal(daysUntil(NOW + 20 * DAY + 5, NOW), 20);
        assert.equal(daysUntil(NOW - 2 * DAY, NOW), -2);
        assert.equal(daysUntil(0, NOW), null);
        assert.equal(daysUntil(undefined, NOW), null);
    });
});

describe("the zBusiness limits come from the server's table", () => {
    it("resolves each feature's enable flag and limits for one package, without naming any of them", () => {
        assert.deepEqual(resolveBizLimits(TABLE, 1), {
            search: { enabled: true, limit_search_me_by_phone_per_month: 20 },
            ar: { enabled: true, limit_template_create: 3, limit_template_active: 2 },
        });
        assert.deepEqual(resolveBizLimits(TABLE, 0).ar, {
            enabled: false,
            limit_template_create: 0,
            limit_template_active: 0,
        });
    });

    it("says nothing for a package the table does not list, and for a table that is not there", () => {
        assert.deepEqual(resolveBizLimits(TABLE, 9), {});
        assert.deepEqual(resolveBizLimits(undefined, 1), {});
        assert.deepEqual(resolveBizLimits("nope", 1), {});
    });
});

describe("the subscription, reduced", () => {
    it("keeps tier, size, months, gateway, status, renewal and dates, and none of the ids or the price", () => {
        const s = summarizeSubscription(SUBSCRIPTION, NOW);
        assert.equal(s.tier, "zCloud Standard");
        assert.equal(s.tierInferred, true);
        assert.equal(s.totalBytes, 100 * GIB);
        assert.equal(s.durationMonths, 12);
        assert.equal(s.gateway, "Zalo");
        assert.equal(s.status, 1);
        assert.equal(s.autoRenew, true, "cancelled_renew false means it renews");
        assert.equal(s.daysLeft, 350);
        assert.equal(s.expiresAt, new Date(NOW + 350 * DAY).toISOString());
        const text = JSON.stringify(s);
        for (const secret of ["secret-product", "secret-renew", "secret-transaction", "secret-origin", "999999"]) {
            assert.ok(!text.includes(secret), `the report carries ${secret}`);
        }
    });

    it("names a gateway it does not know by its number, and reads a cancelled renewal as will-not-renew", () => {
        const s = summarizeSubscription(
            { subscription_info: { ...SUBSCRIPTION.subscription_info, subscription_gw: 7, cancelled_renew: true } },
            NOW,
        );
        assert.equal(s.gateway, "unknown(7)");
        assert.equal(s.autoRenew, false);
    });

    it("is null when the answer has no subscription", () => {
        assert.equal(summarizeSubscription({}, NOW), null);
        assert.equal(summarizeSubscription(null, NOW), null);
    });
});

describe("reading an account with a zBusiness package and a paid zCloud plan", () => {
    const run = async (over = {}) => {
        const r = readers({ profile: PAID_PROFILE, usage: PAID_USAGE, settings: PAID_SETTINGS, ...over });
        const status = await readAccountStatus(fakeApi(), {
            ownId: "u1",
            now: NOW,
            read: r.read,
            localIndex: () => ({ items: 321, bytes: 24 * GIB - 1_000_000 }),
        });
        return { status, called: r.called };
    };

    it("reports the package, its expiry and its limits", async () => {
        const { status } = await run();
        assert.deepEqual(
            { ...status.zbusiness, limits: undefined },
            {
                pkgId: 1,
                active: true,
                name: "zBusiness Basic",
                label: "Business",
                expiresAt: new Date(NOW + 20 * DAY + 3600_000).toISOString(),
                daysLeft: 20,
                expired: false,
                limits: undefined,
            },
        );
        assert.equal(status.zbusiness.limits.ar.limit_template_create, 3);
        assert.deepEqual(status.enterprise, { isEnterprise: false });
        assert.equal(status.name, "Fake Owner");
    });

    it("reports the zCloud plan, the usage by service, the opt-in, the limits as raw numbers and the local index", async () => {
        const { status, called } = await run();
        const z = status.zcloud;
        assert.equal(z.state, "paid");
        assert.deepEqual(z.plan, { code: 0, name: "zcloud" });
        assert.equal(z.subscription.tier, "zCloud Standard");
        assert.equal(z.usage.usedBytes, 25 * GIB);
        assert.equal(z.usage.percent, 25);
        assert.equal(z.usage.overQuota, false);
        assert.deepEqual(z.usage.byService, { cloudMedia: 24 * GIB, myCloud: 1000, messageBackup: 5000 });
        assert.deepEqual(z.optIn, { media: true, mycloud: true, backup: true });
        assert.equal(z.limits.perFileRaw.unit, "undefined", "the unit of these numbers is not defined anywhere");
        assert.equal(z.limits.perFileRaw.cloudMedia, 2147483640);
        assert.equal(z.limits.offloadEnabled, true);
        assert.deepEqual(z.keyBackup, ["drive", "icloud"], "provider names only");
        assert.deepEqual(z.localIndex, { items: 321, bytes: 24 * GIB - 1_000_000, deltaVsServerBytes: 1_000_000 });
        assert.deepEqual(called, ["profile", "usage", "settings", "subscription"]);
    });

    it("carries no key-backup detail, no subscription id and no price anywhere in the report", async () => {
        const { status } = await run();
        const text = JSON.stringify(status);
        for (const secret of ["secret-mail", "secret-identity", "secret-product", "secret-transaction", "999999"]) {
            assert.ok(!text.includes(secret), `the report carries ${secret}`);
        }
    });

    it("says in words what the account holds, with the dates", async () => {
        const { status } = await run();
        const text = describeAccountStatus(status).join("\n");
        assert.match(text, /zBusiness: zBusiness Basic \(package 1\), expires 2026-11-17 \(20 days\)/);
        assert.match(text, /zCloud: zCloud Standard, paid plan\./);
        assert.match(text, /12 months through Zalo, renews automatically, expires 2027-10-13 \(350 days\)/);
        assert.match(text, /Used 25\.0 GB of 100\.0 GB \(25%\)/);
        assert.match(text, /Backs up: media, mycloud, backup\. Key backup: drive, icloud\./);
    });

    it("flags a package whose expiry has passed", async () => {
        const { status } = await run({
            profile: {
                profile: {
                    ...PAID_PROFILE.profile,
                    bizPkg: { ...PAID_PROFILE.profile.bizPkg, expired: NOW - 3 * DAY },
                },
            },
        });
        assert.equal(status.zbusiness.expired, true);
        assert.equal(status.zbusiness.daysLeft, -3);
        assert.match(describeAccountStatus(status).join("\n"), /expired 2026-10-25/);
    });
});

describe("reading an account with no package and no zCloud plan", () => {
    it("reports package 0 and the free plan, and does not ask for a subscription that cannot exist", async () => {
        const r = readers({ profile: FREE_PROFILE, usage: FREE_USAGE, settings: FREE_SETTINGS });
        const status = await readAccountStatus(fakeApi(), { now: NOW, read: r.read });
        assert.equal(status.zbusiness.pkgId, 0);
        assert.equal(status.zbusiness.active, false);
        assert.equal(status.zbusiness.label, null);
        assert.equal(status.zcloud.state, "free");
        assert.equal(status.zcloud.subscription, null);
        assert.equal(status.zcloud.usage.quotaBytes, 0);
        assert.equal(status.zcloud.usage.percent, null, "no percent of a quota of nothing");
        assert.deepEqual(status.zcloud.optIn, { media: false, mycloud: false, backup: true });
        assert.deepEqual(status.zcloud.keyBackup, []);
        assert.equal(status.zcloud.localIndex, null);
        assert.ok(!r.called.includes("subscription"), "a free plan has no subscription to read, as in Zalo Web");
        const text = describeAccountStatus(status).join("\n");
        assert.match(text, /zBusiness: no package \(package 0\)\./);
        assert.match(text, /zCloud: free plan \(no subscription\)\./);
    });

    it("does not read the subscription after the grace period either, and does read it during the grace period", async () => {
        const after = readers({ profile: FREE_PROFILE, usage: { ...FREE_USAGE, plan: 69 }, settings: FREE_SETTINGS });
        const a = await readAccountStatus(fakeApi(), { now: NOW, read: after.read });
        assert.equal(a.zcloud.state, "after-grace");
        assert.ok(!after.called.includes("subscription"));

        const grace = readers({ profile: FREE_PROFILE, usage: { ...PAID_USAGE, plan: 100 }, settings: PAID_SETTINGS });
        const g = await readAccountStatus(fakeApi(), { now: NOW, read: grace.read });
        assert.equal(g.zcloud.state, "grace");
        assert.ok(grace.called.includes("subscription"));
        assert.match(
            describeAccountStatus(g).join("\n"),
            /grace period \(the data is deleted 30 days after the plan ended\)/,
        );
    });

    it("treats a plan number it does not know as unknown, and reads the subscription, as the client counts it paid", async () => {
        const r = readers({ profile: FREE_PROFILE, usage: { ...PAID_USAGE, plan: 42 }, settings: PAID_SETTINGS });
        const status = await readAccountStatus(fakeApi(), { now: NOW, read: r.read });
        assert.equal(status.zcloud.state, "unknown");
        assert.deepEqual(status.zcloud.plan, { code: 42, name: "unknown(42)" });
        assert.ok(r.called.includes("subscription"));
    });
});

describe("a read that fails", () => {
    it("is named, costs only its own part, and does not stop the rest", async () => {
        const r = readers({
            profile: PAID_PROFILE,
            usage: Object.assign(new Error("no viewer key"), { code: -205 }),
            settings: PAID_SETTINGS,
        });
        const status = await readAccountStatus(fakeApi(), { now: NOW, read: r.read });
        assert.equal(status.zcloud, null);
        assert.equal(status.zbusiness.pkgId, 1, "the package was read before");
        assert.deepEqual(status.problems, [{ source: "zcld.v2/usage", reason: "[-205] no viewer key" }]);
        assert.ok(status.sources.includes("me-v2"));
        assert.ok(!status.sources.includes("zcld.v2/usage"));
        assert.match(
            describeAccountStatus(status).join("\n"),
            /Could not read zcld\.v2\/usage: \[-205\] no viewer key/,
        );
    });

    it("leaves the zBusiness part empty when the profile cannot be read, and still reports the cloud", async () => {
        const r = readers({ profile: new Error("offline"), usage: FREE_USAGE, settings: FREE_SETTINGS });
        const status = await readAccountStatus(fakeApi(), { now: NOW, read: r.read });
        assert.equal(status.zbusiness, null);
        assert.equal(status.zcloud.state, "free");
        assert.equal(status.problems[0].source, "me-v2");
    });

    it("keeps the subscription out of the report when only that read fails, and says so", async () => {
        const r = readers({
            profile: PAID_PROFILE,
            usage: PAID_USAGE,
            settings: PAID_SETTINGS,
            subscription: new Error("refused"),
        });
        const status = await readAccountStatus(fakeApi(), { now: NOW, read: r.read });
        assert.equal(status.zcloud.subscription, null);
        assert.equal(status.zcloud.state, "paid");
        assert.equal(status.problems[0].source, "zcld.cloudinfopcweb");
    });
});
