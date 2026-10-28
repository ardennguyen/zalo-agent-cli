/**
 * The account's plans in one read-only report: which zBusiness package it holds, which zCloud plan, how much of the
 * quota is used, what each plan allows, and what this machine's zCloud index holds.
 *
 * Every field comes from a call Zalo's own clients make, none of it from a guess:
 *
 *  - `me-v2` (`fetchAccountInfo`): `bizPkg` (the zBusiness package: id, names, expiry) and `isEnterpriseAccount`.
 *  - the login settings already in memory: `features.ba_config.ba_pkg_config`, the server's table of limits per package
 *    (`<feature>.config.<limit>.{<package id>: value}`, `<feature>.enable.{<package id>: 0|1}`). It is read, never copied
 *    here: the numbers belong to the server and change.
 *  - zCloud `v2/usage` and `cloud-settings` (every account answers them) and, on a paid plan only, `cloudinfopcweb`
 *    (the subscription: gateway, status, size, dates), exactly as Zalo Web does.
 *
 * The plan numbers are the client's own (`usage.plan`): -1 free, 0 paid, 100 grace period (30 days after expiry, the
 * data is deleted when it ends), 69 free after the grace period. A number the client does not know counts as paid
 * there, and is reported as `unknown` here with the number.
 *
 * What it never prints: the cloud viewer key and its cipher key, the key-backup details (only the provider names), the
 * transaction and product ids of the subscription, the price. Read-only: no write, no socket, no state.
 */
import { getCloudSettings, getCloudSubscription, getCloudUsage, summarizeCloudQuota } from "./sync-v2/zcloud.js";

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;

/** The zCloud plan states: usage.plan -> state. */
const STATE = { [-1]: "free", 0: "paid", 69: "after-grace", 100: "grace" };

/** The billing gateways seen: only Zalo's own is known by number. */
const GATEWAY = { 3: "Zalo" };

/**
 * What a zCloud plan number means.
 *
 * @param {number|null} planCode - `usage.plan`
 * @returns {"free"|"paid"|"grace"|"after-grace"|"unknown"}
 */
export function zcloudState(planCode) {
    if (planCode === null || planCode === undefined) return "unknown";
    return STATE[planCode] ?? "unknown";
}

/**
 * The tier name of a paid zCloud plan, from its size. The sizes and names are in Zalo Web's shipped configuration
 * (Mini 10 GB, Standard 100 GB, Family 500 GB, Advanced 1 TB); the pairing of an account's size with a name is ours.
 *
 * @param {number|null} totalBytes
 * @returns {string|null}
 */
export function zcloudTierName(totalBytes) {
    if (!Number.isFinite(totalBytes)) return null;
    const gib = Math.round(totalBytes / GIB);
    return { 10: "zCloud Mini", 100: "zCloud Standard", 500: "zCloud Family", 1024: "zCloud Advanced" }[gib] ?? null;
}

/**
 * Whole days from `now` to a time in epoch milliseconds; negative once it has passed. Null for no time.
 *
 * @param {number|null|undefined} ms
 * @param {number} now
 * @returns {number|null}
 */
export function daysUntil(ms, now) {
    const t = Number(ms);
    return Number.isFinite(t) && t > 0 ? Math.floor((t - now) / DAY_MS) : null;
}

