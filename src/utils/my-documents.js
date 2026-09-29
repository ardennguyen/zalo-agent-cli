/**
 * `me` in a `msg` command's thread argument means My Documents.
 *
 * Zalo's self-chat ("My Documents", "Cloud của tôi") is not the account's own
 * uid. It is a conversation of its own, and sending there is an ordinary 1-1
 * send to its id -- measured against Zalo Web on 2026-09-29, and the replay of
 * `sendMessage(text, <that id>, 0)` is byte-identical to the web's request.
 * The web learns the id from the login config (`send2me_id`), and zca-js
 * already keeps that config at `ctx.loginInfo`. Sending to the own uid instead
 * is rejected with "Tham số không hợp lệ".
 *
 * So both `me` and the own uid resolve to `send2me_id`, as a 1-1:
 *
 *   - `me` is the documented alias.
 *   - The own uid is mapped too, with a notice, because it can never name a
 *     conversation Zalo accepts -- the only thing someone can mean by it is
 *     the self-chat, and refusing would just turn the obvious guess into an
 *     error. Nothing that worked before changes meaning.
 *
 * When the session carries no `send2me_id`, both fail with a clear message
 * rather than send to an id Zalo rejects.
 */

/** The alias, compared case-insensitively. */
export const SELF_ALIAS = "me";

/**
 * Resolve a thread argument that names the self-chat.
 *
 * @param {string} threadId - the argument as typed
 * @param {object} session
 * @param {string|null} session.ownId - this account's uid, when logged in
 * @param {() => (string|null|undefined)} session.send2meId - reads `loginInfo.send2me_id`
 * @param {boolean} [session.groupRequested] - the caller asked for `-t 1`
 * @returns {null|{threadId: string, notice: string}|{error: string}} null when it is not a self reference
 */
export function resolveSelfThread(threadId, { ownId, send2meId, groupRequested = false }) {
    const typed = String(threadId ?? "").trim();
    const alias = typed.toLowerCase() === SELF_ALIAS;
    const own = Boolean(ownId) && typed === String(ownId);
    if (!alias && !own) return null;

    const label = alias ? "`me`" : "Your own uid";
    if (groupRequested) {
        return { error: `${label} means My Documents, which is a 1-1 conversation, not a group. Drop -t 1.` };
    }

    let id = null;
    try {
        id = send2meId();
    } catch (e) {
        return { error: `${label} means My Documents, which needs a logged-in session to resolve: ${e.message}` };
    }
    if (id === undefined || id === null || String(id).trim() === "") {
        return {
            error:
                `${label} means My Documents, but this session did not report its id ` +
                `(loginInfo.send2me_id is empty), so there is nothing to send to.`,
        };
    }
    id = String(id);
    return {
        threadId: id,
        notice: alias
            ? `\`me\` = My Documents (${id}).`
            : `Your own uid is not a conversation Zalo accepts; using My Documents (${id}) instead.`,
    };
}

/**
 * Commander preAction hook body: rewrite a `threadId` argument that names the
 * self-chat, in place, before the action sees it.
 *
 * Works on any command with a positional named `threadId`, and leaves every
 * other command untouched.
 *
 * @param {import("commander").Command} cmd - the command about to run
 * @param {object} session - see {@link resolveSelfThread}; `groupRequested` is derived here
 * @returns {null|{notice: string}|{error: string}}
 */
export function applySelfThreadAlias(cmd, session) {
    const names = (cmd?.registeredArguments || []).map((a) => a.name());
    const idx = names.indexOf("threadId");
    if (idx < 0) return null;
    const value = cmd.processedArgs?.[idx];
    if (typeof value !== "string") return null;

    const groupRequested = Number(cmd.opts?.().type) === 1;
    const resolved = resolveSelfThread(value, { ...session, groupRequested });
    if (!resolved || resolved.error) return resolved;

    cmd.processedArgs[idx] = resolved.threadId;
    if (Array.isArray(cmd.args) && idx < cmd.args.length) cmd.args[idx] = resolved.threadId;
    return { notice: resolved.notice };
}
