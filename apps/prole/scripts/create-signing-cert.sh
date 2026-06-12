#!/usr/bin/env bash
#
# Create a stable, self-signed code-signing identity for Prole so macOS
# stops re-asking for Screen Recording permission on every rebuild.
#
# Why this is needed:
#   Screen capture (screencapture -i) requires the macOS Screen Recording TCC
#   grant, attributed to the *app binary*. macOS keys that grant to the app's
#   Designated Requirement. An ad-hoc/unsigned build's DR is its cdhash, which
#   changes on every `cargo build` — so the grant never sticks and you get
#   re-prompted. Signing every build with the SAME self-signed certificate gives
#   the app a stable DR (anchored to this cert's identity), so you grant Screen
#   Recording once and it persists across rebuilds.
#
# This cert is for LOCAL DEV ONLY. It is not trusted for distribution and does
# not replace a real Apple Developer ID for shipping a notarized .app.
#
# Idempotent: re-running is a no-op once the identity exists.
# Run once:  bash scripts/create-signing-cert.sh

set -euo pipefail

CERT_NAME="Prole Code Signing"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -qF "$CERT_NAME"; then
  echo "✓ Code-signing identity '$CERT_NAME' already exists. Nothing to do."
  exit 0
fi

echo "Creating self-signed code-signing identity '$CERT_NAME'…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Prole Code Signing
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -config "$WORK/openssl.cnf" >/dev/null 2>&1

openssl pkcs12 -export -legacy \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$CERT_NAME" -out "$WORK/cert.p12" -passout pass: >/dev/null 2>&1

# Import the key+cert, granting codesign access to the private key.
security import "$WORK/cert.p12" -k "$LOGIN_KEYCHAIN" -P "" \
  -T /usr/bin/codesign >/dev/null

# Avoid the "codesign wants to use a key" GUI prompt on every signing run.
# Prompts once for your login (keychain) password.
echo "Authorizing codesign to use the key (enter your login/keychain password):"
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$(read -rsp 'Password: ' p; echo "$p")" "$LOGIN_KEYCHAIN" >/dev/null
echo

echo "✓ Created '$CERT_NAME'. Verify with: security find-identity -v -p codesigning"
echo "  Next: rebuild the app, then grant Screen Recording once — it will now persist."
