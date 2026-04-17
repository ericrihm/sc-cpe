#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sc-cpe"
BACKUP_DIR="${BACKUP_DIR:-/tmp/sc-cpe-backups}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/sc-cpe-${TIMESTAMP}.sql"

mkdir -p "$BACKUP_DIR"

echo "Exporting D1 database ${DB_NAME}..."
npx wrangler d1 export "$DB_NAME" --output="$BACKUP_FILE"

echo "Backup saved to ${BACKUP_FILE}"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

# Keep only last 4 backups (4 weeks)
ls -t "${BACKUP_DIR}"/sc-cpe-*.sql 2>/dev/null | tail -n +5 | xargs -r rm -f
echo "Cleanup complete. Backups retained: $(ls "${BACKUP_DIR}"/sc-cpe-*.sql | wc -l)"
