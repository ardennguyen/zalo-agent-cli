/**
 * Request bodies as a server receives them: the bytes, the content type a real fetch adds, and a multipart body's
 * parts. Shared by the in-process fake (tests/unit/fake-zalo-session.js), the CLI preload
 * (tests/unit/support/offline-session.js) and the wire-diff harness, so all three read a body the same way.
 *
 * No ids, no network; pure functions over what a test hands in.
 */
/**
 * The bytes of a request body and the content type a real fetch would send with it.
 *
 * Covers what the engine hands to fetch: a string, URLSearchParams, a Buffer or typed array, Node's
 * `FormData` (serialized through `new Response(fd)`, which is also where its boundary comes from), a `Blob`, the
 * `form-data` package's object (its `getBuffer()`), and any async iterable of chunks (a Node stream).
 *
 * @param {unknown} body
 * @returns {Promise<{bytes: Buffer|null, contentType: string|null}>} `contentType` is the type the body implies,
 *   null when the caller's own header decides
 */
export async function readBody(body) {
    if (body === undefined || body === null) return { bytes: null, contentType: null };
    if (typeof body === "string") return { bytes: Buffer.from(body, "utf8"), contentType: null };
    if (body instanceof URLSearchParams) {
        // what fetch itself sends with a URLSearchParams body
        return {
            bytes: Buffer.from(body.toString(), "utf8"),
            contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        };
    }
    if (Buffer.isBuffer(body)) return { bytes: Buffer.from(body), contentType: null };
    if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body), contentType: null };
    if (ArrayBuffer.isView(body)) {
        return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength), contentType: null };
    }
    if (body instanceof globalThis.FormData || body instanceof globalThis.Blob) {
        const res = new Response(body);
        return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
    }
    if (typeof body.getBuffer === "function") return { bytes: Buffer.from(body.getBuffer()), contentType: null };
    if (typeof body[Symbol.asyncIterator] === "function") {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return { bytes: Buffer.concat(chunks), contentType: null };
    }
    return { bytes: Buffer.from(String(body), "utf8"), contentType: null };
}

/**
 * Split a multipart body into its parts, by the boundary its content type names.
 *
 * @param {Buffer} bytes
 * @param {string} contentType - e.g. `multipart/form-data; boundary=----x`
 * @returns {Array<{name: string|null, filename: string|null, type: string|null, bytes: Buffer}>|null} null when
 *   the content type is not multipart or names no boundary
 */
export function parseMultipart(bytes, contentType) {
    const m = /^multipart\/[^;]+;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ""));
    if (!m || !bytes) return null;
    const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
    const parts = [];
    let at = bytes.indexOf(delimiter);
    while (at !== -1) {
        let start = at + delimiter.length;
        if (bytes.subarray(start, start + 2).toString() === "--") break; // the closing delimiter
        if (bytes.subarray(start, start + 2).toString() === "\r\n") start += 2;
        const next = bytes.indexOf(delimiter, start);
        if (next === -1) break;
        let end = next;
        if (bytes.subarray(end - 2, end).toString() === "\r\n") end -= 2;
        const part = bytes.subarray(start, end);
        const split = part.indexOf("\r\n\r\n");
        const head = split === -1 ? "" : part.subarray(0, split).toString("utf8");
        const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? "";
        parts.push({
            name: /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null,
            filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null,
            type: /content-type:\s*([^\r\n]*)/i.exec(head)?.[1]?.trim() ?? null,
            bytes: Buffer.from(split === -1 ? part : part.subarray(split + 4)),
        });
        at = next;
    }
    return parts;
}
