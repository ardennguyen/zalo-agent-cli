/**
 * The CLI half of src/core/known-ids.js: the commands that take a person or a conversation refuse an id this account
 * has never seen (`UNKNOWN_TO_ACCOUNT`, exit 1) before anything is sent, unless `--allow-unknown`; the lookups that
 * hand out this account's ids (`friend find`, `friend find-username`, `friend find-phones`, `group members`) record
 * them ({@link recordCliKnownIds}), so the command that follows with one is not refused.
 *
 * The commands are listed in one table ({@link CLI_ID_GUARDS}) and attached by {@link installKnownIdGuards}; the
 * preAction hook (src/index.js) settles them through {@link enforceKnownIds} after the login.
 */
import { getActive } from "../core/accounts.js";
import { getAccountDbPath, getAccountDir } from "../core/credentials.js";
import { initDb, isDbOpen } from "../core/db.js";
import {
    UNKNOWN_TO_ACCOUNT,
    findUnknownIds,
    mentionUids,
    recordKnownIds,
    unknownIdRefusal,
} from "../core/known-ids.js";
import { getApi } from "../core/zalo-client.js";
import { error } from "../utils/output.js";

/** What a conversation id is by the command's `--type`: a group with 1, either when the type was not given. */
function threadAs(cmd) {
    try {
        if (cmd.getOptionValueSource?.("type") === "default") return "thread";
    } catch {
        /* no --type: either */
    }
    const t = cmd.opts?.().type;
    if (t === undefined) return "thread";
    return Number(t) === 1 ? "group" : "user";
}

const at = (i, field) => (cmd, args) => [{ id: args[i], as: threadAs(cmd), field }];
const person = (i, field) => (_cmd, args) =>
    (Array.isArray(args[i]) ? args[i] : [args[i]]).map((id) => ({ id, as: "user", field }));

/** The users a `--mention pos:userId:len` names. */
const mentionSpecUids = (specs) =>
    (Array.isArray(specs) ? specs : []).map((s) => String(s).split(":")[1]).filter((u) => u && u !== "-1");

/** Per guarded command (`group sub`): the ids its arguments name. */
export const CLI_ID_GUARDS = {
    "msg send": (cmd, args) => [
        ...at(0, "threadId")(cmd, args),
        ...[...mentionUids(args[1]), ...mentionSpecUids(cmd.opts().mention)].map((id) => ({
            id,
            as: "user",
            field: "mention",
        })),
    ],
    "msg send-image": at(0, "threadId"),
    "msg send-file": at(0, "threadId"),
    "msg send-card": (cmd, args) => [...at(0, "threadId")(cmd, args), ...person(1, "userId")(cmd, args)],
    "msg send-bank": at(0, "threadId"),
    "msg send-qr-transfer": at(0, "threadId"),
    "msg sticker": at(0, "threadId"),
    "msg send-voice": at(0, "threadId"),
    "msg send-link": at(0, "threadId"),
    "msg send-video": at(0, "threadId"),
    "msg react": at(1, "threadId"),
    "msg forward": at(1, "threadId"),
    "msg history": at(0, "threadId"),
    "msg typing": at(0, "threadId"),
    "friend info": person(0, "userId"),
    "friend add": person(0, "userId"),
    "friend remove": person(0, "userId"),
    "friend block": person(0, "userId"),
    "friend unblock": person(0, "userId"),
    "friend last-online": person(0, "userId"),
    "friend alias": person(0, "friendId"),
    "friend alias-remove": person(0, "friendId"),
    "friend undo-request": person(0, "userId"),
    "friend request-status": person(0, "userId"),
    "friend qr": person(0, "userIds"),
    "friend common-groups": person(0, "friendIds"),
    "friend biz": person(0, "friendId"),
    "friend block-feed": person(0, "userId"),
    "group members": (_cmd, args) => [{ id: args[0], as: "group", field: "groupId" }],
};

/**
 * Give every command of CLI_ID_GUARDS `--allow-unknown` and its check. A command missing from the program is an
 * error: the table names commands that exist.
 *
 * @param {import("commander").Command} program
 */
export function installKnownIdGuards(program) {
    for (const [path, ids] of Object.entries(CLI_ID_GUARDS)) {
        const [group, sub] = path.split(" ");
        const cmd = program.commands.find((c) => c.name() === group)?.commands.find((c) => c.name() === sub);
        if (!cmd) throw new Error(`no "${path}" command to guard`);
        cmd.option(
            "--allow-unknown",
            "Use the id even when this account has never seen it (user ids differ per account; see UNKNOWN_TO_ACCOUNT)",
        );
        cmd.zaloKnownIds = ids;
    }
}

/** The active account's id and folder, or nulls. */
function activeAccount() {
    try {
        const acc = getActive();
        return acc?.ownId ? { ownId: String(acc.ownId), accountDir: getAccountDir(acc.ownId) } : null;
    } catch {
        return null;
    }
}

/**
 * The preAction half: refuse a guarded command whose ids this account does not know (exit 1), before its action runs.
 *
 * @param {import("commander").Command} command - the command about to run
 * @param {{json?: boolean, api?: object|null}} [how]
 * @returns {Promise<boolean>} true when the command may go ahead
 */
export async function enforceKnownIds(command, { json = false, api } = {}) {
    const spec = command?.zaloKnownIds;
    if (!spec) return true;
    const opts = command.opts();
    if (opts.allowUnknown === true) return true;
    const acc = activeAccount();
    if (!acc) return true;
    if (!isDbOpen()) {
        try {
            initDb(getAccountDbPath(acc.ownId));
        } catch {
            /* no cache: the account's lists still answer */
        }
    }
    let session = api;
    if (session === undefined) {
        try {
            session = getApi();
        } catch {
            session = null;
        }
    }
    const targets = spec(command, command.processedArgs ?? command.args ?? []);
    const unknown = await findUnknownIds(targets, { api: session, ownId: acc.ownId, accountDir: acc.accountDir });
    if (!unknown.length) return true;
    const r = unknownIdRefusal(unknown, { surface: "cli" });
    if (json) {
        process.exitCode = 1;
        console.log(JSON.stringify({ error: r.message, code: UNKNOWN_TO_ACCOUNT, unknownIds: r.unknownIds }, null, 2));
    } else error(r.message);
    return false;
}

/**
 * Record ids a lookup of the active account handed out (`friend find`, `group members`, ...). Best effort.
 *
 * @param {Iterable<string|number|null|undefined>} ids
 */
export function recordCliKnownIds(ids) {
    const acc = activeAccount();
    if (acc) recordKnownIds(acc.accountDir, acc.ownId, ids);
}
