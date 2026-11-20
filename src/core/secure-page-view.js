/**
 * What the one-time secure pages (src/core/secure-page.js) show, in English and Vietnamese, laid out with the shared
 * page kit (src/utils/page-kit.js) so they look like the QR login page.
 *
 * A page is built from its ticket: the kind of form ("confirm", "pin", "pin-change"), its English title and
 * description (also what the agent and the webhook see), and an optional `view` that says more for the page alone:
 * - `view.type: "oauth"`: an app asks for access; `clientName`, `clientId`, `accountName`, `accountId`, `returnHost`,
 *   `agent` (a per-agent connector address: the agent the grant is for);
 * - `view.heading`, `view.lead`, `view.done`: `{en, vi}` texts that replace the default heading, the sentence under it,
 *   and what a successful answer says.
 * Every dynamic value (an app's name, an account's name, a server-made sentence) is escaped where it is written.
 */

import { ICONS, bi, esc, renderPage } from "../utils/page-kit.js";

/** The words of the pages that do not depend on a ticket. */
export const SECURE_TEXT = Object.freeze({
    en: Object.freeze({
        approverPassword: "Approver password",
        approvePin: "Hidden-chat PIN (to approve)",
        pin: "Hidden-chat PIN",
        currentPin: "Current PIN",
        newPin: "New PIN (4 digits)",
        newPin2: "New PIN again",
        approve: "Approve",
        decline: "Decline",
        unlock: "Unlock",
        save: "Save",
        cancel: "Cancel",
        closeNote: "You can close this page.",
        footer: "This link works once and expires at {time} UTC. Nothing typed here is shown to the AI agent.",
        oauthHeading: "Allow access to your Zalo account?",
        oauthLead: "An app asks to connect to this Zalo account. Approve only if you started this connection.",
        oauthApp: "App",
        oauthAccount: "Account",
        oauthReturns: "After you answer, you return to",
        oauthAgent: "It connects as the agent",
        oauthAgentPick: "Agent of this connection (optional)",
        oauthAgentNone: "No agent (it sees the account as before)",
        oauthAgentNew: "A new agent…",
        oauthAgentNewName: "New agent's name (when you chose a new agent)",
        oauthCan: "It will be able to",
        oauthCanText:
            "Use this account's MCP tools: read its messages and conversations, and send messages as this account.",
        approveHeading: "Approve this action?",
        approveLead: "An AI agent asks to do this on your Zalo account. Nothing happens unless you approve.",
        approveWhat: "Requested action",
        approveWhatNote: "Described by the server.",
        account: "Account",
        pinHeading: "Enter your hidden-chat PIN",
        pinWhat: "Request",
        pinChangeHeading: "Change the hidden-chat PIN",
        pinSetHeading: "Set a hidden-chat PIN",
        pinChangeLead: "Type the current PIN, then the new 4-digit PIN twice.",
        pinSetLead: "Type the new 4-digit PIN twice.",
        choose: "Choose Approve or Decline.",
        approvedTitle: "Approved",
        approvedText: "Approved. The agent can go on now.",
        unlockedTitle: "Unlocked",
        unlockedText: "Unlocked. The agent can go on now.",
        savedTitle: "PIN saved",
        savedText: "The PIN was saved.",
        doneTitle: "Done",
        doneText: "Done. The agent can go on now.",
        notDoneTitle: "Not done",
        declinedTitle: "Declined",
        declinedText: "Nothing was done.",
        notFoundTitle: "Link not found",
        notFoundText: "This link is not known to this server: it may be mistyped, or the server restarted.",
        expiredTitle: "Link expired",
        expiredText: "This link has expired. Ask again for a new one.",
        usedTitle: "Link already used",
        usedText: "This link was already used; each link works once.",
        wrongAccountTitle: "Wrong account",
        wrongAccountText: "This link belongs to another account.",
        answeredTitle: "Already answered",
        answeredOk: "This was already completed; the agent can go on.",
        answeredDeclined: "This was already declined.",
        refusedTitle: "Refused",
        refusedOrigin: "This form can only be sent from its own page.",
        refusedLarge: "That request was too large.",
        notAllowedTitle: "Not allowed",
        notAllowedText: "This page takes GET and POST only.",
        nothingTitle: "Not found",
        nothingText: "There is nothing here.",
        errorTitle: "Error",
        errorText: "Something went wrong.",
        noCheck: "Nothing to check this with.",
        couldNot: "It could not be completed: {why}",
    }),
    vi: Object.freeze({
        approverPassword: "Mật khẩu người duyệt",
        approvePin: "Mã PIN trò chuyện ẩn (để duyệt)",
        pin: "Mã PIN trò chuyện ẩn",
        currentPin: "Mã PIN hiện tại",
        newPin: "Mã PIN mới (4 chữ số)",
        newPin2: "Nhập lại mã PIN mới",
        approve: "Đồng ý",
        decline: "Từ chối",
        unlock: "Mở khóa",
        save: "Lưu",
        cancel: "Hủy",
        closeNote: "Bạn có thể đóng trang này.",
        footer:
            "Liên kết này chỉ dùng được một lần và hết hạn lúc {time} (giờ UTC). Những gì bạn nhập ở đây không " +
            "hiển thị cho trợ lý AI.",
        oauthHeading: "Cho phép truy cập tài khoản Zalo?",
        oauthLead:
            "Một ứng dụng đang yêu cầu kết nối với tài khoản Zalo này. Chỉ đồng ý nếu chính bạn đã bắt đầu kết nối này.",
        oauthApp: "Ứng dụng",
        oauthAccount: "Tài khoản",
        oauthReturns: "Sau khi trả lời, bạn sẽ quay về",
        oauthAgent: "Kết nối với vai trò agent",
        oauthAgentPick: "Agent của kết nối này (không bắt buộc)",
        oauthAgentNone: "Không gắn agent (thấy tài khoản như trước)",
        oauthAgentNew: "Một agent mới…",
        oauthAgentNewName: "Tên agent mới (khi bạn chọn agent mới)",
        oauthCan: "Ứng dụng sẽ có thể",
        oauthCanText:
            "Dùng các công cụ MCP của tài khoản này: đọc tin nhắn và cuộc trò chuyện, và gửi tin nhắn dưới tên " +
            "tài khoản này.",
        approveHeading: "Duyệt thao tác này?",
        approveLead:
            "Trợ lý AI muốn thực hiện việc này trên tài khoản Zalo của bạn. Sẽ không có gì xảy ra nếu bạn không đồng ý.",
        approveWhat: "Thao tác được yêu cầu",
        approveWhatNote: "Mô tả do máy chủ tạo, bằng tiếng Anh.",
        account: "Tài khoản",
        pinHeading: "Nhập mã PIN trò chuyện ẩn",
        pinWhat: "Yêu cầu",
        pinChangeHeading: "Đổi mã PIN trò chuyện ẩn",
        pinSetHeading: "Đặt mã PIN trò chuyện ẩn",
        pinChangeLead: "Nhập mã PIN hiện tại, rồi nhập mã PIN mới gồm 4 chữ số hai lần.",
        pinSetLead: "Nhập mã PIN mới gồm 4 chữ số hai lần.",
        choose: "Hãy chọn Đồng ý hoặc Từ chối.",
        approvedTitle: "Đã đồng ý",
        approvedText: "Đã đồng ý. Trợ lý AI có thể tiếp tục.",
        unlockedTitle: "Đã mở khóa",
        unlockedText: "Đã mở khóa. Trợ lý AI có thể tiếp tục.",
        savedTitle: "Đã lưu mã PIN",
        savedText: "Mã PIN đã được lưu.",
        doneTitle: "Hoàn tất",
        doneText: "Đã xong. Trợ lý AI có thể tiếp tục.",
        notDoneTitle: "Chưa thực hiện",
        declinedTitle: "Đã từ chối",
        declinedText: "Không có thao tác nào được thực hiện.",
        notFoundTitle: "Không tìm thấy liên kết",
        notFoundText: "Máy chủ không nhận ra liên kết này: có thể liên kết bị gõ sai, hoặc máy chủ đã khởi động lại.",
        expiredTitle: "Liên kết đã hết hạn",
        expiredText: "Liên kết này đã hết hạn. Hãy yêu cầu một liên kết mới.",
        usedTitle: "Liên kết đã được sử dụng",
        usedText: "Liên kết này đã được sử dụng; mỗi liên kết chỉ dùng được một lần.",
        wrongAccountTitle: "Sai tài khoản",
        wrongAccountText: "Liên kết này thuộc về một tài khoản khác.",
        answeredTitle: "Đã được trả lời",
        answeredOk: "Yêu cầu này đã được hoàn tất; trợ lý AI có thể tiếp tục.",
        answeredDeclined: "Yêu cầu này đã bị từ chối.",
        refusedTitle: "Bị từ chối",
        refusedOrigin: "Biểu mẫu này chỉ được gửi từ chính trang của nó.",
        refusedLarge: "Yêu cầu này quá lớn.",
        notAllowedTitle: "Không được phép",
        notAllowedText: "Trang này chỉ nhận yêu cầu GET và POST.",
        nothingTitle: "Không tìm thấy",
        nothingText: "Không có gì ở đây.",
        errorTitle: "Lỗi",
        errorText: "Đã có lỗi xảy ra.",
        noCheck: "Không có gì để kiểm tra yêu cầu này.",
        couldNot: "Không thể hoàn tất: {why}",
    }),
});

