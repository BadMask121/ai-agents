/**
 * HTTP layer. Exposes the MCP server over the Streamable HTTP transport, mounted
 * only at /<secretPath>/mcp.
 *
 * Uses stateful session management (the canonical MCP pattern ChatGPT expects):
 * an `initialize` POST with no session creates a transport + server and returns
 * an `mcp-session-id`; the client replays that id on every later POST/GET/DELETE.
 * The Mailbox (and its IMAP connection) is a shared singleton across sessions, so
 * it stays warm regardless of session churn.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Mailbox } from "./mailbox.js";
import { registerTools } from "./tools/index.js";
import { LANDING_HTML } from "./landing.js";

function buildMcpServer(mailbox: Mailbox): McpServer {
  const server = new McpServer(
    { name: "mail-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, mailbox);
  return server;
}

export function createApp(cfg: Config, mailbox: Mailbox): Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const mcpPath = `/${cfg.secretPath}/mcp`;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(LANDING_HTML);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? transports.get(sessionId) : undefined;

    let transport: StreamableHTTPServerTransport;
    if (existing) {
      transport = existing;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildMcpServer(mailbox);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session id" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  };

  // GET (SSE stream) and DELETE (session teardown) require an existing session.
  const handleSession = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      fn(req, res).catch((err: unknown) => {
        console.error("[mail-mcp] request error:", (err as Error).message);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      });
    };

  app.post(mcpPath, wrap(handlePost));
  app.get(mcpPath, wrap(handleSession));
  app.delete(mcpPath, wrap(handleSession));

  // Everything else (including path probes without the secret) → 404.
  app.use((_req: Request, res: Response) => res.status(404).send("Not Found"));

  return app;
}

export function startServer(cfg: Config, mailbox: Mailbox): ReturnType<Express["listen"]> {
  const app = createApp(cfg, mailbox);
  const httpServer = app.listen(cfg.port, () => {
    console.log(`[mail-mcp] listening on :${cfg.port}, MCP at /${cfg.secretPath}/mcp`);
  });
  return httpServer;
}
