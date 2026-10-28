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

`uv` installs the Python tools with their own managed Python. Check with
`which uv`, and if it's missing, run `brew install uv`.

```bash
uv tool install spotdl --python 3.12            # → ~/.local/bin/spotdl
uv tool install "yt-dlp[default]" --python 3.12  # → ~/.local/bin/yt-dlp (incl. the YouTube challenge solver)
ffmpeg -version | head -1                        # brew install ffmpeg if missing
```

yt-dlp needs **deno 2.x** for YouTube, and `cloudflared` comes in step 4.

- **On a supported Homebrew** (Apple silicon under `/opt/homebrew`): run
  `brew install deno cloudflared`.
- **On an Intel-prefix Homebrew (`/usr/local`) on Apple silicon:** Homebrew
  builds everything from source there, which can take hours. Use the signed
  official releases instead:

```bash
mkdir -p ~/.local/bin && cd "$(mktemp -d)"
curl -fsSLO https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip
curl -fsSL  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar -xz
unzip -q deno-aarch64-apple-darwin.zip
install -m 755 deno cloudflared ~/.local/bin/
~/.local/bin/deno --version && ~/.local/bin/cloudflared --version
```

- Keep the tools current with `uv tool upgrade --all`. An outdated yt-dlp fails
  with *"No video formats found"*.
- Make sure `~/.local/bin` comes first in `extra_path` (step 2). An old `deno`
  elsewhere on the PATH (e.g. a 2020 one in `/usr/local/bin`) breaks yt-dlp.

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
ytdlp_bin  = "/Users/<you>/.local/bin/yt-dlp"
ffmpeg_bin = "/usr/local/bin/ffmpeg"          # or /opt/homebrew/bin/ffmpeg
extra_path = "/Users/<you>/.local/bin:/opt/homebrew/bin:/usr/local/bin"   # deno 2.x first
# import_xml: leave unset (see step 5)
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

## 2b. Choosing the downloads folder

Downloads go to `~/Music/DJ_Downloads` by default. To pick a different folder,
install the menu bar app with `apps/dj-sync/macos/build-app.sh --install` and
choose **DJ Sync → Downloads folder → Change…**. The new folder applies from
the next download, with no restart.

Prefer a folder under `~/Music` or another ordinary folder. macOS blocks
background services from Desktop, Documents, Downloads, iCloud Drive and
external drives unless dj-sync has been given Full Disk Access, and the app
warns you about this.

## 3. Build, run, and keep it running (launchd)

```bash
cd $REPO/apps/dj-sync
cargo install --path . --locked     # → ~/.cargo/bin/dj-sync (launchd can't run binaries from ~/Desktop)

# Smoke test in the foreground:
dj-sync &
sleep 2
curl -s http://127.0.0.1:8000/health          # {"status":"ok"}
grep -m1 import_xml ~/Library/Logs/dj-sync.log 2>/dev/null   # (under launchd) which XML it chose
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

- **At login (recommended).** This matches the dj-sync LaunchAgent. Install it,
  then give it the arguments it needs:

  ```bash
  cloudflared service install
  P=~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
  launchctl bootout gui/$(id -u)/com.cloudflare.cloudflared
  /usr/libexec/PlistBuddy \
    -c "Add :ProgramArguments:1 string --config" \
    -c "Add :ProgramArguments:2 string $HOME/.cloudflared/config.yml" \
    -c "Add :ProgramArguments:3 string tunnel" \
    -c "Add :ProgramArguments:4 string run" \
    -c "Delete :KeepAlive" -c "Add :KeepAlive bool true" $P
  launchctl bootstrap gui/$(id -u) $P
  grep 'Registered tunnel connection' ~/Library/Logs/com.cloudflare.cloudflared.err.log | tail -2
  ```

  Recent cloudflared releases write this plist with **no arguments**. For a
  locally managed tunnel, that makes it log *"use `cloudflared tunnel run`"*
  and exit, which is why the extra arguments are added. This is the user-level
  LaunchAgent and reads `~/.cloudflared/config.yml`.

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

If `curl https://mcp.triplejmusic.art/…` on the Mac itself can't resolve right
after setup, the Mac cached "doesn't exist" from an earlier lookup. ChatGPT
isn't affected. Wait for the cache to expire, or flush it with
`sudo killall -HUP mDNSResponder`. You can check that the tunnel works with:

