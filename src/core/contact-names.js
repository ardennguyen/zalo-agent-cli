/**
 * The one way this client names a person: the account owner's alias first, as Zalo shows it.
 *
 * Zalo keeps one record per user (`dName`): the owner's alias when one is set, else the name the owner's contacts give
 * the person, else the user's own name (`zaloName`); a friend the owner saved as "Minh Sales" is "Minh Sales" in the
 * chat header, the group member list, a group message's sender line, a mention, a reaction and a quote alike. The
 * alias list is read again when the server sends an `alias` control (cmd 601), when polling is warned, and when the
 * server's alias version is newer than the one held. This module is that record for the CLI, `listen` and `mcp start`:
 *
 *  - {@link pickName} is the precedence, `alias ?? phonebook name ?? contact name ?? zaloName ?? displayName ?? uid`,
 *    used by every output. The contact name is a profile's `displayName` when it differs from its `zaloName`: Zalo's
 *    profile reads give the name this account knows the person by (with no alias set, the name the owner's contacts
 *    give them), which is what Zalo shows; a `displayName` equal to the Zalo name adds nothing;
 *  - the alias book is the account's alias snapshot, held in memory (a Map lookup on the hot path, never a scan or a
 *    request), loaded once from the account's database (`user_aliases`) and replaced by every complete alias-list
 *    read, {@link startAliasRefresh} keeps it current in a daemon (an `alias` control, then a bounded periodic read);
 *  - the contact book holds the contact names profile reads gave ({@link noteProfiles}: friend lists, profile
 *    lookups, searches), so a message, a mention or a member list names the person the same way without a request;
 *    daemons keep it in the account's database (`user_contact_names`).
 *
 * Stored message rows keep the name the message carried (`senderName`, for audit); the alias is applied when a row is
 * shown or returned, never written over it.
 */
import {
    getDbGeneration,
    getThreadType,
    getUserAliases,
    getUserContactNames,
    isDbOpen,
    replaceUserAliases,
    upsertThread,
    writeUserContactNames,
} from "./db.js";

/** The periodic alias refresh a daemon runs, besides the one an `alias` control triggers. */
export const ALIAS_REFRESH_MS = 30 * 60 * 1000;
/** An `alias` control is followed by one read after this delay; a burst of controls costs one read. */
export const ALIAS_CONTROL_DEBOUNCE_MS = 1500;

const book = {
    generation: -1,
    aliases: new Map(),
    loaded: false,
    fresh: false,
    persist: false,
    contacts: new Map(),
    contactsLoaded: false,
};
const listeners = new Set();
const contactListeners = new Set();

const str = (v) => (typeof v === "string" && v.trim() ? v : null);

/** The book for the database open now; reloaded from it when the open database changed. */
function current() {
    const generation = getDbGeneration();
    if (book.generation !== generation) {
        book.generation = generation;
        book.aliases = new Map();
        book.loaded = false;
        book.fresh = false;
        book.contacts = new Map();
        book.contactsLoaded = false;
    }
    if (!book.contactsLoaded && isDbOpen()) {
        try {
            book.contacts = getUserContactNames();
            book.contactsLoaded = true;
        } catch {
            /* an older database without the table yet: no contact names until the next profile read */
        }
    }
    if (!book.loaded && isDbOpen()) {
        try {
            book.aliases = getUserAliases();
            book.loaded = true;
        } catch {
            /* an older database without the table yet: no aliases until the next read */
        }
    }
    return book;
}

/**
 * The name to show for a person, and the raw values behind it.
 *
 * Accepts the field spellings Zalo uses for a profile (`displayName`/`display_name`/`dName`/`dpn`,
 * `zaloName`/`zalo_name`) and a phonebook name (`pbName`/`phonebookName`: the name the owner's phone contacts give
 * the person, which Zalo puts after the alias). This client reads no phonebook list, so it is used only when a
 * caller passes one.
 *
 * The contact name ({@link contactNameOf}) comes from the fields when they carry both a display name and a Zalo
 * name, else from the contact book; `contactName` in the fields overrides both (null: none).
 *
 * @param {string|number|null} uid
 * @param {object} [fields] - `{alias?, displayName?, zaloName?, ...}`; `alias` undefined means "look it up"
 * @returns {{name: string|null, alias: string|null, contactName: string|null, zaloName: string|null,
 *   displayName: string|null, source: "alias"|"phonebook"|"contact"|"zalo"|"display"|"uid"|"none"}}
 */
