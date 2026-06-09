#!/usr/bin/env bash
#
# Sign the current dev/debug build with the stable self-signed identity so the
# Screen Recording grant persists across `tauri dev` iterations.
#
# `tauri.conf.json` -> bundle.macOS.signingIdentity only signs the bundled .app
# produced by `tauri build`. `tauri dev` runs the bare, unsigned target/debug
# binary, which is rebuilt (with a fresh cdhash) on every change — so dev still
# re-prompts unless re-signed. Run this after a debug build, before launching:
#
#   bash scripts/sign-dev.sh
#
# Prereq: scripts/create-signing-cert.sh has been run once.

set -euo pipefail

CERT_NAME="Proletariat Code Signing"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! security find-identity -v -p codesigning | grep -qF "$CERT_NAME"; then
  echo "✗ Identity '$CERT_NAME' not found. Run scripts/create-signing-cert.sh first." >&2
  exit 1
fi

signed_any=0
for target in \
  "$ROOT/src-tauri/target/debug/proletariat" \
  "$ROOT/src-tauri/target/debug/bundle/macos/Proletariat.app" \
  "$ROOT/src-tauri/target/release/bundle/macos/Proletariat.app"; do
  if [ -e "$target" ]; then
    codesign --force --sign "$CERT_NAME" "$target"
    echo "✓ Signed $target"
    signed_any=1
  fi
done

if [ "$signed_any" -eq 0 ]; then
  echo "Nothing to sign — build the app first (e.g. cargo build or pnpm tauri dev)." >&2
  exit 1
fi
