/**
 * The Companion Router's decisions (docs/agent-routing.md §2): which handler gets an incoming message, who holds a
 * conversation (claims, the owner's human pause, sticky focus), and whether a send may go out. Pure where it can be:
 * {@link decide} reads state through the context it is given and returns the effects for the caller to apply, so the
 * console's test box and the daemon run the same function.
 *
 * Settings (the live policy's `routing.*`, checked by {@link checkRouting}):
 *
 *     enabled            routing on (off: every caller sees every message, as before)
 *     claims             claims, human pause, reply affinity, sticky focus and fallback (the Companion Router add-on)
 *     isolation          per-agent privacy: read tools limited to routed conversations (Companion Router Pro)
 *     owners             other Zalo user ids of the owner (his own messages count as the owner's anyway)
 *     routes             the ordered table, first match wins
 *     default            {target, fallback}: when no route matches
 *     staff              [{id, name, mark?, zaloUserId?, channels: ["console"|"zalo"]}]
 *     settings           claimTtl, humanPause, stickyTtl, affinityTtl, fallbackAfter (durations; unset: the defaults)
 *
 * A target is an agent slug, `human` (the owner in the Zalo apps), `nobody`, or `staff:<id>`.
 */

/** The defaults in effect when a setting is unset (shown as such in the console). */
export const ROUTING_DEFAULTS = Object.freeze({
    claimTtl: 30 * 60_000,
    humanPause: 15 * 60_000,
    stickyTtl: 30 * 60_000,
    affinityTtl: 7 * 24 * 3600_000,
    fallbackAfter: 5 * 60_000,
});
export const MAX_ROUTES = 500;
const KINDS = ["text", "photo", "file", "voice", "link", "video", "sticker"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TARGET = /^([a-z][a-z0-9-]{0,23}|human|nobody|staff:[A-Za-z0-9_-]{1,64})$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UID = /^[0-9]{1,30}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const durationMs = (v) => {
    if (typeof v === "number" && v > 0) return v;
    const m = /^\s*(\d+)\s*(s|m|h|d)\s*$/i.exec(String(v ?? ""));
    return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2].toLowerCase()] : null;
};
const words = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/**
 * Check one fallback chain: agent slugs, `human`, or `{autoReply: text}`.
 * @param {unknown} v
 * @param {string} at
 */
function checkChain(v, at) {
    if (v === undefined || v === null) return { value: null };
    if (!Array.isArray(v) || v.length > 5) return { error: `${at} is not a list of at most 5 steps` };
    const out = [];
    for (const s of v) {
        if (typeof s === "string" && TARGET.test(s) && s !== "nobody") out.push(s);
        else if (isObj(s) && typeof s.autoReply === "string" && s.autoReply.trim() && s.autoReply.length <= 500)
            out.push({ autoReply: s.autoReply.trim() });
        else return { error: `${at} has a step that is not an agent, human, staff:<id> or {autoReply}` };
    }
    return { value: out };
}

/**
 * Check one route.
 * @param {unknown} r
 * @param {number} i
 * @returns {{value: object} | {error: string}}
 */
