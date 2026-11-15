#!/bin/sh
# Removes the WolUPS NUT agent. NUT and its config stay installed. Pairing state is kept unless --purge is given.
#
#   curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall-nut.sh | sh -s -- [--purge]
set -eu

SCRIPT_URL="https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall-nut.sh"
PURGE=""
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE="1" ;;
    -h|--help) echo "Usage: uninstall-nut.sh [--purge]"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Removing the WolUPS NUT agent needs root."
  echo "Rerun with sudo: curl -fsSL $SCRIPT_URL | sudo sh"
  echo "If sudo is not installed, log in as root first (su -) and run the command again."
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now wolups-nut-agent >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/wolups-nut-agent.service
  systemctl daemon-reload || true
fi
rm -f /usr/local/bin/wolups-nut-agent

if [ -n "$PURGE" ]; then
  rm -rf /var/lib/wolups-nut-agent
  echo "WolUPS NUT agent and pairing data removed."
else
  echo "WolUPS NUT agent removed. Pairing data kept in /var/lib/wolups-nut-agent (use --purge to delete it)."
fi
