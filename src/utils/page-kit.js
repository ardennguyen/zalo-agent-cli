/**
 * The look every browser page of the engine shares: the QR login page (src/utils/qr-http-server.js) and the one-time
 * secure pages (src/core/secure-page.js). One stylesheet, one header with the product mark, one card, and one
 * English | Tiếng Việt switch, so they read as one product and remember one language choice.
 *
 * - The language: the `lang` query, then the visitor's saved choice (localStorage `zalo-agent-lang`), then the
 *   browser's language (Vietnamese when it starts with "vi", else English). The server sends both languages; the page
 *   switches on the client. A text in both languages is two elements, `.l-en` and `.l-vi`, and the style hides the one
 *   that does not match `<html lang>`, so a page without its script still reads in the server's default language.
 * - Nothing is loaded from elsewhere: no font, image or script by URL. The one style and the one script of a page
 *   carry the per-response nonce its CSP names (`pageHeaders`), and no element has an inline handler.
 */

import { randomBytes } from "node:crypto";

/** Where the visitor's language choice is saved, shared by every page. */
export const LANG_STORAGE_KEY = "zalo-agent-lang";

/** The languages a page speaks. */
export const PAGE_LANGS = Object.freeze(["en", "vi"]);

/**
 * A fresh nonce for one response's style and script.
 * @returns {string}
 */
export function newNonce() {
    return randomBytes(16).toString("base64");
}

/**
 * Escape text for HTML (element content and quoted attributes).
 * @param {unknown} text
 * @returns {string}
 */
export function esc(text) {
    return String(text ?? "").replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
}

/**
 * The language a request asks for with its `lang` query, or null.
 * @param {string|undefined|null} url - the request URL (path and query)
 * @returns {"en"|"vi"|null}
 */
export function requestedLang(url) {
    const query = String(url ?? "").split("?")[1] ?? "";
    let lang = null;
    try {
        lang = new URLSearchParams(query.split("#")[0]).get("lang");
    } catch {
        return null;
    }
    return PAGE_LANGS.includes(lang) ? lang : null;
}

/**
 * Markup for a text in both languages; each is escaped.
 * @param {string} en
 * @param {string} [vi] - defaults to the English text
 * @param {string} [tag]
 * @returns {string}
 */
export function bi(en, vi = en, tag = "span") {
    return `<${tag} class="l-en" lang="en">${esc(en)}</${tag}><${tag} class="l-vi" lang="vi">${esc(vi)}</${tag}>`;
}