export function pickName(uid, fields = {}) {
    const id = uid === undefined || uid === null || uid === "" ? null : String(uid);
    const f = fields || {};
    const alias = f.alias === undefined ? aliasFor(id) : str(f.alias);
    const displayName = str(f.displayName) ?? str(f.display_name) ?? str(f.dName) ?? str(f.dpn);
    const zaloName = str(f.zaloName) ?? str(f.zalo_name);
    const phonebookName = str(f.pbName) ?? str(f.phonebookName);
    let contactName;
    if (f.contactName !== undefined) contactName = str(f.contactName);
    else if (displayName && zaloName) contactName = contactNameOf(f);
    else contactName = contactNameFor(id);
    if (contactName && contactName === zaloName) contactName = null;
    const base = {
        alias,
        contactName: contactName ?? null,
        zaloName: zaloName ?? displayName ?? null,
        displayName: displayName ?? null,
    };
    if (alias) return { name: alias, ...base, source: "alias" };
    if (phonebookName) return { name: phonebookName, ...base, source: "phonebook" };
    if (contactName) return { name: contactName, ...base, source: "contact" };
    if (zaloName) return { name: zaloName, ...base, source: "zalo" };
    if (displayName) return { name: displayName, ...base, source: "display" };
    return id ? { name: id, ...base, source: "uid" } : { name: null, ...base, source: "none" };
}

/**
 * The owner's alias for a user, or null. A Map lookup: safe on the hot path.
 *
 * @param {string|number|null} uid
 * @returns {string|null}
 */
export function aliasFor(uid) {
    if (uid === undefined || uid === null || uid === "") return null;
    return current().aliases.get(String(uid)) ?? null;
}

/**
 * The contact name a profile object carries: its display name (any spelling) when it also carries a Zalo name and
 * the two differ, else null. Pure.
 *
 * @param {object} profile
 * @returns {string|null}
 */
export function contactNameOf(profile) {
    if (!profile || typeof profile !== "object") return null;
    const displayName = str(profile.displayName) ?? str(profile.display_name) ?? str(profile.dName) ?? str(profile.dpn);
    const zaloName = str(profile.zaloName) ?? str(profile.zalo_name);
    return displayName && zaloName && displayName.trim() !== zaloName.trim() ? displayName : null;
}

/**
 * The contact name the last profile read gave a user (the contact book), or null. A Map lookup: safe on the hot path.
 *
 * @param {string|number|null} uid
 * @returns {string|null}
 */
export function contactNameFor(uid) {
    if (uid === undefined || uid === null || uid === "") return null;
    return current().contacts.get(String(uid)) ?? null;
}

/**
 * The name this account knows a user by, as Zalo shows it: the owner's alias, else the contact name, else null (the
 * caller then uses the user's own name).
 *
 * @param {string|number|null} uid
 * @returns {string|null}
 */
export function preferredNameFor(uid) {
    return aliasFor(uid) ?? contactNameFor(uid);
}

/**
 * Take what profile reads said about users' names into the contact book. A profile carrying both a display name and
 * a Zalo name sets the user's contact name (the display name, when it differs from the Zalo name and is not the
 * owner's alias) or clears it (the two are the same); a profile without both names says nothing. Daemons persist the
 * changes; listeners are told which users changed.
 *
 * @param {Map<string, object>|Iterable<object>} profiles - uid -> profile, or profile objects (`userId`/`uid`/`id`)
 * @returns {string[]} the user ids whose contact name changed
 */
export function noteProfiles(profiles) {
    if (!profiles || typeof profiles[Symbol.iterator] !== "function") return [];
    const b = current();
    const entries =
        profiles instanceof Map ? [...profiles] : [...profiles].map((p) => [p?.userId ?? p?.uid ?? p?.id, p]);
    const changes = new Map();
    const shown = new Map();
    for (const [uid, p] of entries) {
        if (uid === undefined || uid === null || uid === "" || !p || typeof p !== "object") continue;
        const id = String(uid);
        const displayName = str(p.displayName) ?? str(p.display_name) ?? str(p.dName) ?? str(p.dpn);
        const zaloName = str(p.zaloName) ?? str(p.zalo_name);
        if (!displayName || !zaloName) continue;
        const name = contactNameOf(p);
        // A display name equal to the owner's alias is the alias itself: it says nothing about a contact name.
        if (name && name === b.aliases.get(id)) continue;
        if ((b.contacts.get(id) ?? null) !== name) {
            changes.set(id, name);
            shown.set(id, name ?? zaloName);
        }
    }
    if (!changes.size) return [];
    const next = new Map(b.contacts);
    for (const [id, name] of changes) {
        if (name) next.set(id, name);
        else next.delete(id);
    }
    b.contacts = next;
    if (b.persist && isDbOpen()) {
        try {
            writeUserContactNames(changes);
        } catch {
            /* the in-memory book still serves this process */
        }
    }
    const changed = [...changes.keys()];
    for (const fn of contactListeners) safe(() => fn(changed, shown));
    return changed;
}

