#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.paperclip.neon-mirror"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/data/neon-mirror"
SERVICE="${PAPERCLIP_NEON_MIRROR_KEYCHAIN_SERVICE:-paperclip-neon-mirror}"
NODE_BIN_DIR="$(dirname "$(command -v node)")"

command -v neon >/dev/null || { echo "neon CLI is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }

mkdir -p "$AGENTS_DIR" "$LOG_DIR"

node "$SCRIPT_DIR/configure-neon-mirror.mjs"

TEMP_PLIST="$(mktemp)"
trap 'rm -f "$TEMP_PLIST"' EXIT
sed \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  -e "s|__KEYCHAIN_SERVICE__|$SERVICE|g" \
  "$SCRIPT_DIR/com.paperclip.neon-mirror.plist" > "$TEMP_PLIST"
mv "$TEMP_PLIST" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "Logs: $LOG_DIR"
echo "Status: $LOG_DIR/status.json"
