# @ai-agents/mail-mcp

Remote MCP server exposing a **privateemail.com** (Namecheap Private Email /
Open-Xchange) mailbox to **ChatGPT** over the MCP **Streamable HTTP** transport.

Product overview & tool reference: [`docs/mail-mcp/README.md`](../../docs/mail-mcp/README.md).
Design: [`docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md`](../../docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md).

## Layout

```
src/
  config.ts      env → validated Config (fail fast)
  imap.ts        imapflow wrapper: connection lifecycle, folder ops
  smtp.ts        nodemailer wrapper: send
  mailbox.ts     domain service — trims protocol shapes for the model
  tools/index.ts MCP tool registration (thin; calls Mailbox)
  server.ts      Express + Streamable HTTP transport at /<secret>/mcp
  index.ts       entrypoint
```

## Develop

```bash
pnpm install
cp .env.example .env      # fill creds + MCP_SECRET_PATH
pnpm dev                  # http://localhost:8080/<secret>/mcp
pnpm typecheck
pnpm test                 # unit tests (mocked IMAP/SMTP)
RUN_LIVE_TESTS=1 pnpm test  # + one live smoke test against the real mailbox
```

## Deploy (Hetzner / Coolify)

Mirrors the `apps/prole-site` Coolify v4 flow (see the `project_prole_landing` memory):

1. New Coolify **Dockerfile** application. **Base directory:** `apps/mail-mcp`.
   **Dockerfile location:** `Dockerfile` (relative to base dir).
2. Set env secrets in Coolify: `PRIVATEEMAIL_USER`, `PRIVATEEMAIL_PASS`,
   `MCP_SECRET_PATH` (`openssl rand -hex 24`). `PORT` stays `8080`.
3. Assign a domain, e.g. `mail-mcp.jeffrey.build`. Coolify/Traefik terminates TLS.
4. Deploy (API or UI — no webhook). Health check: `GET /health`.
5. In ChatGPT → Settings → Connectors (Developer Mode on) → add custom connector
   `https://mail-mcp.jeffrey.build/<MCP_SECRET_PATH>/mcp`, auth **No authentication**.

## Security

Credentials only in env; never logged or returned. Only `/<secret>/mcp` and
`/health` respond — everything else is 404. Bodies/attachments are size-capped.
`delete_email` moves to Trash unless `permanent: true`.
