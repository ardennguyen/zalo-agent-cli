/**
 * `oa call`: voice-call consent and call links (Zalo's OA docs "Gọi thoại"). The app needs the OA's voice-call
 * permission; calls by phone number need the user's consent first.
 */

import {
    CALL_TYPES,
    CONSENT_REASONS,
    checkCallConsent,
    createInboundCallLink,
    createOutboundCallLink,
    getCallCenterInfo,
    requestCallConsent,
} from "../../core/oa/calls.js";
import { guardSubcommand } from "../../core/confirm-guard.js";
import { error, info, output, success, warning } from "../../utils/output.js";

const REASONS_HELP = Object.entries(CONSENT_REASONS)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

function showLink(r) {
    const d = r.data || {};
    if (d.call_link) info(`Call link: ${d.call_link}`);
    if (d.qr_code) info(`QR code: ${d.qr_code}`);
    if (d.ttl !== undefined) info(`Valid for: ${d.ttl} s`);
}

/**
 * Register `oa call` on the `oa` command.
 * @param {import("commander").Command} oa
 */
export function registerCallsCommands(oa) {
    const json = () => oa.parent?.opts().json;
    const run =
        (fn) =>
        async (...args) => {
            try {
                await fn(...args);
            } catch (e) {
                error(e.message);
            }
        };

    const call = oa.command("call").description("Voice calls: call consent and call links (Zalo Cloud Connect)");

    call.command("consent-request <phone>")
        .description(
            "Ask a user, by phone number, for permission to call them (Zalo charges each request; the user has " +
                "24 h to answer; an approval lasts 30 days)",
        )
        .requiredOption("--reason <code>", `Why you call: ${REASONS_HELP}`)
        .option("--type <type>", `Call type: ${CALL_TYPES.join(", ")}`, "audio")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (phone, opts) => {
                const r = await requestCallConsent({ phone, callType: opts.type, reasonCode: opts.reason }, opts.oaId);
                output(r, json(), () => {
                    if (r.consented) success(`${r.status}: the OA may call ${phone}`);
                    else success(`${r.status} (${phone})`);
                });
            }),
        );

    guardSubcommand(call, "consent-request", "oa.call.consentRequest", {
        target: (phone, opts) => ({ phone, oaId: opts.oaId }),
    });

    call.command("consent-check <phone>")
        .description("Whether a user allowed the OA to call their phone number")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (phone, opts) => {
                const r = await checkCallConsent(phone, opts.oaId);
                output(r, json(), () => {
                    if (r.consented) {
                        const until = r.expired_time ? ` until ${new Date(Number(r.expired_time)).toISOString()}` : "";
                        success(`${r.status}: the OA may call ${phone}${until}`);
                    } else {
                        warning(`${r.status}: the OA may not call ${phone} (code ${r.code})`);
                    }
                });
            }),
        );

    call.command("outbound <user-id>")
        .description("A link and QR code for the OA to call a user")
        .option("--agent <agent-id>", "The agent (their user_id) who makes the call (see `oa call mcc-info`)")
        .option("--type <type>", `Call type: ${CALL_TYPES.join(", ")}`, "audio")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (userId, opts) => {
                const r = await createOutboundCallLink({ userId, agentId: opts.agent, callType: opts.type }, opts.oaId);
                output(r, json(), () => showLink(r));
            }),
        );

    call.command("inbound")
        .description("A link and QR code for a user to call the OA")
        .option("--branch <branch-id>", "The call branch to reach (see `oa call mcc-info`)")
        .option("--agent <agent-id>", "The agent (their user_id) to reach")
        .option("--type <type>", `Call type: ${CALL_TYPES.join(", ")}`, "audio")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (opts) => {
                const r = await createInboundCallLink(
                    { branchId: opts.branch, agentId: opts.agent, callType: opts.type },
                    opts.oaId,
                );
                output(r, json(), () => showLink(r));
            }),
        );

    call.command("mcc-info")
        .description("The call center's agents and branches")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (opts) => {
                const r = await getCallCenterInfo(opts.oaId);
                output(r, json(), () => {
                    const agents = r.data?.agents || [];
                    const branches = r.data?.branches || [];
                    info(`Agents: ${agents.length}`);
                    for (const a of agents) {
                        const alloc = (a.allocation || []).join(", ");
                        info(`  ${a.agent_id ?? "?"}  ${a.agent_name ?? ""}${alloc ? `  branches: ${alloc}` : ""}`);
                    }
                    info(`Branches: ${branches.length}`);
                    for (const b of branches)
                        info(`  ${b.branch_id ?? "?"}  ${b.branch_name ?? ""}  (${b.status ?? "?"})`);
                });
            }),
        );
}
