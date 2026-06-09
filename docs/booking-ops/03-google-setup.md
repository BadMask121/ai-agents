# 03 — Google setup

You create one Google Cloud OAuth app. You do **not** capture a refresh token here — each Gmail/
Calendar account is linked later from Telegram with `/connect` (see [04](04-telegram-setup.md)).

## Steps (~5 minutes)

1. **Create a project** at <https://console.cloud.google.com>.
2. **Enable APIs** (APIs & Services → Library): enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**:
   - User type: **External**.
   - **Publish to Production** (Publishing status → "Publish app"). This matters: apps left in
     "Testing" expire refresh tokens after ~7 days, which would disconnect your accounts weekly.
   - Add the Gmail addresses you'll connect as users if prompted.
   - You may see an "unverified app" warning when authorizing — fine for personal/owner use.
4. **Create credentials** → OAuth client ID → Application type **"Web application"**.
   Under **Authorized redirect URIs**, add your callback URL — the same value you'll set as
   `GOOGLE_REDIRECT_URI`, e.g. `https://booking.yourdomain.com/oauth/callback`. Save the
   **Client ID** and **Client secret**.

   > Why "Web application": Google's device flow (TV/limited-input) is **not allowed** to grant
   > Gmail/Calendar scopes, so linking uses the standard web redirect flow. The bot sends you a
   > consent link; after you authorize, Google redirects to `GOOGLE_REDIRECT_URI`, which the bot's
   > small callback server handles.

## Scopes requested

booking-ops requests exactly these (see `src/google/oauthClient.ts`):

| Scope | Why |
|---|---|
| `gmail.modify` | Read messages, send replies, add/remove labels, mark read — all in one scope. |
| `calendar.events` | Create the booking event. |
| `calendar.readonly` | Free/busy lookups for availability. |

## Environment variables

Set these wherever the worker runs (Coolify env, or a local `.env`):

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://booking.yourdomain.com/oauth/callback
```

There is **no** `GOOGLE_REFRESH_TOKEN` — tokens are captured per-account via `/connect` and stored in
the workspace at `google-accounts/<email>.json`. `GOOGLE_REDIRECT_URI` must exactly match a redirect
URI registered on the OAuth client (step 4).

## Optional: link from a terminal (loopback)

To link an account from a machine with a browser instead of via Telegram, use the loopback CLI. It
needs a separate **"Desktop app"** OAuth client (loopback redirect), then:

```bash
pnpm --filter @ai-agents/booking-ops build
pnpm --filter @ai-agents/booking-ops auth:local   # prints a URL; authorize in your browser
```

Tokens land in `google-accounts/<email>.json`; copy that dir into the server volume to use them in
the deployed bot.
