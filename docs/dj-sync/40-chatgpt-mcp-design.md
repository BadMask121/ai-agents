# 40 — ChatGPT MCP download lane (design)

**Status:** built 2026-10-28 (bd epic `ai-agents-jff.2`). Code is in `apps/dj-sync`
(`http.rs`, `mcp.rs`, `jobs.rs`, `downloader.rs`, `import_xml.rs`). Setup is in
[41-chatgpt-mcp-setup.md](41-chatgpt-mcp-setup.md).

> **Update (2026-10-28):** ChatGPT now reaches an always-on Cloudflare Worker
> queue instead of the Mac directly, and the Mac polls it. See
> [42-cloud-queue.md](42-cloud-queue.md). The tools and job lifecycle below are
> unchanged. The tunnel is only a rollback path.

## Goal

From the ChatGPT app on my phone: paste a Spotify or YouTube link, say
"put this in Rekordbox". A few minutes later:

- the audio is in `~/Music/DJ_Downloads` on the DJ laptop;
- it's listed in a named playlist in the import XML (whatever Rekordbox's
  *Imported Library* points at, or `~/Music/rekordbox_import.xml`);
- that file is the one Rekordbox's **rekordbox xml** tree already reads, ready
  to drag into the collection.

## ⚠️ This reverses an earlier decision

[README.md](README.md) originally listed *"Spotify audio extraction (forbidden,
not negotiable)"* as out of scope. [03-stack-decisions.md](03-stack-decisions.md)
also turned down tunnels and inbound webhooks. This lane deliberately does both:

- **It downloads audio.** spotdl reads track metadata from Spotify and downloads
  the matching audio **from YouTube**. Nothing is ripped from Spotify's own
  stream. YouTube links go to yt-dlp. Both go against Spotify's and YouTube's
  terms of service. This is a **personal-use** tool for one DJ's own prep.
  Don't share the endpoint, and buy the tracks you actually play out.
  *Amended 2026-10-28:* DJ Sync is now distributed publicly, with downloads
  on by default.
  - Each DJ runs the tools on their own Mac, fetched from the tools' official
    sources.
  - The cloud never carries audio.
  - The Terms make each DJ responsible for their rights to the music.

  See the [distribution spec](../superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md).
- **It adds an inbound HTTPS endpoint.** ChatGPT can only call remote MCP
  servers over HTTPS, so a Cloudflare Tunnel exposes `127.0.0.1:8000` as
  `https://mcp.triplejmusic.art`.

The Telegram bot, the matcher, the ISRC-first "match what you own" flow and the
read-only Rekordbox browser are unchanged. The download lane is opt-in
(`[mcp] enabled = true`).

## Decisions

| Decision | Why |
|---|---|
| Extend `dj-sync` rather than start a new crate | It's the same domain (Rekordbox XML, Location paths, tag reading via lofty), and it's one binary for launchd. Each lane is optional, so you can run the bot only, MCP only, or both. |
| MCP only for ChatGPT; no Custom GPT / OpenAPI | Custom GPTs stop running 2026-12-11 and their Actions don't migrate. MCP is what ChatGPT plugins use. |
| Hand-rolled JSON-RPC, not the `rmcp` SDK | It's two tools with no sessions or streaming, about 300 lines, with no SDK churn. It was checked against the official MCP Inspector CLI. |
| `initialize`-based protocol (2025-03-26 … 2025-11-25) | This is what current clients use. 2026-07-28 clients probe with a version header first, and a bare `400` makes them fall back to `initialize`, per that spec's backward-compatibility rules. |
| Secret URL path as the credential | Same model as `mail-mcp`. The ChatGPT connector uses "No authentication", and a long random path behind TLS acts as a bearer token. OAuth would be the upgrade if this were ever shared. |
| Async jobs (`download_to_rekordbox` returns a `job_id`) | Downloads take minutes. Cloudflare cuts requests at about 125 s, and chat tool calls are shorter still. `get_download_status` reports progress. |
| One worker, one queue | spotdl and yt-dlp never run at the same time, which avoids rate limits. Only one task writes the XML, so there's no file locking. The bound port stops a second instance. |
| spotdl for Spotify, yt-dlp for YouTube | spotdl treats a plain YouTube URL as a *search string*. yt-dlp is the right tool for YouTube. |
| lofty, not `id3` | Rekordbox wants `TotalTime`, `BitRate` and `SampleRate`. lofty reads those (and handles m4a/flac/wav), and the crate already used it. |
| Own Location encoder | Rekordbox escapes only space, `" % & ' [ ]` and non-ASCII (lowercase hex), and leaves `# ? ( ) , + ! $ ; @` raw. Generic URL libraries disagree. The old parser cut paths off at `?` and `#`. All 10,781 Locations of a real 7.2.11 export round-trip byte for byte (`tests/location_roundtrip.rs`). |
| Write to Rekordbox's own *Imported Library* path | dj-sync reads `bridgeImportedLibraryFile` from Rekordbox's settings, so Rekordbox needs no setup. Whatever is already there is kept as snapshot `v1.0.0` before the first write. It never adopts the bot's collection export, and falls back to `~/Music/rekordbox_import.xml`. A rewrite keeps every track and playlist but drops attributes we don't model. Since 0.6.0 the same tracks also go into Rekordbox's own library (master.db), with backups; see [doc 43](43-rekordbox-library.md). |
| Optional iOS Shortcut + bearer REST | This is a fallback in case custom MCP plugins don't work in the ChatGPT mobile app, and it's quicker when no chat is needed. |

