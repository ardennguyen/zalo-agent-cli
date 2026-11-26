/**
 * The VietQR (NAPAS 247, EMVCo merchant-presented) payload for a bank transfer, built locally: 00 format, 01 static or
 * dynamic (with an amount), 38 NAPAS (A000000727, the bank's BIN and the account, QRIBFTTA), 53 VND, 54 amount, 58 VN,
 * 62.08 the transfer note, 63 the CRC-16/CCITT-FALSE checksum. Any bank in the bank list gets a QR this way, with no
 * image service involved.
 */

import { qrPng } from "../zalo/qr-image.js";

const NAPAS_GUID = "A000000727";
const SERVICE_TO_ACCOUNT = "QRIBFTTA";

/**
 * One EMVCo field: its id, its length in two digits, its value.
 *
 * @param {string} id
 * @param {string} value
 * @returns {string}
 */
export function tlv(id, value) {
    if (value.length > 99) throw new Error(`EMVCo field ${id} is longer than 99 characters`);
    return id + String(value.length).padStart(2, "0") + value;
}

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, no final XOR.
 *
 * @param {string} text - ASCII
 * @returns {number}
 */
export function crc16Ccitt(text) {
    let crc = 0xffff;
    for (const byte of Buffer.from(text, "ascii")) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

/** The note without Vietnamese marks (banks read the note as plain ASCII), other characters dropped. */
function asciiNote(text) {
    return String(text)
        .normalize("NFD")
        .replace(/\p{Mn}/gu, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .replace(/[^\x20-\x7e]/g, "")
        .trim();
}

/**
 * The VietQR transfer payload.
 *
 * @param {{bin: number|string, accountNumber: string, amount?: number|null, content?: string|null}} transfer
 * @returns {string}
 * @throws {Error} for a BIN that is not six digits or an account number that is not 1-19 letters or digits
 */
export function vietQrPayload({ bin, accountNumber, amount = null, content = null }) {
    const b = String(bin);
    if (!/^\d{6}$/.test(b)) throw new Error("The bank's BIN is six digits.");
    const acc = String(accountNumber ?? "").trim();
    if (!/^[A-Za-z0-9]{1,19}$/.test(acc)) throw new Error("The account number is 1-19 letters or digits.");
    const merchant = tlv("00", NAPAS_GUID) + tlv("01", tlv("00", b) + tlv("01", acc)) + tlv("02", SERVICE_TO_ACCOUNT);
    let body = tlv("00", "01") + tlv("01", amount ? "12" : "11") + tlv("38", merchant) + tlv("53", "704");
    if (amount) body += tlv("54", String(Math.trunc(amount)));
    body += tlv("58", "VN");
    const note = content ? asciiNote(content) : "";
    if (note) body += tlv("62", tlv("08", note));
    body += "6304";
    return body + crc16Ccitt(body).toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The VietQR transfer as a QR code image (PNG bytes).
 *
 * @param {Parameters<typeof vietQrPayload>[0]} transfer
 * @returns {Buffer}
 */
export function vietQrPng(transfer) {
    return qrPng(vietQrPayload(transfer));
}
