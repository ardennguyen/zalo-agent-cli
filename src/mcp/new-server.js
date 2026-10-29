/**
 * The one place an MCP server instance is made, for both transports (stdio and HTTP), so every client is told the
 * same thing on connect: the server's instructions (src/mcp/instructions.js).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

/**
 * @param {string} version - the package version, reported as the server's version
 * @returns {McpServer} a server with no tools registered yet
 */
export function newMcpServer(version) {
    return new McpServer({ name: "zalo-agent", version }, { instructions: SERVER_INSTRUCTIONS });
}
