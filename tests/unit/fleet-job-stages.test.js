/**
 * An account job shows each stage of its run as it happens (./src/core/fleet-jobs.js): the child's progress lines set the
 * plan, the running stage, the phone prompt's state and each stage's result; a run that will not ask the phone says so
 * from the start; the job ends when the child ends, and the command's own result has the last word. The stage runner
 * (startSelf) hands over progress lines and keeps them out of the error text. A stand-in replaces the child process.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { JOB_PROGRESS_MARK, applyProgress, createFleetJobs } from "../../src/core/fleet-jobs.js";

const A = "1000000000000000981";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const PLAN_FULL = {
    type: "plan",
    stages: [
        { name: "messages", run: true },
        { name: "reactions", run: true },
        { name: "cloud", run: true },
        { name: "media", run: true },
    ],
};

/** createFleetJobs with one scripted child: returns the job list, events, and the child's progress hook and settle. */
function rig() {
    const events = [];
    let child;
    const jobs = createFleetJobs({
        startCli: (args, o) => {
            let settle;
            const done = new Promise((r) => (settle = r));
            child = { args, settle, progress: o?.onProgress };
            return { done, cancel: () => settle({ code: 130, stdout: "", stderr: "interrupted" }) };
        },
        publish: (e) => events.push(e),
    });
    const res = { status: () => res, set: () => res, json: (b) => (res.body = b) };
    jobs.handle(A, "/jobs", { method: "POST", body: { kind: "sync" } }, res, { who: "t", ip: "-" });
    return { jobs, events, child: () => child, job: () => jobs.list(A)[0] };
}

describe("account job stages", () => {
    it("plan, running stage, phone wait and confirm, stage results, then the end", async () => {
        const r = rig();
        assert.equal(r.job().phonePrompt, true);
        assert.equal(r.job().phone, null);
        r.child().progress(PLAN_FULL);
        assert.deepEqual(
            r.job().stages.map((s) => [s.name, s.state]),
            [
                ["messages", "running"],
                ["reactions", "queued"],
                ["cloud", "queued"],
                ["media", "queued"],
            ],
        );
        r.child().progress({ type: "phone", state: "waiting" });
        assert.equal(r.job().phone, "waiting");
        r.child().progress({ type: "phone", state: "confirmed" });
        r.child().progress({
            type: "stage",
            stage: "messages",
            status: "ok",
            reason: "complete",
            stats: { saved: 1742, id: 1e12 },
        });
        assert.deepEqual(r.job().stages[0], {
            name: "messages",
            state: "ok",
            reason: "complete",
            counts: { saved: 1742 },
        });
        assert.equal(r.job().stages[1].state, "running");
        r.child().progress({ type: "stage", stage: "reactions", status: "ok" });
        r.child().progress({ type: "stage", stage: "cloud", status: "ok" });
        assert.equal(r.job().stages[3].state, "running", "media runs: the job is honestly still running");
        assert.equal(r.job().state, "running");
        const stdout = JSON.stringify({
            stages: [{ stage: "media", status: "partial", reason: "3 pending", stats: { downloaded: 40 } }],
        });
        r.child().settle({ code: 0, stdout, stderr: "" });
        await new Promise((x) => setImmediate(x));
        assert.equal(r.job().state, "succeeded");
        assert.deepEqual(r.job().stages[3], {
            name: "media",
            state: "partial",
            reason: "3 pending",
            counts: { downloaded: 40 },
        });
        // Every change went out as a job event, the end last.
        assert.ok(r.events.length >= 7);
        assert.equal(r.events.at(-1).job.state, "succeeded");
    });

    it("a run whose messages stage is not needed says it will not ask the phone", () => {
        const r = rig();
        r.child().progress({
            type: "plan",
            stages: [
                { name: "messages", run: false, why: "already complete" },
                { name: "reactions", run: true },
            ],
        });
        assert.equal(r.job().phonePrompt, false);
        assert.equal(r.job().phone, "not-needed");
        assert.deepEqual(r.job().stages[0], {
            name: "messages",
            state: "skipped",
            reason: "already complete",
            counts: {},
        });
        assert.equal(r.job().stages[1].state, "running");
    });

    it("stages still open when a run is cancelled are shown as not run, not running", async () => {
        const r = rig();
        r.child().progress(PLAN_FULL);
        const res = { status: () => res, set: () => res, json: (b) => (res.body = b) };
        r.jobs.handle(A, `/jobs/${r.job().id}/cancel`, { method: "POST" }, res, { who: "t", ip: "-" });
        await new Promise((x) => setImmediate(x));
        assert.equal(r.job().state, "cancelled");
        assert.ok(r.job().stages.every((s) => s.state === "skipped"));
        // A second cancel says the job has ended, with the job.
        r.jobs.handle(A, `/jobs/${r.job().id}/cancel`, { method: "POST" }, res, { who: "t", ip: "-" });
        assert.equal(res.body.code, "JOB_ENDED");
        assert.equal(res.body.job.state, "cancelled");
    });

    it("unknown events and bad stage words change nothing harmful", () => {
        const job = { stages: [] };
        assert.equal(applyProgress(job, null), false);
        assert.equal(applyProgress(job, { type: "phone", state: "hacked" }), false);
        applyProgress(job, { type: "stage", stage: "messages", status: "weird" });
        assert.equal(job.stages[0].state, "failed");
    });

    it("the mark is a line prefix the command never prints for a person", () => {
        assert.ok(JOB_PROGRESS_MARK.startsWith("@@"));
    });
});
