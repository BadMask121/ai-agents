# 05 — Scheduled Portal Scanning

Run `/career-ops scan` automatically every morning so jobs are queued for review when you wake up.

## The wrinkle

career-ops slash commands run inside an interactive `claude` session. Cron-ing them takes one of two shapes:

### Shape A — non-interactive Claude Code (preferred)

```bash
claude -p "/career-ops scan" --output-format text
```

Verify your installed Claude Code CLI supports `-p`:
```bash
claude --help | grep -A2 -- '-p'
```

### Shape B — tmux send-keys (fallback)

```bash
tmux send-keys -t career:0 "/career-ops scan" Enter
```

Hacky but works against the persistent `career` tmux session.

## Find the claude binary path

Under nvm the binary lives in a versioned directory:
```bash
which claude
# e.g. /home/career/.nvm/versions/node/v20.17.0/bin/claude
```

Note this path — you will hard-code it into the systemd unit.

## Create the service

```bash
sudo nano /etc/systemd/system/career-scan.service
```

Paste, substituting your `claude` path and (if using API key auth) your key:

```ini
[Unit]
Description=career-ops portal scan
After=network-online.target

[Service]
Type=oneshot
User=career
WorkingDirectory=/home/career/work/career-ops
Environment=ANTHROPIC_API_KEY=sk-ant-...
ExecStart=/home/career/.nvm/versions/node/v20.17.0/bin/claude -p "/career-ops scan" --output-format text
StandardOutput=append:/home/career/work/career-ops/logs/scan.log
StandardError=append:/home/career/work/career-ops/logs/scan.log
```

If you authenticated via Pro/Max subscription instead of API key, drop the `Environment=` line — the cached token under `~/.claude/` will be used.

## Create the timer

```bash
sudo nano /etc/systemd/system/career-scan.timer
```

Paste:

```ini
[Unit]
Description=Run career-ops scan daily at 07:00

[Timer]
OnCalendar=*-*-* 07:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` means missed runs (e.g., VPS was rebooting) fire on next boot.

## Enable and start

```bash
mkdir -p ~/work/career-ops/logs
sudo systemctl daemon-reload
sudo systemctl enable --now career-scan.timer
systemctl list-timers | grep career
```

## Test it manually before trusting it

```bash
sudo systemctl start career-scan.service
tail -f ~/work/career-ops/logs/scan.log
```

You should see Claude Code output as the scan runs. Ctrl-C the tail when done.

## Adjusting the schedule

Edit `OnCalendar` in the timer unit:
- `*-*-* 07:00:00` — daily at 7am (server local time)
- `*-*-* 07,19:00:00` — twice a day, 7am and 7pm
- `Mon..Fri *-*-* 07:00:00` — weekdays only

After editing:
```bash
sudo systemctl daemon-reload
sudo systemctl restart career-scan.timer
systemctl list-timers | grep career
```

Confirm server timezone with `timedatectl`. Set it if needed: `sudo timedatectl set-timezone America/New_York`.

## Done

Move on to [06-daily-flow.md](06-daily-flow.md).
