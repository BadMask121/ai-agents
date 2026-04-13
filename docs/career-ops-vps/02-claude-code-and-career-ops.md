# 02 — Install Claude Code & career-ops

## Install Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

## Authenticate Claude Code (pick one)

### Option A — Pro/Max subscription (recommended if you have one)

```bash
claude
```

Choose the browser login flow. On a headless VPS it prints a URL with a code. Open the URL on your laptop, sign in, paste the code back into the VPS terminal. Token caches under `~/.claude/`.

### Option B — Anthropic API key

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc
. ~/.bashrc
```

## Verify

```bash
claude
```

You should land in an interactive Claude Code session. Type `/exit` to leave.

## Clone career-ops

```bash
mkdir -p ~/work && cd ~/work
git clone https://github.com/santifer/career-ops.git
cd career-ops
```

## Install dependencies

```bash
npm install
npx playwright install --with-deps chromium
```

## Build the dashboard TUI

```bash
cd dashboard && go build -o career-dashboard . && cd ..
```

## Run the readiness check

```bash
npm run doctor
```

Fix anything it complains about before continuing. If `doctor` is missing or fails, read `package.json` for the actual script names:
```bash
cat package.json
```

## Read the repo before configuring

career-ops is opinionated and the config schemas are not stable. Before editing anything, skim:

```bash
ls config/                    # actual config files
ls templates/                 # example configs
ls .claude/commands/ 2>/dev/null   # slash command definitions
cat README.md                 # source of truth
```

These are the real ground truth — anything in this guide about file names or schemas is "as of writing." Trust the cloned repo over the docs.

## Done

Move on to [03-resume-and-config.md](03-resume-and-config.md).
