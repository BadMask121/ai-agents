// A whole protocol 2 cloud in Node: the Worker's route() over fake Tenant and
// Registry namespaces, a movable clock, and helpers that act like the Mac.

import { AGENT_PROTOCOL_V2 } from "../src/constants";
import { Registry } from "../src/registry";
import { route, type Namespaces, type Secrets } from "../src/router";
import { Tenant } from "../src/tenant";
import { FakeNamespace, FakeWebSocket } from "./do-harness";
import { AGENT_TOKEN, SECRET, SHORTCUT_KEY, makeDeps } from "./helpers";

export type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const ADMIN = "admin-token-0123456789abcdef";

export interface Registered {
  tenant_id: string;
  agent_token: string;
}

export function makeCloud(start = "2026-10-28T12:00:00.000Z", extra: Secrets = {}) {
  let now = new Date(start);
  const clock = () => new Date(now);
  const env: Any = { DEFAULT_PLAYLIST: "ChatGPT Downloads", MAX_URLS: "3", PUBLIC_HOST: "mcp.example.test" };
  const TENANT = new FakeNamespace(Tenant, () => env, (t) => (t.clock = clock));
  const REGISTRY = new FakeNamespace(Registry, () => env, (r) => (r.clock = clock));
  env.TENANT = TENANT;
  env.REGISTRY = REGISTRY;
  const v1 = makeDeps(start);
  const secrets: Secrets = { MCP_SECRET_PATH: SECRET, AGENT_TOKEN, SHORTCUT_API_KEY: SHORTCUT_KEY, ADMIN_TOKEN: ADMIN, ...extra };
  const ns = { TENANT, REGISTRY } as unknown as Namespaces;

  const cloud = {
    TENANT,
    REGISTRY,
    secrets,
    v1,
    call: (req: Request) => route(req, cloud.secrets, v1.deps, ns),
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000);
      v1.advance(seconds);
    },
    now: clock,
    tenant: (t: Registered) => TENANT.instance(t.tenant_id),

    async register(ip = "203.0.113.7", body: Record<string, unknown> = {}): Promise<Response> {
      return cloud.call(
        req("POST", "/v2/register", { protocol: AGENT_PROTOCOL_V2, platform: "macos", arch: "arm64", agent_version: "1.0.0", ...body }, {
          "cf-connecting-ip": ip,
        }),
      );
    },

    async registered(ip?: string): Promise<Registered> {
      const res = await cloud.register(ip);
      if (res.status !== 201) throw new Error(`register → ${res.status} ${await res.text()}`);
      return (await res.json()) as Registered;
    },

    async link(t: Registered, kind = "chatgpt", label?: string): Promise<Any> {
      const res = await cloud.call(req("POST", "/v2/agent/links", { kind, ...(label ? { label } : {}) }, agentHeaders(t)));
      if (res.status !== 201) throw new Error(`link → ${res.status} ${await res.text()}`);
      return res.json();
    },

    /** POST one JSON-RPC message to a link URL; returns [status, body]. */
    async mcp(url: string, message: unknown, headers: Record<string, string> = {}): Promise<[number, Any]> {
      const res = await cloud.call(req("POST", new URL(url).pathname, message, headers));
      const text = await res.text();
      return [res.status, text === "" ? null : JSON.parse(text)];
    },

    async tool(url: string, name: string, args: Record<string, unknown> = {}): Promise<Any> {
      const [status, body] = await cloud.mcp(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      if (status !== 200) throw new Error(`tools/call ${name} → ${status}`);
      return body.result;
    },

    /** The Mac connects (the Worker's 101 upgrade is in the smoke test). */
    async connect(t: Registered, headers: Record<string, string> = {}): Promise<FakeWebSocket> {
      const ws = new FakeWebSocket();
      // As the Worker forwards it: the bearer moves to x-djs-token.
      const h = new Headers({ ...agentHeaders(t), "x-djs-token": t.agent_token, ...headers });
      await cloud.tenant(t).acceptAgent(ws as unknown as WebSocket, h);
      return ws;
    },

    async send(t: Registered, ws: FakeWebSocket, frame: unknown): Promise<void> {
      await cloud.tenant(t).webSocketMessage(ws as unknown as WebSocket, typeof frame === "string" ? frame : JSON.stringify(frame));
    },

    async hello(t: Registered, ws: FakeWebSocket, frame: Record<string, unknown> = {}): Promise<void> {
      await cloud.send(t, ws, { type: "hello", protocol: AGENT_PROTOCOL_V2, agent_version: "1.0.0", active: [], can_claim: true, library_hash: null, ...frame });
    },
  };
  return cloud;
}

export function agentHeaders(t: Registered, protocol = AGENT_PROTOCOL_V2): Record<string, string> {
  return {
    authorization: `Bearer ${t.agent_token}`,
    "x-dj-sync-tenant": t.tenant_id,
    "x-dj-sync-agent-protocol": protocol,
    "x-dj-sync-agent-version": "1.0.0",
  };
}

export function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
  return new Request(`https://mcp.example.test${path}`, init);
}

export const YT = (n: number) => `https://youtu.be/${String(n).padStart(11, "a").slice(-11)}`;