const EN = SECURE_TEXT.en;
const VI = SECURE_TEXT.vi;

/** A `{en, vi}` pair of one key of SECURE_TEXT. */
const pair = (key) => ({ en: EN[key], vi: VI[key] });
/** A `{en, vi}` pair as markup. */
const say = (p, tag) => bi(p.en, p.vi, tag);
/** A `{en, vi}` pair, or null when `p` is not one. */
const asPair = (p) => (p && typeof p.en === "string" ? { en: p.en, vi: typeof p.vi === "string" ? p.vi : p.en } : null);

/**
 * A failed secret check in Vietnamese, from the check's own result (`failure`: which secret, why, how many, how
 * long), or null when it is not one this page knows; the English sentence is the check's own message.
 *
 * @param {{secret?: string, reason?: string, failures?: number, retryAfterMs?: number}|null|undefined} failure
 * @returns {string|null}
 */
export function failureVi(failure) {
    if (!failure || typeof failure !== "object") return null;
    const secs = (ms) => Math.ceil((ms ?? 0) / 1000);
    const times = (n) => (n === 1 ? "sai 1 lần" : `sai ${n} lần liên tiếp`);
    const { secret, reason, failures, retryAfterMs } = failure;
    if (secret === "new-pin") {
        if (reason === "shape") return "Mã PIN mới gồm 4 chữ số.";
        if (reason === "differ") return "Hai mã PIN mới không khớp nhau.";
        return null;
    }
    if (secret === "password") {
        if (reason === "none")
            return "Chưa đặt mật khẩu người duyệt: chủ tài khoản đặt bằng `zalo-agent mcp approver set`.";
        if (reason === "locked") return `Nhập sai mật khẩu quá nhiều lần: hãy thử lại sau ${secs(retryAfterMs)} giây.`;
        if (reason === "wrong") {
            return (
                `Sai mật khẩu người duyệt (${times(failures)}).` +
                (retryAfterMs ? ` Hãy đợi ${secs(retryAfterMs)} giây trước khi thử lại.` : "")
            );
        }
        return null;
    }
    if (secret === "pin" || secret === "current-pin") {
        let line;
        if (reason === "no-pin")
            line =
                "Tài khoản này chưa đặt mã PIN trò chuyện ẩn; hãy đặt mã trước (trên điện thoại, hoặc bằng " +
                "`conv hidden-pin`).";
        else if (reason === "shape") line = "Mã PIN gồm 4 chữ số.";
        else if (reason === "locked")
            line = `Nhập sai mã PIN quá nhiều lần: hãy thử lại sau ${secs(retryAfterMs)} giây.`;
        else if (reason === "wrong" || reason === undefined)
            line =
                `Sai mã PIN (${times(failures)}).` +
                (retryAfterMs ? ` Hãy đợi ${secs(retryAfterMs)} giây trước khi thử lại.` : "");
        else return null;
        return secret === "current-pin" ? `Mã PIN hiện tại: ${line}` : line;
    }
    return null;
}

