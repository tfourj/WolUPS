#!/bin/sh
# Removes the WolUPS agent. Pairing state is kept unless --purge is given.
#
#   curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall.sh | sh -s -- [--purge]
set -eu

SCRIPT_URL="https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall.sh"
PURGE=""
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE="1" ;;
    -h|--help) echo "Usage: uninstall.sh [--purge]"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Removing the WolUPS agent needs root."
  echo "Rerun with sudo: curl -fsSL $SCRIPT_URL | sudo sh"
  echo "If sudo is not installed, log in as root first (su -) and run the command again."
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now wolups-agent >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/wolups-agent.service
  systemctl daemon-reload || true
fi
rm -f /usr/local/bin/wolups-agent

if [ -n "$PURGE" ]; then
  rm -rf /var/lib/wolups-agent
  echo "WolUPS agent and pairing data removed."
else
  echo "WolUPS agent removed. Pairing data kept in /var/lib/wolups-agent (use --purge to delete it)."
fi
