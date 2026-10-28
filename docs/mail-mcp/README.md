# mail-mcp — ChatGPT-connectable MCP for your privateemail.com mailbox

**Status:** 🟢 live (v0.2, Cloudflare Worker) at <https://mail-mcp.jeffrey.build> · **App:** `apps/mail-mcp/` ·
**Design:**
[`docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md`](../superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md)

## What it is

A remote [MCP](https://modelcontextprotocol.io) server that lets **ChatGPT** read,
send, and manage your Namecheap **Private Email** mailbox
(`https://privateemail.com/appsuite/...`). Private Email runs Open-Xchange and
exposes standard **IMAP/SMTP** — this server talks to those, so nothing scrapes
the web UI.

It speaks the MCP **Streamable HTTP** transport, which is what ChatGPT's custom
connectors dial.

## Why these choices

- **ChatGPT only connects to *remote* MCP servers over HTTPS.** A local stdio
  server won't work — so it runs as a Cloudflare Worker with TLS.
- **Developer Mode** in ChatGPT enables the full read+write tool set. Standard
  connector mode only calls `search`/`fetch`, so we also ship read-only
  `search`/`fetch` aliases as a fallback (and for Deep Research).
- **Secret-path auth:** the server only answers at
  `https://<host>/<MCP_SECRET_PATH>/mcp`. For a single-user personal connector
  that long random path behind TLS is effectively a bearer token. OAuth 2.1 is
  the documented upgrade if it's ever shared.

## Tools

| Tool | What it does |
|---|---|
| `list_folders` | List mailbox folders with unread counts |
| `search_email` | Search a folder by from/to/subject/text/date/unseen |
| `list_messages` | List recent messages in a folder (paginated by offset) |
| `read_email` | Full message: headers, text body, attachment manifest |
| `get_attachment` | One attachment's bytes (base64, size-capped) |
| `send_email` | Compose/send; optional reply-threading to an existing message |
| `move_email` | Move a message to another folder |
| `delete_email` | Delete a message (to Trash by default; permanent optional) |
| `mark_email` | Set seen/unseen and flagged/unflagged |
| `search` / `fetch` | Read-only aliases for standard connector mode / Deep Research |

## Configuration (Worker secrets / vars)

| Var | Required | Default | Notes |
|---|---|---|---|
| `PRIVATEEMAIL_USER` | ✅ | — | Full email address |
| `PRIVATEEMAIL_PASS` | ✅ | — | Mailbox password |
| `MCP_SECRET_PATH` | ✅ | — | Long random URL segment, e.g. `k7f2...` |
| `IMAP_HOST` | | `mail.privateemail.com` | |
| `IMAP_PORT` | | `993` | TLS |
| `SMTP_HOST` | | `mail.privateemail.com` | |
| `SMTP_PORT` | | `587` | STARTTLS (Workers sockets refuse port 25) |
| `MAX_BODY_BYTES` | | `100000` | Truncate returned text bodies |
| `MAX_ATTACHMENT_BYTES` | | `5000000` | Cap `get_attachment` payload |

## Run locally

```bash
cd apps/mail-mcp
cp .env.example .dev.vars   # fill in creds + secret path
pnpm install
pnpm dev                    # wrangler dev; serves http://localhost:8787/<secret>/mcp
```

Shake it out with the MCP Inspector before wiring ChatGPT:

```bash
npx @modelcontextprotocol/inspector
# connect to: http://localhost:8787/<MCP_SECRET_PATH>/mcp  (Streamable HTTP)
```

## Connect from ChatGPT

1. ChatGPT → **Settings → Connectors** → enable **Developer Mode** (Plus/Pro).
2. **Add custom connector** → URL:
   `https://<host>/<MCP_SECRET_PATH>/mcp` → auth: **No authentication**.
3. The full tool set appears. Write actions (`send_email`, `delete_email`,
   `move_email`) prompt for confirmation in ChatGPT before running.

## Deploy (Cloudflare) — live

A Cloudflare Worker (`mail-mcp`, `apps/mail-mcp/wrangler.jsonc`) on the custom
domain `https://mail-mcp.jeffrey.build`. Mailbox credentials and
`MCP_SECRET_PATH` are Worker secrets (`wrangler secret`). Deploy with
`pnpm deploy` from `apps/mail-mcp`; roll back with `npx wrangler rollback`.
Health check `GET /health`.

MCP runs **stateless**: every POST gets a fresh server (JSON responses, no
session id), and each tool call opens its own IMAP session. `GET` on the
endpoint is `405` (no server-initiated stream).

Until 2026-10 it ran on Coolify on a Hetzner VPS (Dockerfile + a GitHub Action
calling Coolify's deploy API); both were removed with the move to Cloudflare.

## Safety

- Credentials live only in Worker secrets — never logged or returned.
- Bodies and attachments are size-capped before reaching the model.
- `delete_email` moves to Trash unless `permanent: true`.
- Only `/`, `/health` and `/<secret>/mcp` respond; everything else is 404.
