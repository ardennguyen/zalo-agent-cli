/**
 * The Message Router in a running daemon: it decides each incoming message once ({@link decide}), applies the decision's
 * effects (claims, sticky focus), keeps the owner's human pause from his own sends, answers `@agents`, forwards to staff
 * on their own Zalo and relays their replies back, posts the fallback notices, and gives the tools what they need: the
 * per-caller view of messages, the send guard and the per-agent privacy filter. Off (`routing.enabled` false), it does
 * nothing and every caller sees every message, as before.
 */
import { agentsListText, createClaims, decide, guardSend, settingOf } from "../core/message-router.js";
import { presenceState } from "./agents.js";

const LABELS_TTL_MS = 5 * 60_000;
const NOTICE_GAP_MS = 10 * 60_000;
const STAFF_HANDOFF_MS = 30 * 60_000;
const STAFF_PREFIX = "📩";

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
}) {
    const claims = createClaims({ now });
    const labels = { at: 0, byThread: new Map(), loading: null };
    const lastNotice = new Map();
    const staffForwards = new Map(); // forwarded msgId/cliMsgId -> {threadId, threadType, staffId}
    const staffOpen = new Map(); // staff zaloUserId -> {threadId, threadType, staffId, until}

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

    /** The decision for one message, with no side effect (the console's test box and `route_test`). */
    function test(msg, { cfg = cfgNow(), agents = routingNow().agents, at = now(), labelsOf = null } = {}) {
        return decide(msg, {
            cfg,
            agents,
            now: at,
            myDocuments: isMyDocuments(msg.threadId),
            labelsOf: labelsOf ?? ((t) => labels.byThread.get(String(t)) ?? []),
            sentByOf: (id) => sentBy?.lookup({ msgId: id }) ?? null,
            state: claims,
            presenceOf,
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
    async function onIncoming(n) {
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
                } catch (e) {
                    log(`[router] staff reply not relayed: ${e.message}`);
                }
                return null;
            }
        }
        refreshLabels();
        const d = test(n, { cfg });
        apply(d, n, cfg);
        const routed = {
            ...n,
            route: { to: d.to, by: d.by, ruleId: d.ruleId, observers: d.observers, ownership: d.ownership },
        };
        if (d.before) routed.route.before = d.before;
        if (d.text !== undefined && d.text !== n.text) Object.assign(routed, { rawText: n.text, text: d.text });
        if (d.to.startsWith("staff:")) {
            const s = cfg.staff.find((x) => `staff:${x.id}` === d.to);
            if (s?.channels.includes("zalo"))
                forwardToStaff(s, n).catch((e) => log(`[router] staff forward failed: ${e.message}`));
        }
        if (d.notice) notice(d, n).catch((e) => log(`[router] notice not sent: ${e.message}`));
        return routed;
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
        if (d.notice.owner && noticeOnce(`owner:${d.before}`)) {
            const text =
                lang === "en"
                    ? `⚠️ ${d.before} is away: a message waits for you (conversation ${n.threadId}).`
                    : `⚠️ ${d.before} đang vắng: có tin chờ bạn (cuộc trò chuyện ${n.threadId}).`;
            await send(text, send2meId || ownId, "dm");
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
        if (cfg.claims && !isMyDocuments(n.threadId)) claims.startHuman(n.threadId, settingOf(cfg, "humanPause"));
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
        const mine = (m) => !m.route || m.system || m.route.to === slug || (m.route.observers ?? []).includes(slug);
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

    return {
        claims,
        test,
        onIncoming,
        onOwn,
        onAgentSend,
        viewFilter,
        mayRead,
        enabled: on,
        guard: (who, threadId, quoteMsgId) =>
            guardSend({
                cfg: cfgNow(),
                claims,
                agent: who.agent,
                threadId,
                quoteMsgId,
                ownerChat: isMyDocuments(threadId),
            }),
        presenceOf,
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
            return { ok: true };
        },
    };
}