/**
 * Be told when contact names change (stored DM titles, thread-name caches): the ids, and for each the name the
 * profile read gives without the alias (the contact name, else the Zalo name).
 *
 * @param {(changedIds: string[], names: Map<string, string>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onContactNameChange(fn) {
    contactListeners.add(fn);
    return () => contactListeners.delete(fn);
}

/**
 * The name to show for a user who arrived with a raw name (a message's `dName`, a stored `senderName`): the alias
 * when the owner set one, else the contact name, else that raw name, else null.
 *
 * @param {string|number|null} uid
 * @param {string|null} [rawName]
 * @returns {string|null}
 */
export function nameFor(uid, rawName = null) {
    return preferredNameFor(uid) ?? str(rawName) ?? null;
}

/**
 * A 1-1 conversation's title: the owner's alias for the peer, else the contact name, else the stored title.
 *
 * @param {string|number} threadId - the peer's user id
 * @param {string|null} [storedName]
 * @returns {string|null}
 */
export function dmTitle(threadId, storedName = null) {
    return preferredNameFor(threadId) ?? (storedName || null);
}

/**
 * The alias snapshot this process read from Zalo itself (a daemon's), or null when it has only the stored one or
 * none: a caller that needs a current snapshot then reads one itself.
 *
 * @returns {Map<string, string>|null}
 */
export function aliasSnapshot() {
    const b = current();
    return b.fresh ? b.aliases : null;
}

/**
 * Record one alias this process just set or removed (`friend alias`, zalo_friend `alias`), before the server's own
 * `alias` control brings the full list back.
 *
 * @param {string|number} uid
 * @param {string|null} alias - null or empty when removed
 */
export function noteAliasSet(uid, alias) {
    const next = new Map(current().aliases);
    if (str(alias)) next.set(String(uid), alias);
    else next.delete(String(uid));
    noteAliasSnapshot(next);
}

/**
 * After an alias change, retitle the stored 1-1 conversations of the users whose alias changed: the new alias, or,
 * for a removed alias, the user's current profile name (one batched lookup for just those users). Group titles are
 * never touched. Best effort; returns the titles written so a thread-name cache can take them too.
 *
 * @param {object|null} api
 * @param {string[]} changedIds
 * @param {(line: string) => void} [log]
 * @returns {Promise<Map<string, string>>} userId -> the title written
 */
export async function retitleDmThreads(api, changedIds, log = () => {}) {
    const written = new Map();
    if (!isDbOpen() || !changedIds?.length) return written;
    const dms = changedIds.map(String).filter((id) => {
        try {
            return getThreadType(id) === "dm";
        } catch {
            return false;
        }
    });
    const removed = [];
    for (const id of dms) {
        const preferred = preferredNameFor(id);
        if (preferred) written.set(id, preferred);
        else removed.push(id);
    }
    if (removed.length && api) {
        try {
            const { resolveCurrentUserNames } = await import("./current-user-names.js");
            const names = await resolveCurrentUserNames(api, removed, { aliases: current().aliases, log });
            for (const [id, n] of names) if (n.source !== "uid" && n.name) written.set(id, n.name);
        } catch {
            /* the display-time lookup still applies the alias; a removed one keeps its old title until a sync */
        }
    }
    for (const [id, name] of written) {
        try {
            upsertThread({ threadId: id, type: "dm", name, lastUpdate: 0 });
        } catch {
            written.delete(id);
        }
    }
    return written;
}

/**
 * Retitle the stored 1-1 conversations of users whose contact name changed: the alias when set, else the name the
 * profile read gave. No request; group titles are never touched.
 *
 * @param {string[]} ids
 * @param {Map<string, string>} names - userId -> the contact name, else the Zalo name
 * @returns {Map<string, string>} userId -> the title written
 */
