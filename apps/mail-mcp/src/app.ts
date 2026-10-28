/**
 * HTTP layer. `/` landing page, `/health`, and the MCP endpoint mounted only
 * at /<MCP_SECRET_PATH>/mcp; everything else is 404 (the secret path is the
 * auth, as before).
 *
 * MCP runs stateless: each POST gets a fresh server + Web-standard Streamable
 * HTTP transport with JSON responses, so no session state has to live between
 * Worker requests. There's no server-initiated stream to offer, so GET (and
 * DELETE) on the endpoint are 405.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Config, type Env } from "./config.js";
import { ImapClient, type Connect } from "./imap.js";
import { LANDING_HTML } from "./landing.js";
import { Mailbox } from "./mailbox.js";
import { registerTools } from "./tools/index.js";

export const VERSION = "0.2.0";

function jsonRpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildServer(cfg: Config, connect: Connect): McpServer {
  const server = new McpServer({ name: "mail-mcp", version: VERSION }, { capabilities: { tools: {} } });
  registerTools(server, new Mailbox(cfg, { imap: new ImapClient(cfg, connect) }));
  return server;
}

export async function handle(request: Request, env: Env, connect: Connect): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/" && request.method === "GET") {
    return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (err) {
    console.error("[mail-mcp] config:", (err as Error).message);
    return jsonRpcError(500, "Server is not configured");
  }

  if (pathname !== `/${cfg.secretPath}/mcp`) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const server = buildServer(cfg, connect);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (err) {
    console.error("[mail-mcp] request error:", (err as Error).message);
    return jsonRpcError(500, "Internal server error");
  }
}
