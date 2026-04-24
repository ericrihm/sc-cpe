#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sc-cpe"
BUCKET="sc-cpe-backups"
BACKUP_DIR="${BACKUP_DIR:-/tmp/sc-cpe-backups}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/sc-cpe-${TIMESTAMP}.sql"
UPLOAD_R2=false

for arg in "$@"; do
  case "$arg" in
    --upload-r2) UPLOAD_R2=true ;;
  esac
done

mkdir -p "$BACKUP_DIR"

echo "Exporting D1 database ${DB_NAME}..."
npx wrangler d1 export "$DB_NAME" --output="$BACKUP_FILE"

echo "Backup saved to ${BACKUP_FILE}"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

if [ "$UPLOAD_R2" = true ]; then
  R2_KEY="d1-backup-${TIMESTAMP}.sql"
  echo "Uploading to R2 bucket ${BUCKET} as ${R2_KEY}..."
  npx wrangler r2 object put "${BUCKET}/${R2_KEY}" --file="$BACKUP_FILE"
  echo "R2 upload complete."
fi

# Keep only last 4 backups (4 weeks)
ls -t "${BACKUP_DIR}"/sc-cpe-*.sql 2>/dev/null | tail -n +5 | xargs -r rm -f
echo "Cleanup complete. Backups retained: $(ls "${BACKUP_DIR}"/sc-cpe-*.sql | wc -l)"
