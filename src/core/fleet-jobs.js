/**
 * Account jobs on the fleet controller: the maintenance a console runs for an account — a sync, an attachment
 * download, a storage purge — as a child of this CLI (`zalo-agent --account <id> …`), so each job takes the same code
 * path, guards and daemon routing a person running the command gets. The controller holds no account lock and no
 * socket (AGENTS.md section 13); a running daemon serves the socket stages and the purge on its own channel.
 *
 * Routes, under `/zalo/admin/accounts/<ownId>` (the controller has checked the id and the admin credential):
 *
 *     GET  /jobs                    the account's recent jobs, newest first (the running one included)
 *     POST /jobs {kind, days?, dryRun?}
 *                                   start one: 202 with the job; 409 JOB_RUNNING while one runs for the account,
 *                                   429 JOBS_BUSY when the host runs its maximum
 *     GET  /jobs/<jobId>            one job
 *     POST /jobs/<jobId>/cancel     stop a running job (SIGINT: the commands stop cleanly and a re-run resumes)
 *
 * Kinds:
 *
 *     sync         every stage of `sync`. The message restore asks the owner's phone to confirm (one prompt; it
 *                  waits up to 10 minutes) — say so before starting it. `days` restores only the last N days.
 *     sync-quick   `sync --no-messages`: reactions, pinned and unread conversations, boards, the zCloud index and
 *                  attachments, with no phone prompt.
 *     sync-media   `sync-media`: download the attachments still missing their file.
 *     purge        `db purge --yes`: what the quota and retention rules make due (`dryRun` counts only).
 *
 * Jobs live in memory (a controller restart forgets them; a running child is stopped with the controller). Each
 * start and end is published as a `job` event on `/events` and the admin webhook. The reply carries the command's
 * own `--json` result and, on failure, the end of its error output: ids and counts, never message text.
 */
import { randomBytes } from "node:crypto";

/** Kind -> the CLI arguments after `--json --account <id>`. */
export const JOB_KINDS = Object.freeze({
    sync: (o) => ["sync", ...(o.days ? ["--days", String(o.days)] : [])],
    "sync-quick": () => ["sync", "--no-messages"],
    "sync-media": () => ["sync-media"],
    purge: (o) => ["db", "purge", "--yes", ...(o.dryRun ? ["--dry-run"] : [])],
});

/** Kinds whose run asks the owner's phone to confirm. */
export const PHONE_KINDS = Object.freeze(["sync"]);

export const JOB_STATES = Object.freeze(["running", "succeeded", "failed", "cancelled"]);

/**
 * A job's child writes one line per plan, stage result and phone step to stderr with this mark (ZALO_JOB_PROGRESS=1),
 * so the job shows each stage as it happens; stdout stays the command's one --json result.
 */
export const JOB_PROGRESS_MARK = "@@zalo-job ";

/** A stage's states in a job: queued (planned, not started), running, then the sync's own result word. */
export const STAGE_STATES = Object.freeze([
    "queued",
    "running",
    "skipped",
    "ok",
    "partial",
    "unconfirmed",
    "unavailable",
    "failed",
]);

/** Phone states: asking (the request goes out), waiting (the prompt shows on the phone), confirmed, not-needed. */
export const PHONE_STATES = Object.freeze(["asking", "waiting", "confirmed", "not-needed"]);

/** Counts only (numbers, booleans), one level: a stage's stats as a job shows them. */
function counts(stats) {
    const out = {};
    if (!stats || typeof stats !== "object") return out;
    for (const [k, v] of Object.entries(stats)) {
        if ((typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9) || typeof v === "boolean") out[k] = v;
        if (Object.keys(out).length >= 20) break;
    }
    return out;
}

/**
 * Apply one progress event to a job (in place). Returns true when the job changed.
 *
 * @param {object} job
 * @param {object} e - {type: "plan", stages: [{name, run, why}]} | {type: "stage", stage, status, reason, stats}
 *   | {type: "phone", state}
 */
export function applyProgress(job, e) {
    if (!e || typeof e !== "object") return false;
    if (e.type === "plan" && Array.isArray(e.stages)) {
        job.stages = e.stages
            .filter((s) => s && typeof s.name === "string")
            .slice(0, 20)
            .map((s) => ({
                name: s.name,
                state: s.run ? "queued" : "skipped",
                reason: s.run ? null : (s.why ?? null),
                counts: {},
            }));
        const msg = job.stages.find((s) => s.name === "messages");
        // A run that will not ask the phone says so from the start (the messages stage is not needed).
        job.phonePrompt = Boolean(msg && msg.state === "queued");
        if (!job.phonePrompt) job.phone = "not-needed";
        markRunning(job);
        return true;
    }
    if (e.type === "stage" && typeof e.stage === "string") {
        job.stages ??= [];
        let s = job.stages.find((x) => x.name === e.stage);
        if (!s) job.stages.push((s = { name: e.stage, state: "queued", reason: null, counts: {} }));
        s.state = STAGE_STATES.includes(e.status) ? e.status : "failed";
        s.reason = typeof e.reason === "string" && e.reason ? e.reason.slice(0, 200) : null;
        s.counts = counts(e.stats);
        markRunning(job);
        return true;
    }
    if (e.type === "phone" && PHONE_STATES.includes(e.state)) {
        if (job.phone === e.state) return false;
        job.phone = e.state;
        return true;
    }
    return false;
}

