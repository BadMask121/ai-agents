#!/bin/bash
# Creates the self-made code-signing identity "DJ Sync Release" (spec §2.6)
# once, in the login keychain, with a .p12 backup in ~/.dj-sync-release/.
# Every release is signed with it, so macOS keeps DJ Sync's permissions
# (notifications, folders) across updates. Not an Apple Developer ID: DJs
# still click "Open Anyway" once.
set -euo pipefail
NAME="DJ Sync Release"
DIR="$HOME/.dj-sync-release"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "identity \"$NAME\" already exists"; exit 0
fi
mkdir -p "$DIR"; chmod 700 "$DIR"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/cert.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
O = Triple J Music
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
PASS=$(/usr/bin/openssl rand -base64 24)
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$NAME" -passout "pass:$PASS" -out "$DIR/dj-sync-release.p12"
printf '%s\n' "$PASS" > "$DIR/dj-sync-release.p12.password"
chmod 600 "$DIR/dj-sync-release.p12" "$DIR/dj-sync-release.p12.password"
cp "$WORK/cert.pem" "$DIR/dj-sync-release.cert.pem"
security import "$DIR/dj-sync-release.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "imported \"$NAME\" into the login keychain; backup in $DIR (keep it safe)"
