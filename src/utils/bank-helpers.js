/**
 * Vietnamese bank BIN mapping + VietQR image generation via qr.sepay.vn.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import nodefetch from "node-fetch";

/** Bank name aliases (lowercase, no spaces) → BIN codes. */
export const BANK_NAME_TO_BIN = {
    abbank: 970425,
    acb: 970416,
    agribank: 970405,
    bidv: 970418,
    bvbank: 970454,
    bacabank: 970409,
    baoviet: 970438,
    cake: 546034,
    cbbank: 970444,
    cimb: 422589,
    coopbank: 970446,
    dbs: 796500,
    dongabank: 970406,
    eximbank: 970431,
    gpbank: 970408,
    hdbank: 970437,
    hsbc: 458761,
    hongleong: 970442,
    ibkhcm: 970456,
    ibkhn: 970455,
    indovina: 970434,
    kbank: 668888,
    kienlongbank: 970452,
    kookminhcm: 970463,
    kookminhn: 970462,
    mbbank: 970422,
    mb: 970422,
    msb: 970426,
    ncb: 970419,
    namabank: 970428,
    nonghyup: 801011,
    ocb: 970448,
    oceanbank: 970414,
    pgbank: 970430,
    pvcombank: 970412,
    publicbank: 970439,
    scb: 970429,
    shb: 970443,
    sacombank: 970403,
    saigonbank: 970400,
    seabank: 970440,
    shinhan: 970424,
    standardchartered: 970410,
    tnex: 9704261,
    tpbank: 970423,
    techcombank: 970407,
    timo: 963388,
    ubank: 546035,
    uob: 970458,
    vib: 970441,
    vpbank: 970432,
    vrb: 970421,
    vietabank: 970427,
    vietbank: 970433,
    vietcombank: 970436,
    vcb: 970436,
    vietinbank: 970415,
    ctg: 970415,
    woori: 970457,
};

/** BIN → display name. */
export const BIN_TO_DISPLAY = {
    970425: "ABBank",
    970416: "ACB",
    970405: "Agribank",
    970418: "BIDV",
    970454: "BVBank",
    970409: "BacA Bank",
    970438: "BaoViet Bank",
    546034: "CAKE",
    970444: "CB Bank",
    422589: "CIMB",
    970446: "Co-op Bank",
    796500: "DBS",
    970406: "DongA Bank",
    970431: "Eximbank",
    970408: "GPBank",
    970437: "HDBank",
    458761: "HSBC",
    970442: "Hong Leong",
    970456: "IBK HCM",
    970455: "IBK HN",
    970434: "Indovina",
    668888: "KBank",
    970452: "KienlongBank",
    970463: "Kookmin HCM",
    970462: "Kookmin HN",
    970422: "MB Bank",
    970426: "MSB",
    970419: "NCB",
    970428: "Nam A Bank",
    801011: "NongHyup",
    970448: "OCB",
    970414: "OceanBank",
    970430: "PGBank",
    970412: "PVcomBank",
    970439: "Public Bank",
    970429: "SCB",
    970443: "SHB",
    970403: "Sacombank",
    970400: "Saigon Bank",
    970440: "SeABank",
    970424: "Shinhan",
    970410: "Standard Chartered",
    9704261: "TNEX",
    970423: "TPBank",
    970407: "Techcombank",
    963388: "Timo",
    546035: "UBank",
    970458: "UOB",
    970441: "VIB",
    970432: "VPBank",
    970421: "VRB",
    970427: "VietABank",
    970433: "VietBank",
    970436: "Vietcombank",
    970415: "VietinBank",
    970457: "Woori",
};

/** BIN → SePay short_name for qr.sepay.vn URL. */
const BIN_TO_SEPAY = {
    970415: "VietinBank",
    970436: "Vietcombank",
    970422: "MBBank",
    970416: "ACB",
    970432: "VPBank",
    970423: "TPBank",
    970426: "MSB",
    970428: "NamABank",
    970449: "LienVietPostBank",
    970454: "VietCapitalBank",
    970418: "BIDV",
    970403: "Sacombank",
    970441: "VIB",
    970437: "HDBank",
    970440: "SeABank",
    970408: "GPBank",
    970412: "PVcomBank",
    970419: "NCB",
    970424: "ShinhanBank",
    970429: "SCB",
    970430: "PGBank",
    970405: "Agribank",
    970407: "Techcombank",
    970400: "SaigonBank",
    970406: "DongABank",
    970409: "BacABank",
    970410: "StandardChartered",
    970414: "Oceanbank",
    970421: "VRB",
    970425: "ABBANK",
    970427: "VietABank",
    970431: "Eximbank",
    970433: "VietBank",
    970434: "IndovinaBank",
    970438: "BaoVietBank",
    970439: "PublicBank",
    970443: "SHB",
    970444: "CBBank",
    970448: "OCB",
    970452: "KienLongBank",
    422589: "CIMB",
    458761: "HSBC",
    796500: "DBSBank",
    801011: "Nonghyup",
    970442: "HongLeong",
    970457: "Woori",
    970458: "UnitedOverseas",
    970462: "KookminHN",
    970463: "KookminHCM",
    970446: "COOPBANK",
};

/**
 * Resolve bank name or BIN string to numeric BIN code.
 * @param {string} input - Bank name alias or BIN number
 * @returns {number|null}
 */
export function resolveBankBin(input) {
    if (/^\d+$/.test(input)) {
        const n = Number(input);
        return BIN_TO_DISPLAY[n] ? n : null;
    }
    return BANK_NAME_TO_BIN[input.toLowerCase().replace(/[\s_]/g, "")] || null;
}

/**
 * Download VietQR transfer image from qr.sepay.vn.
 * @param {number} bin
 * @param {string} accountNumber
 * @param {number|null} amount
 * @param {string|null} content - Max 50 chars, SePay param name is "des"
 * @param {string} template - compact | print | qronly
 * @returns {Promise<string|null>} Temp file path or null on failure
 */
export async function generateQrTransferImage(bin, accountNumber, amount = null, content = null, template = "compact") {
    const sepayShort = BIN_TO_SEPAY[bin];
    if (!sepayShort) return null;

    const params = new URLSearchParams({ bank: sepayShort, acc: accountNumber, template });
    if (amount !== null && amount !== undefined) params.set("amount", String(amount));
    if (content) params.set("des", content);

    const url = `https://qr.sepay.vn/img?${params}`;
    const tmpDir = mkdtempSync(join(tmpdir(), "qr_transfer_"));
    const outPath = join(tmpDir, "qr.png");

    try {
        const resp = await nodefetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 15000,
        });
        if (!resp.ok) return null;
        const buffer = Buffer.from(await resp.arrayBuffer());
        writeFileSync(outPath, buffer);
        return outPath;
    } catch {
        return null;
    }
}
