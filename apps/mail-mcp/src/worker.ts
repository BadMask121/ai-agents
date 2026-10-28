/**
 * Cloudflare Worker entry point for mail-mcp.
 * Uses the MCP SDK's stateless Streamable HTTP mode (new server + transport per request).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools/index.js";
import { loadConfig } from "./config.js";

export interface Env {
  PRIVATEEMAIL_USER: string;
  PRIVATEEMAIL_PASS: string;
  MCP_SECRET_PATH: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = loadConfig(env);

    // Landing page
    if (request.url === `https://${cfg.secretPath}/mcp` || request.url === `http://${cfg.secretPath}/mcp`) {
      return new Response("mail-mcp MCP endpoint. Use POST with JSON-RPC 2.0 messages.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Health check
    if (request.url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Everything else → 404
    return new Response("Not Found", { status: 404 });
  },
};
