#!/usr/bin/env bash
# EngOrg Pi installer — sets up the headless companion service on a Raspberry Pi (3 or newer).
#
#   curl -fsSLO https://github.com/carsonbellak/engorg-taskboard/releases/download/latest/EngOrg-Pi.tar.gz
#   mkdir engorg-pi && tar -xzf EngOrg-Pi.tar.gz -C engorg-pi
#   sudo bash engorg-pi/pi/install.sh            # install or upgrade
#   sudo bash engorg-pi/pi/install.sh --uninstall
#
# Layout: /opt/engorg-pi/{releases/<version>, current -> releases/<version>, data/, node/}
# Service: engorg-pi.service (user "engorg"). After this, the Pi keeps itself updated from
# GitHub releases, so you only run this once.
set -euo pipefail

PREFIX=/opt/engorg-pi
SERVICE=engorg-pi
NODE_MAJOR=22
BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "✗ $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash $0"
[ "$(uname -s)" = Linux ] || die "This installer is for Linux (Raspberry Pi OS)."

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service" /usr/local/bin/engorg-pi
  systemctl daemon-reload
  echo "✓ Service removed. Releases + data are still in $PREFIX (sudo rm -rf $PREFIX to delete them)."
  exit 0
fi

[ -f "$BUNDLE/pi/server.js" ] && [ -f "$BUNDLE/package.json" ] || die "Run this from an extracted EngOrg-Pi bundle."
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$BUNDLE/package.json" | head -1)
[ -n "$VERSION" ] || die "Bundle has no version."
echo "• Installing EngOrg Pi v$VERSION"

# ── Node.js (>= 20; a Pi-local copy is used when the system one is too old) ─────────────
node_ok() { "$1" -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)' 2>/dev/null; }
NODE=""
if [ -x "$PREFIX/node/bin/node" ] && node_ok "$PREFIX/node/bin/node"; then
  NODE="$PREFIX/node/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
else
  case "$(uname -m)" in
    armv7l) ARCH=armv7l ;;
    aarch64|arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) die "Unsupported CPU $(uname -m) — needs a Pi 2/3/4/5 (ARMv7 or 64-bit)." ;;
  esac
  echo "• Installing Node.js $NODE_MAJOR for $ARCH…"
  BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt") || die "Could not reach nodejs.org"
  FILE=$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$ARCH\.tar\.gz$" | head -1)
  [ -n "$FILE" ] || die "No Node.js $NODE_MAJOR build for $ARCH — use 64-bit Raspberry Pi OS."
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $FILE\$" | sha256sum -c - >/dev/null) || die "Node.js download failed its checksum."
  rm -rf "$PREFIX/node" && mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/$FILE" -C "$PREFIX/node" --strip-components=1
  rm -rf "$TMP"
  NODE="$PREFIX/node/bin/node"
fi
echo "• Node $("$NODE" -v) at $NODE"

# ── Service user + release ────────────────────────────────────────────────────────────
id engorg >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --no-create-home --shell /usr/sbin/nologin engorg
mkdir -p "$PREFIX/releases" "$PREFIX/data"
DEST="$PREFIX/releases/$VERSION"
rm -rf "$DEST.partial" && mkdir -p "$DEST.partial"
cp -a "$BUNDLE/." "$DEST.partial/"
"$NODE" "$DEST.partial/pi/server.js" --selftest || { rm -rf "$DEST.partial"; die "Self-test failed — nothing changed."; }
rm -rf "$DEST" && mv "$DEST.partial" "$DEST"
ln -sfn "$DEST" "$PREFIX/current"
chown -R engorg:engorg "$PREFIX"
chmod 750 "$PREFIX/data"

# ── systemd unit + CLI ─────────────────────────────────────────────────────────────────
sed "s#@NODE@#$NODE#" "$DEST/pi/engorg-pi.service" > "/etc/systemd/system/$SERVICE.service"
cat > /usr/local/bin/engorg-pi <<EOF
#!/bin/sh
# EngOrg Pi CLI:  sudo engorg-pi code | reset-pairing | status | logs | restart
case "\$1" in
  status)  exec systemctl status $SERVICE ;;
  logs)    exec journalctl -u $SERVICE -f ;;
  restart) exec systemctl restart $SERVICE ;;
esac
[ "\$(id -u)" -eq 0 ] || { echo "Use sudo: sudo engorg-pi \$*" >&2; exit 1; }
exec runuser -u engorg -- env ENGORG_PI_DATA=$PREFIX/data $NODE $PREFIX/current/pi/server.js "\$@"
EOF
chmod 755 /usr/local/bin/engorg-pi

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || die "Service failed to start — see: journalctl -u $SERVICE -e"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
CODE=$(/usr/local/bin/engorg-pi code 2>/dev/null || echo "?")
cat <<EOF

✓ EngOrg Pi v$VERSION is running.

  Pair it from the desktop app: Settings → Integrations → Raspberry Pi → Find Pi
    Address:       ${IP:-<this Pi's IP>}  (port 8780)
    Pairing code:  $CODE
  Status page:     http://${IP:-<pi-ip>}:8780/
  Commands:        sudo engorg-pi code | logs | status | restart

  If a firewall (ufw) is on, allow the LAN in:  sudo ufw allow 8780/tcp && sudo ufw allow 8781/udp
EOF
