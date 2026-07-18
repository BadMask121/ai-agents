# Design: `mail-mcp` — ChatGPT-connectable MCP for privateemail.com

**Date:** 2026-07-18
**Status:** Approved design (pending spec review)
**Owner:** Jeffrey

## Goal

Build a remote MCP server that lets ChatGPT read, send, and manage the
privateemail.com mailbox
(`https://privateemail.com/appsuite/#!!&app=io.ox/mail&folder=default0`).

privateemail.com is Namecheap's Private Email, running Open-Xchange. It exposes
standard IMAP and SMTP, which is the stable, documented way in — no scraping the
OX web UI.

## Constraints (verified 2026-07-18)

- **ChatGPT only connects to remote MCP servers over HTTPS.** Local stdio does
  not work with ChatGPT. The server must be hosted with TLS.
- **ChatGPT Developer Mode** (Plus/Pro, Settings → Connectors) enables full MCP
  with arbitrary read + write tools and drops the old `search`/`fetch`-only
  requirement. Standard connector mode still only calls `search`/`fetch`.
- **Transport:** ChatGPT dials the MCP **Streamable HTTP** transport.
- **Connector auth:** ChatGPT supports No-auth / OAuth 2.1 on the connector.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Full: read, send, manage (move/delete/mark) |
| Hosting | Hetzner VPS via Coolify (own app, mirrors `apps/prole-site`) |
| Mailbox auth | Env-var credentials (Coolify secrets) |
| Connector auth | Secret-path + TLS now; OAuth 2.1 is a later upgrade |
| Std aliases | Yes — expose read-only `search`/`fetch` aliases too |
| Language / runtime | TypeScript on Node.js (fits all-Node repo) |
| Mail libraries | `imapflow` (IMAP), `nodemailer` (SMTP) |
| MCP framework | Official `@modelcontextprotocol/sdk`, Streamable HTTP |

Rejected alternatives: talking to the Open-Xchange HTTP API directly
(under-documented, session-cookie, brittle); Python + FastMCP (second toolchain
for no gain in a Node repo).

## Architecture

```
ChatGPT (Developer Mode)
   │  HTTPS (Streamable HTTP, JSON-RPC)
   ▼
Coolify / Traefik TLS  →  mail-mcp.<domain>/<secret>/mcp
   ▼
Node MCP server (@modelcontextprotocol/sdk, Streamable HTTP transport)
   ├── imapflow    → IMAP  mail.privateemail.com:993  (read / search / manage)
   └── nodemailer  → SMTP  mail.privateemail.com:465  (send)
```

New app lives at `apps/mail-mcp/`, deployed as its own Coolify app.

### Modules (isolated, single-purpose)

- `src/config.ts` — load + validate env (`PRIVATEEMAIL_USER`,
  `PRIVATEEMAIL_PASS`, `MCP_SECRET_PATH`, `IMAP_HOST`/`SMTP_HOST` with
  privateemail defaults, ports). Fail fast on missing secrets.
- `src/imap.ts` — thin `imapflow` wrapper: connect/reconnect, list folders,
  search, fetch summaries, fetch full message, fetch attachment, move, delete,
  flag. Owns connection lifecycle + timeouts. No MCP knowledge.
- `src/smtp.ts` — `nodemailer` wrapper: send a message (with reply threading
  headers). No MCP knowledge.
- `src/mailbox.ts` — mail-domain service composing imap + smtp; converts raw
  IMAP structures into the trimmed shapes returned to the model (HTML→text,
  size caps). This is the unit the tools call.
- `src/tools/*.ts` — one file per MCP tool; each validates input (zod) and calls
  `mailbox`. Thin.
- `src/server.ts` — build the MCP server, register tools, mount Streamable HTTP
  transport at `/<secret>/mcp`, enforce the secret path, start HTTP listener.
- `src/index.ts` — entrypoint.

Boundary test: tools can be understood without reading `imapflow`; `imap.ts`
internals can change without touching tools, because `mailbox.ts` is the
interface.

## Tools

Purpose-built (Developer Mode):

| Tool | Input | Output |
|---|---|---|
| `list_folders` | — | folder names + roles + unread counts |
| `search_email` | folder?, from?, to?, subject?, text?, since?, before?, unseen?, limit? | array of message summaries (uid, from, to, subject, date, snippet, flags, hasAttachments) |
| `list_messages` | folder, limit?, before_uid? (paging) | message summaries, newest first |
| `read_email` | folder, uid | headers, text body (HTML converted), attachment manifest (name, mime, size, partId) |
| `get_attachment` | folder, uid, partId | filename, mime, base64 bytes (size-capped) |
| `send_email` | to, cc?, bcc?, subject, body, in_reply_to? (uid to thread) | sent message id |
| `move_email` | folder, uid, target_folder | ok |
| `delete_email` | folder, uid, permanent? (default false → Trash) | ok |
| `mark_email` | folder, uid, seen?/flagged? | ok |

Standard aliases (read-only, so it degrades to standard connector mode + Deep
Research):

- `search` — text query across the mailbox → `{ results: [{id, title, url}] }`
  where `id` encodes `folder:uid`.
- `fetch` — `id` (folder:uid) → full document (`{id, title, text, url, metadata}`).

## Data flow (read example)

1. ChatGPT calls `search_email` over Streamable HTTP.
2. `search_email` tool validates args, calls `mailbox.search(...)`.
3. `mailbox` asks `imap` to run an IMAP `SEARCH` + fetch envelope/flags for hits.
4. `mailbox` trims to summary shape, returns to tool → JSON-RPC result → ChatGPT.

## Security & safety

- Mailbox creds only in Coolify env secrets; never in code, logs, or responses.
- Server responds **only** at `/<MCP_SECRET_PATH>/mcp`; any other path → 404.
  The secret is a long random string, effectively a bearer-in-URL for a
  single-user connector. TLS by Coolify/Traefik.
- Size caps: truncate text bodies (e.g. 100 KB) and cap `get_attachment` bytes
  (e.g. 5 MB) returned to the model; note truncation in output.
- HTML bodies converted to text before returning.
- Destructive tools (`delete_email`, `move_email`) rely on ChatGPT's built-in
  write-action confirmation; `delete_email` defaults to Trash, not permanent
  expunge.
- No logging of message contents or credentials; structured logs of tool name +
  outcome only.

### Error handling

- IMAP: connection timeout, auth failure, folder-not-found, uid-not-found →
  typed errors surfaced as clean MCP tool errors (no stack/creds leaked).
- Auto-reconnect on dropped IMAP connection with bounded retries.
- SMTP send failure → error with provider message (sanitized).

## Testing

- **Unit:** mock `imapflow` and `nodemailer`; assert each tool maps
  args→calls→trimmed output, incl. size caps and HTML→text.
- **Integration (env-gated):** one live smoke test against the real mailbox
  (list folders, search, read one message) behind `RUN_LIVE_TESTS=1`.
- **Local shakeout:** MCP Inspector against the running server before wiring
  ChatGPT.

## Deployment

- `apps/mail-mcp/Dockerfile` (node:20-alpine, multi-stage build → `dist/`).
- Coolify app (own project id), domain `mail-mcp.<domain>`, env secrets set in
  Coolify. Follows the Coolify v4 deploy mechanics captured in the prole-site
  memory (dockerfile_location relative to base_dir; token needs write+deploy;
  no webhook — trigger deploy via API/UI).

## Out of scope (YAGNI for v1)

- OAuth 2.1 (documented as the upgrade path).
- Folder create/rename/delete.
- Multi-account / multi-user.
- Calendar/contacts (OX has them; not asked for).
- Push/IDLE notifications.