/** The shared stylesheet: tokens, light and dark, the header, the card, type, fields, buttons and the switch. */
export const KIT_STYLE = `
:root{--bg:#f0f3f7;--card:#fff;--line:#dfe4ea;--text:#081c36;--muted:#5b6b7c;--faint:#8593a3;--brand:#0068ff;
  --brand-ink:#fff;--field:#fff;--soft:#f5f7fa;--ok:#0a7d33;--ok-bg:#e7f5ea;--bad:#c4271b;--bad-bg:#fdecea;
  --warn-bg:#fff6e0;--warn:#8a5a00;--focus:rgba(0,104,255,.35);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#181d24;--line:#2b333d;--text:#e8edf3;--muted:#9aa7b5;
  --faint:#6f7c8a;--brand:#4d94ff;--brand-ink:#fff;--field:#11161c;--soft:#1f252e;--ok:#5fd18a;--ok-bg:#16301f;
  --bad:#ff8a80;--bad-bg:#3a1d1b;--warn-bg:#33290f;--warn:#f0c46a;--focus:rgba(77,148,255,.45)}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;padding:24px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:20px;min-height:100vh;background:var(--bg);color:var(--text);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-text-size-adjust:100%}
html[lang="en"] .l-vi,html[lang="vi"] .l-en{display:none!important}
.brand{display:flex;align-items:center;gap:8px;font-size:18px;font-weight:600;letter-spacing:-.2px;color:var(--brand)}
.brand svg{display:block;width:28px;height:28px}
.card{width:100%;max-width:400px;padding:28px 24px 20px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;text-align:center}
.card.wide{max-width:440px;text-align:left}
h1{margin:0 0 6px;font-size:19px;font-weight:600;line-height:1.35}
.sub{margin:0 0 20px;color:var(--muted);font-size:14px}
.badge{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 auto 14px;
  border-radius:50%;background:var(--soft);color:var(--brand);font-size:22px;font-weight:700}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.card.wide .badge{margin-left:0}
dl.facts{margin:0 0 18px;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.facts div{padding:10px 14px;border-top:1px solid var(--line)}
.facts div:first-child{border-top:0}
.facts dt{margin:0 0 2px;color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.facts dd{margin:0;font-size:15px;overflow-wrap:anywhere}
.facts dd small{display:block;color:var(--muted);font-size:13px}
.facts .host{font-size:17px;font-weight:600;color:var(--text)}
.facts .quote{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;white-space:pre-wrap}
.note{margin:0 0 16px;color:var(--muted);font-size:14px}
.msg{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:var(--bad-bg);color:var(--bad);font-size:14px;
  text-align:left;overflow-wrap:anywhere}
.msg.ok{background:var(--ok-bg);color:var(--ok)}
.msg.warn{background:var(--warn-bg);color:var(--warn)}
form{margin:0}
label{display:block;margin:0 0 6px;font-size:14px;font-weight:600;text-align:left}
.field{margin:0 0 14px}
input{display:block;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);
  color:var(--text);font:inherit;font-size:16px}
input.pin{letter-spacing:.5em;font-variant-numeric:tabular-nums;text-align:center}
input:focus,button:focus-visible{outline:3px solid var(--focus);outline-offset:1px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0}
.actions button{flex:1 1 140px}
button{padding:10px 18px;border:1px solid transparent;border-radius:8px;background:var(--brand);color:var(--brand-ink);
  font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;border-color:var(--line);color:var(--text)}
button:disabled{opacity:.6;cursor:default}
.fine{margin:16px 0 0;color:var(--faint);font-size:12.5px;text-align:center}
.hidden{display:none!important}
.lang{margin:16px 0 0;font-size:13px;color:var(--faint);text-align:center}
.lang span{margin:0 6px}
.lang button{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-weight:400;cursor:pointer}
.lang button.on{color:var(--brand);font-weight:600}
@media (max-width:420px){body{padding:16px;justify-content:flex-start}.card{padding:22px 16px 16px}}
`;

/** The product mark beside the name: a speech bubble with a spark, drawn inline (nothing fetched). */
const MARK =
    `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" ` +
    `fill="currentColor"/><path d="M9 10.5h14a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-7l-4.5 3.5v-3.5H9` +
    `A2.5 2.5 0 0 1 6.5 19v-6A2.5 2.5 0 0 1 9 10.5z" fill="#fff"/><circle cx="12" cy="16" r="1.5" ` +
    `fill="currentColor"/><circle cx="16" cy="16" r="1.5" fill="currentColor"/><circle cx="20" cy="16" r="1.5" ` +
    `fill="currentColor"/></svg>`;

/** The header above the card. */
export const BRAND = `<div class="brand">${MARK}<span>zalo-agent-cli</span></div>`;

