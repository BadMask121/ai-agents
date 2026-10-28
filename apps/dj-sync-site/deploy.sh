#!/bin/bash
# Deploy the DJ Sync website: stamp every page's SEO block with the app's
# version (tools/seo.py reads ../dj-sync/macos/VERSION), run the tests, deploy
# the Worker, and check the live home page advertises that version.
# apps/dj-sync/release.sh runs this once a release is uploaded.
#
#   ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER="${WRANGLER:-$(pwd)/../dj-sync-cloud/node_modules/.bin/wrangler}"
SITE="https://djsync.jeffrey.build"

die() { echo "deploy: $*" >&2; exit 1; }
[[ -x "$WRANGLER" ]] || die "wrangler not found at $WRANGLER (pnpm install in apps/dj-sync-cloud)"
VERSION=$(tr -d '[:space:]' < ../dj-sync/macos/VERSION)

python3 -I tools/seo.py public >/dev/null
node --test test/*.test.mjs >/dev/null || die "site tests failed (node --test test/*.test.mjs)"
"$WRANGLER" deploy

# The deploy is live within seconds; allow a little longer before giving up.
want="\"softwareVersion\":\"$VERSION\""
for _ in 1 2 3 4 5 6; do
  live=$(curl -fsS "$SITE/?v=$VERSION" | grep -o '"softwareVersion":"[^"]*"' || true)
  [[ "$live" == "$want" ]] && { echo "== website live with DJ Sync $VERSION: $SITE"; exit 0; }
  sleep 5
done
die "live site shows ${live:-no softwareVersion}, expected $VERSION"
