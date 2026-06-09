# 08 — Deployment

booking-ops is a **resident worker** deployed on the same Hetzner VPS / Coolify as `career-ops-ui`.
Telegram still long-polls (outbound), but the worker also serves **one small public endpoint** —
`/oauth/callback` (+ `/healthz`) on `OAUTH_PORT` (default 8080) — so Google can redirect back after
you authorize an account from your phone. That endpoint needs a **domain + TLS** (Coolify/Traefik
provides both).

## Dockerfile

`apps/booking-ops/Dockerfile` is a slim multi-stage build (`node:20-bookworm-slim`, `tini`,
`USER node`) — no Chrome/Playwright, no pandoc, no claude CLI (drafting is HTTPS via the Anthropic
SDK). Build context is the **monorepo root** (it needs `pnpm-lock.yaml`, `turbo.json`, and
`apps/shared`):

```bash
docker build -f apps/booking-ops/Dockerfile -t booking-ops .
```

`CMD` is `node dist/index.js` under `tini`; it handles `SIGTERM` for graceful shutdown.

## Coolify service (one-time)

1. New resource → **Application** → repo `BadMask121/ai-agents`, branch `main`.
2. Build pack **Dockerfile**; Dockerfile path `apps/booking-ops/Dockerfile`;
   **Build context / base directory = `.`** (monorepo root — same gotcha as career-ops-ui).
3. **Port + domain**: expose container port **8080** and attach a domain/subdomain
   (e.g. `booking.yourdomain.com`) with **Generate SSL Certificate** / **Force HTTPS** on. Point that
   subdomain's DNS A record at the VPS. Traefik terminates TLS and routes to `:8080`. This serves only
   `/oauth/callback` + `/healthz`.
4. **Persistent storage**: mount a volume at **`/workspace/booking-ops`** (Coolify named volume, or a
   host bind-mount like `/home/career/work/booking-ops` for easy inspection/backup). This holds
   `context.md`, `config/packages.yml`, `google-accounts/`, `clients/`, `processed-messages.tsv`, `logs/`.
5. **Environment variables** (mark secrets as Secret; values with `$` as "Is Literal"):

   ```
   ANTHROPIC_API_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://booking.yourdomain.com/oauth/callback   # must match the OAuth client + the domain above
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   LOOPS_API_KEY=...
   BOOKING_OPS_WORKSPACE=/workspace/booking-ops
   BOOKING_TIMEZONE=Europe/London
   OAUTH_PORT=8080               # optional (default 8080)
   GMAIL_POLL_SECONDS=90         # optional
   BOOKING_MODEL=claude-haiku-4-5-20251001   # optional
   ```

   (No `GOOGLE_REFRESH_TOKEN` — accounts are linked via `/connect` and stored in the volume.)
6. Deploy. On boot it starts the OAuth server (`oauth server listening on :8080`), calls
   `deleteWebhook` once (avoids a Telegram 409), then starts both loops. Watch logs for
   `telegram loop started`.

## After first deploy

- DM the bot `/connect` for each Gmail account; `/setcalendar <email>` to pick the booking calendar.
- Put `config/packages.yml` and (optionally) `context.md` into the volume — see [06](06-chatgpt-context.md).

## Ops invariants

- **One poller per bot token.** Never scale replicas > 1 — two pollers double-send and Telegram
  returns 409. Coolify's stop-then-start on redeploy is fine; startup `deleteWebhook` + offset
  tracking cover the overlap.
- **Logs**: Coolify log viewer (stdout) + `logs/` in the volume.

## Alternative: systemd service (no Coolify)

Run it like the existing `career-scan` units but as a **long-running service** (not a timer):

```ini
# /etc/systemd/system/booking-ops.service
[Service]
User=career
WorkingDirectory=/home/career/work/booking-ops/apps/booking-ops
EnvironmentFile=/home/career/work/booking-ops/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now booking-ops`. Coolify is the recommended path for consistency with
career-ops-ui.
