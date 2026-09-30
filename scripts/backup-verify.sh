#!/usr/bin/env bash
# Nightly backup + restore verification.
# Dumps DATABASE_URL, restores into a scratch database and checks row counts match.
#
# Usage: scripts/backup-verify.sh [-n SCHEMA]
#   -n SCHEMA   dump/verify only this schema (default: public). Passed to pg_dump as --schema.
#
# Env: DATABASE_URL (source), RESTORE_ADMIN_URL (a URL to the same or another server's "postgres" DB), BACKUP_DIR.
#
# Supabase / pooled Postgres: pg_dump and pg_restore need a session-mode or direct connection.
# Do NOT point DATABASE_URL at the transaction pooler (Supavisor port 6543): pg_dump uses session state
# (SET commands, snapshots, COPY) that a transaction pooler does not keep between statements, and dumps
# can fail or be inconsistent. Use the direct host (db.<project>.supabase.co:5432) or the session pooler
# (port 5432 on the pooler host) for this script, even if the app itself uses 6543.
set -euo pipefail
SCHEMA=public
while getopts ":n:h" opt; do
  case "$opt" in
    n) SCHEMA="$OPTARG" ;;
    h) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "usage: $0 [-n SCHEMA]" >&2; exit 2 ;;
  esac
done
if ! [[ "$SCHEMA" =~ ^[a-z_][a-z0-9_]*$ ]]; then echo "invalid schema name: $SCHEMA" >&2; exit 2; fi
: "${DATABASE_URL:?}"; : "${RESTORE_ADMIN_URL:?}"
case "$DATABASE_URL" in
  *:6543/*) echo "warning: DATABASE_URL looks like a transaction pooler (:6543); use a session-mode or direct connection" >&2 ;;
esac
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/unyly-$SCHEMA-$STAMP.dump"
pg_dump --format=custom --no-owner --schema="$SCHEMA" --file="$FILE" "$DATABASE_URL"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
SCRATCH="unyly_restore_check_$$"
psql "$RESTORE_ADMIN_URL" -qc "CREATE DATABASE $SCRATCH"
trap 'psql "$RESTORE_ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH"' EXIT
RESTORE_URL="${RESTORE_ADMIN_URL%/*}/$SCRATCH"
# The dump contains CREATE SCHEMA for the selected schema (also for public), so drop the scratch DB's
# empty copy first; pg_restore then recreates it from the dump.
psql "$RESTORE_URL" -qc "SET client_min_messages = warning; DROP SCHEMA IF EXISTS \"$SCHEMA\" CASCADE"
pg_restore --no-owner --dbname="$RESTORE_URL" "$FILE"
for t in users orders submission_attempts checkouts provider_events schema_migrations; do
  q="SELECT count(*) FROM \"$SCHEMA\".\"$t\""
  a=$(psql "$DATABASE_URL" -Atc "$q")
  b=$(psql "$RESTORE_URL" -Atc "$q")
  echo "$SCHEMA.$t: source=$a restored=$b"
  # Source may have grown during the dump; restored must not exceed it.
  if [ "$b" -gt "$a" ]; then echo "MISMATCH in $SCHEMA.$t"; exit 1; fi
done
echo "restore verified"