/** The first planned stage without a result runs now (the sync runs its stages in plan order). */
function markRunning(job) {
    let found = false;
    for (const s of job.stages ?? []) {
        if (s.state === "running") s.state = "queued";
        if (!found && s.state === "queued") {
            s.state = "running";
            found = true;
        }
    }
}

/** Jobs kept per account after they end. */
export const KEEP_PER_ACCOUNT = 20;

/** Jobs running at once on the host (each is a CLI process; a small host has little memory to spare). */
export const DEFAULT_MAX_RUNNING = 2;

const JOB_ID = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * The command's `--json` result: the whole stdout as JSON, else its last line that parses. Null when none does.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseJobResult(stdout) {
    const text = String(stdout ?? "").trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        /* several lines: try them from the end */
    }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l.startsWith("{") && !l.startsWith("[")) continue;
        try {
            return JSON.parse(l);
        } catch {
            /* not this one */
        }
    }
    return null;
}

/**
 * @param {object} args
 * @param {(args: string[]) => {done: Promise<{code: number, stdout: string, stderr: string}>, cancel: () => void}} args.startCli
 *   run this CLI as a child; `cancel` interrupts it
 * @param {(event: object) => void} [args.publish] - the controller's SSE and webhook
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {number} [args.maxRunning]
 * @returns {{handle: Function, list: (ownId: string) => object[], running: () => number, stopAll: () => void}}
 */
