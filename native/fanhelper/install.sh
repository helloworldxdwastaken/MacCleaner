#!/bin/bash
# install.sh — install maccleaner-fanhelperd as a root LaunchDaemon.
#
# Designed to be run AS ROOT by a single osascript admin prompt from the app:
#
#   osascript -e 'do shell script "/path/to/install.sh /path/to/binary <uid>" \
#                 with administrator privileges'
#
# Arguments:
#   $1  path to the built maccleaner-fanhelperd binary (required)
#   $2  uid to authorize as the non-root client (optional; defaults to the
#       console user / SUDO_UID). This uid is recorded so the daemon accepts
#       socket connections only from root or this user (verified via
#       getpeereid()).
#
# Steps: copy binary -> /Library/PrivilegedHelperTools, plist ->
# /Library/LaunchDaemons, chown root:wheel, chmod, write allowed-uid, write a
# newsyslog.d log-rotation drop-in, then launchctl bootstrap.
set -euo pipefail

LABEL="com.dronx.maccleaner.fanhelper"
HELPER_DST="/Library/PrivilegedHelperTools/${LABEL}"
PLIST_DST="/Library/LaunchDaemons/${LABEL}.plist"
SUPPORT_DIR="/Library/Application Support/${LABEL}"
ALLOWED_UID_FILE="${SUPPORT_DIR}/allowed-uid"
SOCKET="/var/run/${LABEL}.sock"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must be run as root" >&2
  exit 1
fi

# --- resolve arguments -------------------------------------------------------
BIN_SRC="${1:-}"
if [ -z "$BIN_SRC" ] || [ ! -f "$BIN_SRC" ]; then
  # Fall back to a sibling ./build/ binary next to this script.
  if [ -f "${SCRIPT_DIR}/build/maccleaner-fanhelperd" ]; then
    BIN_SRC="${SCRIPT_DIR}/build/maccleaner-fanhelperd"
  else
    echo "usage: install.sh <path-to-binary> [uid]" >&2
    exit 1
  fi
fi

# Determine the uid to authorize.
CLIENT_UID="${2:-}"
if [ -z "$CLIENT_UID" ]; then
  CLIENT_UID="${SUDO_UID:-}"
fi
if [ -z "$CLIENT_UID" ]; then
  # Console user (the logged-in GUI user).
  CLIENT_UID="$(stat -f '%u' /dev/console 2>/dev/null || echo '')"
fi
if [ -z "$CLIENT_UID" ]; then
  echo "could not determine client uid; pass it as arg 2" >&2
  exit 1
fi

echo "Installing ${LABEL} (authorizing uid ${CLIENT_UID})"

# --- copy binary -------------------------------------------------------------
mkdir -p "$(dirname "$HELPER_DST")"
cp -f "$BIN_SRC" "$HELPER_DST"
chown root:wheel "$HELPER_DST"
chmod 544 "$HELPER_DST"

# --- write plist -------------------------------------------------------------
cp -f "${SCRIPT_DIR}/${LABEL}.plist" "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"

# --- write allowed-uid -------------------------------------------------------
mkdir -p "$SUPPORT_DIR"
chown root:wheel "$SUPPORT_DIR"
chmod 755 "$SUPPORT_DIR"
printf '%s\n' "$CLIENT_UID" > "$ALLOWED_UID_FILE"
chown root:wheel "$ALLOWED_UID_FILE"
chmod 644 "$ALLOWED_UID_FILE"

# --- newsyslog drop-in -------------------------------------------------------
# The LaunchDaemon appends stderr to /var/log/... forever; without rotation a
# rejection flood or a chatty daemon would grow it unbounded. newsyslog picks
# this drop-in up automatically (no daemon cooperation needed): rotate at
# 1 MB (1024 KB), keep 3 rotated files.
NEWSYSLOG_CONF="/etc/newsyslog.d/${LABEL}.conf"
cat > "$NEWSYSLOG_CONF" <<'EOF'
# logfilename                                [owner:group] mode count size when  flags
/var/log/com.dronx.maccleaner.fanhelper.log                 644  3     1024 *     J
EOF
chown root:wheel "$NEWSYSLOG_CONF"
chmod 644 "$NEWSYSLOG_CONF"

# --- (re)bootstrap the daemon ------------------------------------------------
# Bootout any prior instance first (ignore errors on fresh install).
launchctl bootout system "$PLIST_DST" 2>/dev/null || true
rm -f "$SOCKET" 2>/dev/null || true
launchctl bootstrap system "$PLIST_DST"
launchctl enable "system/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "system/${LABEL}" 2>/dev/null || true

echo "Installed. Daemon socket: ${SOCKET}"
