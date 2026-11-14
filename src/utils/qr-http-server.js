/**
 * Temporary local HTTP server for QR display on headless/VPS environments.
 * Serves the QR image as a plain login page on localhost, laid out like Zalo's own login page.
 * Auto-closes after login completes.
 *
 * The page is also served at a one-time link, `/zalo/qr/<token>` (QrPage below): on the MCP HTTP server's own port
 * when a login runs inside `mcp start --http`, and on this server when `publicUrl` is set (`login --public-url`), so
 * a reverse proxy can route `/zalo/qr/` to it. The QR is a login token: the link carries a random 128-bit token, lives
 * only while a code is on screen, and every answer is `no-store` with a CSP that allows only the page's own image,
 * style, script and polls. Links are built from `publicUrl` or the local address, never from a request's Host header.
 */

import http from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, existsSync, statSync } from "fs";
import { info } from "./output.js";

/**
 * Where the login is, for the page: which QR is on screen (the first, or the second an account with a trusted
 * device is asked to scan), who scanned it, whether it expired (and what asks for a new one), and how the login
 * ended. Set by the login as the events arrive.
 */
const newQrState = () => ({ layer: 1, scanned: null, expired: false, refresh: null, outcome: null, message: "" });
// The process's own login (`login`, `account login`, a login inside `mcp start --http`); a fleet controller's flows
// each have their own (QrPage `state`), so two at once never share a "scanned" or an outcome.
const qrState = newQrState();

/**
 * Note which QR the page should say it is showing. A new code is never expired.
 * @param {number} [layer] - 1 for the first QR, 2 for the one scanned after it
 */
export function noteQrLayer(layer = 1) {
    qrState.layer = layer;
    qrState.expired = false;
    qrState.refresh = null;
    if (layer === 1) qrState.scanned = null;
}

/**
 * Note that the code on screen expired. The page then offers a new one, which calls `refresh` (once); with no
 * `refresh` it can only say so.
 * @param {(() => void)|null} refresh
 */
export function noteQrExpired(refresh) {
    qrState.expired = true;
    qrState.scanned = null;
    qrState.refresh = typeof refresh === "function" ? refresh : null;
}

/**
 * Note how the login ended, for the page to say.
 * @param {"done"|"failed"} outcome
 * @param {string} [message] - why it failed
 */
export function noteQrOutcome(outcome, message = "") {
    qrState.outcome = outcome;
    qrState.message = String(message || "");
    qrState.expired = false;
    qrState.refresh = null;
}

/**
 * Note that the phone scanned the QR and is waiting for the confirmation.
 * @param {string} [name] - the name the phone scanned as, when it is known
 */
export function noteQrScanned(name = "") {
    qrState.scanned = String(name || "");
}

/**
 * Which QR image is current: its modification time, or null before the first.
 * The login loop regenerates the QR roughly every 100 s; the page polls this
 * so it never shows an expired code (measured 2026-09-30: a page opened on
 * the first QR kept showing it after two regenerations, and a scan failed).
 *
 * @param {string} qrImagePath
 * @returns {number|null}
 */
export function qrVersion(qrImagePath) {
    try {
        return statSync(qrImagePath).mtimeMs;
    } catch {
        return null;
    }
}