export function createFleetJobs({
    startCli,
    publish = () => {},
    log = () => {},
    now = Date.now,
    maxRunning = DEFAULT_MAX_RUNNING,
}) {
    const byAccount = new Map(); // ownId -> job[] (newest first)
    const live = new Map(); // jobId -> {job, cancel}

    const view = (j) => ({ ...j });
    const send = (res, code, body) => {
        res.status(code).set({ "Cache-Control": "no-store" }).json(body);
    };

    function remember(job) {
        const list = byAccount.get(job.accountId) ?? [];
        list.unshift(job);
        // Keep the running one and the newest ended ones.
        let ended = 0;
        byAccount.set(
            job.accountId,
            list.filter((j) => j.state === "running" || ++ended <= KEEP_PER_ACCOUNT),
        );
    }

    function start(ownId, kind, opts, who) {
        const args = ["--json", "--account", ownId, ...JOB_KINDS[kind](opts)];
        const job = {
            id: randomBytes(9).toString("base64url"),
            accountId: ownId,
            kind,
            state: "running",
            phonePrompt: PHONE_KINDS.includes(kind),
            params: { ...(opts.days ? { days: opts.days } : {}), ...(opts.dryRun ? { dryRun: true } : {}) },
            startedAt: new Date(now()).toISOString(),
            endedAt: null,
            exitCode: null,
            result: null,
            error: null,
            // Each stage of the run as it happens, and the phone prompt's state (sync kinds; empty for the others).
            stages: [],
            phone: PHONE_KINDS.includes(kind) ? null : "not-needed",
        };
        const run = startCli(args, {
            onProgress: (e) => {
                if (job.state === "running" && applyProgress(job, e))
                    publish({ event: "job", accountId: ownId, job: view(job) });
            },
        });
        const entry = { job, cancel: run.cancel, cancelled: false };
        live.set(job.id, entry);
        remember(job);
        log(`[fleet] job ${job.id} ${kind} ${ownId} started (${who})`);
        publish({ event: "job", accountId: ownId, job: view(job) });
        run.done.then(
            (r) => finish(entry, r),
            (e) => finish(entry, { code: 1, stdout: "", stderr: e?.message ?? String(e) }),
        );
        return job;
    }

    function finish(entry, r) {
        const { job } = entry;
        live.delete(job.id);
        job.exitCode = r.code;
        job.endedAt = new Date(now()).toISOString();
        job.state = entry.cancelled ? "cancelled" : r.code === 0 ? "succeeded" : "failed";
        // Stages still waiting or running when the run ended did not run to their end.
        for (const s of job.stages ?? []) {
            if (s.state === "running" || s.state === "queued")
                s.state = job.state === "succeeded" ? "skipped" : job.state === "cancelled" ? "skipped" : "failed";
        }
        // The command's own result carries each stage's final word: it wins over the live lines.
        const final = parseJobResult(r.stdout);
        if (final && Array.isArray(final.stages))
            for (const st of final.stages) applyProgress(job, { type: "stage", ...st });
        job.result = parseJobResult(r.stdout);
        if (job.state !== "succeeded") {
            const tail = String(r.stderr ?? "").trim();
            job.error = tail ? tail.slice(-500) : null;
        }
        log(`[fleet] job ${job.id} ${job.kind} ${job.accountId} ${job.state} (exit ${r.code})`);
        publish({ event: "job", accountId: job.accountId, job: view(job) });
    }

    /**
     * Serve `/jobs[...]` for an account the controller has already checked.
     *
     * @param {string} ownId
     * @param {string} rest - the path after `/accounts/<ownId>`, e.g. `/jobs` or `/jobs/<id>/cancel`
     * @param {object} req
     * @param {object} res
     * @param {{who: string, ip: string}} ctx
     * @returns {boolean} false for a path that is not a jobs route
     */
    function handle(ownId, rest, req, res, ctx) {
        const m = /^\/jobs(?:\/([^/]+)(\/cancel)?)?$/.exec(rest);
        if (!m) return false;
        const [, jobId, cancel] = m;
        if (!jobId) {
            if (req.method === "GET") {
                send(res, 200, { accountId: ownId, jobs: (byAccount.get(ownId) ?? []).map(view) });
                return true;
            }
            if (req.method !== "POST") {
                send(res, 405, { error: "GET or POST only", code: "METHOD_NOT_ALLOWED" });
                return true;
            }
            const body = req.body && typeof req.body === "object" ? req.body : {};
            const kind = String(body.kind ?? "");
            if (!Object.hasOwn(JOB_KINDS, kind)) {
                send(res, 400, {
                    error: `kind is one of: ${Object.keys(JOB_KINDS).join(", ")}`,
                    code: "UNKNOWN_JOB",
                });
                return true;
            }
            const days = body.days === undefined || body.days === null ? null : Number(body.days);
            if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
                send(res, 400, { error: "days is a whole number from 1 to 3650", code: "INVALID_DAYS" });
                return true;
            }
            if (days !== null && kind !== "sync") {
                send(res, 400, { error: "days applies to a sync only", code: "INVALID_DAYS" });
                return true;
            }
            const running = (byAccount.get(ownId) ?? []).find((j) => j.state === "running");
            if (running) {
                send(res, 409, {
                    error: "a job runs for this account already",
                    code: "JOB_RUNNING",
                    job: view(running),
                });
                return true;
            }
            if (live.size >= maxRunning) {
                send(res, 429, {
                    error: `the host runs ${live.size} jobs already; try again shortly`,
                    code: "JOBS_BUSY",
                });
                return true;
            }
            const job = start(ownId, kind, { days, dryRun: body.dryRun === true }, `${ctx.who} ${ctx.ip}`);
            send(res, 202, view(job));
            return true;
        }
        if (!JOB_ID.test(jobId)) {
            send(res, 400, { error: "not a job id", code: "INVALID_JOB_ID" });
            return true;
        }
        const job = (byAccount.get(ownId) ?? []).find((j) => j.id === jobId);
        if (!job) {
            send(res, 404, { error: "no such job for this account", code: "JOB_NOT_FOUND" });
            return true;
        }
        if (!cancel) {
            if (req.method !== "GET") {
                send(res, 405, { error: "GET only", code: "METHOD_NOT_ALLOWED" });
                return true;
            }
            send(res, 200, view(job));
            return true;
        }
        if (req.method !== "POST") {
            send(res, 405, { error: "POST only", code: "METHOD_NOT_ALLOWED" });
            return true;
        }
        const entry = live.get(jobId);
        if (!entry) {
            send(res, 409, { error: "the job has ended", code: "JOB_ENDED", job: view(job) });
            return true;
        }
        entry.cancelled = true;
        entry.cancel();
        log(`[fleet] job ${jobId} cancel asked (${ctx.who} ${ctx.ip})`);
        send(res, 202, view(job));
        return true;
    }

    return {
        handle,
        list: (ownId) => (byAccount.get(ownId) ?? []).map(view),
        running: () => live.size,
        /** Stop every running child (the controller is shutting down). */
        stopAll() {
            for (const e of live.values()) {
                e.cancelled = true;
                try {
                    e.cancel();
                } catch {
                    /* gone */
                }
            }
        },
    };
}
