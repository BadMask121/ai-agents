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

## 1b. Moving tracks between playlists (MCP tool `move_tracks`)

The owner asked for this on 2026-10-28.

```
move_tracks {
  from_playlist: string, from_playlist_id?: string,
  to_playlist: string,   to_playlist_id?: string,
  track_ids?: string[1..500],   // or:
  all?: boolean,                // every track in from_playlist
  create_playlist?: boolean     // make to_playlist if it doesn't exist
}
```

- **Resolving the playlists.** Both are resolved like every playlist tool:
  unclear or duplicate names return suggestions or the ambiguity question,
  and `*_playlist_id` pins a choice. An unknown target is an error unless
  `create_playlist` is true; then it's created in the DJ Sync folder.
  Moving a playlist into itself is an error.
- **Which tracks.** Either `track_ids` or `all` (not both). `track_ids` must
  all be in the source playlist; any that aren't are listed, and nothing is
  queued.
- **The change.** One library job, so one rbdb transaction: everything moves
  or nothing does, with backups before and after as always. Its ops are an
  optional `ensure_playlist(to)`, then `add_to_playlist(to, id)` for each
  track in source order, then `remove_from_playlist(from, id)` for each.
  Every op carries the resolved `playlist_id`.
- **What the user sees.** The summary reads "Move N tracks from "A" to "B"".
  `destructiveHint` is false: the tracks stay in the library, and backups
  allow undo.
- **Copying** stays `add_tracks_to_playlist`; the tool descriptions say so.
- **Telegram** moves tracks through the assistant (§1c), which asks before
  moving a whole playlist.

## 1c. The Telegram assistant (Workers AI)

The owner tried the bot on 2026-10-28: "the telegram bot is not agentic, it
does not understand". "list the playlists in DJ sync folder" got the help
text, with its first line twice. They chose Cloudflare Workers AI, which is on
the same account and has a free daily allowance. Shipped in Worker 1.4.0.

- **What goes to the model.** Free text that isn't a command, and a link
  whose extra words aren't a clean playlist name (three or more words that
  don't name one playlist, e.g. "download this into a new playlist called
  Lagos Nights <link>"). A link alone, or with a name that resolves (or a
  short unclear one), keeps the buttons of §1.
- **Model.** `@cf/zai-org/glm-4.7-flash` with thinking off: the best
  function-calling quality per neuron among the generally available models
  with function calling (comparison in the dj-sync-cloud README). About 34
  neurons for a two-round message; the `AI_MODEL` var overrides it.
- **Tools.** The 11 MCP tools, run through the MCP dispatcher (same
  validation, resolution, suggestions and dedupe). At most 5 model rounds;
  tool output cut at 6,000 characters before it goes back.
- **System prompt.** What DJ Sync is; list, search or get before acting; use
  "Folder/Name" or `playlist_id` when a name is ambiguous; ask one short
  question when unclear; never invent track ids; plain text; today's date.
- **Replies.** Plain text, tidied (no Markdown, "•" lists), at most 4,096
  characters. "typing…" shows while it works. Jobs it queues get the usual
  finish message.
- **Memory.** The last 10 turns per chat for 24 hours (the DJ's words and the
  replies, plus the track and playlist ids the tools showed, not the tool
  output), so "now move the first two into Gqom" works. Forgotten on unpair.
- **Confirm first.** The model never runs `delete_playlist` or `move_tracks`
  with `all: true`. The bot stores the call (1 hour, single use) and asks
  "Delete the playlist “Folder/Name” (n tracks)? [Delete] [Cancel]"; only the
  tap runs it. A playlist that doesn't resolve isn't asked about: the tool's
  own "which one?" goes back to the model, and nothing is queued.
- **Limits.** 60 questions per chat per UTC day ("That's today's limit …";
  commands and links still work), on top of §1's 60 messages an hour.
- **Failures.** Any Workers AI error (3036 when the account's 10,000 free
  neurons a day are used up, 3040 when busy) or unusable output answers "I
  can't think right now — commands and links still work: /playlists, …".
  Errors are logged, never shown. Failed turns aren't remembered.
- **Without the binding** the bot stays rule-based, and plain words get the
  help text once.

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

## 2b. One-scan iPhone install

The owner asked for this on 2026-10-28: "the iPhone process is too long; we
need a one-click solution". **The DJ scans a QR code and taps Add Shortcut.**

**The Mac builds and signs a personal Shortcut.** This is done by the
dj-sync service (Rust), via `POST /local/links/{id}/install` on a `shortcut`
link:
1. **Build** an unsigned Shortcut plist (the `plist` crate) with the API base
   URL and the `Bearer <tenant_id>.<secret>` key baked in.
2. **Sign** it with `/usr/bin/shortcuts sign --mode anyone`. This needs the
   DJ's Mac signed into iCloud and takes about 4 s. The file is signed by the
   DJ's own Apple ID, not DJ Sync's.
3. **Upload** it to the cloud and return `{install_url, expires_at}`.

If signing fails (no iCloud, say), the reply is 409
`{error:"shortcut_signing_failed", message}`, and the app falls back to
showing the URL and key with the manual guide.

**The Shortcut "DJ Sync":**
- **Input:** Share sheet, URLs and text (`WFWorkflowTypes:["ActionExtension"]`).
- **Steps:**
  1. Get Contents of URL: GET `<base>/api/playlists` with the Authorization header.
  2. Get Dictionary Value `names`.
  3. Choose from List: "Add to which playlist?"
  4. Get Contents of URL: POST `<base>/api/downloads`, JSON
     `{text: <Shortcut Input>, playlist_name: <Chosen Item>}`.
  5. Get Dictionary Value `message`.
  6. Show Notification (title "DJ Sync", body = the message).

**Cloud (dj-sync-cloud):**
- **`PUT /v2/agent/links/{id}/install`** (agent auth; body = the signed
  `.shortcut` bytes, at most 256 KB; shortcut links only) returns
  `{install_url: "https://djsync.jeffrey.build/i/<tenant_id>/<code>", expires_at}`.
  - The code is 16 random bytes, base64url.
  - It expires after 10 minutes and allows at most 5 downloads.
  - A new upload replaces the old one.
- **`GET /i/<tenant>/<code>`** is a small iPhone-friendly page: "Add DJ Sync
  to your iPhone", one big "Add Shortcut" button, and a line on what happens
  next. It sets `noindex` and `no-store`. An expired or used-up code shows a
  friendly "This link expired — make a new QR in DJ Sync on your Mac".
- **`GET /i/<tenant>/<code>/DJ%20Sync.shortcut`** serves the bytes
  (`application/octet-stream`, `attachment; filename="DJ Sync.shortcut"`,
  `no-store`) and counts the download.
- **dj-sync-site** forwards `/i/*`.
- **`GET /api/playlists`** also returns `names`: the default playlist's name
  first, then every playlist's `path` (the DJ Sync folder first, then A–Z).
- **`POST /api/downloads`** also accepts `text`. The links are pulled out of
  free text, so what the Share sheet sends works as is. Every reply carries a
  human `message` ("Sent 1 link to “Gqom” — it'll be in Rekordbox in a few
  minutes." or the error in plain words).

**Mac app.** Connect iPhone shows a QR code of `install_url`, with an expiry
hint and **New QR**. "Show key and URL" stays under a disclosure for the manual
path.

**Website.** `/connect/iphone/` becomes:
1. Scan the QR in DJ Sync → Assistants → Connect iPhone.
2. Tap Add Shortcut.
3. In Spotify or YouTube, Share → DJ Sync.

The manual build moves under "Advanced".

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
