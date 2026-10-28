#!/usr/bin/env bash
# Build "DJ Sync.app": the menu bar app with the dj-sync service inside
# (Contents/Helpers/dj-sync), both universal (Apple silicon + Intel).
#   ./build-app.sh            → build/DJ Sync.app
#   ./build-app.sh --install  → also install to ~/Applications and launch it
# Signed with the "DJ Sync Release" identity when it exists (or
# $DJSYNC_SIGN_IDENTITY), else ad-hoc. See ../scripts/make-signing-cert.sh.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(tr -d '[:space:]' < VERSION)   # semver, single source of truth
BUILD="${VERSION%%-*}"                   # CFBundleVersion: numbers only

# Build products live outside ~/Desktop too: iCloud's file provider tags them
# and codesign (including SwiftPM's own test-bundle signing) then fails.
SCRATCH="$HOME/Library/Caches/dj-sync-menu/build"
ARCHS=(--arch arm64 --arch x86_64)
swift build -c release --product DJSyncMenu --scratch-path "$SCRATCH" "${ARCHS[@]}"
MENU="$(swift build -c release --scratch-path "$SCRATCH" "${ARCHS[@]}" --show-bin-path)/DJSyncMenu"

# The service, one slice per architecture, joined with lipo.
CRATE="$(cd .. && pwd)"
SERVICE_SLICES=()
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$target" || rustup target add "$target"
  cargo build --release --locked --manifest-path "$CRATE/Cargo.toml" --bin dj-sync --target "$target"
  SERVICE_SLICES+=("$CRATE/target/$target/release/dj-sync")
done

# Assemble and sign outside the repo: ~/Desktop is managed by iCloud's file
# provider, which re-tags new bundles with Finder/provider xattrs that
# codesign rejects ("resource fork, Finder information … not allowed").
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/DJ Sync.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$MENU" "$APP/Contents/MacOS/DJSyncMenu"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"   # from ../scripts/make-icon.py
lipo -create -output "$APP/Contents/Helpers/dj-sync" "${SERVICE_SLICES[@]}"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" Info.plist.in > "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"
xattr -cr "$APP"

IDENTITY="${DJSYNC_SIGN_IDENTITY:-}"
# Self-signed, so it isn't "valid" (-v) to the trust system; codesign still
# uses it, and its designated requirement stays the same across builds.
if [[ -z "$IDENTITY" ]] && security find-identity -p codesigning | grep -q '"DJ Sync Release"'; then
  IDENTITY="DJ Sync Release"
fi
SIGN=(--force --timestamp=none --sign "${IDENTITY:--}")
# Inside out: the nested service first, then the app around it.
codesign "${SIGN[@]}" --identifier com.triplejmusic.dj-sync "$APP/Contents/Helpers/dj-sync"
codesign "${SIGN[@]}" "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p build
rm -rf "build/DJ Sync.app"
ditto "$APP" "build/DJ Sync.app"
echo "built build/DJ Sync.app ($VERSION, signed by ${IDENTITY:-ad-hoc})"

if [[ "${1:-}" == "--install" ]]; then
  DEST="$HOME/Applications/DJ Sync.app"
  mkdir -p "$HOME/Applications"
  pkill -x DJSyncMenu 2>/dev/null || true
  # Wait for the old copy to exit, or LaunchServices fails the open (-600).
  for _ in {1..50}; do pgrep -x DJSyncMenu >/dev/null || break; sleep 0.1; done
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  codesign --verify --deep --strict "$DEST"
  # On launch the app installs Helpers/dj-sync as the LaunchAgent's service.
  open "$DEST"
  echo "installed $DEST"
fi