const icon = (paths) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** Small line icons for a card's badge, drawn inline. */
export const ICONS = Object.freeze({
    lock: icon(`<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`),
    link: icon(
        `<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/>` +
            `<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>`,
    ),
    check: icon(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
    cross: icon(`<path d="M7 7l10 10M17 7L7 17"/>`),
    clock: icon(`<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>`),
    alert: icon(`<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>`),
});

/** The English | Tiếng Việt switch: buttons, so it needs no link and no inline handler. */
export const LANGUAGE_SWITCH =
    `<p class="lang" role="group" aria-label="Language / Ngôn ngữ">` +
    `<button type="button" data-lang="en">English</button><span aria-hidden="true">|</span>` +
    `<button type="button" data-lang="vi">Tiếng Việt</button></p>`;

/**
 * The language script, the same on every page: it picks the language (the `lang` query, the saved choice, the
 * browser's), sets `<html lang>` and the title, marks the switch, saves a choice, and tells the page's own script
 * (a `zalo-lang` event on document; `document.documentElement.lang` is the current one).
 */
export const LANGUAGE_SCRIPT = `(()=>{
const KEY=${JSON.stringify(LANG_STORAGE_KEY)},root=document.documentElement;
const ok=(l)=>l==='en'||l==='vi';
const saved=()=>{try{return localStorage.getItem(KEY)}catch{return null}};
const asked=new URLSearchParams(location.search).get('lang');
const browser=(navigator.language||'').toLowerCase().startsWith('vi')?'vi':'en';
function apply(l){
  root.lang=l;
  const t=document.body&&document.body.getAttribute('data-title-'+l);
  if(t)document.title=t;
  document.querySelectorAll('[data-lang]').forEach((b)=>{const on=b.dataset.lang===l;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on))});
  document.dispatchEvent(new CustomEvent('zalo-lang',{detail:l}));
}
document.querySelectorAll('[data-lang]').forEach((b)=>b.addEventListener('click',(e)=>{
  e.preventDefault();
  try{localStorage.setItem(KEY,b.dataset.lang)}catch{}
  apply(b.dataset.lang);
}));
apply([asked,saved(),browser].find(ok));
})();`;

/**
 * A whole page: the header, one card with the switch at its foot, the shared style and the language script, both by
 * nonce. The page's own script, when it has one, runs first in the same element, so it hears the first `zalo-lang`.
 *
 * @param {object} o
 * @param {string} o.nonce
 * @param {{en: string, vi: string}} o.title - the document title in each language
 * @param {string} o.body - the card's markup (already escaped); with `bare`, everything after the header
 * @param {"en"|"vi"} [o.lang] - the language before the script runs
 * @param {string} [o.cardClass] - extra classes of the card
 * @param {string} [o.style] - the page's own style, after the shared one
 * @param {string} [o.head] - more head markup (a refresh meta)
 * @param {string} [o.script] - the page's own script, before the language script
 * @param {boolean} [o.bare] - `body` brings its own cards and switch
 * @returns {string}
 */
export function renderPage({
    nonce,
    title,
    body,
    lang = "en",
    cardClass = "",
    style = "",
    head = "",
    script = "",
    bare = false,
}) {
    const l = PAGE_LANGS.includes(lang) ? lang : "en";
    const main = bare ? body : `<main class="card${cardClass ? ` ${cardClass}` : ""}">${body}${LANGUAGE_SWITCH}</main>`;
    return (
        `<!DOCTYPE html>
<html lang="${l}"><head><meta charset="utf-8">
` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
        `<meta name="color-scheme" content="light dark">${head}
` +
        `<title>${esc(title[l])}</title><style nonce="${nonce}">${KIT_STYLE}${style}</style></head>
` +
        `<body data-title-en="${esc(title.en)}" data-title-vi="${esc(title.vi)}">
${BRAND}
${main}
` +
        `<script nonce="${nonce}">
${
    script
        ? `${script}
`
        : ""
}${LANGUAGE_SCRIPT}
</script>
</body></html>`
    );
}

/**
 * The headers of a page: nothing cached, framed or referred, and a CSP that allows only the page's own style and
 * script (by nonce), plus what the page names.
 *
 * @param {string} nonce
 * @param {object} [o]
 * @param {boolean} [o.img] - its own images (`img-src 'self'`)
 * @param {boolean} [o.connect] - its own polls (`connect-src 'self'`)
 * @param {string[]} [o.formAction] - where its forms may post or be redirected (default `'self'`)
 * @returns {Record<string, string>}
 */
export function pageHeaders(nonce, { img = false, connect = false, formAction = ["'self'"] } = {}) {
    return {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
            "default-src 'none'; " +
            (img ? "img-src 'self'; " : "") +
            (connect ? "connect-src 'self'; " : "") +
            `style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action ${formAction.join(" ")}; ` +
            "frame-ancestors 'none'; base-uri 'none'",
    };
}