```bash
curl --resolve mcp.triplejmusic.art:443:$(dig +short mcp.triplejmusic.art @1.1.1.1 | head -1) https://mcp.triplejmusic.art/health
```

### 4d. Keep the Mac awake

The tunnel is only up while the Mac is awake. Go to System Settings → Battery
→ Options and turn on *Prevent automatic sleeping on power adapter when the
display is off*. Or run `caffeinate -s` during a prep session.

## 5. Rekordbox 7 — usually nothing to do

dj-sync reads Rekordbox's own settings
(`~/Library/Application Support/Pioneer/rekordbox6/rekordbox3.settings`):

- **Imported Library** (`bridgeImportedLibraryFile`). When `[download]
  import_xml` is unset, dj-sync writes to the file this setting points at, so
  Rekordbox picks it up without any changes. The log shows the choice:
  *"import_xml: using Rekordbox's Imported Library path"*.
  - **Existing file there that dj-sync didn't create:** it's kept as the
    baseline snapshot `<file>.versions/<stem>.v1.0.0.xml` before the first
    write. Every later state gets its own semver snapshot: MINOR for a new
    playlist, PATCH for added tracks, MAJOR for an outside edit. dj-sync keeps
    the file's tracks and playlists but drops cue/beatgrid data it doesn't
    model, and the snapshots still have it.
  - **That file is your bot's `rekordbox.xml_path` export:** dj-sync won't
    adopt it, and falls back to `~/Music/rekordbox_import.xml`.
- **The rekordbox xml tree** (`showRbXml`) must be visible in the browser.

Only if the log says *"Rekordbox has no Imported Library set"*, or the tree is
hidden, set them once by hand:

1. Preferences → **View** → **Layout** → tick **rekordbox xml**.
2. Preferences → **Advanced** → **Database** → *rekordbox xml* → **Imported
   Library** → **Browse…** → choose the file named in the log.

After each download job:

1. Select the **rekordbox xml** node and use its reload/refresh control, or
   collapse and expand it.
2. Your playlists, such as *ChatGPT Downloads*, appear under *rekordbox xml →
   Playlists*.
3. Right-click a playlist and choose **Import Playlist**, or drag its tracks
   into the Collection. Rekordbox analyses BPM, key and beatgrid on import.

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

## 6b. Cloud queue, so the Mac can be offline

Once steps 1–6 work, put the always-on Worker in front. After that, ChatGPT
requests made while the Mac is asleep or offline wait in Cloudflare and run
when it's back. See [42-cloud-queue.md](42-cloud-queue.md). In short:

1. Deploy the Worker: `cd apps/dj-sync-cloud`, then `npx wrangler login`,
   `npx wrangler d1 create dj-sync-queue` (put the ID in `wrangler.jsonc`),
   `pnpm db:migrate:remote` and `npx wrangler deploy --tag v0.1.0`.
2. Add `CLOUD_AGENT_TOKEN=$(openssl rand -hex 32)` to `~/.dj-sync/.env`. Then
   pipe `MCP_SECRET_PATH`, `SHORTCUT_API_KEY` and that token (as `AGENT_TOKEN`)
   into `npx wrangler secret put`.
3. Add `[cloud] enabled = true` to `~/.dj-sync/config.toml` and restart
   dj-sync. Check that `curl https://mcp.triplejmusic.art/health` shows
   `"online": true`.

The ChatGPT plugin URL stays the same. The tunnel from step 4 is then only a
rollback path.

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
| New tracks don't appear in Rekordbox | Reload the *rekordbox xml* node, and check that *Imported Library* points at the file the dj-sync log names (`grep import_xml ~/Library/Logs/dj-sync.log`). Check the job's `state` is `done`. |
| Anything else | Check `~/Library/Logs/dj-sync.log`. Set `RUST_LOG=dj_sync=debug` to see each downloader line. |
