import { assertSandboxed } from "../../helpers/sandbox.js";
import { CONFIG_DIR } from "../../../src/core/credentials.js";
import { createStageLock } from "../../../src/core/daemon-channel.js";
import { createSyncJobs } from "../../../src/mcp/sync-jobs.js";
import { createMCPServer } from "../../../src/mcp/mcp-server.js";

assertSandboxed(CONFIG_DIR);
const lock = createStageLock();
const jobs = createSyncJobs({
    lock,
    runners: { messages: async (params) => ({ reason: "complete", days: params.days, messagesSaved: 5 }) },
});
await createMCPServer({}, {}, {}, {}, null, undefined, lock, jobs);
