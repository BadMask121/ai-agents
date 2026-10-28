#!/bin/bash
# Cut a DJ Sync release (spec §4): build the universal, signed app, package
# the DMG (first install) and zip (updates), sign the update feed and the
# tools manifest with the release key, upload everything to R2
# (downloads.triplejmusic.art/djsync/), and tag the commit.
#
#   ./release.sh            build, package, sign, upload, tag
#   ./release.sh --dry-run  everything except upload and tag
#
# Needs: a clean apps/dj-sync tree, matching versions in Cargo.toml and
# macos/VERSION, a CHANGELOG entry for that version, the "DJ Sync Release"
# signing identity (scripts/make-signing-cert.sh) and the Ed25519 release key
# (~/.dj-sync-release/ed25519.key, `dj-sync-sign keygen`).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

BUCKET="dj-sync-downloads"
PREFIX="djsync"
BASE_URL="https://downloads.triplejmusic.art/$PREFIX"
WRANGLER="$HERE/../dj-sync-cloud/node_modules/.bin/wrangler"

die() { echo "release: $*" >&2; exit 1; }

# ---- checks ----
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP_VERSION=$(tr -d '[:space:]' < macos/VERSION)
[[ "$VERSION" == "$APP_VERSION" ]] || die "Cargo.toml ($VERSION) and macos/VERSION ($APP_VERSION) differ"
grep -q "^## \[$VERSION\]" CHANGELOG.md || die "CHANGELOG.md has no [$VERSION] entry"
grep -q "^## \[$VERSION\]" macos/CHANGELOG.md || die "macos/CHANGELOG.md has no [$VERSION] entry"
if [[ $DRY -eq 0 ]]; then
  git diff --quiet -- . && git diff --cached --quiet -- . || die "apps/dj-sync has uncommitted changes"
  ! git rev-parse -q --verify "refs/tags/djsync-v$VERSION" >/dev/null || die "tag djsync-v$VERSION exists"
fi
security find-identity -p codesigning | grep -q '"DJ Sync Release"' || die "no \"DJ Sync Release\" identity (scripts/make-signing-cert.sh)"
[[ -x "$WRANGLER" ]] || die "wrangler not found at $WRANGLER (pnpm install in apps/dj-sync-cloud)"

OUT="$HOME/Library/Caches/dj-sync-release/$VERSION"
rm -rf "$OUT"; mkdir -p "$OUT"
echo "== DJ Sync $VERSION → $OUT"

# ---- build ----
cargo build --release --features release-tools --bin dj-sync-sign -q
SIGNER="$HERE/target/release/dj-sync-sign"
DJSYNC_SIGN_IDENTITY="DJ Sync Release" ./macos/build-app.sh
APP="$HERE/macos/build/DJ Sync.app"
[[ -d "$APP" ]] || die "build-app.sh didn't produce $APP"

# ---- verify the bundle ----
[[ $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString) == "$VERSION" ]] || die "app version isn't $VERSION"
for bin in "$APP/Contents/MacOS/DJSyncMenu" "$APP/Contents/Helpers/dj-sync"; do
  info=$(lipo -info "$bin")
  [[ "$info" == *x86_64* && "$info" == *arm64* ]] || die "$bin isn't universal: $info"
done
codesign --verify --strict --verbose=1 "$APP" 2>&1 | tail -1
codesign -dvv "$APP" 2>&1 | grep -q "Authority=DJ Sync Release" || die "app isn't signed by DJ Sync Release"

# ---- package ----
STAGE="$OUT/dmg"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/DJ Sync.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/If macOS blocks DJ Sync.html" <<HTML
<!doctype html><meta charset="utf-8"><title>Opening DJ Sync</title>
<body style="font:16px/1.5 -apple-system,sans-serif;max-width:34em;margin:3em auto;padding:0 1em">
<h1>Opening DJ Sync the first time</h1>
<p>DJ Sync is free and isn't sold through Apple, so macOS asks you to confirm it once.</p>
<ol>
<li>Drag <b>DJ Sync</b> onto <b>Applications</b>, then open it from Applications.</li>
<li>When macOS says it can't verify DJ Sync, click <b>Done</b>.</li>
<li>Open <b>System Settings → Privacy &amp; Security</b>, scroll down, and click <b>Open Anyway</b> next to DJ Sync.</li>
<li>Confirm with your password or Touch ID. You won't be asked again; updates install themselves.</li>
</ol>
<p>Step-by-step pictures: <a href="https://djsync.triplejmusic.art/install/">djsync.triplejmusic.art/install</a></p>
</body>
HTML
DMG="$OUT/DJ-Sync-$VERSION.dmg"
hdiutil create -quiet -volname "DJ Sync $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
ZIP="$OUT/DJ-Sync-$VERSION.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -f %z "$1"; }
NOTES=$(awk -v v="$VERSION" '$0 ~ "^## \\[" v "\\]" {on=1; next} on && /^## \[/ {exit} on' macos/CHANGELOG.md | sed '/^$/d' | head -20)
V="$VERSION" B="$BASE_URL" N="$NOTES" Z_SHA=$(sha "$ZIP") Z_SIZE=$(size "$ZIP") \
python3 - "$OUT/appcast.json" <<'PY'
import datetime, json, os, sys
e = os.environ
json.dump({"latest": {
    "version": e["V"],
    "min_macos": "14.0",
    "url": f"{e['B']}/DJ-Sync-{e['V']}.zip",
    "dmg_url": f"{e['B']}/DJ-Sync-{e['V']}.dmg",
    "sha256": e["Z_SHA"],
    "size": int(e["Z_SIZE"]),
    "published_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": e["N"],
}}, open(sys.argv[1], "w"), indent=2)
PY
cp toolbox/manifest.json "$OUT/tools-manifest.json"
"$SIGNER" sign "$OUT/appcast.json" "$OUT/tools-manifest.json"
"$SIGNER" verify "$OUT/appcast.json"
"$SIGNER" verify "$OUT/tools-manifest.json"
echo "== packaged: $(du -h "$DMG" | cut -f1) DMG, $(du -h "$ZIP" | cut -f1) zip"

if [[ $DRY -eq 1 ]]; then
  echo "== dry run: not uploading or tagging"; ls -la "$OUT"; exit 0
fi

# ---- upload (versioned files first, then the pointers) ----
put() { # file key content-type cache-control
  "$WRANGLER" r2 object put "$BUCKET/$PREFIX/$2" --file "$1" --content-type "$3" --cache-control "$4" --remote >/dev/null
  echo "   uploaded $PREFIX/$2"
}
IMMUTABLE="public, max-age=31536000, immutable"; SHORT="public, max-age=300"
put "$DMG" "DJ-Sync-$VERSION.dmg" application/x-apple-diskimage "$IMMUTABLE"
put "$ZIP" "DJ-Sync-$VERSION.zip" application/zip "$IMMUTABLE"
put "$OUT/tools-manifest.json.sig" tools-manifest.json.sig text/plain "$SHORT"
put "$OUT/tools-manifest.json" tools-manifest.json application/json "$SHORT"
put "$DMG" DJ-Sync-latest.dmg application/x-apple-diskimage "$SHORT"
put "$OUT/appcast.json.sig" appcast.json.sig text/plain "$SHORT"
put "$OUT/appcast.json" appcast.json application/json "$SHORT"

git tag -a "djsync-v$VERSION" -m "DJ Sync $VERSION"
echo "== released DJ Sync $VERSION: $BASE_URL/DJ-Sync-latest.dmg (tag djsync-v$VERSION; push it with git push --tags)"
