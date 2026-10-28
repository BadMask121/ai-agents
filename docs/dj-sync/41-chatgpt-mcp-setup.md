# 41 — ChatGPT MCP download lane (setup)

This takes you from nothing to "paste a link in ChatGPT and it lands in
Rekordbox". It runs on the DJ laptop (macOS) and takes about 30 minutes. The
design is in [40-chatgpt-mcp-design.md](40-chatgpt-mcp-design.md).

You'll need:
- Rekordbox 7
- Homebrew
- a Rust toolchain (`rustup`; the crate pins its own version)
- a Cloudflare account that manages `triplejmusic.art`
- a ChatGPT plan with developer mode / custom plugins

> Paths below assume the repo is at `~/Desktop/WORK/Project.nosync/ai-agents`;
> adjust `REPO` if not.

```bash
REPO=~/Desktop/WORK/Project.nosync/ai-agents
```

---

## 1. Install the downloaders

```bash
brew install pipx yt-dlp deno     # deno: yt-dlp needs it for YouTube since late 2025
pipx ensurepath                   # adds ~/.local/bin to your shell PATH (open a new terminal)
pipx install spotdl               # spotdl needs Python ≥ 3.11; pipx uses Homebrew's
spotdl --version && yt-dlp --version && ffmpeg -version | head -1
which spotdl yt-dlp ffmpeg deno   # note these absolute paths for step 2
```

- If `ffmpeg` is missing, run `brew install ffmpeg`.
- Don't use an older `yt-dlp` from conda or pip. YouTube changes often, and an
  outdated yt-dlp fails with *"No video formats found"*.
- Keep both tools up to date: `brew upgrade yt-dlp && pipx upgrade spotdl`.

## 2. Configure dj-sync

```bash
mkdir -p ~/.dj-sync
[ -f ~/.dj-sync/config.toml ] || cp $REPO/apps/dj-sync/config.example.toml ~/.dj-sync/config.toml
```

Edit `~/.dj-sync/config.toml`:

- Enable `[mcp]`.
- Set **absolute** binary paths in `[download]`, using what `which` printed in
  step 1. launchd starts programs with a bare `PATH`.
- `library.roots` and `rekordbox.autoimport_dir` must exist even if you don't use
  the Telegram bot. Pointing `library.roots` at `~/Music/DJ_Downloads` means
  `/sync` will see downloaded tracks.

```toml
[mcp]
enabled = true
bind = "127.0.0.1:8000"
public_base_url = "https://mcp.triplejmusic.art"

[download]
spotdl_bin = "/Users/<you>/.local/bin/spotdl"
ytdlp_bin  = "/usr/local/bin/yt-dlp"      # /opt/homebrew/bin/yt-dlp on Apple-silicon Homebrew
ffmpeg_bin = "/usr/local/bin/ffmpeg"
extra_path = "/opt/homebrew/bin:/usr/local/bin"   # so yt-dlp finds deno
```

Create the secrets file (`~/.dj-sync/.env`):

```bash
cat >> ~/.dj-sync/.env <<EOF
MCP_SECRET_PATH=$(openssl rand -hex 24)
SHORTCUT_API_KEY=$(openssl rand -hex 24)
EOF
chmod 600 ~/.dj-sync/.env
```

- Add `TELEGRAM_BOT_TOKEN=…` (and the Spotify keys) here **only** if you also want
  the Telegram bot running under launchd. Leaving it out runs the MCP lane alone.
- `SHORTCUT_API_KEY` is optional (see step 7).

## 3. Build, run, and keep it running (launchd)

```bash
cd $REPO/apps/dj-sync
cargo install --path . --locked     # → ~/.cargo/bin/dj-sync (launchd can't run binaries from ~/Desktop)

# Smoke test in the foreground:
dj-sync &
sleep 2
curl -s http://127.0.0.1:8000/health          # {"status":"ok"}
ls ~/Music/rekordbox_import.xml                # created on first start
kill %1
```

Install the LaunchAgent so it starts at login and restarts if it dies:

