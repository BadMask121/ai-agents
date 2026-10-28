#!/usr/bin/env bash
# Build "DJ Sync.app" (menu bar companion for dj-sync).
#   ./build-app.sh            → build/DJ Sync.app
#   ./build-app.sh --install  → also install to ~/Applications and launch it
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(tr -d '[:space:]' < VERSION)   # semver, single source of truth

swift build -c release --product DJSyncMenu
BIN="$(swift build -c release --show-bin-path)/DJSyncMenu"

# Assemble and sign outside the repo: ~/Desktop is managed by iCloud's file
# provider, which re-tags new bundles with Finder/provider xattrs that
# codesign rejects ("resource fork, Finder information … not allowed").
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/DJ Sync.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/DJSyncMenu"
sed "s/__VERSION__/$VERSION/g" Info.plist.in > "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"
xattr -cr "$APP"
# Ad-hoc signature: enough to run locally and to register as a login item.
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p build
rm -rf "build/DJ Sync.app"
ditto "$APP" "build/DJ Sync.app"
echo "built build/DJ Sync.app ($VERSION)"

if [[ "${1:-}" == "--install" ]]; then
  DEST="$HOME/Applications/DJ Sync.app"
  mkdir -p "$HOME/Applications"
  pkill -x DJSyncMenu 2>/dev/null || true
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  codesign --verify --deep --strict "$DEST"
  open "$DEST"
  echo "installed $DEST"
fi
