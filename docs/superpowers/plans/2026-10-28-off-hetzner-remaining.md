# Off Hetzner: remaining work (portfolio, mail-mcp, cleanup, shutdown)

**Date:** 2026-10-28 · **bd epic:** `ai-agents-pej` · **Status:** done 2026-10-28. Every host is a Cloudflare Worker, the Hetzner account is deleted and its Tailscale node removed (epic closed)

> **Progress (2026-10-28, later):**
> - **Portfolio** (Phase A): built, preview verified byte-identical to Hetzner, portfolio PR #24
>   (clone `/private/tmp/portfolio-new`, branch `feat/cloudflare`). Left: DNS cut-over (A5).
> - **mail-mcp** (Phase B): rewritten and live-verified on `mail-mcp.jeffreyefemena4.workers.dev`
>   with the real mailbox; ai-agents PR #1 (`mail-mcp-cloudflare` → `mail-mcp`, worktree
>   `/private/tmp/mail-mcp-mail`). Left: DNS cut-over, ChatGPT check, live `send_email`.
> - **Cleanup** (Phase C): `apps/prole-site` removed (ai-agents PR #2).
> - **DNS changes need the user's explicit go-ahead** (Claude Code's permission check blocks them
>   otherwise). Then Phase D.

The Hetzner account (server `95.217.185.93`, Coolify) is being deleted. Everything that matters must
run on Cloudflare (or be backed up) first. This plan is self-contained: a later session should be
able to execute it without re-discovering anything.

## Already done (2026-10-28)

