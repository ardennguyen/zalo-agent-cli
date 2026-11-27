/**
 * The Companion Router in a running daemon: it decides each incoming message once ({@link decide}), applies the decision's
 * effects (claims, sticky focus), keeps the owner's human pause from his own sends, answers `@agents`, forwards to staff
 * on their own Zalo and relays their replies back, posts the fallback notices, and gives the tools what they need: the
 * per-caller view of messages, the send guard and the per-agent privacy filter. Off (`routing.enabled` false), it does
 * nothing and every caller sees every message, as before.
 */
import { agentsListText, createClaims, decide, guardSend, settingOf } from "../core/message-router.js";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectionState, presenceState } from "./agents.js";
import { readSealedJson, scopeOfDir, writeSealedJson } from "../core/keystore/index.js";

/** Claims, the human pause and sticky focus, kept across a restart (sealed, in the account folder). */
export const ROUTING_STATE_FILE = "routing-state.json";
const STATE_SPEC = Object.freeze({ kind: "routing-state", use: "boot" });
/** The routing events, kept across restarts for the plan's Activity retention (sealed, in the account folder). */
export const ROUTING_EVENTS_FILE = "routing-events.json";
const EVENTS_SPEC = Object.freeze({ kind: "routing-events", use: "boot" });
const DAY_MS = 24 * 60 * 60_000;
const STATE_WRITE_DELAY_MS = 2000;

const LABELS_TTL_MS = 5 * 60_000;
const NOTICE_GAP_MS = 10 * 60_000;
/** How long the default route's agent may send its one absence notice into a conversation another agent holds. */
const ABSENCE_PASS_MS = 30 * 60_000;
const STAFF_HANDOFF_MS = 30 * 60_000;
const STAFF_PREFIX = "📩";
/** The most routing events a daemon keeps for the console's Activity view and the staff inbox (ids only, no text). */
export const ROUTING_EVENTS_MAX = 5000;
const STAFF_ID = /^[A-Za-z0-9_-]{1,64}$/;
const THREAD_ID = /^[0-9]{1,30}$/;
const MAX_STAFF_TEXT = 4000;

/**
 * The owner's notice of a fallback, in My Documents: which agent could not take a message, why, and where it went.
 *
 * @param {{before: string, to: string, reason?: string}} d - the router's decision
 * @param {string} threadId
 * @param {"vi"|"en"} [lang]
 * @returns {string}
 */
export function fallbackNoticeText(d, threadId, lang = "vi") {
    const off = d.reason === "disabled";
    if (lang === "en") {
        const why = off ? "is turned off" : "is away";
        return d.to === "human"
            ? `⚠️ ${d.before} ${why}: a message waits for you (conversation ${threadId}).`
            : `⚠️ ${d.before} ${why}: a message went to ${d.to} (conversation ${threadId}).`;
    }
    const why = off ? "đang tắt" : "đang vắng";
    return d.to === "human"
        ? `⚠️ ${d.before} ${why}: có tin chờ bạn (cuộc trò chuyện ${threadId}).`
        : `⚠️ ${d.before} ${why}: tin đã chuyển cho ${d.to} (cuộc trò chuyện ${threadId}).`;
}

/**
 * @param {object} deps
 * @param {() => object} deps.routingNow - resolveRouting's answer (agents, marks, presenceWindowMs, cfg)
 * @param {() => object} deps.getApi - the live session
 * @param {() => {ownId: string|null, send2meId: string|null}} deps.ids
 * @param {ReturnType<import("./agents.js").createAgentPresence>|null} [deps.presence]
 * @param {ReturnType<import("./agents.js").createSentByStore>|null} [deps.sentBy]
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {"vi"|"en"} [deps.lang] - the language of the notices and the `@agents` answer
 * @param {(slug: string) => object} [deps.presenceOf] - stands in for the presence store (tests)
 * @param {(slug: string) => {online: boolean, since: number}} [deps.connectionOf] - stands in for the clients'
 *   connections (tests)
 * @param {string|null} [deps.accountDir] - where claims, the human pause and sticky focus are saved (null: memory only)
 * @param {(threadId: string, limit: number) => object[]} [deps.history] - a conversation's cached messages, newest
 *   first (the staff inbox reads a conversation through it)
 * @param {() => Map<string, {name: string}>} [deps.threadNames] - the cached conversations' names (the staff inbox
 *   shows them; nothing else leaves the daemon about a conversation)
 */
