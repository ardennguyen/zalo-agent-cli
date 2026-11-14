/**
 * The small number tables the protocol uses, as Zalo sends them (spec-kernel 15). Frozen plain objects: nothing
 * in the engine indexes them backwards.
 */

/** A conversation's kind, as every send and read takes it. */
export const THREAD_TYPE = Object.freeze({ USER: 0, GROUP: 1 });

/** `setMute`'s action. */
export const MUTE_ACTION = Object.freeze({ MUTE: 1, UNMUTE: 3 });

/** `sendReport`'s reason. */
export const REPORT_REASON = Object.freeze({ OTHER: 0, SENSITIVE: 1, ANNOY: 2, FRAUD: 3 });

/** The languages `updateLang` accepts, as the strings it sends. */
export const UPDATE_LANG = Object.freeze({ VI: "VI", EN: "EN" });

/** What the QR login tells its caller, in the order a login goes through them. */
export const QR_EVENT = Object.freeze({
    QR_GENERATED: 0,
    QR_EXPIRED: 1,
    QR_SCANNED: 2,
    QR_DECLINED: 3,
    GOT_LOGIN_INFO: 4,
});