| Item | Result |
| --- | --- |
| `jeffrey.build` DNS → Cloudflare (`ai-agents-pej.1`) | Zone on Cloudflare Free, NS `cora`/`johnny.ns.cloudflare.com`. Registrar is still Namecheap. Records are edited in the Cloudflare dashboard (wrangler can't). |
| Hetzner-only data backed up (`pej.2`) | `~/hetzner-backup-2026-10-28/`: career-ops `work/` (server-only `cv.md`, `applications.md`, `logs/`, story-bank edits), backups, scripts, crontab, old Prole DMGs, Coolify app list, container env files (`env/*.env`, chmod 600; `mail-mcp.env` has `PRIVATEEMAIL_USER`, `PRIVATEEMAIL_PASS`, `MCP_SECRET_PATH`). |
| Prole site + DMGs (`pej.3`) | Worker `prole-site` + R2 `prole-downloads` at `prole.jeffrey.build` (prole repo `site/`, PR #4). |

**Still pointing at Hetzner** (Cloudflare DNS, DNS-only A → `95.217.185.93`): `jeffrey.build`,
`www.jeffrey.build`, `mail-mcp.jeffrey.build`. MX (Namecheap email forwarding) + SPF TXT are kept
as-is (unused; harmless).

**Not migrated:** career-ops (user: not needed for now; data is in the backup).

## Constraints

- **Workers Free plan** (user decision): ~10 ms CPU per request. mail-mcp must keep per-request CPU
  small (see Phase B). Prole and the portfolio are trivially within it.
- **Own infrastructure per project:** each app gets its own Worker (and bucket, if any); nothing shared.
- **No Hetzner rollback after deletion.** Cut each hostname over, verify, and only then delete the
  account.
- **Secrets** never printed, logged or committed. Load them with `wrangler secret bulk` from a temp
  file built from `~/hetzner-backup-2026-10-28/env/mail-mcp.env`, then delete the temp file.
- **Verifying DNS on this Mac:** its resolver is Tailscale MagicDNS (`100.100.100.100`), which kept
  serving old Hetzner IPs after the Prole cut-over. Check with `dig @1.1.1.1` and
  `curl --resolve host:443:<cloudflare-ip>`, not the local resolver.
- **Worker custom domains** fail (`code 100117`) while a DNS record exists for the host: delete the A
  record in the dashboard first, then `wrangler deploy` (expect up to ~2 min until the certificate
  is served).

---

## Phase A — Portfolio (`jeffrey.build`, `www`) → Worker `jeffrey-build`  · bd `pej.4`

**Repo:** `github.com/BadMask121/portfolio`, branch `main` (deployed commit `8a8308c`). Work in a fresh
`gh repo clone`. **Do not use** `~/Desktop/WORK/Project.nosync/personal/portfolio`: it is an old Nuxt
checkout whose remote uses an SSH alias (`github.com-default`) that no longer resolves.

**Today:** dependency-free static site. `npm run build` (`scripts/build.mjs`) copies `site/` to `dist/`;
Nginx (`nginx.conf`) adds security headers, cache rules, `.mjs` as JavaScript, gzip, `/healthz`;
Traefik/Coolify redirect `www` → apex. `npm test` = 25 node:test tests (all passing).

### A1. Worker code — `src/worker.mjs` (new)

```js
// jeffrey.build on Cloudflare: serves the built site (dist/) with the security
// and cache headers the old Nginx config set, redirects www to the apex, and
// answers /healthz.

export const APEX = 'jeffrey.build'

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

/** Icons never change in place; everything else revalidates (styles and
 * scripts are versioned with ?v= instead). */
export function cacheControlFor(pathname) {
  return /\.(?:svg|ico)$/i.test(pathname)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate'
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX
      return Response.redirect(url.toString(), 301)
    }

    if (url.pathname === '/healthz') {
      return new Response('ok\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
      })
    }

    const asset = await env.ASSETS.fetch(request)
    const headers = new Headers(asset.headers)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
    headers.set('Cache-Control', cacheControlFor(url.pathname))
    // Module scripts must be served as JavaScript.
    if (url.pathname.endsWith('.mjs')) headers.set('Content-Type', 'application/javascript; charset=utf-8')
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers })
  },
}
```

Headers live in the Worker (not a `_headers` file) so they're unit-testable and there's no
header-merging ambiguity; the Worker must run first anyway for the `www` redirect.

### A2. `wrangler.jsonc` (new)

```jsonc
{
  "$schema": "https://unpkg.com/wrangler@4.154.0/config-schema.json",
  "name": "jeffrey-build",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-10-01",
  "build": { "command": "npm run build" },
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "run_worker_first": true
  },
  "routes": [
    { "pattern": "jeffrey.build", "custom_domain": true },
    { "pattern": "www.jeffrey.build", "custom_domain": true }
  ],
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true }
}
```

Keep the repo dependency-free: add `"deploy": "npm run build && npx --yes wrangler@4.154.0 deploy"` to
`package.json` scripts instead of a wrangler devDependency. Add `.wrangler/` to `.gitignore`.

### A3. Tests (`tests/deployment.test.mjs`, rewritten)

Replace the Dockerfile / nginx.conf / compose assertions with:

- `www.jeffrey.build/<path>?<q>` → `301` to `https://jeffrey.build/<path>?<q>`.
- `/healthz` → `200 ok`, `text/plain`, security headers.
- An asset response (fake `env.ASSETS`) gets every `SECURITY_HEADERS` entry; `.css`/`.mjs`/`.html` get
  `public, max-age=0, must-revalidate`; `.svg`/`.ico` get the immutable value; `.mjs` gets
  `application/javascript`; status passes through (404 stays 404).
- `wrangler.jsonc`: assets dir `./dist`, `run_worker_first: true`, both custom domains, build command.
- README documents `npm test`, `npm run build`, Cloudflare/wrangler deploy, `jeffrey.build`.
- Keep the existing `?v=2` asset-versioning test.

All 25 existing tests in the other files must still pass.

### A4. Remove / update

- Delete `Dockerfile`, `.dockerignore`, `nginx.conf`, `compose.production.yml`.
- README: replace "Container" and "Coolify deployment" with "Deploy (Cloudflare)": `npm test`,
  `npm run deploy`, the cut-over notes, and rollback (`npx wrangler rollback`).

### A5. Deploy and cut over

1. `npm test`; `npx wrangler deploy --dry-run`.
2. Preview: deploy from a temp config with `routes` removed and `workers_dev: true`; check `/`, a CSS,
   an `.mjs` (content type), `/og-image.svg` (immutable), `/healthz`, a 404, and that every header is set.
3. Cloudflare dashboard → `jeffrey.build` → DNS: delete the `@` and `www` A records, then immediately
   `npm run deploy`. Brief gap while the certificates are issued.
4. Verify via `--resolve jeffrey.build:443:<cf-ip>` and `--resolve www.jeffrey.build:443:<cf-ip>`:
   `server: cloudflare`, page 200 with headers, `www` → `301` apex, `/healthz` ok.
5. Commit on a branch, push, open a PR (user merges).

**Rollback (while Hetzner still exists):** remove both custom domains, re-add the A records
(`@`, `www` → `95.217.185.93`, DNS-only).

---

## Phase B — mail-mcp → Worker `mail-mcp`  · bd `pej.5`

**Code:** `ai-agents` branch `mail-mcp`, `apps/mail-mcp/`. Work in a git worktree, because the main
checkout is on another branch with the user's uncommitted changes. Design/background:
`docs/superpowers/specs/2026-07-18-mail-mcp-chatgpt-design.md`, `docs/mail-mcp/README.md`.

**Today:** Node/Express, `@modelcontextprotocol/sdk` Streamable HTTP with stateful sessions
(`mcp-session-id`), secret-path auth (`/<MCP_SECRET_PATH>/mcp`, everything else 404), `/` landing
page, `/health`. 11 tools (`list_folders`, `search_email`, `list_messages`, `read_email`,
`get_attachment`, `send_email`, `move_email`, `delete_email`, `mark_email`, `search`, `fetch`).
`imap.ts` (imapflow), `smtp.ts` (nodemailer, 587 STARTTLS), `mailbox.ts` (mailparser + html-to-text,
shaping), `tools/index.ts` (zod schemas + `guard`/`ok`), `config.ts`. Vitest tests.
GitHub Action `.github/workflows/deploy-mail-mcp.yml` deploys to Coolify.

**ChatGPT connector URL must not change:** `https://mail-mcp.jeffrey.build/<MCP_SECRET_PATH>/mcp`.

### Feasibility (proven 2026-10-28 on Cloudflare's network via `wrangler dev --remote`)

| Check | Result |
| --- | --- |
| `cloudflare:sockets` TLS to `mail.privateemail.com:993` | IMAP greeting received |
| `secureTransport: "starttls"` to `:587`, `EHLO`/`STARTTLS`/`startTls()` | Works; EHLO over TLS |
| `nodemailer` (nodejs_compat), fake account | `535 Authentication failed` → full SMTP path works **as-is** |
| `mailparser`, `html-to-text` | Work |
| `imapflow` | **Hangs** after the first untagged response (Node stream compat) → replace it |
| Bundle (nodemailer + mailparser + imapflow + html-to-text) | 878 KB gzip (free limit 3 MB) |

### B1. Workers-native IMAP client — `src/imap/` (replaces `imap.ts`'s imapflow use)

One connection per tool call: connect (TLS 993), `LOGIN`, run the commands, `LOGOUT`. About 1–1.5 s
of I/O, which doesn't count as CPU. Commands needed (from `imap.ts`):

| Operation | IMAP |
| --- | --- |
| `listFolders` | `LIST "" "*"` (special-use attributes like `\Trash`) |
| `status` | `STATUS <f> (MESSAGES UNSEEN)` |
| select | `EXAMINE <f>` for reads, `SELECT <f>` for writes; `EXISTS` from the response |
| `search` | `UID SEARCH` with FROM / TO / SUBJECT / TEXT / SINCE / BEFORE / UNSEEN / ALL (quote/literal-encode values) |
| summaries | `UID FETCH <set> (UID FLAGS ENVELOPE BODYSTRUCTURE)` / `FETCH <a:b> (...)` |
| text part / attachment | `UID FETCH <uid> (BODY.PEEK[<section>])` |
| `move` | `UID MOVE` (fallback `UID COPY` + `\Deleted` + `UID EXPUNGE`) |
| flags | `UID STORE <uid> +FLAGS/-FLAGS (\Seen \Flagged)` |
| permanent delete | `UID STORE +FLAGS (\Deleted)` + `UID EXPUNGE <uid>` |
| reply threading | `UID FETCH <uid> (ENVELOPE)` |

Parts:

- **`connection.ts`**: socket wrapper with a line/literal reader (`{n}\r\n` literals), tagged command
  runner (`A1`, `A2`…), `OK`/`NO`/`BAD` → typed errors, a per-command timeout (15 s), always `LOGOUT`/close.
- **`parser.ts`**: tokenizer for IMAP responses (atoms, numbers, quoted strings with escapes,
  literals, `NIL`, nested lists) → plain arrays. Mappers: `ENVELOPE` (RFC 2047 encoded-word decoding
  for subject/names), `BODYSTRUCTURE` → tree with section numbers (`1`, `1.2`, …), type, params,
  disposition, filename, encoding, size, `FLAGS`, `LIST`, `STATUS`, `SEARCH`.
- **Tests:** recorded Dovecot response transcripts (nested multipart BODYSTRUCTURE, literals,
  encoded subjects, NIL fields) plus a fake socket for the command flow, without network.

### B2. Light reads for the free plan — `mailbox.ts`

The current `read_email` / `get_attachment` download and fully parse the **whole** message (including
every attachment) on each call: the expensive path. Instead:

- **`read_email`:** `UID FETCH (ENVELOPE BODYSTRUCTURE)`, pick the best text part (prefer `text/plain`,
  else `text/html`), fetch only that section, decode its transfer encoding (base64 or
  quoted-printable) and charset (`TextDecoder`), cap to `maxBodyBytes` **before** any HTML→text, then
  convert HTML with `html-to-text` only on the capped string. Attachments list (filename, type, size)
  comes from BODYSTRUCTURE without downloading.
- **`get_attachment`:** fetch only that section. If its transfer encoding is base64, return it as-is
  (strip line breaks), with no decode/re-encode; otherwise base64-encode the bytes. Same
  `maxAttachmentBytes` cap, checked against the BODYSTRUCTURE size first.
- **Attachment `index`:** order of attachment parts in a depth-first BODYSTRUCTURE walk. Note in the
  tool description that indexes come from `read_email`.
- `mailparser` is no longer needed (drop it); keep `html-to-text`, `nodemailer`, `zod`.
- Summaries (`toSummary`), `encodeId`/`decodeId`, reply-subject logic: unchanged.

### B3. MCP on Workers — `src/worker.ts` (replaces `server.ts`, `index.ts`)

- Cloudflare `agents` SDK `McpAgent` (Durable Object, SQLite class, available on the free plan) with
  the existing `registerTools(server, mailbox)` unchanged. `Mailbox` is built per request from `env`
  secrets.
- Routing in `fetch`: `GET /` → landing page; `GET /health` → `{status:"ok"}`; requests under
  `/${env.MCP_SECRET_PATH}/mcp` → rewrite the path to `/mcp` and pass to `MailMcp.serve("/mcp")`;
  everything else → 404 (same secret-path behaviour as today).
- `config.ts`: read from `env` instead of `process.env`; drop `PORT`.
- `wrangler.jsonc`: `name: "mail-mcp"`, `main: "src/worker.ts"`, `compatibility_flags: ["nodejs_compat"]`,
  Durable Object binding + migration (`new_sqlite_classes: ["MailMcp"]`), custom domain
  `mail-mcp.jeffrey.build`, `workers_dev: false`, observability on.
- **Spike result (2026-10-28, `pej.5.1` closed) — use the stateless SDK, not `McpAgent`:**
  `@modelcontextprotocol/sdk@1.32.1`'s `WebStandardStreamableHTTPServerTransport`
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), with a new `McpServer` per request
  in a plain Worker, passed `initialize`, `notifications/initialized` (202), `tools/list` (zod →
  JSON Schema), `tools/call`, and validation errors. Deployed CPU: 13/33 ms on a cold isolate
  (completed on the free plan), 4–5 ms warm. `GET` must return `405` explicitly (otherwise it opens
  a stream that never closes). `agents@0.31` was rejected: it pins the SDK to exactly 1.32.1,
  requires zod 4, and has many peer dependencies. No Durable Object needed, so drop the DO binding
  and migration below. Bump `zod` to `^3.25`.
- **Started by an earlier agent** (worktree `/private/tmp/mail-mcp-mail`, branch
  `mail-mcp-cloudflare`, commit `ca5a684`): a 39-line `src/worker.ts` stub (health/404 only; its
  landing check compares the full URL to the secret, which never matches), `wrangler.jsonc` with
  `nodejs_compat`, Dockerfile removed. Replace the stub.

### B4. Secrets, tests, deploy, cut-over

1. Port the tests to the Worker setup (vitest, or `@cloudflare/vitest-pool-workers` for the Worker
   entry): config, mailbox shaping (with a fake IMAP client), smtp, tools; new IMAP parser/client tests.
   Typecheck.
2. Secrets: build a temp JSON from `~/hetzner-backup-2026-10-28/env/mail-mcp.env` (only
   `PRIVATEEMAIL_USER`, `PRIVATEEMAIL_PASS`, `MCP_SECRET_PATH`), `npx wrangler secret bulk <file>`,
   delete the file. Never echo values.
3. Preview deploy (temp config: no routes, `workers_dev: true`). Verify with the real mailbox:
   `initialize` + `tools/list` (11 tools), `list_folders`, `list_messages` (limit 3), `read_email` on
   one of them, a large-HTML email if available (watch CPU time in logs), and SMTP auth via a
   **non-sending** check (nodemailer `verify()`). Wrong secret path → 404. **Do not send email** unless
   the user asks.
4. Cut-over: dashboard → delete the `mail-mcp` A record → `wrangler deploy` (custom domain). Verify the
   same calls at `https://mail-mcp.jeffrey.build/<secret>/mcp` via `--resolve`.
5. Ask the user to run one real ChatGPT tool call through the existing connector.
6. Delete `.github/workflows/deploy-mail-mcp.yml` and `apps/mail-mcp/Dockerfile`; update
   `apps/mail-mcp/README.md`, `docs/mail-mcp/README.md` (deploy = `wrangler deploy`; secrets via
   `wrangler secret`). Commit on `mail-mcp`, PR.

**Risks:** free-plan CPU on unusually large HTML parts (mitigated by capping before conversion: if a
call still exceeds, return a clear "message too large to render" error rather than crash); IMAP edge
cases (servers sending literals in ENVELOPE, non-UTF-8 charsets, so test with transcripts);
`McpAgent` transport compatibility with ChatGPT (verify early, fallback above).

---

## Phase C — Cleanup  · bd `pej.3.6` (+ parts of `pej.5`)

- `ai-agents` branch `agentation-mac`: delete `apps/prole-site/` (replaced by `prole/site/`); commit via
  a worktree; PR or direct push per the user's preference.
- Remove the Coolify deploy workflow and Dockerfile for mail-mcp (Phase B6).
- Update memory notes (`project_prole_landing`, `project_mail_mcp`, `project_off_hetzner`) and
  `CLAUDE.md`'s "VPS access" section (Hetzner gone).

## Phase D — Readiness check, then shutdown  · bd `pej.6`

Run and record:

```sh
for h in jeffrey.build www.jeffrey.build prole.jeffrey.build mail-mcp.jeffrey.build; do
  for r in 1.1.1.1 8.8.8.8; do echo "$h @$r: $(dig +short @$r $h A | tr '\n' ' ')"; done
done   # none may be 95.217.185.93
for h in jeffrey.build prole.jeffrey.build; do curl -sI https://$h/ | grep -i '^server'; done   # cloudflare
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.jeffrey.build/   # 301 -> apex
curl -s https://mail-mcp.jeffrey.build/health                                           # {"status":"ok"}
```

- Cloudflare dashboard DNS: no record points at `95.217.185.93`.
- Backups present and readable in `~/hetzner-backup-2026-10-28/`.
- No release or deploy path left that uses SSH or Coolify (`prole/scripts/release.sh`, mail-mcp
  workflow).

Then **the user**:
1. Deletes the Hetzner server and account.
2. Removes the Hetzner node from Tailscale (admin console).
3. Optionally: revokes the Coolify API token and deletes the GitHub Actions secrets
   `COOLIFY_TOKEN`/`COOLIFY_APP_UUID` (ai-agents repo); drops the unused MX/SPF records.

## Order

A (portfolio, ~1 h) → B (mail-mcp: B3 spike first, then B1/B2, B4; the biggest piece) → C → D.
A and C are independent of B and can ship first.
