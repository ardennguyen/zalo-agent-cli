/**
 * "Export my data": a copy of the account's message database for its owner, built as a job and handed out through an
 * expiring download link. Used by `db export` (CLI, src/commands/db.js) and by the admin API's export route
 * (`POST /zalo/admin/export/<ownId>`, src/core/admin-api.js), which a CRM calls with its admin credential.
 *
 * - **Encryption, chosen per export:** `password` (src/core/export-crypt.js: scrypt + AES-256-GCM, the parameters in
 *   the file's header; the password is never stored or logged) or `plaintext` (a SQLite file anyone can read; the
 *   caller must confirm it, as `db export --plaintext` needs `--yes`).
 * - **Hidden chats are left out** unless the request carries one of: a single-use hidden-access grant (the owner typed
 *   the PIN on the engine's secure page, `/zalo/secure/<token>`, purpose "hidden-export"; the grant is bound to
 *   {ownId, action: export, includeHidden} and lives {@link GRANT_TTL_MS} after the PIN was entered), or the PIN in the
 *   JSON body over https (or loopback), checked once with the hidden-chat lockout (src/core/hidden-chats.js) and
 *   dropped. Hidden threads in the file are marked (`export_hidden_threads`, src/core/db-tools.js markExport).
 * - **Delivery:** a media link (src/core/media-deliver.js, `kind: "export"`): bearer or capability as `media.linkAuth`
 *   says, byte ranges, `no-store`, an attachment; `media.linkTtl` long. The file is deleted once it has been
 *   downloaded whole, when the link expires, when it is revoked (logout, kick, rekey, a link-policy change, a chat
 *   hidden after the export was made, `DELETE` on the job), and with the process; a start sweeps what a crash left.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { copyDatabase } from "./db-tools.js";
import { encryptExportFile, passwordProblem } from "./export-crypt.js";
import { shredFile } from "./sqlite.js";
import { hiddenKey, pinFailureLine } from "./hidden-chats.js";
import { GUARDS } from "./confirm-guard.js";
import { isLoopbackIp, normalizeIp } from "./media-route.js";
import { audit } from "./policy-store.js";

/** How long a hidden-access grant stays usable after the PIN was entered on the secure page. */
export const GRANT_TTL_MS = 2 * 60_000;
/** The secure-page action of a hidden-access grant. */
export const HIDDEN_EXPORT_ACTION = "hidden-export";
/** Jobs remembered (finished ones go first). */
const MAX_JOBS = 50;
const TEMP_PREFIX = ".export-";

/** What a grant is bound to. */
export function grantTarget(ownId) {
    return { ownId: String(ownId), action: "export", includeHidden: true };
}

/** The folder an engine builds its exports in (private to the account). */
export function exportDir(accountDir) {
    return join(accountDir, "exports");
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM";
    }
}

/**
 * Remove the decrypted temporary copies a killed export left in `dir` (`.export-<pid>-…`): those of a process that is
 * gone, or older than an hour.
 *
 * @param {string} dir
 */
export function sweepExportTemps(dir) {
    let names = [];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const n of names) {
        const m = new RegExp(`^${TEMP_PREFIX.replace(".", "\\.")}(\\d+)-`).exec(n);
        if (!m) continue;
        const p = join(dir, n);
        try {
            if (!pidAlive(Number(m[1])) || Date.now() - statSync(p).mtimeMs > 3_600_000) shredFile(p);
        } catch {
            /* gone already */
        }
    }
}

