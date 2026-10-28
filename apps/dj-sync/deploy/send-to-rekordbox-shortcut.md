# iOS Shortcut: "Send to Rekordbox"

A Share Sheet shortcut that sends the current Spotify or YouTube link straight
to dj-sync, without going through ChatGPT. It uses the bearer-authenticated REST
route, so `SHORTCUT_API_KEY` must be set in `~/.dj-sync/.env` (see
[`docs/dj-sync/41-chatgpt-mcp-setup.md`](../../../docs/dj-sync/41-chatgpt-mcp-setup.md)).

## Build it (Shortcuts app on iPhone, ~2 minutes)

1. **New Shortcut** → name it **Send to Rekordbox**.
2. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Under
   *Share Sheet Types*, leave only **URLs** and **Text** selected.
3. Add the action **Receive** *URLs and Text* **input from** *Share Sheet*.
   Set *If there's no input* to **Ask For** → *Text* (so you can also paste a link).
4. Add **Get Contents of URL**:
   - URL: `https://mcp.triplejmusic.art/api/downloads`
   - Method: **POST**
   - Headers:
     - `Authorization` → `Bearer <your SHORTCUT_API_KEY>`
     - `Content-Type` → `application/json`
   - Request Body: **JSON**, with fields:
     - `url` (Text) → the **Shortcut Input** variable
     - `playlist_name` (Text) → `Phone` (optional; omit to use the default playlist)
5. Add **Get Dictionary Value** → get **Value** for key `message` in
   *Contents of URL*.
6. Add **Show Notification** → *Dictionary Value*.

## Use it

In Spotify: **Share → More… → Send to Rekordbox** (or long-press a track →
Share). In YouTube: **Share → Send to Rekordbox**. You'll get a notification
like *"Queued."* with a job id. The files land in `~/Music/DJ_Downloads`, and the
tracks show up in Rekordbox's **rekordbox xml** tree after a reload.

## Request / response reference

```http
POST /api/downloads
Authorization: Bearer <SHORTCUT_API_KEY>
Content-Type: application/json

{"url": "https://open.spotify.com/track/…", "playlist_name": "Phone"}
```

- `url` may be share-sheet text such as `"Song by Artist https://…"`. The link is
  pulled out of it.
- `urls: [...]` works too, up to `download.max_urls_per_job`.
- **202** returns the job: `job_id`, `state`, `playlist`, `urls`, `message`,
  `position`, `rejected`.
- **400** means there were no supported links, or the body is invalid.
- **401** means the bearer token is wrong. **404** means `SHORTCUT_API_KEY` isn't set on the server.

`GET /api/downloads/{job_id}` (same bearer) returns the job's current state. A
second shortcut could poll it, but the notification is usually enough.
