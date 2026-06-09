# syntax=docker/dockerfile:1.7
#
# booking-ops — resident worker (Telegram long-poll + Gmail poll).
#
# This Dockerfile expects the BUILD CONTEXT to be the monorepo root, not
# apps/booking-ops. From Coolify or docker build, use:
#
#   docker build -f apps/booking-ops/Dockerfile -t booking-ops .
#
# so we can see pnpm-workspace.yaml, pnpm-lock.yaml and turbo.json for
# deterministic installs. Much slimmer than career-ops-ui: no Chrome/Playwright,
# no pandoc, no claude CLI — drafting goes over HTTPS via the Anthropic SDK.
# It exposes NO port: long-polling is outbound-only, so there is no web server,
# no healthcheck endpoint, no domain/TLS.

# ─── base ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

# ─── deps (prune monorepo to only what booking-ops needs) ──────────
FROM base AS deps

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/booking-ops/package.json ./apps/booking-ops/package.json
# Other manifests so pnpm's workspace resolution doesn't break.
COPY apps/shared/package.json ./apps/shared/package.json
COPY apps/sample-agent/package.json ./apps/sample-agent/package.json
COPY apps/career-ops-ui/package.json ./apps/career-ops-ui/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ai-agents/booking-ops...

# ─── build ─────────────────────────────────────────────────────────
FROM base AS build

WORKDIR /repo

COPY --from=deps /repo ./
COPY apps/shared ./apps/shared
COPY apps/booking-ops ./apps/booking-ops

# Build the filtered graph (includes @ai-agents/shared via `...`).
RUN pnpm --filter @ai-agents/booking-ops... run build

# ─── runtime ───────────────────────────────────────────────────────
FROM base AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Mirror the /repo layout so pnpm's symlinked workspace node_modules resolve.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/shared/package.json ./apps/shared/package.json
COPY --from=build /repo/apps/shared/dist ./apps/shared/dist
COPY --from=build /repo/apps/booking-ops/package.json ./apps/booking-ops/package.json
COPY --from=build /repo/apps/booking-ops/dist ./apps/booking-ops/dist
COPY --from=build /repo/apps/booking-ops/node_modules ./apps/booking-ops/node_modules

# Workspace volume — mounted from host/named-volume in prod.
RUN mkdir -p /workspace/booking-ops && chown -R node:node /workspace /app

USER node

ENV NODE_ENV=production \
    BOOKING_OPS_WORKSPACE=/workspace/booking-ops \
    OAUTH_PORT=8080

WORKDIR /app/apps/booking-ops

# Public OAuth callback for the Telegram /connect web flow. Coolify maps the
# domain to this port (+ TLS via Traefik). Telegram itself still long-polls
# (outbound) — this port serves only /oauth/callback and /healthz.
EXPOSE 8080

# Node-based healthcheck (image is slim — no curl). Hits /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.OAUTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
