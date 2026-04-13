# 01 — VPS Bootstrap

Base OS setup, non-root user, runtimes (Node, Go), Playwright system libs.

## SSH in as root

From your laptop (substitute your Hetzner public IP — find it in the Hetzner Cloud console):
```bash
ssh root@<your-hetzner-ip>
```

If the box was built from the Coolify image, you'll land in a working environment that already has Docker and the Coolify dashboard running. Don't worry about that — we install career-ops as a separate user and never touch Coolify.

## Update + base packages

```bash
apt update && apt upgrade -y
apt install -y build-essential git curl ca-certificates gnupg \
  tmux pandoc ufw unzip jq
```

## Create non-root user

```bash
adduser --disabled-password --gecos "" career
usermod -aG sudo career
mkdir -p /home/career/.ssh
cp ~/.ssh/authorized_keys /home/career/.ssh/
chown -R career:career /home/career/.ssh
chmod 700 /home/career/.ssh
chmod 600 /home/career/.ssh/authorized_keys
```

Test from your laptop in a new terminal:
```bash
ssh career@<your-hetzner-ip>
```
If that works, stop using root.

## Baseline firewall

**If Coolify is already on the box:** check what ufw is doing first — Coolify typically does NOT enable ufw by default and instead relies on Docker's iptables rules. Don't blindly enable ufw here, you may break Coolify's reverse proxy.

```bash
ufw status
```

If ufw is inactive (the common Coolify case), leave it alone for now. Tailscale will provide the security perimeter for career-ops; Coolify keeps managing whatever it exposes.

If ufw is active and you want to add rules:
```bash
sudo ufw allow 22/tcp
# add any Coolify ports already in use BEFORE enabling
sudo ufw status verbose
```

Once Tailscale SSH is verified working in step 04, you can remove the public port 22 rule (if it's there).

## Switch to the career user

```bash
su - career
```

Everything below runs as `career`.

## Node 20 via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 20
nvm alias default 20
node -v   # expect v20.x
```

## Go (for the Bubble Tea TUI dashboard)

```bash
GO_VERSION=1.22.6
curl -LO https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin' >> ~/.bashrc
. ~/.bashrc
go version
```

## Playwright/Chromium system libs

`npx playwright install --with-deps chromium` will pull these later, but pre-seeding avoids surprises:

```bash
sudo apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 fonts-liberation
```

Note: on Ubuntu 22.04 use `libasound2`; on 24.04 use `libasound2t64`. Adjust if apt complains.

## Done

Move on to [02-claude-code-and-career-ops.md](02-claude-code-and-career-ops.md).
