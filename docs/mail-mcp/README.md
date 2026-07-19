# mail-mcp — ChatGPT-connectable MCP for your privateemail.com mailbox

**Status:** 🟢 live (v1) at <https://mail-mcp.jeffrey.build> · **App:** `apps/mail-mcp/` ·
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
  server won't work — so it's deployed with TLS (Coolify on the Hetzner VPS).
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

## Configuration (env)

| Var | Required | Default | Notes |
|---|---|---|---|
| `PRIVATEEMAIL_USER` | ✅ | — | Full email address |
| `PRIVATEEMAIL_PASS` | ✅ | — | Mailbox password |
| `MCP_SECRET_PATH` | ✅ | — | Long random URL segment, e.g. `k7f2...` |
| `IMAP_HOST` | | `mail.privateemail.com` | |
| `IMAP_PORT` | | `993` | TLS |
| `SMTP_HOST` | | `mail.privateemail.com` | |
| `SMTP_PORT` | | `465` | TLS |
| `PORT` | | `8080` | HTTP listen port |
| `MAX_BODY_BYTES` | | `100000` | Truncate returned text bodies |
| `MAX_ATTACHMENT_BYTES` | | `5000000` | Cap `get_attachment` payload |

## Run locally

```bash
cd apps/mail-mcp
cp .env.example .env   # fill in creds + secret path
pnpm install
pnpm dev               # tsx watch; serves http://localhost:8080/<secret>/mcp
```

Shake it out with the MCP Inspector before wiring ChatGPT:

```bash
npx @modelcontextprotocol/inspector
# connect to: http://localhost:8080/<MCP_SECRET_PATH>/mcp  (Streamable HTTP)
```

## Connect from ChatGPT

1. ChatGPT → **Settings → Connectors** → enable **Developer Mode** (Plus/Pro).
2. **Add custom connector** → URL:
   `https://<host>/<MCP_SECRET_PATH>/mcp` → auth: **No authentication**.
3. The full tool set appears. Write actions (`send_email`, `delete_email`,
   `move_email`) prompt for confirmation in ChatGPT before running.

## Deploy (Hetzner / Coolify) — live

Deployed as its own Coolify application on the Hetzner box, built from
`apps/mail-mcp/Dockerfile` (build context `apps/mail-mcp`), served at
`https://mail-mcp.jeffrey.build` with Let's Encrypt TLS. Mailbox credentials and
`MCP_SECRET_PATH` are set as Coolify env secrets. Coolify app `mail-mcp`
(project `mail-mcp`), health check `GET /health`.

**Auto-deploy:** unlike `apps/prole-site` (which has no webhook), this app
redeploys automatically. `.github/workflows/deploy-mail-mcp.yml` fires on any
push touching `apps/mail-mcp/**` on the `mail-mcp` branch and calls Coolify's
deploy API (token + app uuid in encrypted GitHub Actions secrets). Pushing to
`main` does **not** deploy — only the `mail-mcp` branch does.

> Manual "Run workflow" (workflow_dispatch) only appears once the workflow file
> exists on the default branch (`main`) — a GitHub rule. Push-triggered deploys
> work regardless.

## Safety

- Credentials live only in env/secrets — never logged or returned.
- Bodies and attachments are size-capped before reaching the model.
- `delete_email` moves to Trash unless `permanent: true`.
- Only `/<secret>/mcp` and `/health` respond; everything else is 404.
