#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sc-cpe"
BUCKET="sc-cpe-backups"
CONFIRM=false
LIST=false
LATEST=false
KEY=""

usage() {
  echo "Usage:"
  echo "  $0 --list                    List available backups in R2"
  echo "  $0 --latest --confirm        Restore the most recent backup"
  echo "  $0 <r2-key> --confirm        Restore a specific backup"
  echo ""
  echo "Options:"
  echo "  --confirm    Required safety flag for restore operations"
  echo "  --list       List backups without restoring"
  echo "  --latest     Select the most recent backup"
  exit 1
}

if [ $# -eq 0 ]; then usage; fi

for arg in "$@"; do
  case "$arg" in
    --list)    LIST=true ;;
    --latest)  LATEST=true ;;
    --confirm) CONFIRM=true ;;
    --help|-h) usage ;;
    -*)        echo "Unknown flag: $arg"; usage ;;
    *)         KEY="$arg" ;;
  esac
done

if [ "$LIST" = true ]; then
  echo "Available backups in R2 bucket '${BUCKET}':"
  npx wrangler r2 object list "$BUCKET" --json \
    | jq -r '.[] | "\(.key)\t\(.size) bytes\t\(.uploaded)"' \
    | sort -r
  exit 0
fi

if [ "$CONFIRM" != true ]; then
  echo "ERROR: --confirm flag required for restore operations."
  echo "This will overwrite the production database. Use with care."
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$LATEST" = true ]; then
  echo "Finding most recent backup..."
  KEY=$(npx wrangler r2 object list "$BUCKET" --json \
    | jq -r '.[] | .key' | sort -r | head -1)
  if [ -z "$KEY" ]; then
    echo "ERROR: No backups found in R2 bucket '${BUCKET}'"
    exit 1
  fi
  echo "Latest backup: $KEY"
fi

if [ -z "$KEY" ]; then
  echo "ERROR: No backup key specified. Use --latest or provide a key."
  usage
fi

RESTORE_FILE="${TMPDIR}/restore.sql"
echo "Downloading ${KEY} from R2..."
npx wrangler r2 object get "${BUCKET}/${KEY}" --file="$RESTORE_FILE"
echo "Downloaded: $(du -h "$RESTORE_FILE" | cut -f1)"

echo ""
echo "=== RESTORING to D1 database '${DB_NAME}' ==="
echo ""
npx wrangler d1 execute "$DB_NAME" --remote --file="$RESTORE_FILE"

echo ""
echo "Running sanity checks..."
npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT 'users' AS tbl, COUNT(*) AS cnt FROM users UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log UNION ALL SELECT 'attendance', COUNT(*) FROM attendance UNION ALL SELECT 'certs', COUNT(*) FROM certs" \
  | jq '.[0].results[]'

echo ""
echo "Restore complete."