/**
 * What a check's answer says on the page, in both languages: its message, with the Vietnamese from its `failure`.
 *
 * @param {{message?: string|null, failure?: object}} result
 * @returns {{en: string, vi: string}}
 */
export function noticeOf(result) {
    const en = String(result?.message ?? "");
    return { en, vi: failureVi(result?.failure) ?? en };
}

/**
 * "It could not be completed: <why>", in both languages.
 * @param {string} why
 * @returns {{en: string, vi: string}}
 */
export function couldNotNotice(why) {
    return { en: EN.couldNot.replace("{why}", () => why), vi: VI.couldNot.replace("{why}", () => why) };
}

/** The "nothing to check this with" notice. */
export const NO_CHECK_NOTICE = Object.freeze(pair("noCheck"));
/** The "choose Approve or Decline" notice. */
export const CHOOSE_NOTICE = Object.freeze(pair("choose"));

const fact = (label, value) => `<div><dt>${say(label)}</dt><dd>${value}</dd></div>`;

const pinInput = (name, label) =>
    `<div class="field"><label for="${name}">${say(label)}</label><input id="${name}" name="${name}" type="password" ` +
    `class="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" minlength="4" autocomplete="off" required></div>`;

const passwordInput = () =>
    `<div class="field"><label for="secret">${say(pair("approverPassword"))}</label><input id="secret" name="secret" ` +
    `type="password" class="wide" autocomplete="off" maxlength="256" required></div>`;

