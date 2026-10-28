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
# The pages link straight to DJ-Sync-$VERSION.dmg, so it must be released first.
DMG="$SITE/download/DJ-Sync-$VERSION.dmg"
curl -fsSI "$DMG" >/dev/null || die "DJ-Sync-$VERSION.dmg isn't released yet (apps/dj-sync/release.sh deploys the site itself)"
"$WRANGLER" deploy

# The deploy is live within seconds; allow a little longer before giving up.
latest() { curl -fsSI "$SITE/download/DJ-Sync-latest.dmg" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }'; }
for _ in 1 2 3 4 5 6; do
  page=$(curl -fsS "$SITE/?v=$VERSION" || true)
  if [[ "$page" == *"\"softwareVersion\":\"$VERSION\""* && "$page" == *"$DMG"* && "$(latest)" == "$DMG" ]]; then
    echo "== website live with DJ Sync $VERSION: $DMG"; exit 0
  fi
  sleep 5
done
die "the live site isn't on $VERSION yet (home page download link or DJ-Sync-latest.dmg → $(latest))"
