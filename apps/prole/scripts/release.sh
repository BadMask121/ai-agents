#!/usr/bin/env bash
#
# Build the Prole DMG locally and upload it to the landing-page host, where
# nginx serves it at /download/Prole.dmg (see apps/prole-site/).
#
# Why local (not CI): macOS bundles need a Mac, and building locally avoids the
# com.apple.quarantine xattr that a downloaded-then-rebuilt artifact would carry.
# The app is ad-hoc signed (tauri.conf.json -> bundle.macOS.signingIdentity "-"),
# so users still do a one-time right-click -> Open; that's documented on the site.
#
# Usage:
#   bash scripts/release.sh            # build universal DMG + upload
#   bash scripts/release.sh --dry-run  # print the build target, scp dest + URL, do nothing
#
# Override the destination with env vars:
#   PROLE_HOST       ssh host          (default: root@95.217.185.93)
#   PROLE_REMOTE_DIR remote dir        (default: /data/prole-releases)
#   PROLE_TARGET     rust target triple or "host"
#                                      (default: universal-apple-darwin)

set -euo pipefail

PROLE_HOST="${PROLE_HOST:-root@95.217.185.93}"
PROLE_REMOTE_DIR="${PROLE_REMOTE_DIR:-/data/prole-releases}"
PROLE_TARGET="${PROLE_TARGET:-universal-apple-darwin}"
REMOTE_NAME="Prole.dmg"   # stable filename → stable /download/Prole.dmg URL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Where Tauri drops the DMG depends on whether we cross-compile to a triple.
if [ "$PROLE_TARGET" = "host" ]; then
  BUILD_ARGS=(--bundles dmg)
  DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
else
  BUILD_ARGS=(--target "$PROLE_TARGET" --bundles dmg)
  DMG_DIR="$ROOT/src-tauri/target/$PROLE_TARGET/release/bundle/dmg"
fi

echo "Prole release"
echo "  target:    $PROLE_TARGET"
echo "  dmg dir:   $DMG_DIR"
echo "  dest:      $PROLE_HOST:$PROLE_REMOTE_DIR/$REMOTE_NAME"
echo "  → served:  /download/$REMOTE_NAME"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run — nothing built or uploaded)"
  exit 0
fi

# A universal build needs both arch targets; adding is idempotent and cheap.
if [ "$PROLE_TARGET" = "universal-apple-darwin" ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
fi

echo "→ Building (this compiles release; universal builds both arches)…"
pnpm tauri build "${BUILD_ARGS[@]}"

DMG="$(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -n1 || true)"
if [ -z "$DMG" ]; then
  echo "✗ No .dmg found in $DMG_DIR after build." >&2
  exit 1
fi
echo "✓ Built $DMG"

echo "→ Uploading to $PROLE_HOST…"
ssh "$PROLE_HOST" "mkdir -p '$PROLE_REMOTE_DIR'"
# Upload to a temp name then move, so a download mid-upload never gets a partial file.
scp "$DMG" "$PROLE_HOST:$PROLE_REMOTE_DIR/.$REMOTE_NAME.tmp"
ssh "$PROLE_HOST" "mv '$PROLE_REMOTE_DIR/.$REMOTE_NAME.tmp' '$PROLE_REMOTE_DIR/$REMOTE_NAME'"

echo "✓ Released. Download path: /download/$REMOTE_NAME"
echo "  (live at <coolify-url>/download/$REMOTE_NAME)"