export function createRouterRuntime({
    routingNow,
    getApi,
    ids,
    presence = null,
    sentBy = null,
    log = () => {},
    now = Date.now,
    lang = "vi",
    presenceOf: presenceOverride = null,
    connectionOf: connectionOverride = null,
    accountDir = null,
    history = null,
    threadNames = null,
}) {
    // Saved a moment after each change, read back at start with what expired meanwhile left out (owner, 2026-11-20).
    const stateFile = accountDir ? join(accountDir, ROUTING_STATE_FILE) : null;
    let saveTimer = null;
    let claims = null;
    const save = () => {
        saveTimer = null;
        try {
            writeSealedJson(stateFile, scopeOfDir(accountDir), STATE_SPEC, claims.snapshot());
        } catch (e) {
            log(`[router] ${ROUTING_STATE_FILE} not written: ${e.message}`);
        }
    };
    claims = createClaims({
        now,
        onChange: () => {
            if (!stateFile || saveTimer) return;
            saveTimer = setTimeout(save, STATE_WRITE_DELAY_MS);
            saveTimer.unref?.();
        },
    });
    if (stateFile && existsSync(stateFile)) {
        try {
            claims.restore(readSealedJson(stateFile, scopeOfDir(accountDir), STATE_SPEC));
        } catch (e) {
            log(`[router] ${ROUTING_STATE_FILE} cannot be read (${e.message}); starting without saved claims`);
        }
    }
    const labels = { at: 0, byThread: new Map(), loading: null };
    const lastNotice = new Map();
    const staffForwards = new Map(); // forwarded msgId/cliMsgId -> {threadId, threadType, staffId}
    const staffOpen = new Map(); // staff zaloUserId -> {threadId, threadType, staffId, until}

    // Routing events (docs/agent-routing.md §4.1): ids and decisions only, never a message's text. The fleet controller
    // reads them after `seq` moves and publishes them to the console (Activity, the staff inbox and its counts).
    // They are kept sealed in the account folder (owner, 2026-11-20) for `routing.logDays` (at least a day), so a restart
    // or a deploy loses none; the stream position (bootId, seq) is kept with them, so nothing is published twice.
    const eventsFile = accountDir ? join(accountDir, ROUTING_EVENTS_FILE) : null;
    let bootId = randomBytes(4).toString("hex");
    let events = [];
    let seq = 0;
    if (eventsFile && existsSync(eventsFile)) {
        try {
            const saved = readSealedJson(eventsFile, scopeOfDir(accountDir), EVENTS_SPEC);
            if (saved?.v === 1 && typeof saved.bootId === "string" && Number.isInteger(saved.seq)) {
                bootId = saved.bootId;
                seq = saved.seq;
                events = Array.isArray(saved.events) ? saved.events : [];
            }
        } catch (e) {
            log(`[router] ${ROUTING_EVENTS_FILE} cannot be read (${e.message}); starting a new event log`);
        }
    }
    const keepDays = () => Math.max(1, routingNow()?.logDays ?? 7);
    const prune = () => {
        const floor = now() - keepDays() * DAY_MS;
        const first = events.findIndex((e) => Date.parse(e.at) >= floor);
        if (first !== 0) events.splice(0, first < 0 ? events.length : first);
        if (events.length > ROUTING_EVENTS_MAX) events.splice(0, events.length - ROUTING_EVENTS_MAX);
    };
    let eventsTimer = null;
    const saveEvents = () => {
        eventsTimer = null;
        try {
            prune();
            writeSealedJson(eventsFile, scopeOfDir(accountDir), EVENTS_SPEC, { v: 1, bootId, seq, events });
        } catch (e) {
            log(`[router] ${ROUTING_EVENTS_FILE} not written: ${e.message}`);
        }
    };
    function emit(kind, fields = {}) {
        seq += 1;
        events.push({ id: `${bootId}-${seq}`, seq, at: new Date(now()).toISOString(), kind, ...fields });
        prune();
        if (eventsFile && !eventsTimer) {
            eventsTimer = setTimeout(saveEvents, STATE_WRITE_DELAY_MS);
            eventsTimer.unref?.();
        }
    }

    const cfgNow = () => routingNow().cfg;
    const on = () => Boolean(cfgNow()?.enabled);
    const isMyDocuments = (threadId) => {
        const { ownId, send2meId } = ids();
        return [ownId, send2meId].some((x) => x && String(x) === String(threadId));
    };

    function refreshLabels() {
        if (labels.loading || now() - labels.at < LABELS_TTL_MS) return;
        const api = getApi();
        if (typeof api?.getLabels !== "function") return;
        labels.loading = Promise.resolve(api.getLabels())
            .then((r) => {
                const byThread = new Map();
                for (const l of r?.labelData ?? r?.labels ?? []) {
                    for (const t of l?.conversations ?? []) {
                        const key = String(t).replace(/^g/, "");
                        if (!byThread.has(key)) byThread.set(key, []);
                        byThread.get(key).push(String(l.text ?? l.name ?? ""));
                    }
                }
                labels.byThread = byThread;
                labels.at = now();
            })
            .catch((e) => log(`[router] labels not read: ${e.message}`))
            .finally(() => {
                labels.loading = null;
            });
    }

    const presenceOf = (slug) => {
        if (presenceOverride) return presenceOverride(slug);
        const r = routingNow();
        const agent = r.agents.find((a) => a.slug === slug) ?? null;
        if (!presence) return { state: "listening" };
        return presenceState(
            presence.list().map((e) => ({
                ...e,
                lastSeen: Date.parse(e.lastSeen ?? "") || 0,
                waits: e.waiting ? 1 : 0,
                statusAt: Date.parse(e.statusAt ?? "") || null,
            })),
            slug,
            { agent, windowMs: r.presenceWindowMs, now: now() },
        );
    };

    // A client's connection: its open waits only (src/mcp/agents.js connectionState). No presence store (a test
    // runtime): every client counts as connected.
    const connectionOf = (slug) => {
        if (connectionOverride) return connectionOverride(slug);
        if (!presence) return { online: true, since: 0 };
        return connectionState(
            presence.list().map((e) => ({
                key: e.key,
                waits: e.waiting ? 1 : 0,
                waitEndAt: Date.parse(e.waitEndAt ?? "") || null,
            })),
            slug,
            { now: now() },
        );
    };
    // Which conversations were told of which client's absence: `${slug}\n${threadId}` -> the absence (its `since`).
    const absenceTold = new Map();
    // The absence notices still to be sent: notifier and conversation -> until when its one send may go out.
    const absencePass = new Map();

    /** The decision for one message, with no side effect (the console's test box and `route_test`). */
    function test(
        msg,
        { cfg = cfgNow(), agents = routingNow().agents, at = now(), labelsOf = null, mentionsMe = false } = {},
    ) {
        return decide(msg, {
            cfg,
            agents,
            now: at,
            mentionsMe,
            myDocuments: isMyDocuments(msg.threadId),
            labelsOf: labelsOf ?? ((t) => labels.byThread.get(String(t)) ?? []),
            sentByOf: (id) => sentBy?.lookup({ msgId: id }) ?? null,
            state: claims,
            presenceOf,
            connectionOf,
        });
    }

    async function send(text, threadId, threadType) {
        const api = getApi();
        return api.sendMessage(text, String(threadId), threadType === "group" ? 1 : 0);
    }

    function noticeOnce(key) {
        const t = lastNotice.get(key) ?? 0;
        if (now() - t < NOTICE_GAP_MS) return false;
        lastNotice.set(key, now());
        return true;
    }

    /** Forward a customer's message to a staff member's own Zalo (option B); his reply comes back through {@link onIncoming}. */
    async function forwardToStaff(staff, msg) {
        const who = msg.senderName || msg.senderId || "?";
        const text = `${STAFF_PREFIX} ${who}: ${msg.text || `[${msg.type || "message"}]`}\n↩ ${lang === "en" ? "Reply to this message to answer." : "Trả lời tin này để phản hồi."}`;
        const r = await send(text, staff.zaloUserId, "dm");
        const entry = { threadId: String(msg.threadId), threadType: msg.threadType, staffId: staff.id };
        for (const id of [r?.message?.msgId ?? r?.msgId, r?.message?.cliMsgId ?? r?.cliMsgId])
            if (id) staffForwards.set(String(id), entry);
        staffOpen.set(String(staff.zaloUserId), { ...entry, until: now() + STAFF_HANDOFF_MS });
    }

    /**
     * A message from someone else, before it reaches the agents. Returns the message with its `route` (and the trigger
     * removed from `text`, the original in `rawText`), or null when it is not for the agents at all (a staff member's
     * relayed reply).
     *
     * @param {object} n - a normalized message
     * @returns {Promise<object|null>}
     */
    async function onIncoming(n, { mentionsMe = false } = {}) {
        const cfg = cfgNow();
        if (!cfg?.enabled) return n;
        // A staff member answering on his own Zalo (option B): relayed to the customer, never shown to the agents.
        const staff = cfg.staff.find(
            (s) => s.zaloUserId && s.zaloUserId === String(n.senderId) && n.threadType === "dm",
        );
        if (staff && String(n.threadId) === staff.zaloUserId) {
            const quoted = n.replyTo?.msgId ? staffForwards.get(String(n.replyTo.msgId)) : null;
            const open = staffOpen.get(staff.zaloUserId);
            const to = quoted ?? (open && open.until > now() ? open : null);
            if (to) {
                const mark = staff.mark || `👤 ${staff.name}:`;
                try {
                    const r = await send(`${mark} ${n.text ?? ""}`.trim(), to.threadId, to.threadType);
                    sentBy?.record(
                        [r?.message?.msgId ?? r?.msgId, r?.message?.cliMsgId ?? r?.cliMsgId]
                            .filter(Boolean)
                            .map(String),
                        { agent: { slug: `staff:${staff.id}`, name: staff.name }, sub: null, credential: "staff" },
                        to.threadId,
                    );
                    claims.assign(to.threadId, `staff:${staff.id}`, { ms: settingOf(cfg, "claimTtl"), held: true });
                    emit("staffReply", {
                        threadId: to.threadId,
                        threadType: to.threadType,
                        by: `staff:${staff.id}`,
                        channel: "zalo",
                    });
                } catch (e) {
                    log(`[router] staff reply not relayed: ${e.message}`);
                }
                return null;
            }
        }
        refreshLabels();
        const d = test(n, { cfg, mentionsMe });
        apply(d, n, cfg);
        const routed = {
            ...n,
            route: { to: d.to, by: d.by, ruleId: d.ruleId, observers: d.observers, ownership: d.ownership },
        };
        if (d.before) routed.route.before = d.before;
        if (d.queued) {
            routed.route.queued = true;
            const absence = absenceFor(d, n, cfg);
            if (absence) routed.route.absence = absence;
            log(
                `[router] ${d.to} is offline: message ${n.msgId ?? "-"} in ${n.threadId} is queued for it` +
                    (absence ? `; ${absence.notifier} tells the sender` : ""),
            );
        }
        // A fallback is never silent: logged here, kept as a routing event (the console's Activity) and told to the owner.
        if (d.by === "fallback")
            log(
                `[router] fallback: ${d.before} is ${d.reason ?? "unavailable"}; message ${n.msgId ?? "-"} in ${n.threadId} went to ${d.to}`,
            );
        emit(d.by === "fallback" ? "fallback" : d.queued ? "queued" : "routed", {
            threadId: String(n.threadId),
            threadType: n.threadType === "group" ? "group" : "dm",
            msgId: n.msgId ? String(n.msgId) : null,
            to: d.to,
            by: d.by,
            ruleId: d.ruleId ?? null,
            ...(d.before ? { before: d.before } : {}),
            ...(d.reason ? { reason: d.reason } : {}),
            ...(routed.route.absence ? { notifier: routed.route.absence.notifier } : {}),
        });
        if (d.text !== undefined && d.text !== n.text) Object.assign(routed, { rawText: n.text, text: d.text });
        if (d.to.startsWith("staff:")) {
            const s = cfg.staff.find((x) => `staff:${x.id}` === d.to);
            if (s?.channels.includes("zalo"))
                forwardToStaff(s, n).catch((e) => log(`[router] staff forward failed: ${e.message}`));
        }
        if (d.notice) notice(d, n).catch((e) => log(`[router] notice not sent: ${e.message}`));
        return routed;
    }

    /**
     * The absence notice for a message queued for an offline client: once per conversation and absence, the default
     * route's agent (the companion, as a rule) tells the sender, in its own words under its own rules (owner,
     * 2026-11-27); the engine sends no text of its own. Null when it was told already, or no agent can tell it.
     */
    function absenceFor(d, n, cfg) {
        const notifier = routingNow().agents.find((a) => a.slug === cfg.default.target) ?? null;
        if (!notifier || notifier.slug === d.to || !notifier.enabled || presenceOf(notifier.slug).state === "disabled")
            return null;
        const key = `${d.to}\n${n.threadId}`;
        const since = d.notice?.away?.since ?? 0;
        if (absenceTold.has(key) && absenceTold.get(key) === since) return null;
        absenceTold.set(key, since);
        if (absenceTold.size > 10_000) absenceTold.delete(absenceTold.keys().next().value);
        absencePass.set(
            `${notifier.slug}
${n.threadId}`,
            now() + ABSENCE_PASS_MS,
        );
        if (absencePass.size > 10_000) absencePass.delete(absencePass.keys().next().value);
        return {
            agent: d.to,
            name: d.notice?.away?.name ?? d.to,
            notifier: notifier.slug,
            ...(cfg.awayNotice ? { guidance: cfg.awayNotice } : {}),
        };
    }

    function apply(d, n, cfg) {
        if (d.effects.sticky === "clear") claims.setSticky(n.threadId, null);
        else if (d.effects.sticky) claims.setSticky(n.threadId, d.effects.sticky, settingOf(cfg, "stickyTtl"));
        // A message that fell back assigns nothing: the next one is routed afresh, by the same route and chain.
        if (d.effects.claim && cfg.claims && d.by !== "fallback")
            claims.assign(n.threadId, d.effects.claim.holder, {
                ms: settingOf(cfg, "claimTtl"),
                ownership: d.ownership,
                msgId: n.msgId ?? null,
            });
        for (const a of [d.to, ...(d.observers ?? [])])
            if (a && !["human", "nobody", "system"].includes(a))
                claims.noteRouted(a, n.threadId, settingOf(cfg, "affinityTtl"));
    }

    async function notice(d, n) {
        const { send2meId, ownId } = ids();
        if (d.notice.autoReply && noticeOnce(`auto:${n.threadId}`))
            await send(d.notice.autoReply, n.threadId, n.threadType);
        if (d.notice.owner && noticeOnce(`owner:${d.before}:${d.to}`)) {
            await send(fallbackNoticeText(d, n.threadId, lang), send2meId || ownId, "dm");
        }
    }

    /**
     * One of the account's own messages (sent from the owner's phone, PC or web, or by an agent). A message no agent
     * sent starts the human pause on its conversation; `@agents` is answered in My Documents.
     *
     * @param {object} n - the normalized message
     * @param {{byAgent: boolean}} opts - whether it is the echo of an agent's send
     * @returns {Promise<"answered"|null>}
     */
    async function onOwn(n, { byAgent }) {
        const cfg = cfgNow();
        if (!cfg?.enabled || byAgent) return null;
        const text = String(n.text ?? "").trim();
        if (/^@agents\b/i.test(text)) {
            const r = routingNow();
            const list = r.agents.filter((a) => a.enabled).map((a) => ({ ...a, presence: presenceOf(a.slug) }));
            const { send2meId, ownId } = ids();
            // Answered in My Documents only: typed in a customer's chat, the list must not reach the customer.
            await send(agentsListText(list, lang), send2meId || ownId, "dm").catch((e) =>
                log(`[router] @agents: ${e.message}`),
            );
            return "answered";
        }
        if (cfg.claims && !isMyDocuments(n.threadId)) {
            const was = claims.humanUntil(n.threadId);
            claims.startHuman(n.threadId, settingOf(cfg, "humanPause"));
            if (!was) emit("humanPause", { threadId: String(n.threadId), by: "owner" });
        }
        return null;
    }

    /** After an agent's send: its claim on the conversation is held. */
    function onAgentSend(slug, threadId) {
        const cfg = cfgNow();
        if (!cfg?.enabled || !cfg.claims || !slug || isMyDocuments(threadId)) return;
        claims.assign(threadId, slug, { ms: settingOf(cfg, "claimTtl"), held: true });
    }

    /**
     * The caller's view of buffered messages: with routing on, a bound agent sees what is routed to it or that it
     * observes (`view: "all"` shows everything, marked `forMe`), and an unbound connection sees nothing new.
     */
    function viewFilter(messages, who, view = "mine") {
        if (!on() || !Array.isArray(messages)) return messages;
        const slug = who.agent?.slug ?? null;
        const mine = (m) =>
            !m.route ||
            m.system ||
            m.route.to === slug ||
            m.route.absence?.notifier === slug ||
            (m.route.observers ?? []).includes(slug);
        if (view === "all" && slug && !cfgNow().isolation)
            return messages.map((m) => (m.route ? { ...m, forMe: mine(m) } : m));
        return messages
            .filter(mine)
            .map((m) => (m.route && m.route.to !== slug && slug ? { ...m, role: "observe" } : m));
    }

    /** Per-agent privacy (Pro): whether the caller may read this conversation. */
    function mayRead(who, threadId) {
        const cfg = cfgNow();
        if (!cfg?.enabled || !cfg.isolation || !who.agent) return true;
        return claims.allowedThreads(who.agent.slug).has(String(threadId));
    }

    /** A handler the console may name: an agent slug, a staff member of the routing, or the owner. */
    function knownTarget(cfg, to) {
        if (to === "human") return true;
        if (typeof to !== "string") return false;
        if (to.startsWith("staff:")) return cfg.staff.some((s) => `staff:${s.id}` === to);
        return routingNow().agents.some((a) => a.slug === to);
    }

    function staffOf(cfg, p) {
        const id = String(p?.staff ?? "");
        if (!STAFF_ID.test(id)) throw new Error("staff is not a staff id");
        const s = cfg.staff.find((x) => x.id === id);
        if (!s) throw new Error(`no staff member ${id} in this account's routing`);
        if (!s.channels.includes("console")) throw new Error(`staff member ${id} does not answer in the console`);
        return s;
    }

    function threadOf(p) {
        const t = String(p?.threadId ?? "");
        if (!THREAD_ID.test(t)) throw new Error("threadId is not a conversation id");
        return t;
    }

    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

    /**
     * The console's requests, through the daemon channel (`/routing`) and the admin API (`/access/<ownId>/routing/...`):
     * the routing events, the claims card (release, reassign, human pause) and the staff inbox (a staff member's routed
     * conversations, reading one, answering from the account with his mark, claiming and releasing). A staff member
     * reaches only what was routed to him or what he holds; the console checks who he is, this checks what he may see.
     *
     * @param {object} p - `{action, ...}`
     * @returns {Promise<object>}
     */
    async function serve(p = {}) {
        const cfg = cfgNow();
        const action = String(p.action ?? "");
        if (action === "events") {
            const since = p.bootId === bootId && Number.isInteger(p.since) ? p.since : 0;
            return { bootId, seq, events: events.filter((e) => e.seq > since) };
        }
        if (!cfg?.enabled) throw new Error("routing is off on this account");
        if (action === "claims") return { claims: claims.list(), human: claims.humanList() };
        if (action === "release") {
            const threadId = threadOf(p);
            const cur = claims.claimOf(threadId);
            const released = claims.release(threadId);
            if (released) emit("released", { threadId, by: "console", holder: cur?.holder ?? null });
            return { released };
        }
        if (action === "assign") {
            const threadId = threadOf(p);
            if (!knownTarget(cfg, p.to)) throw new Error("to is not an agent, a staff member or human");
            claims.release(threadId);
            if (p.to === "human") claims.startHuman(threadId, settingOf(cfg, "humanPause"));
            else claims.assign(threadId, p.to, { ms: settingOf(cfg, "claimTtl") });
            emit("handoff", { threadId, by: "console", to: p.to });
            return { claim: claims.claimOf(threadId) ?? null, humanUntil: iso(claims.humanUntil(threadId)) };
        }
        if (action === "human") {
            const threadId = threadOf(p);
            const minutes = Number(p.minutes);
            const ms =
                Number.isFinite(minutes) && minutes > 0
                    ? Math.min(minutes, 7 * 24 * 60) * 60_000
                    : settingOf(cfg, "humanPause");
            claims.startHuman(threadId, ms);
            emit("humanPause", { threadId, by: "console" });
            return { humanUntil: iso(claims.humanUntil(threadId)) };
        }
        if (action === "endHuman") {
            const threadId = threadOf(p);
            claims.endHuman(threadId);
            emit("humanEnd", { threadId, by: "console" });
            return { ended: true };
        }
        // ── The staff inbox (option A) ──
        const staff = staffOf(cfg, p);
        const me = `staff:${staff.id}`;
        const nameOf = () => {
            try {
                const names = typeof threadNames === "function" ? threadNames() : null;
                return (id) => names?.get(String(id))?.name ?? null;
            } catch {
                return () => null;
            }
        };
        if (action === "inbox") {
            const name = nameOf();
            return { staff: me, threads: claims.routedTo(me).map((t) => ({ ...t, name: name(t.threadId) })) };
        }
        const threadId = threadOf(p);
        if (!claims.allowedThreads(me).has(threadId))
            return { refused: true, code: "NOT_ROUTED", message: "This conversation was not routed to you." };
        if (action === "thread") {
            if (typeof history !== "function") throw new Error("this daemon does not read conversations");
            const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
            const rows = history(threadId, limit).map((m) => {
                const by = sentBy?.lookup({ msgId: m.msgId }) ?? null;
                return by ? { ...m, sentBy: by } : m;
            });
            return {
                threadId,
                name: nameOf()(threadId),
                messages: rows,
                claim: claims.claimOf(threadId) ?? null,
                humanUntil: iso(claims.humanUntil(threadId)),
            };
        }
        if (action === "claim") {
            const cur = claims.claimOf(threadId);
            if (cur && cur.holder !== me)
                return {
                    refused: true,
                    code: "CLAIMED",
                    holder: cur.holder,
                    message: `${cur.holder} handles this conversation.`,
                };
            claims.assign(threadId, me, { ms: settingOf(cfg, "claimTtl"), held: true });
            emit("claimed", { threadId, by: me });
            return { claim: claims.claimOf(threadId) };
        }
        if (action === "unclaim") {
            const released = claims.release(threadId, me);
            if (released) emit("released", { threadId, by: me, holder: me });
            return { released };
        }
        if (action === "send") {
            const text = typeof p.text === "string" ? p.text.trim() : "";
            if (!text) throw new Error("text is empty");
            if (text.length > MAX_STAFF_TEXT) throw new Error(`text is longer than ${MAX_STAFF_TEXT} characters`);
            const g = guardSend({ cfg, claims, agent: { slug: me }, threadId });
            if (!g.ok) {
                emit("refusedSend", { threadId, by: me, code: g.code });
                return { refused: true, ...g };
            }
            const threadType = p.threadType === "group" ? "group" : "dm";
            const mark = staff.mark || `👤 ${staff.name}:`;
            const r = await send(`${mark} ${text}`, threadId, threadType);
            const msgId = r?.message?.msgId ?? r?.msgId ?? null;
            const cliMsgId = r?.message?.cliMsgId ?? r?.cliMsgId ?? null;
            sentBy?.record(
                [msgId, cliMsgId].filter(Boolean).map(String),
                { agent: { slug: me, name: staff.name }, sub: null, credential: "staff" },
                threadId,
            );
            claims.assign(threadId, me, { ms: settingOf(cfg, "claimTtl"), held: true });
            emit("staffReply", { threadId, threadType, by: me, channel: "console" });
            return {
                sent: true,
                msgId: msgId === null ? null : String(msgId),
                cliMsgId: cliMsgId === null ? null : String(cliMsgId),
            };
        }
        throw new Error(`unknown routing action "${action}"`);
    }

    return {
        claims,
        /** Write the saved state now (on shutdown). */
        flush: () => {
            if (stateFile) save();
            if (eventsFile) saveEvents();
        },
        test,
        onIncoming,
        onOwn,
        onAgentSend,
        viewFilter,
        mayRead,
        enabled: on,
        guard: (who, threadId, quoteMsgId) => {
            const g = guardSend({
                cfg: cfgNow(),
                claims,
                agent: who.agent,
                threadId,
                quoteMsgId,
                ownerChat: isMyDocuments(threadId),
            });
            // The agent telling a sender of a client's absence may send there once, though the client holds the
            // conversation (or it was never routed to it); the owner answering himself still stops it.
            const pass = `${who.agent?.slug}
${threadId}`;
            if (!g.ok && g.code !== "HUMAN_ACTIVE" && (absencePass.get(pass) ?? 0) > now()) {
                absencePass.delete(pass);
                return { ok: true };
            }
            return g;
        },
        presenceOf,
        connectionOf,
        /** Hand a claim to another agent, the owner or a staff member. */
        handoff(who, threadId, to, note = null) {
            const cfg = cfgNow();
            if (!cfg?.enabled) return { ok: false, message: "Routing is off on this account." };
            const cur = claims.claimOf(threadId);
            if (cur && cur.holder !== who.agent?.slug)
                return { ok: false, message: `${cur.holder} holds this conversation.` };
            if (to === "human") claims.startHuman(threadId, settingOf(cfg, "humanPause"));
            claims.release(threadId);
            if (to !== "human") claims.assign(threadId, to, { ms: settingOf(cfg, "claimTtl"), note });
            emit("handoff", { threadId: String(threadId), by: who.agent?.slug ?? null, to });
            return { ok: true };
        },
        /** Note a refused send (the guard's answer) in the routing events. */
        noteRefused(who, threadId, code) {
            emit("refusedSend", { threadId: String(threadId), by: who.agent?.slug ?? null, code });
        },
        /** Where the events stand (the daemon's health carries it, so the controller reads new ones only). */
        eventsHead: () => (on() ? { bootId, seq } : null),
        serve,
    };
}
