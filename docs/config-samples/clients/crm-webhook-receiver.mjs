// A CRM endpoint for the webhook `mcp start -w <url>` / `listen -w <url>` sends. Node 22, no dependencies.
//
//   WEBHOOK_SECRET=... node crm-webhook-receiver.mjs
//
// What matters here, because the sender does not retry:
//   1. Verify the signature over the RAW body (not over re-serialized JSON).
//   2. Answer 2xx immediately and do the real work afterwards. The sender gives a
//      delivery 5 seconds and then forgets it; a slow CRM loses messages.
//   3. De-duplicate on the message id: a message can reach you twice (a webhook
//      plus a later catch-up through `/events/wait` or the tools).
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

/**
 * Check `X-Zalo-Signature: sha256=<hex hmac of the body>` (and the Bearer secret).
 *
 * @param {Buffer|string} rawBody - the request body exactly as received
 * @param {Record<string, string|string[]|undefined>} headers - lower-cased request headers
 * @param {string} secret - the shared webhook secret
 * @returns {boolean}
 */
export function verifyWebhook(rawBody, headers, secret) {
    const header = String(headers["x-zalo-signature"] ?? "");
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

const seen = new Set(); // use your database in production

export function startReceiver({ secret, port = 8080, onMessage = (m) => console.log("message", m.id ?? m.msgId, m.threadId) } = {}) {
    return http
        .createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks);
                if (!verifyWebhook(raw, req.headers, secret)) {
                    res.writeHead(401).end();
                    return;
                }
                res.writeHead(200).end("ok"); // acknowledge first
                const event = JSON.parse(raw.toString("utf8"));
                // `mcp start` sends {event:"message", accountId, id, threadId, threadType, senderId, senderName, text, timestamp, type, attachment}
                // `listen` sends   {accountId, event:"message"|..., msgId, threadId, type, isSelf, uidFrom, dName, msgType, content}
                const id = event.id ?? event.msgId;
                if (id && seen.has(`${event.accountId}:${id}`)) return;
                if (id) seen.add(`${event.accountId}:${id}`);
                queueMicrotask(() => onMessage(event));
            });
        })
        .listen(port);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("crm-webhook-receiver.mjs")) {
    if (!process.env.WEBHOOK_SECRET) throw new Error("set WEBHOOK_SECRET");
    startReceiver({ secret: process.env.WEBHOOK_SECRET, port: Number(process.env.PORT) || 8080 });
    console.log("listening");
}