```bash
sed "s#/Users/YOU#$HOME#g" deploy/com.triplejmusic.dj-sync.plist \
  > ~/Library/LaunchAgents/com.triplejmusic.dj-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.triplejmusic.dj-sync.plist
launchctl kickstart -k gui/$(id -u)/com.triplejmusic.dj-sync
tail -f ~/Library/Logs/dj-sync.log
```

| Task | Command |
|---|---|
| Deploy new code | `cargo install --path . --locked && launchctl kickstart -k gui/$(id -u)/com.triplejmusic.dj-sync` |
| Stop | `launchctl bootout gui/$(id -u)/com.triplejmusic.dj-sync` |
| Verbose downloader output | set `RUST_LOG` to `dj_sync=debug` in the plist, then `bootout` + `bootstrap` |

## 4. Cloudflare Tunnel → `https://mcp.triplejmusic.art`

### 4a. Create the tunnel (locally managed)

```bash
brew install cloudflared
cloudflared tunnel login                          # browser opens: pick triplejmusic.art
cloudflared tunnel create dj-sync                 # prints the tunnel UUID, writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns dj-sync mcp.triplejmusic.art   # creates the proxied CNAME

cp $REPO/apps/dj-sync/deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml
# edit ~/.cloudflared/config.yml: put the UUID in `tunnel:` and `credentials-file:`,
# and replace /Users/YOU with your home dir
cloudflared tunnel ingress validate
cloudflared tunnel run dj-sync                    # foreground test; in another terminal:
curl -s https://mcp.triplejmusic.art/health       # {"status":"ok"}
```

The ingress goes to `http://127.0.0.1:8000`, not `localhost`, which can
resolve to IPv6.

### 4b. Start it automatically

- **At login (recommended).** This matches the dj-sync LaunchAgent, which also
  starts at login. It installs `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`
  and reads `~/.cloudflared/config.yml`:

  ```bash
  cloudflared service install
  ```

- **At boot, before login.** It reads `/etc/cloudflared/`, so copy the config
  and credentials there and fix `credentials-file:` to point at the new path:

  ```bash
  sudo mkdir -p /etc/cloudflared
  sudo cp ~/.cloudflared/config.yml ~/.cloudflared/<UUID>.json /etc/cloudflared/
  sudo cloudflared service install                 # LaunchDaemon
  ```

  dj-sync itself still only starts at login, so a tunnel with no one logged in
  has nothing to forward to. Turn on automatic login if you want boot-to-ready.

- **Dashboard-managed alternative.** Go to Zero Trust → Networks → Tunnels →
  Create a tunnel → Cloudflared. Copy the `sudo cloudflared service install
  <TOKEN>` command, then add the public hostname `mcp.triplejmusic.art` →
  `HTTP` → `127.0.0.1:8000`. In this setup the dashboard owns the ingress, so
  skip the config file.

- **Windows.** Install with `winget install --id Cloudflare.cloudflared`, then
  run `cloudflared.exe service install <TOKEN>` using a dashboard-managed
  tunnel. dj-sync is macOS-first: the code is portable (it writes
  `file://localhost/C:/…` Locations on Windows), but it's untested there. Run it
  from Task Scheduler with an "At log on" trigger.

### 4c. Let ChatGPT through Cloudflare's bot protection

ChatGPT's servers are bots by definition, and new zones block AI bots by default.

- **Block AI bots / AI Crawl Control:** in the Cloudflare dashboard for
  `triplejmusic.art`, go to Security → Bots. Turn the block off, or add a WAF
  custom rule with action *Skip* for `http.host eq "mcp.triplejmusic.art"`.
- **Bot Fight Mode:** this can't be skipped per hostname on the free plan. If
  it's on and ChatGPT gets challenged, turn it off for the zone.
- **Check:** after your first ChatGPT attempt, look at Security → Events for
  blocked or challenged requests to `mcp.triplejmusic.art`.

### 4d. Keep the Mac awake

The tunnel is only up while the Mac is awake. Go to System Settings → Battery
→ Options and turn on *Prevent automatic sleeping on power adapter when the
display is off*. Or run `caffeinate -s` during a prep session.

