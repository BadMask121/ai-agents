# 04 — Mobile Access (Tailscale + ttyd + PWA)

This is the part that makes your phone the front-end. We use:
- **Tailscale** as a private mesh VPN so the VPS is reachable from your phone but not from the public internet
- **ttyd** as a web terminal exposing tmux + Claude Code in a browser
- **tmux** for a persistent session that survives disconnects
- **PWA install** so the ttyd URL becomes an icon on your phone home screen

## Install Tailscale on the VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=career-vps
```

This opens an auth URL. Open it on your laptop, sign in to Tailscale (free tier is fine), authorize the device.

`--ssh` lets Tailscale handle SSH for you, so you can ssh into the box over Tailscale without exposing port 22 publicly.

Get the Tailscale IP:
```bash
tailscale ip -4
# e.g. 100.64.12.34
```

Note this address — you will use it from your phone.

## Install Tailscale on your phone

1. App Store / Play Store → Tailscale → install
2. Sign in with the same account you used on the VPS
3. `career-vps` appears in the device list
4. Toggle Tailscale on whenever you want to use the agent

## Verify Tailscale SSH

From your laptop with Tailscale also installed:
```bash
ssh career@career-vps
```

If that works, lock down the public SSH port:
```bash
sudo ufw delete allow 22/tcp
```

**Only do this once Tailscale SSH is confirmed working**, or you will lock yourself out and have to use the Hetzner web console (the screen icon next to your server in the Hetzner Cloud UI) to recover.

## Install ttyd

```bash
sudo apt install -y ttyd
ttyd --version
```

## Create the systemd service

```bash
sudo nano /etc/systemd/system/career-ttyd.service
```

Paste:

```ini
[Unit]
Description=ttyd for career-ops over Tailscale
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=career
WorkingDirectory=/home/career/work/career-ops
ExecStart=/usr/bin/ttyd -i tailscale0 -p 7681 -W -c career:STRONG_PASSWORD_HERE tmux new -A -s career
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Replace `STRONG_PASSWORD_HERE`** with a real password. Defense in depth on top of Tailscale.

Key flags:
- `-i tailscale0` — bind only to the Tailscale interface. Not reachable from the public internet even if ufw is misconfigured.
- `-W` — write mode (otherwise the terminal is read-only)
- `-c user:pass` — basic auth
- `tmux new -A -s career` — attach to (or create) a persistent tmux session named `career` so disconnecting your phone does not kill `claude`

## Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now career-ttyd
sudo systemctl status career-ttyd
```

If it fails to start, check the logs:
```bash
sudo journalctl -u career-ttyd -n 50 --no-pager
```

## Connect from your phone

1. Phone Tailscale → on
2. Open mobile browser
3. Visit: `http://100.64.12.34:7681` (substitute your Tailscale IP)
   - Or `http://career-vps:7681` if MagicDNS is enabled in your Tailscale admin
4. Enter the basic-auth credentials (`career` / your password)
5. You should see a terminal with the tmux session
6. Type `claude` to start Claude Code

## Add to home screen as a PWA

**iOS Safari:**
1. Tap the Share icon
2. Add to Home Screen
3. Name it "career-ops"
4. Tap the new icon → opens straight into the terminal

**Android Chrome:**
1. Tap the menu (three dots)
2. Install app / Add to Home screen
3. Tap the new icon → opens straight into the terminal

## Optional — TLS over Tailscale

For an `https://` URL (some browsers nag about basic auth over plain http):

```bash
sudo tailscale cert career-vps.<your-tailnet>.ts.net
```

This drops cert + key files in the current directory. Find your tailnet name in the Tailscale admin console (looks like `tail1234.ts.net`). Then update the systemd unit's `ExecStart` to add:

```
--ssl --ssl-cert /path/to/cert.pem --ssl-key /path/to/key.pem
```

Restart the service.

## Fallback: SSH client app

If ttyd misbehaves on a flaky connection, install Termius (iOS/Android), Blink (iOS), or Termux (Android). Add the VPS as a host using the Tailscale name `career-vps`. Connect, then:

```bash
tmux attach -t career || tmux new -s career
claude
```

This is more reliable for long sessions but worse for TUI rendering on a small mobile keyboard.

## Done

Move on to [05-scheduled-scanning.md](05-scheduled-scanning.md).
