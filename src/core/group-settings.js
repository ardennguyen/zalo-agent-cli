/**
 * `group settings`' flags, mapped to the GroupSetting keys they toggle.
 *
 * The read-modify-write against Zalo (and why it must be one) is the protocol layer's:
 * src/zalo/custom/group-settings.js. This module only turns the command's options into the changes it sends.
 */

/**
 * CLI flag -> the GroupSetting key it toggles. Each flag also has a `--no-`
 * form. `topic-only` is Zalo Web's ONLY_ADMIN_SET_TOPIC: when 1, only the
 * owner and admins can pin messages, notes and polls to the top of the chat
 * (the web's `checkAuth` denies a plain member `allowPin` then, ~2668943).
 */
export const SETTING_FLAGS = Object.freeze({
    "block-name": "blockName",
    "sign-admin": "signAdminMsg",
    "msg-history": "enableMsgHistory",
    "join-appr": "joinAppr",
    "lock-post": "lockCreatePost",
    "lock-poll": "lockCreatePoll",
    "lock-msg": "lockSendMsg",
    "lock-view-member": "lockViewMember",
    "topic-only": "setTopicOnly",
});

/** Commander's option key for a flag: "lock-view-member" -> "lockViewMember". */
const optionKey = (flag) => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * The setting changes the user actually asked for.
 *
 * Commander leaves an option undefined when neither `--X` nor `--no-X` was
 * typed (`--X` is declared first, so it has no default). That undefined is the
 * whole difference between "leave it" and "turn it off", so it must never be
 * collapsed into false.
 *
 * @param {object} opts - the `group settings` Commander options
 * @returns {Record<string, 0|1>} GroupSetting key -> requested value, only for flags given
 */
export function settingChangesFromOptions(opts) {
    const changes = {};
    for (const [flag, key] of Object.entries(SETTING_FLAGS)) {
        const value = opts?.[optionKey(flag)];
        if (value === undefined) continue;
        changes[key] = value ? 1 : 0;
    }
    return changes;
}