/**
 * The OAuth approve page's agent picker (Companion Router): no agent, one of the account's agents, or a new one by name.
 * The choice is the grant's agent; a new name becomes an agent the console offers to create.
 */
const agentPicker = (agents) =>
    `<div class="field"><label for="agent">${say(pair("oauthAgentPick"))}</label><select id="agent" name="agent" class="wide">` +
    `<option value="">${say(pair("oauthAgentNone"))}</option>` +
    agents.map((a) => `<option value="${esc(a.slug)}">${esc(a.name)} (${esc(a.slug)})</option>`).join("") +
    `<option value="+new">${say(pair("oauthAgentNew"))}</option></select></div>` +
    `<div class="field"><label for="agentNew">${say(pair("oauthAgentNewName"))}</label><input id="agentNew" name="agentNew" ` +
    `class="wide" maxlength="40" autocomplete="off"></div>`;

const buttons = (yes, no, noValidate) =>
    `<div class="actions"><button type="submit" name="decision" value="approve">${say(pair(yes))}</button>` +
    `<button type="submit" name="decision" value="decline" class="secondary"${noValidate ? " formnovalidate" : ""}>` +
    `${say(pair(no))}</button></div>`;

/** An account as "name" over "id", or the id alone. */
function accountValue(name, id) {
    const n = String(name ?? "").trim();
    const i = String(id ?? "").trim();
    if (n && n !== i) return `${esc(n)}${i ? `<small>${esc(i)}</small>` : ""}`;
    return esc(i);
}

/**
 * The form page of a pending ticket. The form posts back to the token path itself, relatively.
 *
 * @param {object} ticket - see TicketStore#issue
 * @param {{en: string, vi: string}|null} [notice] - why the form is shown again
 * @param {{lang?: "en"|"vi"|null}} [o] - the language the link asked for, kept on the form's answer
 * @returns {{title: {en: string, vi: string}, body: string, cardClass: string}}
 */
