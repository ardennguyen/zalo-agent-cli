/**
 * The hidden-chat actions both surfaces run (`conv hidden|hide|unhide|hidden-pin|hidden-pin-reset` and
 * zalo_conversation's `hidden`, `hide`, `unhide`, `hidden_pin`, `hidden_pin_reset`), as Zalo Web does them:
 *
 * - listing needs the PIN; without it only the count and whether a PIN is set are given;
 * - hiding needs a PIN to be set (Web asks for one first); unhiding needs the PIN, as opening a hidden chat does;
 * - changing the PIN needs the current one (when set) and the new one twice;
 * - removing the PIN (`reset`) needs no PIN, and then the device that asked deletes every hidden conversation through
 *   the ordinary delete, which Zalo syncs to the other devices.
 *
 * Nothing here takes the PIN from a command line or returns, logs or stores it (src/core/hidden-chats.js keeps the
 * hash in memory only).
 */

import { createHash } from "node:crypto";
import { markThreadGone } from "./db.js";
import { newestMessageAnchor } from "./conversation-actions.js";
import { pinFailureLine } from "./hidden-chats.js";

const PIN_SHAPE = /^\d{4}$/;

/**
 * The hidden list, read fresh from Zalo into the set.
 *
 * @param {object} api
 * @param {import("./hidden-chats.js").HiddenChats} set
 * @returns {Promise<{count: number, hasPin: boolean, threads: Array<{threadId: string, isGroup: boolean|null}>}>}
 */
export async function readHidden(api, set) {
    const raw = await set.refresh(api);
    const threads = set.threads(raw);
    return { count: threads.length, hasPin: set.hasPin, threads };
}

/**
 * Check a PIN change as typed, then send it. The PINs are not kept.
 *
 * @param {object} api
 * @param {import("./hidden-chats.js").HiddenChats} set - refreshed (it knows whether a PIN is set)
 * @param {{pin?: string, newPin?: string, newPin2?: string}} typed
 * @returns {Promise<{ok: true, hadPin: boolean} | {ok: false, retry: boolean, message: string}>}
 */
export async function changeHiddenPin(api, set, { pin, newPin, newPin2 }) {
    const hadPin = set.hasPin;
    if (hadPin) {
        const r = set.verifyPin(pin);
        if (!r.ok) {
            return { ok: false, retry: r.reason !== "locked", message: `Current PIN: ${pinFailureLine(r)}` };
        }
    }
    if (!PIN_SHAPE.test(String(newPin ?? ""))) return { ok: false, retry: true, message: "The new PIN is 4 digits." };
    if (String(newPin) !== String(newPin2 ?? "")) {
        return { ok: false, retry: true, message: "The two new PINs differ." };
    }
    await api.updateHiddenConversPin(String(newPin));
    set.setPinHash(createHash("md5").update(String(newPin)).digest("hex"));
    return { ok: true, hadPin };
}

/**
 * Remove the PIN as Zalo Web does: list the hidden conversations, reset the PIN, then delete each conversation the way
 * `conv delete` does (backwards from its newest known message), reporting each one.
 *
 * @param {object} api
 * @param {import("./hidden-chats.js").HiddenChats} set
 * @returns {Promise<{reset: true, deleted: number, conversations: Array<{threadId: string, threadType: "dm"|"group", deleted: boolean, error?: string}>}>}
 */
export async function resetHiddenPinAndDelete(api, set) {
    const { threads } = await readHidden(api, set);
    await api.resetHiddenConversPin();
    set.clear();
    const conversations = [];
    for (const t of threads) {
        const type = t.isGroup ? 1 : 0;
        const row = { threadId: t.threadId, threadType: type === 1 ? "group" : "dm", deleted: false };
        try {
            const anchor = await newestMessageAnchor(api, t.threadId, type);
            if (!anchor) {
                row.error =
                    "no cached message carries the ids a delete needs; delete it with `conv delete` and its ids";
            } else {
                await api.deleteChat(anchor, t.threadId, type);
                row.deleted = true;
                try {
                    markThreadGone(String(t.threadId));
                } catch {
                    /* no local cache for this thread */
                }
            }
        } catch (e) {
            row.error = e.message;
        }
        conversations.push(row);
    }
    return { reset: true, deleted: conversations.filter((c) => c.deleted).length, conversations };
}
