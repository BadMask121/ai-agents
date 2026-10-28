# 07 — Deployment

**Nothing here is wired yet.** The Dockerfile is bd `ai-agents-z3w.10`; Coolify is not to
be touched unless asked.

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Or an `ant auth login` profile on the host |
| `DEEPGRAM_API_KEY` | ✅ | — | Billed per minute of audio |
| `AUTH_SECRET` | ✅ in prod | — | JWT signing key, **≥32 chars**. Boot fails if shorter. |
| `AUTH_PASSWORD_HASH` | ✅ in prod | — | bcrypt hash. **If unset, the server serves open** with a loud warning — localhost only. |
| `TODO_AI_DATA_DIR` | — | `./data` | Directory holding `todos.json` |
| `PORT` | — | `8080` | |

`config.ts` reads these once at boot, validates, and exports a frozen object — same shape
as `apps/mail-mcp/src/config.ts`. **Fail loudly at startup**, not on the first request: a
missing Deepgram key should stop the process with a clear message, not surface as a 502
the first time someone taps the mic.

Generate a password hash:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'your-password'
```

Document all six in `.env.example`. Commit none of them.

## Dockerfile

Copy `apps/mail-mcp/Dockerfile` — it's already the right shape. Self-contained build
context (the app directory, not the repo root), `npm install` rather than a pnpm workspace
install, two stages, `USER node`, `node:22-alpine`.

Three changes:

```dockerfile
COPY public ./public                           # the client is not built, just copied

RUN mkdir -p /data && chown node:node /data     # before USER node
ENV TODO_AI_DATA_DIR=/data
```

Alpine is fine here — and that's downstream of the JSON-store decision. There's no native
module, so there's no musl prebuild to go missing. (This is exactly what `better-sqlite3`
would have cost: a glibc base or `python3 make g++` in the image.)

Note the split between the two Dockerfile styles in this repo: `career-ops-ui` builds from
the **monorepo root** because it needs workspace deps; `mail-mcp` builds from its **own
directory** because it has none. todo-ai has none — use the mail-mcp style.

## Persistence

`todos.json` must live on a **bind mount or volume**, not inside the container layer.
Without that, every redeploy silently resets the todo list. `TODO_AI_DATA_DIR=/data` plus
a host mount at `/data` is the whole story.

Backup is `cp todos.json todos.json.bak`. It's a single-user JSON file; anything more
elaborate is theatre. Do take a copy before running any schema migration.

## TLS is mandatory

Not a nice-to-have:

**`getUserMedia` is unavailable outside a secure context.** Over plain HTTP to an IP or
domain, `navigator.mediaDevices` is `undefined` and the microphone never starts — the
app's headline feature is silently dead. `http://localhost` is exempt, which is why this
never shows up in development.

Session cookies also want `secure` in production, which plain HTTP forecloses.

So a deployment needs a real domain with a certificate — the same gap already tracked for
`career-ops-ui` in bd **`ai-agents-0xv`**, where `ALLOW_INSECURE_COOKIES` exists as a
stopgap on a Coolify sslip.io URL. Do **not** replicate that flag here: for career-ops-ui
it degrades cookie security, but for todo-ai it wouldn't help at all, because no flag can
make a browser hand out the microphone over plain HTTP.

## If Coolify is wired later

Only when asked. Prior art, and the gotchas already paid for:

- `apps/mail-mcp` deploys via `.github/workflows/deploy-mail-mcp.yml` — this Coolify
  instance has no GitHub App/webhook, so deploys are triggered through the Coolify API
  with `COOLIFY_TOKEN` + `COOLIFY_APP_UUID` in repo Actions secrets. Never in the tree.
- `dockerfile_location` is relative to `base_dir` — see bd `ai-agents-1te`, which is
  exactly this getting it wrong for career-ops-ui.
- The Coolify token needs **write + deploy** scope.
- Outbound HTTPS to `api.anthropic.com` and `api.deepgram.com` must be reachable. Worth
  checking early: this host is known to block some outbound ports — `mail-mcp` had to move
  SMTP to 587/STARTTLS because Hetzner blocks 465/25. 443 is fine, but don't assume.

## Health

`GET /healthz` is unauthenticated and returns `200 {"ok":true}` once the store has loaded.
It deliberately does **not** ping Anthropic or Deepgram — a health check that fails when a
third party has a bad minute causes restart loops that fix nothing.
