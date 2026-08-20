#!/usr/bin/env bash
set -euo pipefail

# One-way local PostgreSQL -> Neon mirror.
#
# This is intentionally a snapshot mirror rather than a native Postgres
# subscription: the local Paperclip database is loopback-only and currently
# runs with wal_level=replica. launchd invokes this script on a cadence.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PAPERCLIP_HOME_DIR="${PAPERCLIP_HOME:-$HOME/.paperclip}"
INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME_DIR/instances/$INSTANCE_ID"
STATE_DIR="$INSTANCE_ROOT/data/neon-mirror"
STATUS_FILE="$STATE_DIR/status.json"
LOCK_DIR="$STATE_DIR/.lock"
KEYCHAIN_SERVICE="${PAPERCLIP_NEON_MIRROR_KEYCHAIN_SERVICE:-paperclip-neon-mirror}"
SOURCE_DATABASE_URL="${PAPERCLIP_MIRROR_SOURCE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"
CREDENTIALS_FILE="$STATE_DIR/credentials.env"

if [[ -f "$CREDENTIALS_FILE" ]]; then
  # The installer creates this file with mode 0600. It contains only the
  # dedicated mirror URL and is intentionally outside the repository.
  # shellcheck disable=SC1090
  source "$CREDENTIALS_FILE"
fi

mkdir -p "$STATE_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "neon mirror already running" >&2
  exit 0
fi
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

write_status() {
  local status="$1"
  local message="${2:-}"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  MESSAGE="$message" NOW="$now" STATUS="$status" STATUS_PATH="$STATUS_FILE" node <<'NODE'
const fs = require("node:fs");
const path = process.env.STATUS_PATH;
let previous = {};
try { previous = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
const output = {
  ...previous,
  status: process.env.STATUS,
  message: process.env.MESSAGE,
  updatedAt: process.env.NOW,
};
if (process.env.STATUS === "running") output.startedAt = process.env.NOW;
if (process.env.STATUS === "ok") output.lastSuccessAt = process.env.NOW;
if (process.env.STATUS === "error") output.lastFailureAt = process.env.NOW;
fs.writeFileSync(path, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
NODE
}

NEON_DATABASE_URL="${PAPERCLIP_MIRROR_NEON_URL:-}"
if [[ -z "$NEON_DATABASE_URL" ]]; then
  NEON_DATABASE_URL="$(security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
fi
if [[ -z "$NEON_DATABASE_URL" ]]; then
  write_status error "Neon connection string is missing from macOS Keychain service $KEYCHAIN_SERVICE"
  echo "Missing Neon connection string in Keychain service: $KEYCHAIN_SERVICE" >&2
  exit 1
fi

write_status running "Starting snapshot mirror"
WORK_DIR="$(mktemp -d "$STATE_DIR/run.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap 'cleanup_work; cleanup' EXIT

on_error() {
  local code=$?
  write_status error "Mirror failed with exit code $code"
  exit "$code"
}
trap on_error ERR

DUMP_FILE="$WORK_DIR/paperclip.dump"
echo "[$(date -u +%FT%TZ)] dumping local Paperclip database"
pg_dump --format=custom --no-owner --no-privileges --file "$DUMP_FILE" "$SOURCE_DATABASE_URL"

echo "[$(date -u +%FT%TZ)] restoring mirror to Neon"
pg_restore --clean --if-exists --exit-on-error --single-transaction --no-owner --no-privileges --dbname "$NEON_DATABASE_URL" "$DUMP_FILE"

table_names() {
  local database_url="$1"
  psql "$database_url" -Atqc \
    "select tablename from pg_tables where schemaname = 'public' order by tablename"
}

echo "[$(date -u +%FT%TZ)] verifying public-table parity"
table_names "$SOURCE_DATABASE_URL" > "$WORK_DIR/source-table-names"
table_names "$NEON_DATABASE_URL" > "$WORK_DIR/neon-table-names"
if ! cmp -s "$WORK_DIR/source-table-names" "$WORK_DIR/neon-table-names"; then
  echo "source and Neon public-table names differ" >&2
  diff -u "$WORK_DIR/source-table-names" "$WORK_DIR/neon-table-names" >&2 || true
  exit 1
fi

# Writes may legitimately land on the local source during a dump, so exact
# row-count equality is not a valid assertion. This catches the dangerous
# case: a table that currently has source rows but is empty in Neon.
table_counts() {
  local database_url="$1"
  psql "$database_url" -Atqc \
    "select format('select %L, count(*) from %I.%I', schemaname, schemaname, tablename)
       from pg_tables where schemaname = 'public' order by tablename" \
    | while IFS= read -r query; do
        psql "$database_url" -Atqc "$query"
      done
}
table_counts "$SOURCE_DATABASE_URL" > "$WORK_DIR/source-table-counts"
table_counts "$NEON_DATABASE_URL" > "$WORK_DIR/neon-table-counts"
if ! awk -F'|' 'NR == FNR { source[$1] = $2; next } $2 == 0 && source[$1] > 0 { print $1 ": source=" source[$1] ", Neon=0"; bad=1 } END { exit bad }' \
  "$WORK_DIR/source-table-counts" "$WORK_DIR/neon-table-counts"; then
  echo "one or more non-empty source tables are empty in Neon" >&2
  exit 1
fi

DUMP_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
write_status ok "Mirror completed; dump bytes: $DUMP_BYTES"
echo "[$(date -u +%FT%TZ)] mirror completed ($DUMP_BYTES dump bytes)"