function checkRoute(r, i) {
    const at = `routes[${i}]`;
    if (!isObj(r)) return { error: `${at} is not an object` };
    const id = String(r.id ?? "").trim();
    if (!ID.test(id)) return { error: `${at}.id is not 1-64 letters, digits, - or _` };
    const target = String(r.target ?? "");
    if (!TARGET.test(target)) return { error: `${at}.target is not an agent, human, nobody or staff:<id>` };
    const m = isObj(r.match) ? r.match : {};
    const match = {};
    if (m.threads !== undefined) match.threads = words(m.threads).slice(0, 200);
    if (m.threadType !== undefined) {
        if (!["dm", "group"].includes(m.threadType)) return { error: `${at}.match.threadType is not dm or group` };
        match.threadType = m.threadType;
    }
    if (m.myDocuments !== undefined) match.myDocuments = m.myDocuments === true;
    if (m.senders !== undefined) {
        const s = words(m.senders);
        if (s.some((x) => x !== "owner" && x !== "anyone" && !UID.test(x)))
            return { error: `${at}.match.senders holds something that is not owner, anyone or a user id` };
        match.senders = s;
    }
    if (m.labels !== undefined) match.labels = words(m.labels).slice(0, 20);
    if (m.mentionsAccount !== undefined) match.mentionsAccount = m.mentionsAccount === true;
    if (m.kinds !== undefined) {
        const k = words(m.kinds);
        if (k.some((x) => !KINDS.includes(x)))
            return { error: `${at}.match.kinds is not a list of ${KINDS.join(", ")}` };
        match.kinds = k;
    }
    if (m.trigger !== undefined) {
        const t = isObj(m.trigger) ? m.trigger : {};
        const word = String(t.word ?? "").trim();
        const who = t.who ?? "owner";
        // Customers may use a trigger only in its hashtag form (owner, 2026-11-20); `@`, `-` and plain words stay owner-only.
        if (!/^[@#/]?[\p{L}\p{N}_-]{1,32}:?$/u.test(word)) return { error: `${at}.match.trigger.word is not one word` };
        if (!["owner", "anyone"].includes(who)) return { error: `${at}.match.trigger.who is not owner or anyone` };
        if (who === "anyone" && !word.startsWith("#"))
            return { error: `${at}.match.trigger: a trigger customers may use is a hashtag (#word)` };
        match.trigger = { word: word.toLowerCase(), who, sticky: t.sticky === true, strip: t.strip !== false };
    }
    if (m.window !== undefined) {
        const w = isObj(m.window) ? m.window : {};
        const days = words(w.days);
        if (days.some((d) => !DAYS.includes(d))) return { error: `${at}.match.window.days are not sun..sat` };
        if (!HHMM.test(String(w.from ?? "")) || !HHMM.test(String(w.to ?? "")))
            return { error: `${at}.match.window.from/to are not HH:mm` };
        match.window = {
            days: days.length ? days : DAYS,
            from: w.from,
            to: w.to,
            tz: String(w.tz || "Asia/Ho_Chi_Minh"),
        };
    }
    const fb = checkChain(r.fallback, `${at}.fallback`);
    if (fb.error) return fb;
    const observers = words(r.observers).filter((x) => /^[a-z][a-z0-9-]{0,23}$/.test(x));
    const ownership = ["thread", "message", "auto"].includes(r.ownership) ? r.ownership : "auto";
    return {
        value: {
            id,
            name: String(r.name ?? "").slice(0, 80),
            enabled: r.enabled !== false,
            match,
            target,
            observers,
            ownership,
            fallback: fb.value,
        },
    };
}

/**
 * Check and normalize the routing settings (everything but `agents`, `marks` and `presenceWindow`, which
 * src/core/routing-policy.js checks).
 *
 * @param {unknown} value - the `routing` block
 * @returns {{value: object} | {error: string}}
 */
export function checkRouting(value) {
    const v = isObj(value) ? value : {};
    const routes = [];
    if (v.routes !== undefined) {
        if (!Array.isArray(v.routes) || v.routes.length > MAX_ROUTES)
            return { error: `routes is not a list of at most ${MAX_ROUTES}` };
        const ids = new Set();
        for (const [i, r] of v.routes.entries()) {
            const c = checkRoute(r, i);
            if (c.error) return c;
            if (ids.has(c.value.id)) return { error: `routes[${i}].id "${c.value.id}" is used twice` };
            ids.add(c.value.id);
            routes.push(c.value);
        }
    }
    const d = isObj(v.default) ? v.default : {};
    const defTarget = d.target === undefined ? "human" : String(d.target);
    if (!TARGET.test(defTarget)) return { error: "default.target is not an agent, human, nobody or staff:<id>" };
    const defFb = checkChain(d.fallback, "default.fallback");
    if (defFb.error) return defFb;
    const staff = [];
    for (const [i, s] of (Array.isArray(v.staff) ? v.staff : []).entries()) {
        if (!isObj(s) || !ID.test(String(s.id ?? ""))) return { error: `staff[${i}].id is not an id` };
        const channels = words(s.channels).filter((c) => c === "console" || c === "zalo");
        if (s.zaloUserId !== undefined && s.zaloUserId !== null && !UID.test(String(s.zaloUserId)))
            return { error: `staff[${i}].zaloUserId is not a user id` };
        if (channels.includes("zalo") && !s.zaloUserId)
            return { error: `staff[${i}] forwards to Zalo but has no zaloUserId` };
        staff.push({
            id: String(s.id),
            name: String(s.name ?? s.id).slice(0, 40),
            mark: s.mark ? String(s.mark).slice(0, 40) : null,
            zaloUserId: s.zaloUserId ? String(s.zaloUserId) : null,
            channels: channels.length ? channels : ["console"],
        });
    }
    const settings = {};
    for (const k of Object.keys(ROUTING_DEFAULTS)) {
        const raw = isObj(v.settings) ? v.settings[k] : undefined;
        if (raw === undefined || raw === null) continue;
        const ms = durationMs(raw);
        if (!ms || ms < 10_000) return { error: `settings.${k} is not a duration of at least 10s` };
        settings[k] = ms;
    }
    return {
        value: {
            enabled: v.enabled === true,
            claims: v.claims === true,
            isolation: v.isolation === true,
            owners: words(v.owners).filter((x) => UID.test(x)),
            routes,
            default: { target: defTarget, fallback: defFb.value },
            staff,
            settings,
        },
    };
}

/** A setting's effective value. */
export const settingOf = (cfg, key) => cfg.settings?.[key] ?? ROUTING_DEFAULTS[key];

/** Whether the time `now` falls in a window (days and HH:mm in its time zone; `to` before `from` crosses midnight). */
export function inWindow(win, now) {
    let parts;
    try {
        parts = Object.fromEntries(
            new Intl.DateTimeFormat("en-US", {
                timeZone: win.tz,
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
            })
                .formatToParts(new Date(now))
                .map((p) => [p.type, p.value]),
        );
    } catch {
        return false;
    }
    const day = String(parts.weekday).slice(0, 3).toLowerCase();
    const hm = `${parts.hour}:${parts.minute}`;
    const overnight = win.to <= win.from;
    const inside = overnight ? hm >= win.from || hm < win.to : hm >= win.from && hm < win.to;
    // An overnight window's early hours belong to the day it started.
    const startDay = overnight && hm < win.to ? DAYS[(DAYS.indexOf(day) + 6) % 7] : day;
    return inside && win.days.includes(startDay);
}

/**
 * The first word of a text as a trigger (`@dev`, `#ticket`, `/dev`, `PM:`), lowercase, and the text without it.
 * @param {string} text
 */
export function leadingWord(text) {
    const m = /^\s*(\S+)\s*([\s\S]*)$/u.exec(String(text ?? ""));
    return m ? { word: m[1].toLowerCase(), rest: m[2] } : { word: "", rest: "" };
}

/** The hashtags in a text, lowercase. */
export const hashtags = (text) =>
    [...String(text ?? "").matchAll(/(^|\s)(#[\p{L}\p{N}_-]{1,32})/gu)].map((m) => m[2].toLowerCase());

/**
 * Which handler gets one incoming message, and why (docs/agent-routing.md §2.9).
 *
 * @param {object} msg - a normalized message: threadId, threadType (dm|group), senderId, text, type, replyTo, isSelf
 * @param {object} ctx
 * @param {object} ctx.cfg - checked routing settings ({@link checkRouting})
 * @param {Array<object>} ctx.agents - checked agents (src/core/routing-policy.js)
 * @param {boolean} [ctx.myDocuments] - the message is in the account's own My Documents
 * @param {boolean} [ctx.mentionsMe] - the message mentions the account (or @All) in a group
 * @param {number} [ctx.now]
 * @param {(threadId: string) => string[]} [ctx.labelsOf] - the conversation's Zalo labels
 * @param {(msgId: string) => {agent: string|null, at: string}|null} [ctx.sentByOf] - who sent a message (affinity)
 * @param {object} [ctx.state] - {humanUntil(threadId), sticky(threadId), holder(threadId, msgId)}
 * @param {(slug: string) => {state: string, lastSeen?: string|null, since?: string}} [ctx.presenceOf]
 * @returns {{to: string, by: string, ruleId: string|null, observers: string[], ownership: string, before?: string,
 *   text?: string, effects: object, trace: string[], notice?: object}}
 */
export function decide(msg, ctx) {
    const { cfg, agents = [], now = Date.now(), labelsOf = () => [], sentByOf = () => null, state = {} } = ctx;
    const trace = [];
    const fromOwner = Boolean(msg.isSelf) || (msg.senderId && cfg.owners.includes(String(msg.senderId)));
    const thread = String(msg.threadId);
    const effects = {};
    const ownershipOf = (r) =>
        r?.ownership && r.ownership !== "auto" ? r.ownership : msg.threadType === "group" ? "message" : "thread";
    const result = (to, by, extra = {}) =>
        withFallback({ to, by, ruleId: null, observers: [], ownership: ownershipOf(null), ...extra });
    const agentOf = (slug) => agents.find((a) => a.slug === slug) ?? null;
    const targetKnown = (t) => t === "human" || t === "nobody" || t.startsWith("staff:") || Boolean(agentOf(t));

    function withFallback(r) {
        r.trace = trace;
        r.effects = effects;
        if (!cfg.claims) return r;
        const a = agentOf(r.to);
        if (!a) return r;
        const p = ctx.presenceOf ? ctx.presenceOf(a.slug) : { state: "listening" };
        const after = settingOf(cfg, "fallbackAfter");
        const since = Date.parse(p.since ?? p.lastSeen ?? "") || 0;
        // Away for longer than fallbackAfter (it said so, or stopped calling). An agent this daemon has never seen (a
        // webhook receiver, an on-demand connector) is not away: its messages wait for it.
        const unavailable =
            !a.enabled ||
            p.state === "disabled" ||
            (a.delivery === "live" && p.state === "away" && since > 0 && now - since > after);
        if (!unavailable) return r;
        const route = cfg.routes.find((x) => x.id === r.ruleId);
        const chain = route?.fallback ?? cfg.default.fallback ?? ["human"];
        trace.push(`${a.slug} is ${p.state}: fallback`);
        for (const step of chain.length ? chain : ["human"]) {
            if (typeof step === "object") {
                return { ...r, before: r.to, to: "human", by: "fallback", notice: { autoReply: step.autoReply } };
            }
            const next = agentOf(step);
            if (next) {
                const np = ctx.presenceOf ? ctx.presenceOf(next.slug) : { state: "listening" };
                if (next.enabled && np.state !== "disabled" && np.state !== "away")
                    return { ...r, before: r.to, to: step, by: "fallback" };
                continue;
            }
            return {
                ...r,
                before: r.to,
                to: step,
                by: "fallback",
                notice: step === "human" ? { owner: true } : undefined,
            };
        }
        return { ...r, before: r.to, to: "human", by: "fallback", notice: { owner: true } };
    }

    // 1. The owner is answering this conversation himself.
    if (cfg.claims && !fromOwner && (state.humanUntil?.(thread) ?? 0) > now) {
        trace.push("human pause");
        return { ...result("human", "human"), ownership: "thread" };
    }

    // 2. An explicit trigger.
    const { word, rest } = leadingWord(msg.text);
    if (fromOwner && word === "@agents") {
        trace.push("@agents");
        return { ...result("system", "agents"), text: rest };
    }
    if (fromOwner && word === "@end") {
        effects.sticky = "clear";
        trace.push("@end: focus cleared");
    }
    const tags = hashtags(msg.text);
    for (const r of cfg.routes) {
        if (!r.enabled || !r.match.trigger) continue;
        const t = r.match.trigger;
        const mayUse = t.who === "anyone" || fromOwner;
        const hit = t.word.startsWith("#") ? tags.includes(t.word) : word === t.word || word === `${t.word}:`;
        if (!hit || !mayUse || !otherConditions(r, { skipTrigger: true })) continue;
        trace.push(`trigger ${t.word} (${r.id})`);
        if (t.sticky && fromOwner && agentOf(r.target)) effects.sticky = r.target;
        if (cfg.claims && agentOf(r.target)) effects.claim = { holder: r.target, state: "assigned", handoff: true };
        const out = result(r.target, "trigger", { ruleId: r.id, observers: r.observers, ownership: ownershipOf(r) });
        return t.strip && !t.word.startsWith("#") ? { ...out, text: rest } : out;
    }
    // The agent's own slug as a trigger, from the owner: `@dev …`.
    if (fromOwner && word.startsWith("@") && agentOf(word.slice(1))) {
        const slug = word.slice(1);
        trace.push(`trigger @${slug}`);
        if (cfg.claims) effects.claim = { holder: slug, state: "assigned", handoff: true };
        return { ...result(slug, "trigger"), text: rest };
    }

    if (cfg.claims) {
        // 3. Sticky focus (the owner's channel to one agent).
        const sticky = effects.sticky === "clear" ? null : state.sticky?.(thread);
        if (fromOwner && sticky && agentOf(sticky)) {
            trace.push(`sticky ${sticky}`);
            return result(sticky, "sticky");
        }
        // 4. Reply affinity: a reply to an agent's message goes back to it.
        const quoted = msg.replyTo?.msgId ? sentByOf(String(msg.replyTo.msgId)) : null;
        if (quoted?.agent && agentOf(quoted.agent) && now - Date.parse(quoted.at) <= settingOf(cfg, "affinityTtl")) {
            trace.push(`reply to ${quoted.agent}`);
            return result(quoted.agent, "reply");
        }
        // 5. An active claim.
        const holder = state.holder?.(thread, msg.replyTo?.msgId ?? null);
        if (holder && targetKnown(holder)) {
            trace.push(`claim ${holder}`);
            return result(holder, "claim");
        }
    }

    // 6. The routes table.
    function otherConditions(r, { skipTrigger = false } = {}) {
        const m = r.match;
        if (!skipTrigger && m.trigger) return false;
        if (m.threads && !m.threads.includes(thread)) return false;
        if (m.threadType && m.threadType !== msg.threadType) return false;
        if (m.myDocuments !== undefined && m.myDocuments !== Boolean(ctx.myDocuments)) return false;
        if (m.senders && m.senders.length) {
            const ok = m.senders.some(
                (s) => s === "anyone" || (s === "owner" ? fromOwner : String(msg.senderId) === s),
            );
            if (!ok) return false;
        }
        if (m.labels && m.labels.length) {
            const have = labelsOf(thread).map((l) => String(l).toLowerCase());
            if (!m.labels.some((l) => have.includes(l.toLowerCase()))) return false;
        }
        if (m.kinds && m.kinds.length && !m.kinds.includes(kindOf(msg))) return false;
        if (m.mentionsAccount !== undefined && m.mentionsAccount !== Boolean(ctx.mentionsMe)) return false;
        if (m.window && !inWindow(m.window, now)) return false;
        return true;
    }
    for (const r of cfg.routes) {
        if (!r.enabled || r.match.trigger || !otherConditions(r)) continue;
        trace.push(`rule ${r.id}`);
        if (cfg.claims && agentOf(r.target)) effects.claim = { holder: r.target, state: "assigned" };
        return result(r.target, "rule", { ruleId: r.id, observers: r.observers, ownership: ownershipOf(r) });
    }

    // 7. The default route.
    trace.push("default");
    if (cfg.claims && agentOf(cfg.default.target)) effects.claim = { holder: cfg.default.target, state: "assigned" };
    return result(cfg.default.target, "default");
}

/** The router's word for a message's kind. */
export function kindOf(msg) {
    const t = String(msg?.type ?? "text").toLowerCase();
    if (t === "text" || t === "webchat") return "text";
    if (["photo", "image", "gif"].includes(t)) return "photo";
    if (["voice", "audio"].includes(t)) return "voice";
    if (["link", "recommended"].includes(t)) return "link";
    if (t === "video") return "video";
    if (t === "sticker") return "sticker";
    return "file";
}

/**
 * Claims, the owner's human pause and sticky focus of one account (in memory, per daemon).
 *
 * @param {{now?: () => number}} [opts]
 */
export function createClaims({ now = Date.now, onChange = () => {} } = {}) {
    const threads = new Map(); // threadId -> {holder, state, until, note}
    const messages = new Map(); // msgId -> {holder, until}
    const human = new Map(); // threadId -> until
    const sticky = new Map(); // threadId -> {agent, until}
    const routed = new Map(); // agent -> Map(threadId -> until), for isolation
    const live = (m, k) => {
        const e = m.get(k);
        if (e && (e.until ?? e) <= now()) {
            m.delete(k);
            return null;
        }
        return e ?? null;
    };
    return {
        humanUntil: (thread) => live(human, String(thread)) ?? 0,
        startHuman(thread, ms) {
            onChange();
            human.set(String(thread), now() + ms);
        },
        endHuman(thread) {
            onChange();
            human.delete(String(thread));
        },
        sticky: (thread) => live(sticky, String(thread))?.agent ?? null,
        setSticky(thread, agent, ms) {
            onChange();
            if (agent === null) sticky.delete(String(thread));
            else sticky.set(String(thread), { agent, until: now() + ms });
        },
        holder(thread, msgId = null) {
            if (msgId) {
                const m = live(messages, String(msgId));
                if (m) return m.holder;
            }
            return live(threads, String(thread))?.holder ?? null;
        },
        claimOf: (thread) => live(threads, String(thread)),
        assign(thread, holder, { ms, ownership = "thread", msgId = null, held = false, note = null } = {}) {
            onChange();
            if (ownership === "message" && msgId) messages.set(String(msgId), { holder, until: now() + ms });
            else threads.set(String(thread), { holder, state: held ? "held" : "assigned", until: now() + ms, note });
        },
        release(thread, holder = null) {
            const c = live(threads, String(thread));
            if (!c || (holder && c.holder !== holder)) return false;
            threads.delete(String(thread));
            onChange();
            return true;
        },
        noteRouted(agent, thread, ms) {
            onChange();
            if (!routed.has(agent)) routed.set(agent, new Map());
            routed.get(agent).set(String(thread), now() + ms);
        },
        /** The conversations an agent may read under per-agent privacy: routed to it lately, or claimed by it. */
        allowedThreads(agent) {
            const out = new Set();
            for (const [t, until] of routed.get(agent) ?? []) if (until > now()) out.add(t);
            for (const [t, c] of threads) if (c.holder === agent && c.until > now()) out.add(t);
            return out;
        },
        /** Everything still running, to save (expired entries are left out). */
        snapshot() {
            const t = now();
            const keep = (m) => [...m.entries()].filter(([, e]) => (e.until ?? e) > t);
            return {
                v: 1,
                threads: keep(threads),
                messages: keep(messages),
                human: keep(human),
                sticky: keep(sticky),
                routed: [...routed.entries()].map(([a, m]) => [a, keep(m)]),
            };
        },
        /** Put a saved snapshot back, leaving out what expired meanwhile. */
        restore(snap) {
            if (!snap || snap.v !== 1) return;
            const t = now();
            const put = (m, list) => {
                for (const [k, e] of Array.isArray(list) ? list : []) if ((e?.until ?? e) > t) m.set(k, e);
            };
            put(threads, snap.threads);
            put(messages, snap.messages);
            put(human, snap.human);
            put(sticky, snap.sticky);
            for (const [a, list] of Array.isArray(snap.routed) ? snap.routed : []) {
                const m = new Map();
                put(m, list);
                if (m.size) routed.set(a, m);
            }
        },
        list() {
            const t = now();
            return [...threads.entries()]
                .filter(([, c]) => c.until > t)
                .map(([threadId, c]) => ({ threadId, ...c, until: new Date(c.until).toISOString() }));
        },
        /** The conversations the owner answers himself now (the human pause), with when each pause ends. */
        humanList() {
            const t = now();
            return [...human.entries()]
                .filter(([, until]) => until > t)
                .map(([threadId, until]) => ({ threadId, until: new Date(until).toISOString() }));
        },
        /** The conversations routed to (or claimed by) one handler, with when each was last routed there. */
        routedTo(agent) {
            const t = now();
            const out = new Map();
            for (const [threadId, until] of routed.get(agent) ?? [])
                if (until > t) out.set(threadId, { threadId, until });
            for (const [threadId, c] of threads)
                if (c.holder === agent && c.until > t && !out.has(threadId))
                    out.set(threadId, { threadId, until: null });
            return [...out.values()].map((e) => ({
                threadId: e.threadId,
                until: e.until === null ? null : new Date(e.until).toISOString(),
                claim: live(threads, e.threadId)
                    ? { ...threads.get(e.threadId), until: new Date(threads.get(e.threadId).until).toISOString() }
                    : null,
            }));
        },
    };
}

/**
 * Whether a send by an agent may go out (docs/agent-routing.md §3.4): refused while the owner answers himself
 * (HUMAN_ACTIVE), when another agent holds the conversation or the quoted message (CLAIMED), or, under per-agent privacy,
 * when the conversation was never routed to it (NOT_ROUTED).
 *
 * @param {object} p
 * @param {object} p.cfg
 * @param {ReturnType<typeof createClaims>} p.claims
 * @param {object|null} p.agent - the caller's agent
 * @param {string} p.threadId
 * @param {string|null} [p.quoteMsgId]
 * @param {boolean} [p.ownerChat] - My Documents: never guarded
 * @returns {{ok: true} | {ok: false, code: string, message: string, holder?: string, until?: string}}
 */
export function guardSend({ cfg, claims, agent, threadId, quoteMsgId = null, ownerChat = false }) {
    if (!cfg?.enabled || !agent || ownerChat) return { ok: true };
    if (cfg.claims) {
        const until = claims.humanUntil(threadId);
        if (until)
            return {
                ok: false,
                code: "HUMAN_ACTIVE",
                until: new Date(until).toISOString(),
                message: `The owner is answering this conversation himself until ${new Date(until).toISOString()}; nothing was sent.`,
            };
        const holder = claims.holder(threadId, quoteMsgId);
        if (holder && holder !== agent.slug)
            return {
                ok: false,
                code: "CLAIMED",
                holder,
                message: `${holder} handles this ${quoteMsgId ? "message" : "conversation"}; nothing was sent. Use zalo_inbox handoff or ask the owner.`,
            };
    }
    if (cfg.isolation && !claims.allowedThreads(agent.slug).has(String(threadId)))
        return {
            ok: false,
            code: "NOT_ROUTED",
            message: "This conversation was not routed to you; nothing was sent.",
        };
    return { ok: true };
}

/**
 * The `@agents` answer: each agent, its presence and its trigger, for the owner reading it in a Zalo app.
 *
 * @param {Array<{slug: string, name: string, presence?: {state: string}}>} agents
 * @param {string} lang - "vi" or "en"
 * @returns {string}
 */
export function agentsListText(agents, lang = "vi") {
    const state = {
        vi: { listening: "đang nghe", away: "vắng mặt", onDemand: "theo nhu cầu", idle: "chưa thấy", disabled: "tắt" },
        en: { listening: "listening", away: "away", onDemand: "on demand", idle: "not seen", disabled: "off" },
    }[lang === "en" ? "en" : "vi"];
    const head = lang === "en" ? "Agents on this account:" : "Các trợ lý của tài khoản này:";
    const lines = agents.map(
        (a) => `• ${a.name} (@${a.slug}): ${state[a.presence?.state] ?? a.presence?.state ?? "?"}`,
    );
    const foot =
        lang === "en"
            ? "Write @<name> at the start of a message to talk to one; @end ends the focus."
            : "Gõ @<tên> ở đầu tin để nói với một trợ lý; @end để kết thúc.";
    return [head, ...(lines.length ? lines : ["–"]), foot].join("\n");
}
