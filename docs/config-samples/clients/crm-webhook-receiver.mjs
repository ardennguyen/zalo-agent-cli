// A CRM endpoint for the webhook `mcp start -w <url>` / `listen -w <url>` sends. Node 22, no dependencies.
//
//   WEBHOOK_SECRET=... node crm-webhook-receiver.mjs
//
// What matters here, because delivery is at least once and in order:
//   1. Verify the signature over the RAW body (not over re-serialized JSON).
//   2. Answer 2xx immediately and do the real work afterwards. A POST has 10
//      seconds; past that, or on anything but 2xx, the sender retries it (1 s
//      doubling to 5 min) and holds every later event behind it.
//   3. De-duplicate on the message id: a message can reach you twice (a retry
//      after your reply was lost, or a later catch-up through `/events/wait`).
//   4. A body with `event: "batch"` carries several events in `events`
//      (ZALO_WEBHOOK_BATCH_SIZE > 1); `eventsOf()` flattens both shapes.
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

/**
 * The events in one webhook body: the body itself, or `events` of a batch.
 * @param {object} body - Parsed JSON
 * @returns {object[]}
 */
export function eventsOf(body) {
    return body?.event === "batch" && Array.isArray(body.events) ? body.events : [body];
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
                const body = JSON.parse(raw.toString("utf8"));
                // `mcp start` sends {event:"message", accountId, id, threadId, threadType, senderId, senderName, text, timestamp, type, attachment}
                // `listen` sends   {accountId, event:"message"|..., msgId, threadId, type, isSelf, uidFrom, dName, msgType, content}
                for (const event of eventsOf(body)) {
                    const id = event.id ?? event.msgId;
                    if (id && seen.has(`${event.accountId}:${id}`)) continue;
                    if (id) seen.add(`${event.accountId}:${id}`);
                    queueMicrotask(() => onMessage(event));
                }
            });
        })
        .listen(port);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("crm-webhook-receiver.mjs")) {
    if (!process.env.WEBHOOK_SECRET) throw new Error("set WEBHOOK_SECRET");
    startReceiver({ secret: process.env.WEBHOOK_SECRET, port: Number(process.env.PORT) || 8080 });
    console.log("listening");
}