export function formView(ticket, notice = null, { lang = null } = {}) {
    const view = ticket.view && typeof ticket.view === "object" ? ticket.view : {};
    let heading;
    let lead = asPair(view.lead);
    let facts = "";
    let fields;
    let badge = ICONS.lock;
    if (ticket.kind === "confirm") {
        const secret =
            ticket.secretKind === "pin"
                ? pinInput("secret", pair("approvePin"))
                : ticket.secretKind === "password"
                  ? passwordInput()
                  : "";
        const picker =
            view.type === "oauth" && !view.agent && Array.isArray(view.agents) ? agentPicker(view.agents) : "";
        fields = picker + secret + buttons("approve", "decline", Boolean(secret));
        if (view.type === "oauth") {
            badge = ICONS.link;
            heading = pair("oauthHeading");
            lead ??= pair("oauthLead");
            const app = accountValue(view.clientName, view.clientId);
            facts =
                fact(pair("oauthApp"), app) +
                fact(pair("oauthAccount"), accountValue(view.accountName, view.accountId)) +
                // A per-agent connector address: the grant is that agent's (Companion Router).
                (view.agent ? fact(pair("oauthAgent"), `<span class="host">${esc(view.agent)}</span>`) : "") +
                fact(pair("oauthReturns"), `<span class="host">${esc(view.returnHost)}</span>`) +
                fact(pair("oauthCan"), say(pair("oauthCanText")));
        } else {
            heading = pair("approveHeading");
            lead ??= pair("approveLead");
            const account =
                view.accountName || view.accountId
                    ? fact(pair("account"), accountValue(view.accountName, view.accountId))
                    : "";
            facts =
                fact(
                    pair("approveWhat"),
                    `<span class="quote" lang="en">${esc(view.wouldDo ?? ticket.description)}</span>` +
                        `<small>${say(pair("approveWhatNote"))}</small>`,
                ) + account;
        }
    } else if (ticket.kind === "pin-change") {
        heading = ticket.hasPin ? pair("pinChangeHeading") : pair("pinSetHeading");
        lead ??= ticket.hasPin ? pair("pinChangeLead") : pair("pinSetLead");
        fields =
            (ticket.hasPin ? pinInput("pin", pair("currentPin")) : "") +
            pinInput("newPin", pair("newPin")) +
            pinInput("newPin2", pair("newPin2")) +
            buttons("save", "cancel", true);
    } else {
        heading = pair("pinHeading");
        if (!lead) {
            facts = fact(
                pair("pinWhat"),
                `<span lang="en">${esc(ticket.description)}</span><small>${say(pair("approveWhatNote"))}</small>`,
            );
        }
        fields = pinInput("pin", pair("pin")) + buttons("unlock", "cancel", true);
    }
    heading = asPair(view.heading) ?? heading;
    const time = new Date(ticket.expiresAt).toISOString().slice(11, 16);
    const body =
        `<div class="badge">${badge}</div><h1>${say(heading)}</h1>` +
        (lead ? `<p class="sub">${say(lead)}</p>` : "") +
        (facts ? `<dl class="facts">${facts}</dl>` : "") +
        (notice ? `<p class="msg" role="alert">${say(notice)}</p>` : "") +
        `<form method="post" action="${esc(ticket.token)}${lang ? `?lang=${lang}` : ""}" autocomplete="off">${fields}</form>` +
        `<p class="fine">${bi(EN.footer.replace("{time}", time), VI.footer.replace("{time}", time))}</p>`;
    return { title: heading, body, cardClass: "wide" };
}

/**
 * A status page: a heading, what happened, and that the page may be closed.
 *
 * @param {object} o
 * @param {{en: string, vi: string}|string} o.title - a pair, or a key of SECURE_TEXT
 * @param {{en: string, vi: string}|string} o.text - a pair, or a key of SECURE_TEXT
 * @param {"ok"|"bad"|"warn"} [o.tone]
 * @returns {{title: {en: string, vi: string}, body: string, cardClass: string}}
 */
export function statusView({ title, text, tone = "bad" }) {
    const t = typeof title === "string" ? pair(title) : title;
    const x = typeof text === "string" ? pair(text) : text;
    const badge = tone === "ok" ? ICONS.check : tone === "warn" ? ICONS.clock : ICONS.cross;
    const body =
        `<div class="badge ${tone}">${badge}</div><h1>${say(t)}</h1>` +
        (x.en ? `<p class="msg${tone === "ok" ? " ok" : tone === "warn" ? " warn" : ""}">${say(x)}</p>` : "") +
        `<p class="note">${say(pair("closeNote"))}</p>`;
    return { title: t, body, cardClass: "" };
}

/**
 * What a ticket's successful answer says: the view's `done` when it has one, else the check's own message in English
 * and the kind's sentence in Vietnamese.
 *
 * @param {object} ticket
 * @param {"approved"|"done"} status
 * @param {string|null} [message]
 * @returns {{title: {en: string, vi: string}, text: {en: string, vi: string}}}
 */
export function successText(ticket, status, message = null) {
    const done = asPair(ticket.view?.done);
    const [titleKey, textKey] =
        ticket.kind === "pin-change"
            ? ["savedTitle", "savedText"]
            : ticket.kind === "pin"
              ? ["unlockedTitle", "unlockedText"]
              : status === "done"
                ? ["doneTitle", "doneText"]
                : ["approvedTitle", "approvedText"];
    if (done) return { title: pair(titleKey), text: done };
    return { title: pair(titleKey), text: { en: message || EN[textKey], vi: VI[textKey] } };
}

/**
 * The whole document of a view.
 *
 * @param {{title: {en: string, vi: string}, body: string, cardClass?: string}} view
 * @param {{nonce: string, lang?: "en"|"vi"}} o
 * @returns {string}
 */
export function renderView(view, { nonce, lang = "en" }) {
    return renderPage({ nonce, lang, title: view.title, body: view.body, cardClass: view.cardClass ?? "" });
}
