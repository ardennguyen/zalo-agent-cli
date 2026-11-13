/**
 * `reminder list` pages a group's reminders the way Zalo expects (and `zalo_reminder` does): page 2 and later carry
 * `last_id`, the id of the last topic of the page before, so the pages before are read first. A DM's pages have no
 * cursor. Runs the real command against an offline session (./support/offline-cli.js). Every id is fake.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { seedAccount, seedThread, runOffline, requestsTo } from "./support/offline-cli.js";

void SANDBOX_HOME;

const GROUP = "200000000000000091";
const PEER = "300000000000000091";

/** A group reminder as `/api/board/listReminder` lists it (a topic with a start time). */
const topic = (id) => ({
    id,
    creatorId: "500000000000000091",
    startTime: 1800000000000 + id,
    params: JSON.stringify({ title: `r${id}` }),
});

const objectData = (q) => JSON.parse(q.params.objectData);

describe("reminder list --page", () => {
    before(() => {
        seedAccount();
        seedThread(GROUP, "group");
        seedThread(PEER, "dm");
    });

    it("a group's page 2 asks page 1 first and sends its last id", async () => {
        const r = await runOffline(["reminder", "list", GROUP, "-t", "1", "-n", "2", "-p", "2", "--json"], {
            responses: {
                "/api/board/listReminder": {
                    __sequence: [JSON.stringify([topic(71), topic(72)]), JSON.stringify([topic(73)])],
                },
            },
        });
        assert.equal(r.code, 0, r.all);
        const asks = requestsTo(r.requests, "/api/board/listReminder").map(objectData);
        // Red without the cursor: one request for page 2 with last_id 0 (what the CLI sent before).
        assert.deepEqual(
            asks.map((o) => [o.page, o.count, o.last_id]),
            [
                [1, 2, 0],
                [2, 2, 72], // a JSON number, a parsed id: the exact id quoted brings page 1 back
            ],
        );
        assert.deepEqual(
            JSON.parse(r.stdout).map((x) => x.id),
            ["73"],
        );
    });

    it("a DM's page 2 goes by page number alone", async () => {
        const r = await runOffline(["reminder", "list", PEER, "-t", "0", "-p", "2", "--json"]);
        assert.equal(r.code, 0, r.all);
        const asks = requestsTo(r.requests, "/api/board/oneone/list").map(objectData);
        assert.deepEqual(
            asks.map((o) => o.page),
            [2],
        );
    });
});