export function retitleDmTitles(ids, names) {
    const written = new Map();
    if (!isDbOpen() || !ids?.length) return written;
    for (const id of ids.map(String)) {
        const title = aliasFor(id) ?? names?.get(id) ?? null;
        if (!title) continue;
        try {
            if (getThreadType(id) !== "dm") continue;
            upsertThread({ threadId: id, type: "dm", name: title, lastUpdate: 0 });
            written.set(id, title);
        } catch {
            /* a title that fails to store keeps the display-time name */
        }
    }
    return written;
}

/**
 * The sender fields of a message as every output returns them: `senderName` alias-first (then the contact name, then
 * the name the message carried), plus the raw values.
 *
 * @param {string|number|null} senderId
 * @param {string|null} rawName - the name the message carried (stored as `senderName`)
 * @returns {{senderName: string|null, senderAlias: string|null, senderZaloName: string|null}}
 */
export function senderNameFields(senderId, rawName) {
    const alias = aliasFor(senderId);
    const raw = str(rawName);
    return { senderName: alias ?? contactNameFor(senderId) ?? raw ?? null, senderAlias: alias, senderZaloName: raw };
}

/**
 * "Name (uid)" for a human-readable line, alias first; just the uid when no name is known.
 *
 * @param {string|number|null} uid
 * @param {string|null} [rawName] - the name the event carried, if any
 * @returns {string}
 */
export function personLabel(uid, rawName = null) {
    const id = uid === undefined || uid === null || uid === "" ? "?" : String(uid);
    const name = nameFor(uid, rawName);
    return name && name !== id ? `${name} (${id})` : id;
}

/**
 * A group event's `data` with its people named alias first: each `updateMembers[]` entry's `dName` becomes the name
 * to show, with `alias` and `zaloName` (the name the event carried) beside it, and the actor gets `sourceName`.
 * A copy; the event itself (and what is stored from it) is not changed.
 *
 * @param {object} data - a `group_event`'s data
 * @returns {object}
 */
export function groupEventNames(data) {
    if (!data || typeof data !== "object") return data;
    const out = { ...data };
    if (Array.isArray(data.updateMembers)) {
        out.updateMembers = data.updateMembers.map((m) => {
            if (!m || typeof m !== "object") return m;
            const alias = aliasFor(m.id);
            const raw = str(m.dName);
            return { ...m, dName: alias ?? contactNameFor(m.id) ?? raw, alias, zaloName: raw };
        });
    }
    if (data.sourceId !== undefined && data.sourceId !== null) out.sourceName = nameFor(data.sourceId);
    return out;
}

/**
 * The person fields of a profile-like object as every output returns them: `displayName` alias-first (the existing
 * field), plus `alias` and `zaloName`.
 *
 * @param {string|number|null} uid
 * @param {object} [profile]
 * @returns {{displayName: string|null, alias: string|null, zaloName: string|null}}
 */
export function personNameFields(uid, profile) {
    const p = pickName(uid, { ...profile, alias: undefined });
    const shown = p.source === "uid" ? null : p.name;
    return { displayName: shown, alias: p.alias, zaloName: p.zaloName };
}

/**
 * A copy of a raw Zalo person object (a friend, a profile, a group member, a search result) as a `--json` reply
 * returns it: whichever name fields it has (`displayName`, `dName`, `display_name`) carry the owner's alias when
 * one is set, else the contact name (the object's own when it carries both names, else the contact book's), `alias`
 * is added, and `zaloName` is added when the object had none (the name before the alias).
 *
 * @param {object} p
 * @param {string|number} [uid] - defaults to the object's `userId`, `uid` or `id`
 * @returns {object}
 */
export function aliasFirst(p, uid = p?.userId ?? p?.uid ?? p?.id) {
    if (!p || typeof p !== "object") return p;
    const alias = aliasFor(uid);
    const out = { ...p, alias };
    if (out.zaloName === undefined) {
        out.zaloName = str(p.zalo_name) ?? str(p.displayName) ?? str(p.dName) ?? str(p.display_name) ?? null;
    }
    const own = (str(p.displayName) ?? str(p.display_name) ?? str(p.dName)) && (str(p.zaloName) ?? str(p.zalo_name));
    const shown = alias ?? (own ? contactNameOf(p) : contactNameFor(uid));
    if (shown) {
        let named = false;
        for (const k of ["displayName", "dName", "display_name"]) {
            if (k in p) {
                out[k] = shown;
                named = true;
            }
        }
        if (!named) out.displayName = shown;
    }
    return out;
}

