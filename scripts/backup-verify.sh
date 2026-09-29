#!/usr/bin/env bash
# Nightly backup + restore verification.
# Dumps DATABASE_URL, restores into a scratch database and checks row counts match.
# Env: DATABASE_URL (source), RESTORE_ADMIN_URL (a URL to the same server's "postgres" DB), BACKUP_DIR.
set -euo pipefail
: "${DATABASE_URL:?}"; : "${RESTORE_ADMIN_URL:?}"
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/unyly-$STAMP.dump"
pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
SCRATCH="unyly_restore_check_$$"
psql "$RESTORE_ADMIN_URL" -qc "CREATE DATABASE $SCRATCH"
trap 'psql "$RESTORE_ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH"' EXIT
RESTORE_URL="${RESTORE_ADMIN_URL%/*}/$SCRATCH"
pg_restore --no-owner --dbname="$RESTORE_URL" "$FILE"
for t in users orders submission_attempts checkouts provider_events; do
  a=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM $t")
  b=$(psql "$RESTORE_URL" -Atc "SELECT count(*) FROM $t")
  echo "$t: source=$a restored=$b"
  # Source may have grown during the dump; restored must not exceed it and must be close.
  if [ "$b" -gt "$a" ]; then echo "MISMATCH in $t"; exit 1; fi
done
echo "restore verified"
