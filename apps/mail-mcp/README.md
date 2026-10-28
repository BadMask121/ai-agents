# @ai-agents/mail-mcp

Remote MCP server exposing a **privateemail.com** (Namecheap Private Email /
Open-Xchange) mailbox to **ChatGPT** over the MCP **Streamable HTTP** transport.

**Live:** `https://mail-mcp.jeffrey.build`, a Cloudflare Worker (`mail-mcp`).
MCP endpoint: `https://mail-mcp.jeffrey.build/<MCP_SECRET_PATH>/mcp`.

Product overview & tool reference: [`docs/mail-mcp/README.md`](../../docs/mail-mcp/README.md).
Design: [`docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md`](../../docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md).

## Layout

```
src/
  worker.ts        Worker entry (wires in cloudflare:sockets)
  app.ts           routes: / landing, /health, /<secret>/mcp (stateless MCP); 404 otherwise
  config.ts        Worker env → validated Config (fail fast)
  mailbox.ts       domain service: one IMAP session per call, trims shapes for the model
  tools/index.ts   MCP tool registration (thin; calls Mailbox)
  smtp.ts          nodemailer: send (587 STARTTLS)
  text.ts          light HTML → text
  imap.ts          IMAP exports
  imap/protocol.ts IMAP wire format: response reader + value parser
  imap/codec.ts    mailbox names, encoded headers, base64/QP, charsets
  imap/structure.ts ENVELOPE / BODYSTRUCTURE → body part + attachments
  imap/session.ts  connect, LOGIN, LIST/STATUS/SELECT/SEARCH/FETCH/MOVE/STORE/EXPUNGE
  socket.ts        cloudflare:sockets TLS connector
```

The IMAP client is written for Workers sockets (imapflow's Node streams don't
work there). Reads fetch only what they need (`read_email` the text part,
`get_attachment` that one section) to stay inside the free-plan CPU budget.

## Develop

```bash
pnpm install
cp .env.example .dev.vars   # fill creds + MCP_SECRET_PATH (wrangler dev reads .dev.vars)
pnpm dev                    # wrangler dev: http://localhost:8787/<secret>/mcp
pnpm typecheck
pnpm test                   # vitest: scripted IMAP server, no network
```

## Deploy (Cloudflare)

```bash
pnpm deploy   # wrangler deploy (custom domain mail-mcp.jeffrey.build)
```

Secrets live in the Worker (`wrangler secret put <NAME>` or `wrangler secret
bulk`): `PRIVATEEMAIL_USER`, `PRIVATEEMAIL_PASS`, `MCP_SECRET_PATH`
(`openssl rand -hex 24`). Rollback: `npx wrangler rollback`. Health check:
`GET /health`.

In ChatGPT → Settings → Connectors (Developer Mode on) → custom connector
`https://mail-mcp.jeffrey.build/<MCP_SECRET_PATH>/mcp`, auth **No authentication**.

## Security

Credentials only in Worker secrets; never logged or returned. Only `/`,
`/health` and `/<secret>/mcp` respond, everything else is 404. Bodies and
attachments are size-capped. `delete_email` moves to Trash unless
`permanent: true`.
