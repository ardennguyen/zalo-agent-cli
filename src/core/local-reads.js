/**
 * The answers of the local reads of src/zalo/reads.js, registered on import.
 *
 * The protocol layer lists `voice-transcript` and `account-status` beside the reads that go to Zalo, but what they
 * answer from is this application's: the transcripts the listener records in the account's folder, and the plan
 * summary `account status` prints. Every module that calls `callRead` imports this one first.
 */
import { registerLocalRead } from "../zalo/reads.js";
import { getAccountDir } from "./credentials.js";
import { readTranscript, voiceTextFile } from "./voice-text.js";
import { readAccountStatus } from "./account-status.js";

registerLocalRead("voice-transcript", (a, api) =>
    readTranscript(voiceTextFile(getAccountDir(String(api.getOwnId()))), a.reqId),
);
registerLocalRead("account-status", (_a, api) => readAccountStatus(api, { ownId: String(api.getOwnId()) }));
