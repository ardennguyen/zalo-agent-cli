/**
 * The largest file this account may send, as Zalo decides it for the account's tier, read from the session's own
 * settings (never copied): the upload store's caps (`uploads.maxBytes`, `uploads.urlMaxBytes`) default to it, and a
 * deployment may only lower them.
 *
 * - `features.sharefile.max_size_share_file_v3` (MB): the file-send limit, 25 MB when the settings lack it, as Zalo's
 *   own clients assume.
 * - `features.multi_site_upload.zcloud_upload_file_max_size` (bytes, 1 GiB when absent): a paid zCloud plan may send up
 *   to this, and it bounds every other plan too.
 * - The zCloud plan (`usage.plan`): paid unless it is free (-1), free after the grace period (69) or in it (100).
 *   zBusiness packages carry no file-size limit.
 *
 * This engine sends a file through the chat upload, which carries at most the share-file limit; a paid plan's larger
 * allowance needs Zalo's separate cloud upload, which it does not make. So the limit is
 * `min(share-file limit, zCloud upload limit)` for every plan, and the report says what the plan itself would allow.
 *
 * The daemon writes what it read to `<accountDir>/uploads/zalo-limit.json`, so a CLI command without a session (`file
 * put`) uses the same number.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIB = 1024 * 1024;
/** What Zalo's clients assume when the settings name no share-file limit (MB). */
export const SHARE_FILE_FALLBACK_MB = 25;
/** What Zalo's clients assume when the settings name no zCloud upload limit. */
export const ZCLOUD_UPLOAD_FALLBACK_BYTES = 1024 * MIB;
/** zCloud plans that are not paid. */
const UNPAID_PLANS = new Set([-1, 69, 100]);

/**
 * The account's file limit from the session's settings and (when known) its zCloud plan.
 *
 * @param {object|null|undefined} features - the session's `settings.features`
 * @param {{plan?: number|null}} [opts]
 * @returns {{bytes: number, shareFileBytes: number, zcloudUploadBytes: number, plan: number|null,
 *   tier: "free"|"grace"|"zcloud"|"unknown", planAllowsBytes: number, fromSettings: boolean}}
 */
export function zaloFileLimit(features, { plan = null } = {}) {
    const mb = Number(features?.sharefile?.max_size_share_file_v3);
    const z = Number(features?.multi_site_upload?.zcloud_upload_file_max_size);
    const shareFileBytes = (Number.isFinite(mb) && mb > 0 ? mb : SHARE_FILE_FALLBACK_MB) * MIB;
    const zcloudUploadBytes = Number.isFinite(z) && z > 0 ? z : ZCLOUD_UPLOAD_FALLBACK_BYTES;
    const known = Number.isFinite(Number(plan)) && plan !== null;
    const paid = known && !UNPAID_PLANS.has(Number(plan));
    const tier = !known ? "unknown" : Number(plan) === 100 ? "grace" : paid ? "zcloud" : "free";
    return {
        bytes: Math.min(shareFileBytes, zcloudUploadBytes),
        shareFileBytes,
        zcloudUploadBytes,
        plan: known ? Number(plan) : null,
        tier,
        planAllowsBytes: paid ? zcloudUploadBytes : Math.min(shareFileBytes, zcloudUploadBytes),
        fromSettings: Number.isFinite(mb) && mb > 0,
    };
}

/** The last limit read per account folder, in this process. */
const known = new Map();

/**
 * Read the account's limit from a live session and remember it (here and in the account folder).
 *
 * @param {object} api - the session (`getContext`)
 * @param {string|null} accountDir
 * @param {{plan?: number|null}} [opts]
 * @returns {ReturnType<typeof zaloFileLimit>|null} null when the session has no settings yet
 */
export function readAccountFileLimit(api, accountDir, { plan = null } = {}) {
    let features = null;
    try {
        const ctx = api?.getContext?.();
        features = ctx?.settings?.features ?? ctx?.loginInfo?.settings?.features ?? null;
    } catch {
        features = null;
    }
    if (!features) return accountDir ? knownAccountFileLimit(accountDir) : null;
    const limit = zaloFileLimit(features, { plan: plan ?? known.get(accountDir ?? "")?.plan ?? null });
    if (accountDir) {
        const before = known.get(accountDir);
        known.set(accountDir, limit);
        if (before && JSON.stringify(before) === JSON.stringify(limit)) return limit;
        try {
            mkdirSync(join(accountDir, "uploads"), { recursive: true, mode: 0o700 });
            writeFileSync(join(accountDir, "uploads", "zalo-limit.json"), JSON.stringify(limit), { mode: 0o600 });
        } catch {
            /* the number is still known in this process */
        }
    }
    return limit;
}

/**
 * The limit last read for an account folder: in this process, else what a daemon wrote. Null when never read.
 *
 * @param {string} accountDir
 * @returns {ReturnType<typeof zaloFileLimit>|null}
 */
export function knownAccountFileLimit(accountDir) {
    if (known.has(accountDir)) return known.get(accountDir);
    try {
        const v = JSON.parse(readFileSync(join(accountDir, "uploads", "zalo-limit.json"), "utf8"));
        if (Number.isSafeInteger(v?.bytes) && v.bytes > 0) {
            known.set(accountDir, v);
            return v;
        }
    } catch {
        /* never read */
    }
    return null;
}

/**
 * Note the account's zCloud plan (a usage read), so the next limit names the tier.
 *
 * @param {string} accountDir
 * @param {number|null} plan
 * @param {object} [api] - re-read the limit with it
 */
export function noteZCloudPlan(accountDir, plan, api = null) {
    const prev = known.get(accountDir);
    if (api) readAccountFileLimit(api, accountDir, { plan });
    else if (prev) known.set(accountDir, { ...prev, ...zaloFileLimitFromKnown(prev, plan) });
}

function zaloFileLimitFromKnown(prev, plan) {
    const features = {
        sharefile: { max_size_share_file_v3: prev.shareFileBytes / MIB },
        multi_site_upload: { zcloud_upload_file_max_size: prev.zcloudUploadBytes },
    };
    return zaloFileLimit(features, { plan });
}

/** Test seam: forget what this process read. */
export function resetKnownFileLimits() {
    known.clear();
}