## Components

```
ChatGPT (web / iOS)            iOS Share Sheet Shortcut
        │ MCP JSON-RPC                 │ POST /api/downloads (Bearer)
        ▼                              ▼
  https://mcp.triplejmusic.art  ── Cloudflare Tunnel ──▶ 127.0.0.1:8000
                                                           │
                                         http.rs (axum)    │  /health, /<secret>/mcp, /api/*
                                           │
                                         mcp.rs            │  initialize, tools/list, tools/call
                                           │
                                         jobs.rs           │  queue → single worker
                                           ├── downloader.rs  spotdl / yt-dlp → .staging/<job>/<n>/
                                           ├── library::read_meta (lofty)
                                           └── import_xml.rs  upsert tracks + playlist, atomic save
                                                           │
                         ~/Music/DJ_Downloads/*.mp3        <Rekordbox Imported Library>.xml
                                                           │
                                       Rekordbox 7 → rekordbox xml tree → drag into collection
```

## Tools

| Tool | Input | Result |
|---|---|---|
| `download_to_rekordbox` | `urls: string[1..25]`, `playlist_name?: string ≤ 100` | Returns immediately: `{job_id, state, playlist, urls, position, deduplicated, rejected}`. Unsupported links are skipped and listed in `rejected`. If none are usable, it returns `isError`. If an identical request is still queued or running, it returns the existing job, because ChatGPT retries calls. |
| `get_download_status` | `job_id?` | That job (`state`: queued / running / done / failed, `tracks`, `errors`, `message`), or the last 5 jobs. Errors are summarised to the downloader's last `ERROR:` line. It also reports playlist (library) jobs. |
| `list_playlists`, `search_tracks`, `get_playlist`, `create_playlist`, `add_tracks_to_playlist`, `remove_tracks_from_playlist`, `rename_playlist`, `delete_playlist` | see [doc 43](43-rekordbox-library.md#playlist-tools-chatgpt) | Served by the cloud Worker (0.2.0+) from a snapshot of the Rekordbox library. Writes are queued for the Mac. |

Accepted links are rebuilt in a canonical form (`parser::extract_media_ref`):

- Spotify `track` / `album` / `playlist` → `https://open.spotify.com/<kind>/<id>`.
- YouTube video → `https://www.youtube.com/watch?v=<11-char id>`. This drops
  `&list=RD…` "Mix" playlists, which never end. YouTube `/playlist?list=PL…`
  links are also accepted.
- Everything else is rejected: `http`, other hosts, artist pages, channels,
  and anything that could pass as a command-line flag.

## Job lifecycle

1. `submit` validates the playlist name (control characters removed, at most
   100 characters), then queues the job.
2. The worker creates `DJ_Downloads/.staging/<job>/<n>/` for each link. Staging
   sits on the same disk, so the final move is a rename.
3. It runs the downloader:
   - Arguments go in as an argv list, never through a shell.
   - It sets `kill_on_drop`, a timeout (`job_timeout_secs`), an explicit
     `PATH`, and keeps the last 40 lines of output.
   - A failure on one link is recorded and the job carries on.
4. Each staged audio file is moved into `DJ_Downloads`. If a file with the same
   name and size is already there, that one is reused. Otherwise the file gets
   a ` (n)` suffix.
5. lofty reads the tags. The XML is loaded, then:
   - each track is upserted by its *decoded* Location (so an existing file keeps
     its TrackID);
   - the playlist is upserted under ROOT (only missing IDs are appended);
   - the file is saved atomically (`.tmp` → rename) and snapshotted as the
     next semver version (see *Versioned snapshots*). A job that adds nothing
     new doesn't write and doesn't create a version.
6. The staging directory is removed.
7. The job ends `done` if at least one track landed, otherwise `failed`. A job
   where everything failed leaves the XML untouched.

Jobs are kept in memory (the last 50). A restart forgets job history, and any
leftover staging is cleared at startup. Files and XML entries already written
stay put.

## Versioned snapshots (semver)

Every state of the import XML is kept in `<file>.versions/<stem>.vX.Y.Z.xml`,
next to the file. For example, `~/Library/rekordbox/rekordbox/rekordbox.xml.versions/rekordbox.v1.2.0.xml`.
Each snapshot is plain Rekordbox XML, so you can import it or copy it back to
restore that version.

| Bump | When | Example |
|---|---|---|
| **MAJOR** | The library changed underneath dj-sync: the first time a file is seen (an existing original, or the empty file dj-sync creates, becomes `1.0.0`), or the file no longer matches the latest snapshot because something else edited it. That outside version is snapshotted *before* dj-sync writes. | `1.4.2` → edited in another tool → `2.0.0` |
| **MINOR** | A job created a new playlist. | `1.0.0` → `1.1.0` |
| **PATCH** | A job only added tracks to existing playlists. | `1.1.0` → `1.1.1` |

- **No-op jobs:** a job that changes nothing creates no version.
- **Immutable:** snapshots are never overwritten.
- **Retention:** the newest `download.keep_versions` (default 100) are kept,
  plus every `X.0.0`.
- **Where it shows:** job status reports the version (`xml_version`), and the
  completion message says *"Rekordbox XML is now vX.Y.Z"*.

This replaces the earlier rolling `.bak` and the one-time `.pre-dj-sync.bak`.

## Security model

- **Network exposure:** the server binds to `127.0.0.1` only. The public way in
  is the tunnel, and only for `mcp.triplejmusic.art`.
- **MCP auth:**
  - The endpoint path includes `MCP_SECRET_PATH` (at least 32 characters of
    `[A-Za-z0-9_-]`). Every other path returns 404.
  - Request logs record the method and status only, never the path.
  - The server speaks only the MCP methods above. Anything else is
    "method not found".
- **Origin check:** an `Origin` header that isn't ChatGPT/OpenAI, localhost or
  the public host gets a 403. This is the MCP spec's DNS-rebinding defence.
- **REST:** `/api/*` exists only when `SHORTCUT_API_KEY` is set. It checks the
  Bearer token with a constant-time comparison.
- **Input limits:**
  - Request bodies are capped at 64 KB.
  - At most 25 links per job.
  - The allowlist plus canonical rebuilding means the downloader is always
    given an `https://` URL that it built itself.
- **Worst case if the secret leaks:** someone can queue downloads of
  Spotify/YouTube links onto this Mac. They can't choose file paths, run
  commands, or read files. To revoke it, rotate `MCP_SECRET_PATH` and update the
  ChatGPT connector.

## Failure model

| Failure | What happens |
|---|---|
| Mac asleep / tunnel down | ChatGPT reports that the connector is unreachable. Nothing is queued. |
| spotdl / yt-dlp missing or outdated | The job fails with the downloader's own `ERROR:` line, e.g. *"No video formats found … Confirm you are on the latest version"*. Fix with `brew upgrade yt-dlp` or `pipx upgrade spotdl`. |
| One link in a playlist fails | The other tracks still land. The failure is listed in `errors`. |
| Import XML exists but is unreadable | The job fails. The file is **never** overwritten with an empty document. |
| Port 8000 taken (second instance) | The HTTP lane exits non-zero, and launchd retries every 30 s. |
| Restart mid-download | The child process is killed (`kill_on_drop`). The job is forgotten and staging is cleared on the next start. Re-send the link. |

## Known limits

- **Playlist order:** tracks within a Spotify playlist land in file-name order.
  spotdl downloads in parallel, so the original order isn't recoverable.
- **Pending checks:**
  - Whether custom MCP plugins work in the ChatGPT **mobile** app wasn't
    confirmed when this was written. The iOS Shortcut is the fallback.
  - Whether Rekordbox's xml-tree reload re-reads the file from disk is still to
    be confirmed on 7.x.
- **spotdl's Spotify scraping** (the default since 4.5) is fragile. Spotify's
  developer-mode quotas limit the `--use-official-api` alternative.