## 5. Rekordbox 7 (one-time)

1. **Show the xml tree:** Rekordbox → Preferences → **View** → **Layout** →
   tick **rekordbox xml**. A *rekordbox xml* node appears in the browser tree on
   the left.
2. **Point it at the import file:** Preferences → **Advanced** → **Database** →
   *rekordbox xml* → **Imported Library** → **Browse…** → choose
   `~/Music/rekordbox_import.xml`. dj-sync creates this file on first start. In
   the file picker, press ⌘⇧. to show hidden files if you need to, or ⌘⇧G and
   type the path.
3. **After each download job:**
   - Select the **rekordbox xml** node and use its reload/refresh control, or
     collapse and expand it.
   - Your playlists, such as *ChatGPT Downloads*, appear under *rekordbox xml →
     Playlists*.
   - Right-click a playlist and choose **Import Playlist**, or drag its tracks
     into the Collection. Rekordbox analyses BPM, key and beatgrid on import.

This file is separate from anything Rekordbox writes. The Telegram bot's
browser reads a different file: your manual *File → Export Collection in xml
format* export at `rekordbox.xml_path`. The two don't collide.

## 6. Add the plugin in ChatGPT

1. On the web, open **chatgpt.com/plugins**. In older layouts it's Settings →
   Apps & Connectors → Advanced → **Developer mode** → *Create*. Add a custom
   MCP server with these settings:
   - **Name:** DJ Sync
   - **URL:** `https://mcp.triplejmusic.art/<MCP_SECRET_PATH>/mcp`. Get the
     secret with `grep MCP_SECRET_PATH ~/.dj-sync/.env`.
   - **Authentication:** No authentication. The secret path is the credential.
2. ChatGPT lists two tools: **download_to_rekordbox** and **get_download_status**.
3. In a chat, with the plugin enabled, try:
   > Download this to Rekordbox in a playlist called Friday: https://open.spotify.com/track/…

   ChatGPT asks you to confirm, because this is a write action. It replies with
   a job id.
4. A few minutes later, ask *"How did that download go?"*. ChatGPT calls
   `get_download_status`.

**On your phone:** plugins added on the web should appear in the iOS and Android
apps. If the plugin doesn't show up on mobile, use the Shortcut in step 7.

To rotate the secret:
1. Set a new `MCP_SECRET_PATH` in `~/.dj-sync/.env`.
2. Run `launchctl kickstart -k gui/$(id -u)/com.triplejmusic.dj-sync`.
3. Update the plugin URL in ChatGPT.

## 7. Optional: iOS Share Sheet Shortcut

With `SHORTCUT_API_KEY` set, follow
[`apps/dj-sync/deploy/send-to-rekordbox-shortcut.md`](../../apps/dj-sync/deploy/send-to-rekordbox-shortcut.md).
It adds a *Share → Send to Rekordbox* action in the Spotify and YouTube apps,
with no chat needed.

## Troubleshooting

| Symptom | Check |
|---|---|
| ChatGPT can't connect | Run `curl https://mcp.triplejmusic.art/health`. Then check that the tunnel is running (`cloudflared tunnel info dj-sync`), that the Mac is awake, and Cloudflare Security → Events (step 4c). |
| `curl …/health` works but ChatGPT says 404 | The secret in the plugin URL is wrong. |
| Job fails: *starting … (is it installed?)* | The `[download]` binary paths must be absolute (launchd's PATH is bare). |
| yt-dlp: *No video formats found* / *Sign in to confirm* | Run `brew upgrade yt-dlp`. Make sure `deno` is on `extra_path`. |
| spotdl errors or rate limits | Run `pipx upgrade spotdl`. If scraping keeps failing, set `spotdl_use_official_api = true` with your own Spotify app keys. |
| New tracks don't appear in Rekordbox | Reload the *rekordbox xml* node, and check that *Imported Library* points at `~/Music/rekordbox_import.xml`. Check the job's `state` is `done`. |
| Anything else | Check `~/Library/Logs/dj-sync.log`. Set `RUST_LOG=dj_sync=debug` to see each downloader line. |
