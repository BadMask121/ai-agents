# syntax=docker/dockerfile:1.7
#
# career-ops-ui
#
# This Dockerfile expects the BUILD CONTEXT to be the monorepo root,
# not packages/career-ops-ui. From Coolify or docker build, use:
#
#   docker build -f packages/career-ops-ui/Dockerfile -t career-ops-ui .
#
# That way we can see pnpm-workspace.yaml, pnpm-lock.yaml, and turbo.json
# and get deterministic installs via pnpm deploy.

# ─── base ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

# ─── deps (prune monorepo to only what career-ops-ui needs) ────────
FROM base AS deps

WORKDIR /repo

# Copy just the files needed to resolve the dependency graph
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/career-ops-ui/package.json ./packages/career-ops-ui/package.json

# Also copy other package manifests if they exist, so pnpm's workspace
# resolution doesn't break. Add more lines here if you add packages.
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sample-agent/package.json ./packages/sample-agent/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ai-agents/career-ops-ui...

# ─── build ─────────────────────────────────────────────────────────
FROM base AS build

WORKDIR /repo

COPY --from=deps /repo ./
COPY packages/career-ops-ui ./packages/career-ops-ui

RUN pnpm --filter @ai-agents/career-ops-ui run build

# ─── runtime ───────────────────────────────────────────────────────
FROM base AS runtime

# System deps:
#   pandoc + poppler-utils — resume conversion (docx/pdf/md)
#   tini                   — pid 1 init
#   curl, ca-certs         — healthcheck + fetching
#   wget + gnupg           — fetch Google Chrome signing key
#   playwright chromium libs — so /career-ops pipeline can render PDFs
#   google-chrome-stable   — required by @playwright/mcp (it hardcodes the
#                            'chrome' channel, won't accept Playwright's bundled
#                            chromium binary). amd64-only — local builds on
#                            Apple Silicon need --platform linux/amd64.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    poppler-utils \
    tini \
    curl \
    ca-certificates \
    wget \
    gnupg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
 && wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally, install @playwright/mcp (Microsoft's official
# Playwright MCP server — Claude's browser_navigate/browser_snapshot tools),
# and pre-pull Playwright Chromium into a SHARED path readable by the node user.
#
# Why the shared path: by default, `playwright install chromium` drops the
# browser binary into $HOME/.cache/ms-playwright, which is /root/.cache/... when
# the install runs as root. The container later switches to USER node, which
# cannot read /root. Setting PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright puts
# the binary in a known location we can chown.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN mkdir -p /opt/ms-playwright \
 && npm install -g @anthropic-ai/claude-code@2.1.104 @playwright/mcp \
 && npx --yes playwright@1.58.1 install chromium \
 && chown -R node:node /opt/ms-playwright

WORKDIR /app

# Mirror the /repo layout from the build stage. pnpm's per-package node_modules
# contain symlinks like `next -> ../../../node_modules/.pnpm/next@.../node_modules/next`,
# which only resolve correctly if the workspace root sits 3 levels up from
# packages/<pkg>/node_modules/<dep>. Flattening the package into /app breaks both
# the symlinks and the bin lookup (next is at packages/.../node_modules/.bin/next,
# not the workspace-root node_modules/.bin).
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/career-ops-ui/.next ./packages/career-ops-ui/.next
COPY --from=build /repo/packages/career-ops-ui/package.json ./packages/career-ops-ui/package.json
COPY --from=build /repo/packages/career-ops-ui/next.config.ts ./packages/career-ops-ui/next.config.ts
COPY --from=build /repo/packages/career-ops-ui/node_modules ./packages/career-ops-ui/node_modules

# Runtime dir for career-ops workspace — bind-mounted from host in prod
RUN mkdir -p /workspace/career-ops && chown -R node:node /workspace /app

USER node

# Pre-configure Claude CLI to see the Playwright MCP server on boot.
# Writes ~/.claude.json (user-scope) with an mcpServers entry. This means
# every `claude -p "..."` invocation from the app already has browser_navigate,
# browser_snapshot, browser_click, browser_type, etc. available as tools —
# no per-request `claude mcp add` needed.
RUN mkdir -p /home/node/.claude \
 && printf '%s\n' '{' \
    '  "mcpServers": {' \
    '    "playwright": {' \
    '      "command": "npx",' \
    '      "args": ["-y", "@playwright/mcp"]' \
    '    }' \
    '  }' \
    '}' > /home/node/.claude.json

WORKDIR /app/packages/career-ops-ui
EXPOSE 3000

ENV PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    CAREER_OPS_WORKSPACE=/workspace/career-ops

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3000/login || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
