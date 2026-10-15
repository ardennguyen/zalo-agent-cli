/**
 * Process-local tracking for explicitly requested MCP sync stages. The daemon
 * owns this object, not an HTTP request's short-lived McpServer. The runners
 * own all sync work; this module only tracks bounded progress and the result.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/**
 * Create a bounded, account-local job tracker using the daemon's stage lock.
 * Completed jobs are retained until displaced by ten newer jobs or restart.
 * A requestId retry returns the same job while retained, without another tap.
 * @param {{runners: object, lock: object}} deps - daemon runners and shared stage lock
 * @returns {{start: Function, status: Function}}
 */
export function createSyncJobs({ runners, lock }) {
    const jobs = new Map();
    const snapshot = (job) => (job ? structuredClone(job) : null);

    return {
        start({ requestId, stage, ...params }) {
            const existing = [...jobs.values()].find((job) => job.requestId === requestId);
            if (existing) {
                if (existing.stage !== stage || !isDeepStrictEqual(existing.params, params)) {
                    throw new Error("requestId already names a different sync request; use a new requestId.");
                }
                return snapshot(existing);
            }
            if (!["messages", "reactions"].includes(stage) || typeof runners[stage] !== "function") {
                throw new Error("Unsupported sync stage.");
            }
            const release = lock.tryAcquire(`mcp-sync:${stage}`);
            if (!release)
                throw new Error(`Sync/history is busy (${lock.current()?.stage}); check status and retry later.`);

            const job = {
                jobId: randomUUID(),
                requestId,
                stage,
                params,
                state: "running",
                startedAt: Date.now(),
                finishedAt: null,
                phoneConfirmationRequired: stage === "messages",
                events: [],
            };
            // The lock guarantees no other running job is evicted here.
            while (jobs.size >= 10) jobs.delete(jobs.keys().next().value);
            jobs.set(job.jobId, job);
            const initial = snapshot(job);
            Promise.resolve().then(async () => {
                try {
                    job.result = await runners[stage](params, (event) => {
                        // Retain recent progress, never an unbounded event stream.
                        job.events.push({
                            at: Date.now(),
                            phase: String(event.phase || "progress").slice(0, 80),
                            detail: String(event.detail || "").slice(0, 1000),
                        });
                        if (job.events.length > 20) job.events.shift();
                    });
                    job.state = "completed";
                } catch (error) {
                    job.state = "failed";
                    job.error = error?.message || String(error);
                } finally {
                    job.finishedAt = Date.now();
                    release();
                }
            });
            return initial;
        },
        status(jobId) {
            if (jobId) {
                const job = jobs.get(jobId);
                if (!job) throw new Error("Unknown or expired sync job; jobs are lost when the daemon restarts.");
                return snapshot(job);
            }
            return snapshot([...jobs.values()].at(-1)) || { state: "idle" };
        },
    };
}