const PAGE_STYLE = `
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
  background:#f0f3f7;color:#081c36;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.brand{font-size:20px;font-weight:600;letter-spacing:-.2px;color:#0068ff}
.card{width:min(380px,92vw);padding:28px 28px 24px;background:#fff;border:1px solid #dfe4ea;border-radius:8px;text-align:center}
h1{margin:0 0 4px;font-size:18px;font-weight:600}
.sub{margin:0 0 20px;color:#5b6b7c;font-size:14px}
.frame{position:relative;width:240px;height:240px;margin:0 auto 18px;padding:10px;background:#fff}
.frame i{position:absolute;width:22px;height:22px;border:3px solid #0068ff}
.frame i:nth-of-type(1){top:0;left:0;border-right:0;border-bottom:0}
.frame i:nth-of-type(2){top:0;right:0;border-left:0;border-bottom:0}
.frame i:nth-of-type(3){bottom:0;left:0;border-right:0;border-top:0}
.frame i:nth-of-type(4){bottom:0;right:0;border-left:0;border-top:0}
.frame img{display:block;width:100%;height:100%;image-rendering:pixelated}
.note{min-height:42px;margin:0;color:#5b6b7c;font-size:14px}
.note b{color:#081c36;font-weight:600}
.done h1{color:#0a7d33}
.frame .expired{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  background:rgba(255,255,255,.93);font-weight:600}
.frame.off img{filter:blur(3px);opacity:.35}
button{padding:8px 18px;border:0;border-radius:6px;background:#0068ff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.failed h1{color:#c4271b}
.hidden{display:none!important}
.lang{margin:14px 0 0;font-size:13px;color:#8593a3}
.lang span{margin:0 8px}
.lang a{color:#5b6b7c;text-decoration:none}
.lang a.on{color:#0068ff;font-weight:600}
`;

/**
 * Everything the page says, in the two languages Zalo offers. The page picks one from the `lang` query, then a
 * saved choice, then the browser's language; the server only ever sends both.
 */
export const PAGE_TEXT = Object.freeze({
    en: Object.freeze({
        documentTitle: "Log in to Zalo",
        preparing: "Preparing the code…",
        title: "Log in with QR code",
        sub: "Use the Zalo app on your phone to scan this code.",
        note: "Open Zalo, tap the QR scanner, and point it at this code.",
        secondTitle: "Scan the new code",
        secondSub: "This code replaced the first one.",
        secondNote: "Your account asks to confirm this device: scan this code once more.",
        confirmTitle: "Confirm on your phone",
        confirmNote: "Tap Confirm in the Zalo app to finish logging in.",
        doneTitle: "You are logged in",
        doneSub: "You can close this page. The command line is ready.",
        expiredTitle: "QR code expired",
        expiredNote: "Get a new code to keep logging in.",
        expiredGone: "Run the login command again for a new code.",
        refresh: "Get a new code",
        failedTitle: "Login failed",
        failedSub: "See the command line for details, then run the login again.",
        goneTitle: "The login command has ended",
        goneSub: "See the command line for how it went.",
        qrAlt: "QR code",
    }),
    vi: Object.freeze({
        documentTitle: "Đăng nhập Zalo",
        preparing: "Đang chuẩn bị mã…",
        title: "Đăng nhập bằng mã QR",
        sub: "Dùng ứng dụng Zalo trên điện thoại để quét mã này.",
        note: "Mở Zalo, chọn quét mã QR và hướng camera vào mã này.",
        secondTitle: "Quét mã mới",
        secondSub: "Mã này đã thay thế mã đầu tiên.",
        secondNote: "Tài khoản của bạn yêu cầu xác nhận thiết bị này: hãy quét mã này thêm một lần nữa.",
        confirmTitle: "Xác nhận trên điện thoại",
        confirmNote: "Nhấn Xác nhận trong ứng dụng Zalo để hoàn tất đăng nhập.",
        doneTitle: "Đã đăng nhập thành công",
        doneSub: "Bạn có thể đóng trang này. Dòng lệnh đã sẵn sàng.",
        expiredTitle: "Mã QR đã hết hạn",
        expiredNote: "Lấy mã mới để tiếp tục đăng nhập.",
        expiredGone: "Chạy lại lệnh đăng nhập để có mã mới.",
        refresh: "Lấy mã mới",
        failedTitle: "Đăng nhập thất bại",
        failedSub: "Xem chi tiết ở dòng lệnh, rồi chạy lại lệnh đăng nhập.",
        goneTitle: "Lệnh đăng nhập đã kết thúc",
        goneSub: "Xem kết quả ở dòng lệnh.",
        qrAlt: "Mã QR",
    }),
});

