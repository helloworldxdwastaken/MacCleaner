#!/bin/bash
# uninstall.sh — remove maccleaner-fanhelperd and restore automatic fan control.
#
# Designed to be run AS ROOT by a single osascript admin prompt from the app:
#
#   osascript -e 'do shell script "/path/to/uninstall.sh" \
#                 with administrator privileges'
#
# Order: restore auto fan control (so no boost outlives the daemon) -> bootout
# -> remove binary, plist, support dir, socket, newsyslog drop-in.
set -uo pipefail

LABEL="com.dronx.maccleaner.fanhelper"
HELPER_DST="/Library/PrivilegedHelperTools/${LABEL}"
PLIST_DST="/Library/LaunchDaemons/${LABEL}.plist"
SUPPORT_DIR="/Library/Application Support/${LABEL}"
SOCKET="/var/run/${LABEL}.sock"

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh must be run as root" >&2
  exit 1
fi

# 1) Restore automatic fan control before tearing anything down. Prefer the
#    installed helper; fall back to a sibling build binary.
if [ -x "$HELPER_DST" ]; then
  "$HELPER_DST" auto 2>/dev/null || true
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [ -x "${SCRIPT_DIR}/build/maccleaner-fanhelperd" ]; then
    "${SCRIPT_DIR}/build/maccleaner-fanhelperd" auto 2>/dev/null || true
  fi
fi

# 2) Stop and unload the daemon (booting it out triggers its SIGTERM handler,
#    which also restores auto as a belt-and-braces measure).
launchctl bootout system "$PLIST_DST" 2>/dev/null || true

# 3) Remove all installed files.
rm -f "$HELPER_DST" 2>/dev/null || true
rm -f "$PLIST_DST" 2>/dev/null || true
rm -f "$SOCKET" 2>/dev/null || true
rm -f "/etc/newsyslog.d/${LABEL}.conf" 2>/dev/null || true
rm -rf "$SUPPORT_DIR" 2>/dev/null || true

echo "Uninstalled ${LABEL} and restored automatic fan control."