/**
 * Make sure this process holds a current alias snapshot before naming people: a one-shot command reads the alias
 * list once (nothing when a snapshot was already read). A failed read leaves the stored snapshot in use.
 *
 * @param {object} api
 * @returns {Promise<boolean>} whether a current snapshot is held
 */
export async function ensureAliases(api) {
    if (current().fresh) return true;
    return Boolean(await refreshAliases(api).catch(() => null));
}

/**
 * Take a complete alias snapshot (a missing user has no alias). Persisted to the account's database when this
 * process keeps it (a daemon); listeners are told what changed.
 *
 * @param {Map<string, string>} aliases
 * @returns {string[]} the user ids whose alias changed
 */
export function noteAliasSnapshot(aliases) {
    if (!(aliases instanceof Map)) return [];
    const b = current();
    // Nothing held yet and no snapshot taken: this one is a first load, not a change.
    const first = b.aliases.size === 0 && !b.fresh;
    const changed = [];
    for (const [id, alias] of aliases) if (b.aliases.get(id) !== alias) changed.push(id);
    for (const id of b.aliases.keys()) if (!aliases.has(id)) changed.push(id);
    b.aliases = new Map(aliases);
    b.loaded = true;
    b.fresh = true;
    // A contact name equal to a new alias was the alias itself (read before the alias list was): drop it.
    const stale = new Map();
    for (const id of changed) if (b.aliases.has(id) && b.contacts.get(id) === b.aliases.get(id)) stale.set(id, null);
    if (stale.size) {
        b.contacts = new Map([...b.contacts].filter(([id]) => !stale.has(id)));
        if (b.persist && isDbOpen()) {
            try {
                writeUserContactNames(stale);
            } catch {
                /* the in-memory book still serves this process */
            }
        }
    }
    if (b.persist && isDbOpen()) {
        try {
            replaceUserAliases(b.aliases);
        } catch {
            /* the in-memory snapshot still serves this process */
        }
    }
    if (changed.length) for (const fn of listeners) safe(() => fn(changed, b.aliases, { first }));
    return changed;
}

/**
 * Keep alias snapshots in the account's database (a daemon: `listen`, `mcp start`), so a one-shot command that reads
 * only the cache (`msg list`, `msg search`, `conv list`, `db export`) names people by alias without a request.
 *
 * @param {boolean} [on=true]
 */
export function setAliasPersistence(on = true) {
    book.persist = Boolean(on);
}

/**
 * Be told when aliases change (thread-name caches, stored DM titles).
 *
 * @param {(changedIds: string[], aliases: Map<string, string>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onAliasChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Read the alias list now and take it as the snapshot. A failed or partial read keeps the snapshot held.
 *
 * @param {object} api
 * @returns {Promise<Map<string, string>|null>} the snapshot read, or null when the read failed
 */
export async function refreshAliases(api) {
    const { readUserAliasSnapshot } = await import("./current-user-names.js");
    return readUserAliasSnapshot(api);
}

/**
 * A daemon's alias refresher: one read at start, one shortly after each `alias` control (debounced), and one every
 * `intervalMs`. Reads never overlap, the timers are unref'd, and nothing here throws into the caller.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getApi - the current session (null while re-logging in)
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.debounceMs]
 * @param {(line: string) => void} [opts.log]
 * @returns {{trigger: (why?: string) => void, refreshNow: (why?: string) => Promise<boolean>, stop: () => void}}
 */
export function startAliasRefresh({
    getApi,
    intervalMs = ALIAS_REFRESH_MS,
    debounceMs = ALIAS_CONTROL_DEBOUNCE_MS,
    log = () => {},
} = {}) {
    let running = null;
    let again = false;
    let pending = null;
    let stopped = false;
    const refreshNow = async (why = "periodic") => {
        if (stopped) return false;
        if (running) {
            again = true;
            return running;
        }
        running = (async () => {
            let api = null;
            try {
                api = getApi?.();
            } catch {
                api = null;
            }
            if (!api) return false;
            const before = current().aliases;
            const snap = await refreshAliases(api).catch(() => null);
            if (!snap) {
                log(`aliases: refresh (${why}) failed; keeping the ${before.size} held`);
                return false;
            }
            return true;
        })();
        try {
            return await running;
        } finally {
            running = null;
            if (again && !stopped) {
                again = false;
                refreshNow("queued").catch(() => {});
            }
        }
    };
    const trigger = (why = "alias control") => {
        if (stopped) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = null;
            refreshNow(why).catch(() => {});
        }, debounceMs);
        pending.unref?.();
    };
    const timer = intervalMs > 0 ? setInterval(() => refreshNow("periodic").catch(() => {}), intervalMs) : null;
    timer?.unref?.();
    return {
        trigger,
        refreshNow,
        stop() {
            stopped = true;
            if (pending) clearTimeout(pending);
            if (timer) clearInterval(timer);
        },
    };
}