const isoOrNull = (ms) => {
    const t = Number(ms);
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

/**
 * The limits of one zBusiness package, read from the server's table.
 *
 * @param {object|undefined} table - `features.ba_config.ba_pkg_config`
 * @param {number} pkgId
 * @returns {Record<string, Record<string, unknown>>} feature -> `{enabled, <limit>: value, ...}`
 */
export function resolveBizLimits(table, pkgId) {
    const out = {};
    if (!table || typeof table !== "object") return out;
    const at = (byPkg) => (byPkg && typeof byPkg === "object" ? byPkg[String(pkgId)] : undefined);
    for (const [feature, def] of Object.entries(table)) {
        if (!def || typeof def !== "object") continue;
        const row = {};
        const enabled = at(def.enable);
        if (enabled !== undefined) row.enabled = Boolean(Number(enabled));
        for (const [limit, byPkg] of Object.entries(def.config ?? {})) {
            const v = at(byPkg);
            if (v !== undefined) row[limit] = v;
        }
        if (Object.keys(row).length) out[feature] = row;
    }
    return out;
}

/**
 * The subscription, reduced: no transaction ids, no product ids, no price.
 *
 * @param {object|null|undefined} reply - `cloudinfopcweb` answer
 * @param {number} now
 * @returns {object|null}
 */
export function summarizeSubscription(reply, now) {
    const s = reply?.subscription_info;
    if (!s || typeof s !== "object") return null;
    const total = Number.isFinite(Number(s.total_cloud)) ? Number(s.total_cloud) : null;
    const gw = Number.isFinite(Number(s.subscription_gw)) ? Number(s.subscription_gw) : null;
    return {
        tier: zcloudTierName(total),
        tierInferred: true,
        totalBytes: total,
        durationMonths: Number.isFinite(Number(s.duration_months)) ? Number(s.duration_months) : null,
        gateway: gw === null ? null : (GATEWAY[gw] ?? `unknown(${gw})`),
        status: Number.isFinite(Number(s.status)) ? Number(s.status) : null,
        autoRenew: s.cancelled_renew === undefined ? null : !s.cancelled_renew,
        subscribedAt: isoOrNull(s.subscription_time),
        expiresAt: isoOrNull(s.expire_time),
        daysLeft: daysUntil(s.expire_time, now),
    };
}

/** What an error says, for the report's problem list: a message, never key material. */
const reasonOf = (e) =>
    `${e?.code !== undefined && e?.code !== null ? `[${e.code}] ` : ""}${String(e?.message ?? e).slice(0, 160)}`;

/**
 * Read the account's plans.
 *
 * @param {object} api - the logged-in api (`fetchAccountInfo`, `getContext`)
 * @param {object} [opts]
 * @param {string} [opts.ownId]
 * @param {number} [opts.now]
 * @param {() => ({items: number, bytes: number}|null)} [opts.localIndex] - what this machine's zCloud index holds
 * @param {object} [opts.read] - replaces the network calls (tests): `profile`, `usage`, `settings`, `subscription`
 * @returns {Promise<object>} the report; a call that failed is named in `problems` and its part is null
 */
export async function readAccountStatus(
    api,
    { ownId = null, now = Date.now(), localIndex = () => null, read = {} } = {},
) {
    const rd = {
        profile: () => api.fetchAccountInfo(),
        usage: () => getCloudUsage(api),
        settings: () => getCloudSettings(api),
        subscription: () => getCloudSubscription(api),
        ...read,
    };
    const problems = [];
    const sources = [];
    const attempt = async (source, fn) => {
        try {
            const v = await fn();
            sources.push(source);
            return v ?? null;
        } catch (e) {
            problems.push({ source, reason: reasonOf(e) });
            return null;
        }
    };

    const account = await attempt("me-v2", rd.profile);
    const profile = account?.profile ?? account ?? {};
    const features = (() => {
        try {
            const ctx = api.getContext?.();
            return ctx?.settings?.features ?? ctx?.loginInfo?.settings?.features ?? {};
        } catch {
            return {};
        }
    })();

    // ---- zBusiness: the package on the profile, the limits from the server's table
    const biz = profile.bizPkg ?? null;
    const pkgId = Number.isFinite(Number(biz?.pkgId)) ? Number(biz.pkgId) : null;
    const zbusiness =
        pkgId === null
            ? null
            : {
                  pkgId,
                  active: pkgId !== 0,
                  name: biz.pkgName?.EN ?? biz.pkgName?.VI ?? null,
                  label: biz.label?.EN ?? biz.label?.VI ?? null,
                  expiresAt: isoOrNull(biz.expired),
                  daysLeft: daysUntil(biz.expired, now),
                  expired: Number(biz.expired) > 0 ? Number(biz.expired) < now : null,
                  limits: resolveBizLimits(features.ba_config?.ba_pkg_config, pkgId),
              };

    // ---- zCloud: usage and settings answer for every account; the subscription only for a paid plan
    const usage = await attempt("zcld.v2/usage", rd.usage);
    const settings = await attempt("zcld.cloud-settings", rd.settings);
    let zcloud = null;
    if (usage) {
        const q = summarizeCloudQuota(usage, settings ?? {});
        const state = zcloudState(q.planCode);
        const paid = state === "paid" || state === "grace" || state === "unknown";
        const subscription = paid
            ? summarizeSubscription(await attempt("zcld.cloudinfopcweb", rd.subscription), now)
            : null;
        const keyBackup = Object.entries(settings?.key_export ?? {})
            .filter(([, v]) => v && typeof v === "object" && Object.keys(v).length)
            .map(([provider]) => provider);
        const local = localIndex();
        const cloudMedia = Number(usage.service_usage?.cloud_media);
        zcloud = {
            state,
            plan: { code: q.planCode, name: q.plan },
            subscription,
            usage: {
                usedBytes: q.usageBytes,
                quotaBytes: q.quotaBytes,
                freeBytes: q.freeBytes,
                percent: q.quotaBytes ? Math.round((q.usageBytes / q.quotaBytes) * 1000) / 10 : null,
                overQuota: q.overQuota,
                byService: {
                    cloudMedia: usage.service_usage?.cloud_media ?? null,
                    myCloud: usage.service_usage?.my_cloud ?? null,
                    messageBackup: usage.service_usage?.message_backup ?? null,
                },
            },
            limits: {
                perFileRaw: { cloudMedia: q.perFileLimitRaw, myCloud: q.myCloudPerFileLimitRaw, unit: "undefined" },
                offloadEnabled: settings ? Boolean(Number(settings.enable_offload)) : null,
                communityStored: settings ? Boolean(Number(settings.enable_community)) : null,
            },
            optIn: q.optIn,
            keyBackup,
            localIndex: local
                ? {
                      items: local.items,
                      bytes: local.bytes,
                      deltaVsServerBytes: Number.isFinite(cloudMedia) ? cloudMedia - local.bytes : null,
                  }
                : null,
        };
    }

    return {
        ownId,
        name: profile.displayName ?? profile.zaloName ?? null,
        checkedAt: new Date(now).toISOString(),
        sources,
        problems,
        zbusiness,
        enterprise:
            profile.isEnterpriseAccount === undefined
                ? null
                : { isEnterprise: Boolean(Number(profile.isEnterpriseAccount)) },
        zcloud,
    };
}

const fmtBytes = (n) => {
    if (n === null || n === undefined) return "?";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const fmtDay = (iso) => (iso ? iso.slice(0, 10) : "?");

/**
 * The report as lines for a person.
 *
 * @param {Awaited<ReturnType<typeof readAccountStatus>>} s
 * @returns {string[]}
 */
export function describeAccountStatus(s) {
    const out = [];
    const b = s.zbusiness;
    if (!b) out.push("zBusiness: not read.");
    else if (!b.active) out.push("zBusiness: no package (package 0).");
    else {
        const when = b.expired
            ? `expired ${fmtDay(b.expiresAt)}`
            : `expires ${fmtDay(b.expiresAt)}${b.daysLeft !== null ? ` (${b.daysLeft} days)` : ""}`;
        out.push(`zBusiness: ${b.name ?? `package ${b.pkgId}`} (package ${b.pkgId}), ${when}.`);
    }
    if (s.enterprise?.isEnterprise) out.push("Enterprise account: yes.");
    const z = s.zcloud;
    if (!z) out.push("zCloud: not read.");
    else {
        const u = z.usage;
        if (z.state === "free") {
            out.push("zCloud: free plan (no subscription).");
        } else {
            const tier = z.subscription?.tier ?? null;
            const label = {
                paid: "paid plan",
                grace: "grace period (the data is deleted 30 days after the plan ended)",
                "after-grace": "free, after the grace period",
                unknown: `plan ${z.plan.code}`,
            }[z.state];
            out.push(`zCloud: ${tier ? `${tier}, ` : ""}${label}.`);
            if (z.subscription) {
                const sub = z.subscription;
                out.push(
                    `  Subscription: ${sub.durationMonths ?? "?"} months through ${sub.gateway ?? "?"}, ` +
                        `${sub.autoRenew === null ? "" : sub.autoRenew ? "renews automatically, " : "will not renew, "}` +
                        `expires ${fmtDay(sub.expiresAt)}${sub.daysLeft !== null ? ` (${sub.daysLeft} days)` : ""}.`,
                );
            }
        }
        out.push(
            `  Used ${fmtBytes(u.usedBytes)} of ${fmtBytes(u.quotaBytes)}${u.percent !== null ? ` (${u.percent}%)` : ""}` +
                `${u.overQuota ? ", OVER the quota" : ""}: media ${fmtBytes(u.byService.cloudMedia)}, My Cloud ${fmtBytes(u.byService.myCloud)}, text message backup ${fmtBytes(u.byService.messageBackup)}.`,
        );
        const on = Object.entries(z.optIn ?? {})
            .filter(([, v]) => v)
            .map(([k]) => k);
        out.push(
            `  Backs up: ${on.length ? on.join(", ") : "nothing"}. Key backup: ${z.keyBackup.length ? z.keyBackup.join(", ") : "none"}.`,
        );
        if (z.localIndex) {
            out.push(
                `  This machine's index: ${z.localIndex.items} item(s), ${fmtBytes(z.localIndex.bytes)}` +
                    `${z.localIndex.deltaVsServerBytes === null ? "" : ` (the server counts ${fmtBytes(Math.abs(z.localIndex.deltaVsServerBytes))} ${z.localIndex.deltaVsServerBytes >= 0 ? "more" : "less"} in media)`}.`,
            );
        }
    }
    for (const p of s.problems) out.push(`Could not read ${p.source}: ${p.reason}`);
    return out;
}
