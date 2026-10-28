# DJ Sync: connect from anywhere (Telegram, Claude, iPhone): design addendum

**Date:** 2026-10-28.

**Extends:** [the distribution spec](2026-10-28-dj-sync-public-distribution-design.md),
§3.2 (links) and §7 (the reserved Telegram shape). bd epic `ai-agents-jff.7`.

**Why:** a custom MCP connector in ChatGPT needs a **paid** ChatGPT plan. DJs
also need free ways in. In order of reach:

| Channel | Cost to the DJ | How |
|---|---|---|
| **Telegram** | Free, any phone | One shared DJ Sync bot. The Mac app pairs a chat by QR code |
| **Claude** | Free plan allows one custom connector | The existing MCP link (kind `claude`) |
| **iPhone Shortcut** | Free, no account | The existing REST API (link kind `shortcut`) plus `GET /api/playlists` |
| ChatGPT | Paid plan (Plus, Pro, Business, Enterprise or Edu) | The existing MCP link (kind `chatgpt`); refresh the connector after DJ Sync updates |

## 1. Telegram bot

**One bot for every DJ.**
- **Webhook:** `POST https://djsync.jeffrey.build/telegram/webhook`.
  dj-sync-site forwards `/telegram/*` to dj-sync-cloud.
- **Secrets:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`. Every
  update must carry `X-Telegram-Bot-Api-Secret-Token`, otherwise it gets 401.
- **Var:** `TELEGRAM_BOT_USERNAME` (without the @).

**Setup.** `POST /v2/admin/telegram/setup` (Bearer `ADMIN_TOKEN`) calls:
- `setWebhook` (with `secret_token`, `allowed_updates: ["message","callback_query"]`, `drop_pending_updates`)
- `setMyCommands` (/playlists, /search, /status, /help, /stop)
- `setMyDescription` and `setMyShortDescription`

It returns the `getMe` result. Without the bot secrets, `/telegram/*` returns
404 and creating a `telegram` link returns 503 `telegram_not_configured`.

### Pairing

1. **The Mac creates the link.** The Mac app sends
   `POST /v2/agent/links {kind:"telegram"}`. The Tenant creates a link row
   (kind `telegram`, label "Telegram") and a one-time **pairing code**
   (16 random bytes, base64url, 22 characters).
   - **Where the code lives:** in the Registry as
     `pairing_codes(code PK, tenant_id, link_id, expires_at)`, valid for
     10 minutes.
   - **What the Mac gets back:** `{id, kind, label, created_at, last_used_at: null, url: "https://t.me/<bot>?start=<code>", expires_at, paired: false}`.
   - **Rotate** issues a new code and unbinds any chat. **Delete** unbinds the
     chat and tells it "Disconnected".
2. **The DJ opens `t.me/<bot>?start=<code>`** (QR code or button), and
   Telegram sends `/start <code>`.
3. **The Worker consumes the code** in the Registry (single use; expired codes
   are refused) and upserts `telegram_chats(chat_id PK, tenant_id, link_id)`.
   One chat belongs to one DJ, and the latest pairing wins.
4. **The Tenant binds the chat to the link.** It stores
   `telegram_chats(link_id PK, chat_id, username, first_name)`, sets
   `last_used_at`, and replies with a welcome message.
5. **The Mac sees it paired.** `GET /v2/agent/links` returns `paired: true`,
   `telegram_username` and a label like "Telegram (@user)" for that link. The
   Mac app polls this for its live check, as it does for MCP links.

**Other messages.** The Worker routes each one by `chat_id` through the
Registry, then the Tenant's `/__/telegram`. An unknown chat gets "This chat
isn't connected. In DJ Sync on your Mac: Assistants → Connect Telegram."

### What the bot does (Tenant)

**Links in a message** (Spotify or YouTube, validated like MCP):
- **Playlist hint.** The text left over after removing the links and filler
  words ("add", "to", "into", "in", "the", "playlist", "please") is the
  playlist hint.
- **A clear hint** (it `resolvePlaylist`s to one playlist): the download is
  queued into that playlist (`playlist_id` pinned).
- **No hint, or an unclear one:** the bot replies with **buttons**:
  - the closest matches (or, with no hint, up to 6 playlists, DJ Sync folder
    first);
  - **"Default (ChatGPT Downloads)"**;
  - with an unclear hint, **"New playlist: <hint>"**.
- **Waiting downloads** are kept in `tg_pending(id, chat_id, urls, hint, created_at)`
  for 24 hours. `callback_data` is `d:<pending id>:<playlist id | def | new>`,
  at most 64 bytes.
- **On queueing,** the bot edits its message to "Queued: N link(s) → <playlist>.
  I'll tell you when it's in Rekordbox." and records
  `tg_jobs(job_id PK, chat_id)`.

**Commands:**
- `/playlists [words]`: up to 40 playlists with track counts (filtered when
  words are given).
- `/search <words>`: the top 10 tracks.
- `/status`: the last 5 jobs.
- `/help`.
- `/stop`: unpairs this chat, as if the link were deleted.

**Any other text:** a short help message.

**When a job finishes:** if the job is in `tg_jobs`, the bot sends
"✅ <message>" or "⚠️ <message>" to that chat.

**Rules:**
- **Rate limit:** 60 messages per hour per chat. Over it, the bot replies once
  and then ignores messages until the hour is up.
- **Reply size:** 4,096 characters at most; longer lists are trimmed with
  "…and N more".
- **Mac offline:** replies include the same offline note as MCP.
- **Errors never leak.** A failure answers "Something went wrong; try again in
  a minute."

**Privacy:** the Registry stores `chat_id → tenant`. The DJ's Tenant stores the
chat id, the Telegram username and first name, and pending and job rows. The
privacy page says so.

## 2. iPhone Shortcut (REST)

- **`POST /v2/agent/links {kind:"shortcut"}`** already returns
  `{api_url, token}` (`Authorization: Bearer <tenant_id>.<secret>`).
- **New: `GET /api/playlists`** (same bearer) returns
  `{playlists: [{playlist_id, name, folder, path, tracks}]}`, with the DJ Sync
  folder first and then A–Z. It's used by the Shortcut's "Choose from List"
  step.
- **`POST /api/downloads`** gains an optional `playlist_id`. A pinned id wins;
  a `playlist_name` is resolved like MCP, and an unclear name falls back to
  that name as given. This keeps today's behaviour: the Shortcut is a direct
  action, not a conversation.
- **The guide** (`/connect/iphone/`) builds a 5-action Shortcut:
  1. Receive URLs from the Share Sheet.
  2. Get Contents of `…/api/playlists` with the header.
  3. Choose from the list of playlist names.
  4. POST `…/api/downloads` with `{urls, playlist_id}`.
  5. Show a notification.

## 3. Claude

- **Origin check.** `originAllowed` also accepts `claude.ai`, `*.claude.ai`
  and `*.anthropic.com`. Claude's connector usually calls server-to-server,
  without an Origin, but this covers the browser case.
- **The guide** (`/connect/claude/`):
  - The free plan allows **one** custom connector.
  - Add it under Settings → Connectors → Add custom connector, using the link
    from DJ Sync → Assistants → Connect Claude → Copy.
  - Turn it on in a chat from the tools menu.

## 4. Mac app

**Assistants** gains **Connect Telegram** and **Connect iPhone** next to
ChatGPT and Claude. The Rust `/local/links` route accepts kind `telegram`.

- **Telegram:**
  - Shows a QR code of the `t.me` deep link (CoreImage) and an **Open
    Telegram** button.
  - Polls until `paired`, then shows "Telegram (@user)". A pairing code that
    has expired can be renewed with **New code** (rotate).
- **iPhone:** shows the API URL and key with Copy buttons, plus **Setup
  guide**, which opens `/connect/iphone/`.
- **Version:** 1.1.0, released with `release.sh`.

## 5. Website guides

- **`/connect/chatgpt/`:** starts with "Needs a paid ChatGPT plan (Plus, Pro,
  Business, Enterprise or Edu) to add custom connectors (MCP)", followed by
  the steps and a "Refresh after DJ Sync updates" section.
- **`/connect/claude/`:** free with one connector.
- **New pages:** `/connect/telegram/` and `/connect/iphone/`.
- **Home "Works with":** Telegram (free), Claude (free), iPhone Shortcut
  (free) and ChatGPT (paid plan).
- **Also updated:** the FAQ ("Which way should I connect?"), the privacy page
  (Telegram data) and the sitemap.

## 6. Owner steps

1. **Create the bot.** In Telegram, open @BotFather and send `/newbot`. Name it
   "DJ Sync", give it a username ending in `bot`, and copy the token.
2. **Store the token.** Run
   `npx wrangler secret put TELEGRAM_BOT_TOKEN --name dj-sync-cloud` in a
   terminal and paste it; the owner keeps it to themselves. Then tell Claude
   the bot's username.
3. **Claude finishes the setup:** sets `TELEGRAM_WEBHOOK_SECRET` and
   `ADMIN_TOKEN` (generated), the username var, deploys, calls the setup
   route, and runs the end-to-end test.
