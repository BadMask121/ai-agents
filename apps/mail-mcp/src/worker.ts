/**
 * Cloudflare Worker entry for mail-mcp (mail-mcp.jeffrey.build). Secrets:
 * PRIVATEEMAIL_USER, PRIVATEEMAIL_PASS, MCP_SECRET_PATH (`wrangler secret`).
 */
import { handle } from "./app.js";
import type { Env } from "./config.js";
import { connectTls } from "./socket.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, connectTls);
  },
};