/**
 * Build one export file at `out` (never over an existing file).
 *
 * @param {object} args
 * @param {string} args.dbFile - `accounts/<ownId>/zalo.db`
 * @param {string} args.out
 * @param {"password"|"plaintext"|"account"} args.encryption - `account`: under the account's own key (`db export`
 *   without a choice, which opens only on this machine)
 * @param {string} [args.password]
 * @param {string[]} [args.excludeThreadIds] - the hidden threads, left out
 * @param {string[]} [args.hiddenIds] - with them included: the hidden threads, marked in the file
 * @param {string} [args.workDir] - where the decrypted temporary copy of a password export is made (the account's
 *   folder by default: private)
 * @param {{N: number, r: number, p: number}} [args.kdf]
 * @returns {Promise<{file: string, bytes: number, encryption: string, messages: number, hiddenChats: string,
 *   hiddenThreads: number, kdf?: object}>}
 */
export async function buildExport({
    dbFile,
    out,
    encryption,
    password,
    excludeThreadIds = [],
    hiddenIds = [],
    workDir,
    kdf,
}) {
    const exportInfo = { hiddenIds: excludeThreadIds.length ? [] : hiddenIds };
    const summary = (r, extra = {}) => ({
        file: resolve(out),
        bytes: statSync(out).size,
        encryption,
        messages: r.messages,
        hiddenChats: excludeThreadIds.length ? "excluded" : hiddenIds.length ? "included" : "none",
        hiddenThreads: r.hiddenThreads,
        ...extra,
    });
    if (encryption === "plaintext" || encryption === "account") {
        const r = copyDatabase(dbFile, out, {
            plaintext: encryption === "plaintext",
            excludeThreadIds,
            exportInfo,
        });
        return summary(r);
    }
    if (encryption !== "password") throw new Error(`unknown encryption "${encryption}"`);
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    if (existsSync(out)) throw new Error(`${resolve(out)} exists: name a new file (nothing was written).`);
    if (!existsSync(dirname(resolve(out)))) throw new Error(`The folder ${dirname(resolve(out))} does not exist.`);
    const dir = workDir ?? dirname(resolve(dbFile));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepExportTemps(dir);
    const tmp = join(dir, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.db`);
    try {
        const r = copyDatabase(dbFile, tmp, { plaintext: true, excludeThreadIds, exportInfo });
        const enc = await encryptExportFile(tmp, out, password, kdf ? { kdf } : {});
        return summary(r, { kdf: enc.kdf });
    } finally {
        for (const s of ["", ".partial", ".partial-journal", "-journal"]) {
            try {
                shredFile(tmp + s);
            } catch {
                rmSync(tmp + s, { force: true });
            }
        }
    }
}

/**
 * Whether a request reached this server over https: a TLS connection, or a proxy that is this machine (or a trusted
 * one) saying `X-Forwarded-Proto: https`; a plain connection from this machine with no such header counts too.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string[]} [trustedProxies]
 * @returns {boolean}
 */
export function secureTransport(req, trustedProxies = []) {
    if (req.socket?.encrypted) return true;
    const peer = normalizeIp(req.socket?.remoteAddress);
    const loop = isLoopbackIp(peer);
    const proxy = loop || trustedProxies.includes(peer);
    const xfp = String(req.headers?.["x-forwarded-proto"] ?? "")
        .split(",")[0]
        .trim()
        .toLowerCase();
    if (proxy && xfp) return xfp === "https";
    return loop;
}

const SECRET_QUERY = /(?:^|[?&])(pin|password|grant)=/i;

/**
 * The export jobs of one server and the admin API's `/export` routes.
 *
 *     POST   /export/<ownId>                  start a job: {encryption, password?, confirm?, includeHidden?, grant?, pin?}
 *     GET    /export/<ownId>                  the jobs
 *     GET    /export/<ownId>/<jobId>          one job: its state, and its download link once ready
 *     DELETE /export/<ownId>/<jobId>          revoke its link and delete its file
 *     POST   /export/<ownId>/hidden-access    a secure-page link for the owner's PIN, and the grant it unlocks
 *
 * @param {object} args
 * @param {string} args.ownId - this server's account (another id is 404)
 * @param {string} args.accountDir
 * @param {string} args.dbFile
 * @param {import("./hidden-chats.js").HiddenChats} args.hidden
 * @param {() => object|null} [args.getApi] - the session, to read the PIN hash when only the mirror is known
 * @param {import("./secure-page.js").SecurePage} [args.securePage]
 * @param {import("./media-deliver.js").MediaLinks} args.links
 * @param {string[]} [args.trustedProxies]
 * @param {{N: number, r: number, p: number}} [args.kdf] - tests: a cheaper scrypt
 * @param {() => number} [args.now]
 * @param {(line: string) => void} [args.log]
 * @returns {{handle: (req: object, res: object, ctx: {who: string, ip: string, path: string}) => Promise<void>,
 *   jobs: Map<string, object>, idle: () => Promise<void>}}
 */
export function createExportApi({
    ownId,
    accountDir,
    dbFile,
    hidden,
    getApi = () => null,
    securePage = null,
    links,
    trustedProxies = [],
    kdf,
    now = Date.now,
    log = (l) => console.error(l),
}) {
    const dir = exportDir(accountDir);
    // Files of a previous process: their links lived in its memory, so nothing can fetch them any more.
    rmSync(dir, { recursive: true, force: true });
    /** @type {Map<string, object>} */
    const jobs = new Map();
    let running = null;

    const send = (res, code, body, headers = {}) => {
        res.status(code)
            .set({ "Cache-Control": "no-store", ...headers })
            .json(body);
    };

    const view = (job) => ({
        jobId: job.id,
        accountId: ownId,
        state: job.state,
        encryption: job.encryption,
        includeHidden: job.includeHidden,
        createdAt: new Date(job.createdAt).toISOString(),
        ...(job.finishedAt ? { finishedAt: new Date(job.finishedAt).toISOString() } : {}),
        ...(job.result
            ? {
                  bytes: job.result.bytes,
                  messages: job.result.messages,
                  hiddenChats: job.result.hiddenChats,
                  hiddenThreads: job.result.hiddenThreads,
                  ...(job.result.kdf ? { kdf: job.result.kdf } : {}),
              }
            : {}),
        ...(job.state === "ready" && job.link
            ? {
                  download: {
                      url: job.link.url,
                      expiresAt: new Date(job.link.expiresAt).toISOString(),
                      auth: job.link.auth,
                      fileName: job.fileName,
                  },
              }
            : {}),
        ...(job.error ? { error: job.error } : {}),
        ...(job.endedBecause ? { endedBecause: job.endedBecause } : {}),
    });

    const remember = (job) => {
        jobs.set(job.id, job);
        while (jobs.size > MAX_JOBS) {
            const old = [...jobs.values()].find((j) => j.state !== "building" && j.state !== "ready");
            if (!old) break;
            jobs.delete(old.id);
        }
    };

    const dropFile = (job) => {
        if (!job.file) return;
        try {
            if (job.encryption === "plaintext") shredFile(job.file);
            else rmSync(job.file, { force: true });
        } catch (e) {
            log(`[export] job ${job.id}: its file could not be removed (${e.code || e.message})`);
        }
    };

    const end = (job, reason) => {
        clearTimeout(job.timer);
        dropFile(job);
        job.state = reason === "downloaded" ? "downloaded" : reason === "expired" ? "expired" : "revoked";
        job.endedBecause = reason;
        job.finishedAt ??= now();
        log(
            `[export] job ${job.id}: ${job.state}${job.state === "revoked" ? ` (${reason})` : ""}; its file is deleted`,
        );
    };

    /** The hidden set with the PIN hash Zalo gave (a mirror alone has none). */
    const hiddenWithHash = async () => {
        if (hidden.source !== "zalo") await hidden.ensure(getApi());
        return hidden;
    };

    const run = async (job, { password, excludeThreadIds, hiddenIds }) => {
        const epoch = links.revokeEpoch ?? 0;
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const ext = job.encryption === "password" ? "zaexport" : "db";
            job.fileName = `zalo-export-${new Date(job.createdAt).toISOString().slice(0, 10)}-${job.id.slice(0, 8)}.${ext}`;
            job.file = join(dir, `${job.id}.${ext}`);
            // Let the 202 go out before the copy, which holds the event loop for its snapshot.
            await new Promise((r) => setImmediate(r));
            job.result = await buildExport({
                dbFile,
                out: job.file,
                encryption: job.encryption,
                password,
                excludeThreadIds,
                hiddenIds,
                workDir: dir,
                kdf,
            });
            password = null;
            if ((links.revokeEpoch ?? 0) !== epoch || job.endedBecause) {
                end(job, job.endedBecause ?? "links were revoked while it was built");
                return;
            }
            const link = links.issue({
                accountId: ownId,
                msgId: `export:${job.id}`,
                threadId: null,
                file: job.file,
                scope: null,
                mime: "application/octet-stream",
                name: job.fileName,
                size: job.result.bytes,
                kind: "export",
                plain: true,
                onEnd: (reason) => end(job, reason),
                extra: { exportJob: job.id, hiddenAtExport: new Set([...hidden.ids]) },
            });
            job.link = link;
            job.state = "ready";
            job.finishedAt = now();
            // The link ends on time even when nobody asks for it again (lookups prune lazily).
            job.timer = setTimeout(
                () => links.revokeWhere((l) => l.token === link.token, "expired"),
                Math.max(0, link.expiresAt - now()) + 50,
            );
            job.timer.unref?.();
            log(
                `[export] job ${job.id}: ready (${job.result.messages} messages, ${job.result.bytes} bytes, ` +
                    `${job.encryption}, hidden chats ${job.result.hiddenChats})`,
            );
        } catch (e) {
            job.state = "failed";
            job.error = e.message;
            job.finishedAt = now();
            dropFile(job);
            log(`[export] job ${job.id}: failed (${e.message})`);
        } finally {
            password = null;
            running = null;
        }
    };

    /** Start a job; the body's secrets are read once and dropped from it. */
    const start = async (req, res, { who, ip }) => {
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
        if (!body) return send(res, 400, { error: "the body must be a JSON object" });
        const password = body.password;
        const pin = body.pin;
        body.password = undefined;
        body.pin = undefined;
        const { encryption, confirm, grant } = body;
        const includeHidden = body.includeHidden === true;
        if (body.includeHidden !== undefined && typeof body.includeHidden !== "boolean")
            return send(res, 400, { error: "includeHidden is true or false" });
        if (encryption !== "password" && encryption !== "plaintext") {
            return send(res, 400, {
                error: 'encryption is required: "password" (the file opens with a password you give) or "plaintext"',
                code: "ENCRYPTION_REQUIRED",
            });
        }
        if (encryption === "password") {
            const problem = passwordProblem(password);
            if (problem) return send(res, 400, { error: problem, code: "PASSWORD" });
        } else if (password !== undefined) {
            return send(res, 400, { error: 'a password goes with encryption "password" only', code: "PASSWORD" });
        }
        if (encryption === "plaintext" && confirm !== true) {
            return send(res, 409, {
                error: "Not done: a plaintext export needs confirm: true.",
                code: "CONFIRM_REQUIRED",
                confirmationRequired: true,
                wouldDo: GUARDS["db.exportPlaintext"].what({
                    ownerId: ownId,
                    output: "a download link",
                    includeHidden,
                }),
                retryWith: { confirm: true },
            });
        }
        if (!includeHidden && (grant !== undefined || pin !== undefined)) {
            return send(res, 400, { error: "a grant or a PIN goes with includeHidden: true only" });
        }
        if (includeHidden && (grant === undefined) === (pin === undefined)) {
            return send(res, 400, {
                error:
                    "includeHidden needs either a hidden-access grant (POST .../hidden-access, then the owner enters " +
                    "the PIN on the secure page) or the PIN in this body over https, not both",
                code: "PIN_REQUIRED",
                pinRequired: true,
            });
        }
        if ((password !== undefined || pin !== undefined) && !secureTransport(req, trustedProxies)) {
            audit({
                actor: `admin-api ${who} ${ip}`,
                target: `export:${ownId}`,
                op: "start",
                result: "insecureTransport",
            });
            return send(res, 403, {
                error: "a PIN or a password is taken over https only (or from this machine); nothing was done",
                code: "INSECURE_TRANSPORT",
            });
        }
        if (running)
            return send(res, 409, { error: "an export is being built; wait for it", code: "BUSY", jobId: running });
        const why = links.issueProblem();
        if (why) return send(res, 409, { error: `no download link can be made: ${why}`, code: "NO_LINK" });

        let set;
        try {
            set = await hiddenWithHash();
        } catch (e) {
            return send(res, 503, {
                error: `which chats are hidden could not be read (${e.message}): nothing was exported`,
            });
        }
        if (!set.known) {
            return send(res, 503, {
                error: "which chats are hidden is not known yet (Zalo could not be asked): nothing was exported",
            });
        }
        if (includeHidden) {
            if (pin !== undefined) {
                const r = set.verifyPin(pin);
                if (!r.ok) {
                    audit({
                        actor: `admin-api ${who} ${ip}`,
                        target: `export:${ownId}`,
                        op: "start",
                        result: `pin-${r.reason}`,
                    });
                    const locked = r.reason === "locked";
                    return send(
                        res,
                        locked ? 429 : r.reason === "no-pin" ? 409 : 403,
                        { error: pinFailureLine(r), code: locked ? "PIN_LOCKED" : "PIN_REFUSED", reason: r.reason },
                        locked ? { "Retry-After": String(Math.ceil((r.retryAfterMs ?? 0) / 1000)) } : {},
                    );
                }
            } else {
                const used = securePage?.store?.consume(String(grant), {
                    accountId: ownId,
                    action: HIDDEN_EXPORT_ACTION,
                    target: grantTarget(ownId),
                });
                const until = used?.ok ? used.ticket.outcome?.grantExpiresAt : null;
                if (!used?.ok || !Number.isFinite(until) || until <= now()) {
                    audit({
                        actor: `admin-api ${who} ${ip}`,
                        target: `export:${ownId}`,
                        op: "start",
                        result: "grantRefused",
                    });
                    return send(res, 403, {
                        error: used?.ok
                            ? "that grant has expired; ask for a new one"
                            : (used?.message ?? "no secure page on this server"),
                        code: "GRANT_REFUSED",
                        ...(used?.reason ? { reason: used.reason } : {}),
                    });
                }
            }
        }
        const ids = [...set.ids];
        const job = {
            id: randomBytes(16).toString("hex"),
            state: "building",
            encryption,
            includeHidden,
            createdAt: now(),
            file: null,
            link: null,
            result: null,
            timer: null,
        };
        remember(job);
        running = job.id;
        audit({
            actor: `admin-api ${who} ${ip}`,
            target: `export:${ownId}`,
            op: "start",
            result: "accepted",
            job: job.id,
            encryption,
            includeHidden,
        });
        log(
            `[export] job ${job.id}: building (${encryption}, hidden chats ${includeHidden ? "included" : "excluded"})`,
        );
        job.promise = run(job, {
            password,
            excludeThreadIds: includeHidden ? [] : ids,
            hiddenIds: includeHidden ? ids.map(hiddenKey) : [],
        });
        return send(res, 202, view(job), { Location: `/zalo/admin/export/${ownId}/${job.id}` });
    };

    /** A secure-page link for the owner's PIN; the grant (a separate claim) goes to the caller. */
    const hiddenAccess = async (req, res, { who, ip }) => {
        if (!securePage) return send(res, 501, { error: "this server has no secure page" });
        let set;
        try {
            set = await hiddenWithHash();
        } catch (e) {
            return send(res, 503, { error: `the hidden-chat PIN could not be read (${e.message})` });
        }
        if (!set.hasPin) return send(res, 409, { error: pinFailureLine({ reason: "no-pin" }), code: "NO_PIN" });
        const opened = await securePage.open({
            accountId: ownId,
            action: HIDDEN_EXPORT_ACTION,
            target: grantTarget(ownId),
            kind: "pin",
            title: "Include hidden chats in your export",
            description:
                "Enter your hidden-chat PIN to include your hidden conversations in one data export. The PIN is " +
                "checked here and never sent to the application that asked.",
            separateClaim: true,
            onSubmit: ({ pin }) => {
                const r = set.verifyPin(pin);
                if (r.ok) {
                    return {
                        status: "approved",
                        message: "Unlocked for one export. You can close this page.",
                        outcome: { grantExpiresAt: now() + GRANT_TTL_MS },
                    };
                }
                return { status: r.reason === "locked" ? "failed" : "retry", message: pinFailureLine(r) };
            },
        });
        audit({ actor: `admin-api ${who} ${ip}`, target: `export:${ownId}`, op: "hidden-access", result: "issued" });
        return send(res, 201, {
            secureUrl: opened.url,
            grant: opened.claim,
            pageExpiresAt: new Date(opened.expiresAt).toISOString(),
            grantTtlSeconds: GRANT_TTL_MS / 1000,
            how:
                "Show secureUrl to the account owner (it works once). Once they have entered the PIN there, start the " +
                "export with includeHidden: true and this grant within grantTtlSeconds. Never ask them for the PIN.",
        });
    };

    const handle = async (req, res, { who, ip, path }) => {
        if (
            SECRET_QUERY.test(
                String(req.originalUrl ?? req.url ?? "")
                    .split("#")[0]
                    .replace(/^[^?]*/, ""),
            )
        ) {
            return send(res, 400, {
                error: "a PIN, password or grant never goes in the URL; send it in the JSON body. Nothing was done.",
                code: "SECRET_IN_URL",
            });
        }
        const m = /^\/export\/([^/]+)(?:\/([^/]+))?$/.exec(path);
        if (!m) return send(res, 404, { error: "not found" });
        const id = decodeURIComponent(m[1]);
        if (id !== String(ownId)) {
            return send(res, 404, {
                error: `this server exports account ${ownId} only; ask the server that runs ${id}`,
            });
        }
        const sub = m[2] ? decodeURIComponent(m[2]) : null;
        if (sub === "hidden-access") {
            if (req.method !== "POST") return send(res, 405, { error: "POST only" }, { Allow: "POST" });
            return hiddenAccess(req, res, { who, ip });
        }
        if (!sub) {
            if (req.method === "POST") return start(req, res, { who, ip });
            if (req.method === "GET") return send(res, 200, { jobs: [...jobs.values()].map(view) });
            return send(res, 405, { error: "GET or POST" }, { Allow: "GET, POST" });
        }
        const job = jobs.get(sub);
        if (!job) return send(res, 404, { error: "no such export job on this server" });
        if (req.method === "GET") return send(res, 200, view(job));
        if (req.method === "DELETE") {
            if (job.state === "ready" && job.link) links.revokeWhere((l) => l.token === job.link.token, "deleted");
            else if (job.state === "building") job.endedBecause = "deleted";
            audit({
                actor: `admin-api ${who} ${ip}`,
                target: `export:${ownId}`,
                op: "delete",
                result: "applied",
                job: job.id,
            });
            return send(res, 200, view(job));
        }
        return send(res, 405, { error: "GET or DELETE" }, { Allow: "GET, DELETE" });
    };

    return {
        handle,
        jobs,
        /** Wait for the job being built (tests). */
        idle: async () => {
            for (const j of jobs.values()) await j.promise;
        },
    };
}
