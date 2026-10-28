/**
 * The Worker's HTTP surface: landing page, health, secret-path guard and the
 * stateless MCP endpoint (initialize, tools/list) — none of which need IMAP.
 */
import { describe, it, expect } from "vitest";
import { handle } from "./app.js";
import type { Connect } from "./imap.js";

const env = { PRIVATEEMAIL_USER: "me@example.com", PRIVATEEMAIL_PASS: "secret", MCP_SECRET_PATH: "s3cret" };
const noNetwork: Connect = async () => {
  throw new Error("no network in tests");
};
const BASE = "https://mail-mcp.jeffrey.build";

const rpc = (body: unknown, path = "/s3cret/mcp") =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body),
  });

describe("HTTP surface", () => {
  it("serves the landing page and health without secrets", async () => {
    const landing = await handle(new Request(`${BASE}/`), {}, noNetwork);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("<!doctype html>");
    expect(await (await handle(new Request(`${BASE}/health`), {}, noNetwork)).json()).toEqual({ status: "ok" });
  });

  it("404s anything but the secret MCP path", async () => {
    for (const path of ["/mcp", "/wrong/mcp", "/s3cret", "/s3cret/mcp/extra"]) {
      expect((await handle(rpc({}, path), env, noNetwork)).status, path).toBe(404);
    }
  });

  it("answers GET/DELETE on the endpoint with 405 (stateless: no stream to open)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handle(new Request(`${BASE}/s3cret/mcp`, { method }), env, noNetwork);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("reports missing configuration as a JSON-RPC error", async () => {
    const res = await handle(rpc({}), { PRIVATEEMAIL_USER: "x" }, noNetwork);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { message: "Server is not configured" } });
  });
});

describe("MCP endpoint", () => {
  it("initializes, then lists all 11 tools, each on a fresh request", async () => {
    const init = await handle(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      env,
      noNetwork,
    );
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: "mail-mcp", version: "0.2.0" } } });

    const note = await handle(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), env, noNetwork);
    expect(note.status).toBe(202);

    const list = await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, noNetwork);
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools.sort()).toEqual(
      ["delete_email", "fetch", "get_attachment", "list_folders", "list_messages", "mark_email", "move_email", "read_email", "search", "search_email", "send_email"].sort(),
    );
  });

  it("turns a mailbox failure into a tool error, not an HTTP error", async () => {
    const res = await handle(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_folders", arguments: {} } }), env, noNetwork);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/IMAP_CONNECT/);
  });
});
