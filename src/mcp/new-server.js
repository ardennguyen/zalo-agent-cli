/**
 * The one place an MCP server instance is made, for both transports (stdio and HTTP), so every client is told the
 * same thing on connect: the server's instructions (src/mcp/instructions.js), and what the caller is told about
 * itself among the account's agents (src/mcp/agents.js inboxInstructions).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

/**
 * @param {string} version - the package version, reported as the server's version
 * @param {string} [callerInstructions] - lines about this caller, after the server's own ("" for none)
 * @returns {McpServer} a server with no tools registered yet
 */
export function newMcpServer(version, callerInstructions = "") {
    return new McpServer(
        { name: "zalo-agent", version },
        { instructions: callerInstructions ? `${SERVER_INSTRUCTIONS}\n${callerInstructions}` : SERVER_INSTRUCTIONS },
    );
}
