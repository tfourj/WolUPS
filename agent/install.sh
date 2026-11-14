#!/bin/sh
# WolUPS agent installer for Linux systemd hosts (amd64, arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/install.sh | sh -s -- --server URL --token TOKEN
#
# Run it as root (the default on Proxmox). It never calls sudo itself.
set -eu

RELEASE_BASE="https://github.com/tfourj/WolUPS/releases/latest/download"
SCRIPT_URL="https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/install.sh"
BIN_PATH="/usr/local/bin/wolups-agent"
UNIT_PATH="/etc/systemd/system/wolups-agent.service"
STATE_DIR="/var/lib/wolups-agent"

SERVER=""
TOKEN=""
ALLOW_HTTP=""
LOCAL_BINARY=""

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage: install.sh [--server URL] [--token TOKEN] [--release-base URL] [--allow-http] [--binary PATH]

Installs or upgrades the WolUPS agent and pairs it with your WolUPS server.
Without --token on an already paired machine, only the binary is upgraded.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --release-base) RELEASE_BASE="${2:-}"; shift 2 ;;
    --allow-http) ALLOW_HTTP="1"; shift ;;
    --binary) LOCAL_BINARY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  say "The WolUPS agent installer needs root to install a system service."
  say ""
  say "Rerun the same command with sudo, for example:"
  say "  curl -fsSL $SCRIPT_URL | sudo sh -s -- --server <url> --token <token>"
  say ""
  say "If sudo is not installed, log in as root first (su -) and run the command again."
  exit 1
fi

[ "$(uname -s)" = "Linux" ] || fail "only Linux is supported"
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail "systemd is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required (coreutils)"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  probe() { curl -fsS -o /dev/null --max-time 10 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  probe() { wget -q -O /dev/null -T 10 "$1"; }
else
  fail "curl or wget is required"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

PAIRED=""
[ -f "$STATE_DIR/state.json" ] && PAIRED="1"

if [ -z "$TOKEN" ] && [ -z "$PAIRED" ]; then
  [ -r /dev/tty ] || fail "--server and --token are required"
  if [ -z "$SERVER" ]; then
    printf 'WolUPS URL (for example https://wolups.example.com): ' >/dev/tty
    read -r SERVER </dev/tty
  fi
  printf 'Enrollment token: ' >/dev/tty
  read -r TOKEN </dev/tty
fi

if [ -n "$TOKEN" ]; then
  [ -n "$SERVER" ] || fail "--server is required with --token"
  SERVER="${SERVER%/}"
  case "$SERVER" in
    https://*) ;;
    http://*) [ -n "$ALLOW_HTTP" ] || fail "server URL must use https (add --allow-http only on a trusted LAN)" ;;
    *) fail "server URL must start with https://" ;;
  esac
  say "Checking WolUPS at $SERVER ..."
  probe "$SERVER/api/health" || fail "cannot reach $SERVER/api/health from this machine"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
ASSET="wolups-agent-linux-$ARCH"

if [ -n "$LOCAL_BINARY" ]; then
  say "Using local binary $LOCAL_BINARY"
  cp "$LOCAL_BINARY" "$TMP/$ASSET"
else
  say "Downloading $ASSET ..."
  fetch "$RELEASE_BASE/$ASSET" "$TMP/$ASSET" || fail "download failed: $RELEASE_BASE/$ASSET"
  fetch "$RELEASE_BASE/$ASSET.sha256" "$TMP/$ASSET.sha256" || fail "checksum download failed"
  (cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null) || fail "checksum verification failed"
  say "Checksum verified"
fi

chmod 0755 "$TMP/$ASSET"
"$TMP/$ASSET" version >/dev/null || fail "downloaded binary does not run on this machine"

if systemctl is-active --quiet wolups-agent 2>/dev/null; then
  systemctl stop wolups-agent
fi
install -m 0755 "$TMP/$ASSET" "$BIN_PATH.new"
mv -f "$BIN_PATH.new" "$BIN_PATH"
say "Installed $("$BIN_PATH" version)"

if [ -n "$TOKEN" ]; then
  if [ -n "$ALLOW_HTTP" ]; then
    "$BIN_PATH" enroll --server "$SERVER" --token "$TOKEN" --release-base "$RELEASE_BASE" --allow-http
  else
    "$BIN_PATH" enroll --server "$SERVER" --token "$TOKEN" --release-base "$RELEASE_BASE"
  fi
fi

cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=WolUPS agent
Documentation=https://github.com/tfourj/WolUPS
After=network-online.target
Wants=network-online.target
# Stop after Proxmox has shut down its guests, so WolUPS still sees the host while VMs and LXCs stop.
# Harmless on hosts without Proxmox.
Before=pve-guests.service

[Service]
Type=simple
ExecStart=$BIN_PATH serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=$STATE_DIR /usr/local/bin
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# Hard limits, so a bug can never fill the disk with logs or eat the host's memory
LogRateLimitIntervalSec=60
LogRateLimitBurst=100
MemoryHigh=64M
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable wolups-agent >/dev/null 2>&1
systemctl restart wolups-agent
sleep 2
systemctl is-active --quiet wolups-agent || fail "service did not start, check: journalctl -u wolups-agent"

say ""
say "WolUPS agent is running. Logs: journalctl -u wolups-agent -f"