/**
 * The account's own current profile (`fetchAccountInfo`): its name (the Zalo name, else the display name) and its
 * phone number when Zalo gives one.
 *
 * @param {() => object|null} getApi
 * @returns {Promise<{name: string|null, phone: string|null}|null>}
 */
async function readOwnProfile(getApi) {
    const api = getApi?.();
    if (typeof api?.fetchAccountInfo !== "function") return null;
    const info = await api.fetchAccountInfo();
    const p = info?.profile || info || {};
    return { name: str(p.zaloName) ?? str(p.displayName) ?? null, phone: str(p.phoneNumber) ?? null };
}

/** Forget the in-memory book (tests). */
export function resetAliasBook() {
    book.generation = -1;
    book.aliases = new Map();
    book.loaded = false;
    book.fresh = false;
    book.persist = false;
    book.contacts = new Map();
    book.contactsLoaded = false;
    listeners.clear();
    contactListeners.clear();
}

function safe(fn) {
    try {
        fn();
    } catch {
        /* a listener's failure is its own */
    }
}

/**
 * Everything a daemon (`listen`, `mcp start`) does for aliases, in one place so the two stay the same: keep the
 * snapshot in the account's database, read it at start, reread it on an `alias` control and every
 * {@link ALIAS_REFRESH_MS}, and retitle the stored 1-1 conversations whose alias changed.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getApi
 * @param {(line: string) => void} [opts.log]
 * @param {(titles: Map<string, string>) => void} [opts.onRetitled] - e.g. update a thread-name cache
 * @param {(profile: {name: string|null, phone: string|null}) => void} [opts.onOwnProfile] - the account's own name
 *   and phone: read once when the first listener attaches, reread after a `profile` control
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.debounceMs]
 * @returns {{attach: (listener: object) => void, refreshNow: (why?: string) => Promise<boolean>,
 *   trigger: (why?: string) => void, stop: () => void}}
 */
export function startDaemonAliases({ getApi, log = () => {}, onRetitled, onOwnProfile, intervalMs, debounceMs } = {}) {
    setAliasPersistence(true);
    const refresher = startAliasRefresh({ getApi, log, intervalMs, debounceMs });
    let profileRead = false;
    const readProfile = (why) => {
        if (typeof onOwnProfile !== "function") return;
        readOwnProfile(getApi)
            .then((p) => p && (p.name || p.phone) && onOwnProfile(p))
            .catch(() => log(`profile: own profile not read (${why})`));
    };
    const off = onAliasChange((ids, _aliases, { first = false } = {}) => {
        log(first ? `aliases: loaded ${ids.length}` : `aliases: ${ids.length} changed`);
        let api = null;
        try {
            api = getApi?.() ?? null;
        } catch {
            api = null;
        }
        retitleDmThreads(api, ids, log)
            .then((titles) => titles.size && onRetitled?.(titles))
            .catch(() => {});
    });
    // A contact name a profile read changed: the stored 1-1 titles follow it (the alias still wins), as Zalo's do.
    const offContacts = onContactNameChange((ids, names) => {
        const titles = retitleDmTitles(ids, names);
        if (titles.size) safe(() => onRetitled?.(titles));
    });
    return {
        attach(listener) {
            listener?.on?.("alias_change", () => refresher.trigger("alias control"));
            // Own name or avatar changed on another device (`profile` control, act `update`): reread it, as Zalo
            // does. Its other acts (`update_status`, `phonebook`, `mode`, `biz`) change no name this client shows.
            listener?.on?.("profile_change", (change) => {
                if (change?.act === "update") readProfile("profile control");
            });
            // Once per daemon, at start, as Zalo reads the signed-in profile: an account that logged in
            // before the phone was kept has none stored yet, and a rename made while the daemon was down is caught.
            if (!profileRead) {
                profileRead = true;
                readProfile("start");
            }
        },
        refreshNow: refresher.refreshNow,
        trigger: refresher.trigger,
        stop() {
            off();
            offContacts();
            refresher.stop();
        },
    };
}