const LANGUAGE_SWITCH = `<p class="lang"><a href="#" data-lang="en">English</a><span>&middot;</span><a href="#" data-lang="vi">Tiếng Việt</a></p>`;

/** Where the page fetches its image, status and refresh on the local server (`/qr`). */
const LOCAL_PATHS = Object.freeze({ image: "/qr.png", status: "/status", refresh: "/refresh" });

function waitingPage(nonce) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${PAGE_TEXT.en.documentTitle}</title><style nonce="${nonce}">${PAGE_STYLE}</style></head>
<body><div class="brand">zalo-agent-cli</div><div class="card"><h1>${PAGE_TEXT.en.preparing}</h1>
<p class="sub">${PAGE_TEXT.vi.preparing}</p></div></body></html>`;
}

function loginPage(version, paths, nonce) {
    const en = PAGE_TEXT.en;
    const imageUrl = `${paths.image}?v=${version}`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${en.documentTitle}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<style nonce="${nonce}">${PAGE_STYLE}</style></head>
<body>
<div class="brand">zalo-agent-cli</div>
<div class="card" id="login">
<h1 id="title">${en.title}</h1>
<p class="sub" id="sub">${en.sub}</p>
<div class="frame" id="frame"><i></i><i></i><i></i><i></i><img id="qr" src="${imageUrl}" alt="${en.qrAlt}">
<div class="expired hidden" id="expired"><span id="expiredTitle">${en.expiredTitle}</span><button type="button" id="refresh">${en.refresh}</button></div></div>
<p class="note" id="note">${en.note}</p>
${LANGUAGE_SWITCH}
</div>
<div class="card done hidden" id="done"><h1 id="doneTitle">${en.doneTitle}</h1>
<p class="sub" id="doneSub">${en.doneSub}</p></div>
<div class="card failed hidden" id="failed"><h1 id="failedTitle">${en.failedTitle}</h1>
<p class="sub" id="failedMsg"></p><p class="note" id="failedSub">${en.failedSub}</p></div>
<script nonce="${nonce}">
// Poll /status: swap in each new QR, say which one this is, offer a new code when it expires, and say how it ended.
const TEXT=${JSON.stringify(PAGE_TEXT)};
let version=${JSON.stringify(version)},layer=1,scanned=null,expired=false,canRefresh=false,ended=null,why='',misses=0,timer=null;
const $=(id)=>document.getElementById(id);
const saved=()=>{try{return localStorage.getItem('zalo-agent-lang')}catch{return null}};
const asked=new URLSearchParams(location.search).get('lang');
let lang=[asked,saved(),(navigator.language||'').toLowerCase().startsWith('vi')?'vi':'en'].find((l)=>l==='vi'||l==='en');
function render(){
  const t=TEXT[lang];
  document.documentElement.lang=lang;
  document.title=t.documentTitle;
  $('qr').alt=t.qrAlt;
  $('doneTitle').textContent=t.doneTitle;
  $('doneSub').textContent=t.doneSub;
  $('login').classList.toggle('hidden',ended!==null);
  $('done').classList.toggle('hidden',ended!=='done');
  $('failed').classList.toggle('hidden',ended!=='failed'&&ended!=='gone');
  $('failedTitle').textContent=ended==='gone'?t.goneTitle:t.failedTitle;
  $('failedMsg').textContent=ended==='gone'?'':why;
  $('failedSub').textContent=ended==='gone'?t.goneSub:t.failedSub;
  $('frame').classList.toggle('off',expired);
  $('expired').classList.toggle('hidden',!expired);
  $('expiredTitle').textContent=t.expiredTitle;
  $('refresh').textContent=t.refresh;
  $('refresh').classList.toggle('hidden',!canRefresh);
  if(expired){
    $('title').textContent=t.expiredTitle;
    $('sub').textContent=t.sub;
    $('note').textContent=canRefresh?t.expiredNote:t.expiredGone;
  }else if(scanned!==null){
    $('title').textContent=t.confirmTitle;
    $('sub').textContent=scanned;
    $('note').textContent=t.confirmNote;
  }else if(layer===2){
    $('title').textContent=t.secondTitle;
    $('sub').textContent=t.secondSub;
    $('note').textContent=t.secondNote;
  }else{
    $('title').textContent=t.title;
    $('sub').textContent=t.sub;
    $('note').textContent=t.note;
  }
  document.querySelectorAll('[data-lang]').forEach((a)=>a.classList.toggle('on',a.dataset.lang===lang));
}
document.querySelectorAll('[data-lang]').forEach((a)=>a.addEventListener('click',(e)=>{
  e.preventDefault();lang=a.dataset.lang;
  try{localStorage.setItem('zalo-agent-lang',lang)}catch{}
  render();
}));
$('refresh').addEventListener('click',async()=>{
  $('refresh').disabled=true;
  try{await fetch('${paths.refresh}',{method:'POST'})}catch{}
  $('refresh').disabled=false;
  poll();
});
render();
async function poll(){
  if(ended)return;
  try{
    const d=await (await fetch('${paths.status}',{cache:'no-store'})).json();
    misses=0;
    if(d.loggedIn)ended='done';
    else if(d.outcome==='failed'){ended='failed';why=d.message||''}
    else{
      if(d.qrVersion&&d.qrVersion!==version){version=d.qrVersion;$('qr').src='${paths.image}?v='+version}
      layer=d.layer||1;scanned=d.scanned;expired=Boolean(d.expired);canRefresh=Boolean(d.canRefresh);
    }
  }catch{
    // The command serves this page only while the login runs: gone means it ended, and the terminal says how.
    if(++misses>=3)ended='gone';
  }
  render();
  if(ended&&timer){clearInterval(timer);timer=null}
}
poll();
timer=setInterval(poll,1500);
</script>
</body></html>`;
}

