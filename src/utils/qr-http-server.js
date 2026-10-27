/**
 * Temporary local HTTP server for QR display on headless/VPS environments.
 * Serves the QR image as a plain login page on localhost, laid out like the Zalo Web login.
 * Auto-closes after login completes.
 */

import http from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { info } from "./output.js";

/**
 * Where the login is, for the page: which QR is on screen (the first, or the second an account with a trusted
 * device is asked to scan) and who scanned it. Set by the login command as the events arrive.
 */
const qrState = { layer: 1, scanned: null };

/**
 * Note which QR the page should say it is showing.
 * @param {number} [layer] - 1 for the first QR, 2 for the one scanned after it
 */
export function noteQrLayer(layer = 1) {
    qrState.layer = layer;
    if (layer === 1) qrState.scanned = null;
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
.hidden{display:none}
.lang{margin:14px 0 0;font-size:13px;color:#8593a3}
.lang span{margin:0 8px}
.lang a{color:#5b6b7c;text-decoration:none}
.lang a.on{color:#0068ff;font-weight:600}
`;

/**
 * Everything the page says, in the two languages Zalo Web offers. The page picks one from the `lang` query, then a
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
        qrAlt: "Mã QR",
    }),
});

const LANGUAGE_SWITCH = `<p class="lang"><a href="#" data-lang="en">English</a><span>&middot;</span><a href="#" data-lang="vi">Tiếng Việt</a></p>`;

function waitingPage() {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PAGE_TEXT.en.documentTitle}</title><style>${PAGE_STYLE}</style></head>
<body><div class="brand">zalo-agent-cli</div><div class="card"><h1>${PAGE_TEXT.en.preparing}</h1>
<p class="sub">${PAGE_TEXT.vi.preparing}</p></div></body></html>`;
}

function loginPage(imageUrl, version) {
    const en = PAGE_TEXT.en;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${en.documentTitle}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PAGE_STYLE}</style></head>
<body>
<div class="brand">zalo-agent-cli</div>
<div class="card" id="login">
<h1 id="title">${en.title}</h1>
<p class="sub" id="sub">${en.sub}</p>
<div class="frame"><i></i><i></i><i></i><i></i><img id="qr" src="${imageUrl}" alt="${en.qrAlt}"></div>
<p class="note" id="note">${en.note}</p>
${LANGUAGE_SWITCH}
</div>
<div class="card done hidden" id="done"><h1 id="doneTitle">${en.doneTitle}</h1>
<p class="sub" id="doneSub">${en.doneSub}</p></div>
<script>
// Poll /status: swap in each new QR, say which one this is, and notice the end of the login.
const TEXT=${JSON.stringify(PAGE_TEXT)};
let version=${JSON.stringify(version)},layer=1,scanned=null;
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
  if(scanned!==null){
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
render();
async function poll(){
  try{
    const d=await (await fetch('/status')).json();
    if(d.loggedIn){$('login').classList.add('hidden');$('done').classList.remove('hidden');return}
    if(d.qrVersion&&d.qrVersion!==version){version=d.qrVersion;$('qr').src='/qr.png?v='+version}
    layer=d.layer||1;scanned=d.scanned;render();
  }catch{}
}
poll();
setInterval(poll,1500);
</script>
</body></html>`;
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
 *
 * @returns {{ url: string, close: () => void }}
 */
export function startQrServer(qrImagePath, port = 18927, tryPorts = [18927, 8080, 3000, 9000], exposeOnLan = false) {
    const bindHost = exposeOnLan ? "0.0.0.0" : "127.0.0.1";
    const server = http.createServer(async (req, res) => {
        // The path decides, not the query: `/qr?lang=vi` is the page, `/qr.png?v=1` is the image.
        const path = (req.url || "/").split("?")[0];
        if (path === "/qr" || path === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            if (!existsSync(qrImagePath)) {
                res.end(waitingPage());
                return;
            }
            // The image is fetched by URL (the same one the poll swaps in), so the page stays small.
            const version = qrVersion(qrImagePath);
            res.end(loginPage(`/qr.png?v=${version}`, version));
        } else if (path === "/qr.png") {
            // Raw PNG image endpoint — for agents to send direct image link
            if (!existsSync(qrImagePath)) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("QR not generated yet");
                return;
            }
            const img = readFileSync(qrImagePath);
            res.writeHead(200, {
                "Content-Type": "image/png",
                "Content-Length": img.length,
                "Cache-Control": "no-cache, no-store",
            });
            res.end(img);
        } else if (path === "/status") {
            // Login status endpoint for browser polling
            let loggedIn = false;
            try {
                const { isLoggedIn } = await import("../core/zalo-client.js");
                loggedIn = isLoggedIn();
            } catch {}
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    loggedIn,
                    qrVersion: qrVersion(qrImagePath),
                    layer: qrState.layer,
                    scanned: qrState.scanned,
                }),
            );
        } else {
            res.writeHead(404);
            res.end("Not found");
        }
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

        // Auto-detect public IP for VPS users
        try {
            const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
            publicIp = (await res.text()).trim() || null;
        } catch {}

        if (jsonMode) {
            console.log(
                JSON.stringify({
                    event: "qr_server",
                    port: actualPort,
                    localUrl: `http://localhost:${actualPort}/qr`,
                    imageUrl: `http://localhost:${actualPort}/qr.png`,
                    publicUrl: publicIp ? `http://${publicIp}:${actualPort}/qr` : null,
                    publicImageUrl: publicIp ? `http://${publicIp}:${actualPort}/qr.png` : null,
                }),
            );
        } else {
            info(`QR available at: http://localhost:${actualPort}/qr`);
            if (publicIp) info(`On VPS, open: http://${publicIp}:${actualPort}/qr`);
            else info(`On VPS, open: http://<your-server-ip>:${actualPort}/qr`);
            info(`If firewall blocks, run: sudo ufw allow ${actualPort}/tcp`);
            info(`Or copy QR file: scp user@vps:~/.zalo-agent-cli/qr.png ./qr.png`);
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
        close: () => {
            try {
                server.close();
            } catch {}
        },
    };
}