/** Headers of the page: nothing cached, nothing framed, no referrer, and a CSP that allows the page's own image,
 * its polls, and its one inline style and script (by nonce). */
function pageHeaders(nonce) {
    return {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
            `default-src 'none'; img-src 'self'; connect-src 'self'; style-src 'nonce-${nonce}'; ` +
            `script-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    };
}

const DATA_HEADERS = Object.freeze({
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
});

/**
 * Answer one of the page's own requests: `page`, `image`, `status` or `refresh`.
 * @param {import("http").ServerResponse} res
 * @param {string} what - "page", "image", "status" or "refresh"; anything else is a 404
 * @param {{qrImagePath: string, paths: {image: string, status: string, refresh: string}, method?: string,
 *   onOutcomeRead?: () => void}} ctx
 */
async function answerQr(res, what, { qrImagePath, paths, method = "GET", onOutcomeRead, state = qrState }) {
    const qrState = state;
    if (what === "page") {
        const nonce = randomBytes(16).toString("base64");
        res.writeHead(200, pageHeaders(nonce));
        if (!existsSync(qrImagePath)) {
            res.end(waitingPage(nonce));
            return;
        }
        // The image is fetched by URL (the same one the poll swaps in), so the page stays small.
        res.end(loginPage(qrVersion(qrImagePath), paths, nonce));
    } else if (what === "image") {
        // Raw PNG image endpoint — for agents to send direct image link
        if (!existsSync(qrImagePath)) {
            res.writeHead(404, { ...DATA_HEADERS, "Content-Type": "text/plain" });
            res.end("QR not generated yet");
            return;
        }
        const img = readFileSync(qrImagePath);
        res.writeHead(200, {
            ...DATA_HEADERS,
            "Content-Type": "image/png",
            "Content-Length": img.length,
            "Cache-Control": "no-cache, no-store",
        });
        res.end(img);
    } else if (what === "status") {
        // Login status endpoint for browser polling
        let loggedIn = qrState.outcome === "done";
        if (qrState.outcome === null) {
            try {
                const { isLoggedIn } = await import("../core/zalo-client.js");
                loggedIn = isLoggedIn();
            } catch {}
        }
        res.writeHead(200, { ...DATA_HEADERS, "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                loggedIn,
                qrVersion: qrVersion(qrImagePath),
                layer: qrState.layer,
                scanned: qrState.scanned,
                expired: qrState.expired,
                canRefresh: qrState.expired && qrState.refresh !== null,
                outcome: qrState.outcome,
                message: qrState.outcome === "failed" ? qrState.message : "",
            }),
        );
        if (qrState.outcome !== null) onOutcomeRead?.();
    } else if (what === "refresh" && method === "POST") {
        // The page's "Get a new code": only an expired code is replaced, and only once.
        const refresh = qrState.expired ? qrState.refresh : null;
        qrState.refresh = null;
        res.writeHead(refresh ? 200 : 409, { ...DATA_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: Boolean(refresh) }));
        if (refresh) refresh();
    } else {
        res.writeHead(404, { ...DATA_HEADERS, "Content-Type": "text/plain" });
        res.end("Not found");
    }
}

/**
 * Whether a page is open (it polls its status), and closing once it has read how the login ended: closing at once
 * left the page polling a server that was gone, so it never said "logged in". With no page open, at once.
 * @param {() => void} close
 */
function pageWatch(close) {
    let pageOpen = false;
    let outcomeSeen = null;
    return {
        polled: () => {
            pageOpen = true;
        },
        outcomeRead: () => {
            const done = outcomeSeen;
            outcomeSeen = null;
            done?.();
        },
        /**
         * Close once an open page has read how the login ended (`noteQrOutcome` first), or after `graceMs`.
         * @param {{graceMs?: number}} [o]
         * @returns {Promise<void>}
         */
        finish: ({ graceMs = 4000 } = {}) =>
            new Promise((resolve) => {
                if (!pageOpen) {
                    close();
                    resolve();
                    return;
                }
                // This timer is what keeps the process up for the page's last poll: the server itself is unref'd.
                const timer = setTimeout(() => done(), graceMs);
                const done = () => {
                    clearTimeout(timer);
                    outcomeSeen = null;
                    // a moment for the answer to leave before the server goes
                    setTimeout(() => {
                        close();
                        resolve();
                    }, 50);
                };
                outcomeSeen = done;
            }),
    };
}

/** The path prefix of the one-time QR page. */
export const QR_PATH_PREFIX = "/zalo/qr/";
/** How long a QR link lives after a code appears: Zalo's code lasts about 100 s, plus a little for the scan. */
export const QR_LINK_TTL_MS = 2 * 60_000;
const QR_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const QR_PATH_SHAPE = /^\/zalo\/qr\/([^/?#]*)(\/(?:qr\.png|status|refresh)?)?$/;

/** A request path or URL with any QR-page token replaced, for logs. */
export function maskQrPath(url) {
    return String(url ?? "").replace(/\/zalo\/qr\/[^/?#\s]*/g, "/zalo/qr/***");
}

/**
 * The one-time link to the QR page, `/zalo/qr/<token>`, with its image at `/zalo/qr/<token>/qr.png`. One login at a
 * time per process, so one link: a new one replaces the last. The token is 128 random bits, kept in memory only, and
 * dies `QR_LINK_TTL_MS` after the last code appeared (`extend`), or when the login ends.
 */
export class QrPage {
    /** @param {{now?: () => number, state?: object}} [opts] - `state`: the page's own login state (default: a new one) */
    constructor({ now = Date.now, state = newQrState() } = {}) {
        this.now = now;
        this.state = state;
        this.publicUrl = null;
        this.localBaseUrl = null;
        /** True when an HTTP server serves this page (`mcp start --http`), so a login there needs no server of its own. */
        this.mounted = false;
        this.token = null;
        this.expiresAt = 0;
        this.qrImagePath = null;
        this.watch = null;
    }

    /**
     * Where the link points: `publicUrl` (resolvePublicUrl) when set, else the serving server's local address.
     * @param {{publicUrl?: string|null, localBaseUrl?: string|null, mounted?: boolean}} [o]
     * @returns {QrPage}
     */
    configure({ publicUrl, localBaseUrl, mounted } = {}) {
        if (publicUrl !== undefined) this.publicUrl = publicUrl;
        if (localBaseUrl !== undefined) this.localBaseUrl = localBaseUrl;
        if (mounted !== undefined) this.mounted = Boolean(mounted);
        return this;
    }

    /**
     * Issue the link for a login's QR, replacing any earlier one.
     * @param {{qrImagePath: string, ttlMs?: number, watch?: object}} o - `watch`: the standalone server's own (both of
     *   its pages share it)
     * @returns {{token: string, url: string|null, imageUrl: string|null, expiresAt: number,
     *   finish: (o?: {graceMs?: number}) => Promise<void>, close: () => void}}
     */
    open({ qrImagePath, ttlMs = QR_LINK_TTL_MS, watch: shared = null }) {
        const token = randomBytes(16).toString("base64url");
        this.token = token;
        this.qrImagePath = qrImagePath;
        this.expiresAt = this.now() + ttlMs;
        const close = () => {
            if (this.token === token) this.revoke();
        };
        const watch = shared ?? pageWatch(close);
        this.watch = watch;
        const base = this.publicUrl || this.localBaseUrl;
        const url = base ? `${base}${QR_PATH_PREFIX}${token}` : null;
        return {
            token,
            url,
            imageUrl: url ? `${url}/qr.png` : null,
            expiresAt: this.expiresAt,
            finish: watch.finish,
            close,
        };
    }

    /**
     * Keep the link alive for `ms` more: a new code appeared, or an expired one waits for "Get a new code".
     * @param {number} [ms]
     */
    extend(ms = QR_LINK_TTL_MS) {
        if (this.token) this.expiresAt = Math.max(this.expiresAt, this.now() + ms);
    }

    /** This page's login state, as the module's note* functions set the process's. */
    noteLayer(layer = 1) {
        this.state.layer = layer;
        this.state.expired = false;
        this.state.refresh = null;
        if (layer === 1) this.state.scanned = null;
    }

    noteScanned(name = "") {
        this.state.scanned = String(name || "");
    }

    noteExpired(refresh) {
        this.state.expired = true;
        this.state.scanned = null;
        this.state.refresh = typeof refresh === "function" ? refresh : null;
    }

    noteOutcome(outcome, message = "") {
        this.state.outcome = outcome;
        this.state.message = String(message || "");
        this.state.expired = false;
        this.state.refresh = null;
    }

    /**
     * Whether a request path names this page's live token (several pages share one server: a fleet controller's flows).
     * @param {string} url
     * @returns {boolean}
     */
    owns(url) {
        const m = QR_PATH_SHAPE.exec(String(url ?? "").split("?")[0]);
        if (!m || !this.token || !QR_TOKEN_SHAPE.test(m[1])) return false;
        const a = Buffer.from(m[1]);
        const b = Buffer.from(this.token);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    /** End the link. */
    revoke() {
        this.token = null;
        this.expiresAt = 0;
        this.qrImagePath = null;
        this.watch = null;
    }

    #live(token) {
        if (!this.token || !QR_TOKEN_SHAPE.test(token)) return false;
        const a = Buffer.from(token);
        const b = Buffer.from(this.token);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
        if (this.now() >= this.expiresAt) {
            this.revoke();
            return false;
        }
        return true;
    }

    /**
     * The request handler. Returns false for a path that is not the page's (the caller goes on), true once it answered.
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     * @returns {Promise<boolean>}
     */
    async handle(req, res) {
        const path = String(req.url ?? "").split("?")[0];
        const m = QR_PATH_SHAPE.exec(path);
        if (!m) return false;
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
            res.writeHead(405, { ...DATA_HEADERS, Allow: "GET, POST", "Content-Type": "text/plain" });
            res.end("Not allowed");
            return true;
        }
        if (!this.#live(m[1])) {
            res.writeHead(404, { ...DATA_HEADERS, "Content-Type": "text/plain" });
            res.end("This QR link is not valid or has expired. Run the login again for a new one.");
            return true;
        }
        const sub = (m[2] ?? "").slice(1);
        const what = sub === "" ? "page" : sub === "qr.png" ? "image" : sub;
        // Relative to the page's own path, so they work under a proxy's base path: `<token>/status` from
        // `.../zalo/qr/<token>`, or `status` from `.../zalo/qr/<token>/`.
        const rel = m[2] === "/" ? "" : `${this.token}/`;
        const watch = this.watch;
        if (what === "status") watch?.polled();
        await answerQr(res, what, {
            qrImagePath: this.qrImagePath,
            paths: { image: `${rel}qr.png`, status: `${rel}status`, refresh: `${rel}refresh` },
            method: req.method,
            onOutcomeRead: () => watch?.outcomeRead(),
            state: this.state,
        });
        return true;
    }
}

let currentQrPage = null;

/**
 * The process's QR page (one login at a time per process).
 * @returns {QrPage}
 */
export function getQrPage() {
    if (!currentQrPage) currentQrPage = new QrPage({ state: qrState });
    return currentQrPage;
}

/**
 * Start a temporary HTTP server that serves the QR image.
 * @param {string} qrImagePath - path to QR PNG file
 * @param {number} port - default 18927
 * @param {number[]} tryPorts - ports to try in order
 * @param {boolean} exposeOnLan - bind 0.0.0.0 instead of 127.0.0.1
 *
 *   The QR is a **login token**: anyone who can fetch and scan it before it
 *   expires signs in as this account. Binding 0.0.0.0 therefore offers the
 *   account to the whole network, so it is opt-in (`--qr-url`) rather than
 *   the default. Loopback still covers the ordinary desktop case, where the
 *   browser is on the same machine.
 * @param {{publicUrl?: string|null, qrPage?: QrPage}} [o] - `publicUrl` (resolvePublicUrl): also serve the page at
 *   `<publicUrl>/zalo/qr/<token>`, the link printed, for a reverse proxy that routes `/zalo/qr/` to this port
 *
 * @returns {{ url: string, link: string|null, close: () => void, finish: (o?: {graceMs?: number}) => Promise<void> }}
 */
export function startQrServer(
    qrImagePath,
    port = 18927,
    tryPorts = [18927, 8080, 3000, 9000],
    exposeOnLan = false,
    { publicUrl = null, qrPage = getQrPage() } = {},
) {
    const bindHost = exposeOnLan ? "0.0.0.0" : "127.0.0.1";
    qrState.outcome = null;
    qrState.message = "";
    let link = null;
    const close = () => {
        if (link && qrPage.token === link.token) qrPage.revoke();
        try {
            server.close();
        } catch {}
    };
    // One watch for both pages: whichever is open reads the outcome before the server goes.
    const watch = pageWatch(close);
    // With a public URL, the page is also at a one-time link a reverse proxy routes here (`/zalo/qr/<token>`).
    if (publicUrl) link = qrPage.configure({ publicUrl }).open({ qrImagePath, watch });
    const server = http.createServer(async (req, res) => {
        if (link && (await qrPage.handle(req, res))) return;
        // The path decides, not the query: `/qr?lang=vi` is the page, `/qr.png?v=1` is the image.
        const path = (req.url || "/").split("?")[0];
        const what =
            path === "/qr" || path === "/"
                ? "page"
                : path === "/qr.png"
                  ? "image"
                  : path === "/status"
                    ? "status"
                    : path === "/refresh"
                      ? "refresh"
                      : null;
        if (what === "status") watch.polled();
        await answerQr(res, what, {
            qrImagePath,
            paths: LOCAL_PATHS,
            method: req.method,
            onOutcomeRead: watch.outcomeRead,
        });
    });

    // Try ports in order until one works (avoids firewall issues)
    let currentPortIdx = 0;

    function tryListen() {
        const p = tryPorts[currentPortIdx];
        server.listen(p, bindHost);
        // Never let the QR server be the reason the process stays alive. It
        // is a convenience view onto a file, not work in its own right — and
        // an orphaned one holds its port long after login finished, so the
        // NEXT login silently falls through to 8080. (Observed: a login's
        // server still serving HTTP 200 on 18927 hours later.)
        server.unref();
    }

    // unref() on the server does not reach its connections: the browser tab's
    // keep-alive socket held the process open after a finished login until the
    // tab was closed (seen in the first live two-QR login, 2026-10-28).
    server.on("connection", (socket) => socket.unref());

    server.on("listening", async () => {
        const actualPort = server.address().port;
        const jsonMode = process.env.ZALO_JSON_MODE === "1";
        let publicIp = null;

        // A public address only means something when the page listens on the network (--qr-url): bound to
        // loopback, as by default, it answers on this machine alone, and the address it used to print could not work.
        // A configured publicUrl is the address: nobody is asked for one.
        if (exposeOnLan && !link) {
            try {
                const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
                publicIp = (await res.text()).trim() || null;
            } catch {}
        }

        if (jsonMode) {
            console.log(
                JSON.stringify({
                    event: "qr_server",
                    port: actualPort,
                    lan: exposeOnLan,
                    localUrl: `http://localhost:${actualPort}/qr`,
                    imageUrl: `http://localhost:${actualPort}/qr.png`,
                    publicUrl: link?.url ?? (publicIp ? `http://${publicIp}:${actualPort}/qr` : null),
                    publicImageUrl: link?.imageUrl ?? (publicIp ? `http://${publicIp}:${actualPort}/qr.png` : null),
                }),
            );
        } else if (link) {
            info(`QR available at: ${link.url}`);
            info(
                `That link is served on port ${actualPort} of this machine: your reverse proxy must route ` +
                    `${QR_PATH_PREFIX} to it. It works for this login only. Locally: http://localhost:${actualPort}/qr`,
            );
        } else if (exposeOnLan) {
            info(`QR available at: http://localhost:${actualPort}/qr`);
            if (publicIp) info(`On VPS, open: http://${publicIp}:${actualPort}/qr`);
            else info(`On VPS, open: http://<your-server-ip>:${actualPort}/qr`);
            info(`If firewall blocks, run: sudo ufw allow ${actualPort}/tcp`);
            info(`Or copy QR file: scp user@vps:~/.zalo-agent-cli/qr.png ./qr.png`);
        } else {
            info(`QR available at: http://localhost:${actualPort}/qr (this machine only)`);
            info(
                `On a VPS: ssh -L ${actualPort}:127.0.0.1:${actualPort} <server>, then open http://localhost:${actualPort}/qr here; ` +
                    "or log in with --qr-url to open the page to the network.",
            );
        }
    });

    server.on("error", (err) => {
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
            currentPortIdx++;
            if (currentPortIdx < tryPorts.length) {
                info(`Port ${tryPorts[currentPortIdx - 1]} unavailable, trying ${tryPorts[currentPortIdx]}...`);
                tryListen();
            }
        }
    });

    tryListen();

    return {
        url: `http://localhost:${port}/qr`,
        link: link?.url ?? null,
        close,
        /**
         * Close once an open page has read how the login ended (`noteQrOutcome` first), or after `graceMs`. Closing at
         * once left the page polling a server that was gone, so it never said "logged in". With no page open, at once.
         * @param {{graceMs?: number}} [o]
         * @returns {Promise<void>}
         */
        finish: watch.finish,
    };
}
