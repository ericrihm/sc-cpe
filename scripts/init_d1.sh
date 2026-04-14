#!/usr/bin/env bash
# Apply schema + seed to the SC-CPE D1 database.
# Usage:
#   DB_NAME=sc-cpe ./scripts/init_d1.sh              # remote
#   DB_NAME=sc-cpe LOCAL=1 ./scripts/init_d1.sh      # local wrangler dev

set -euo pipefail
cd "$(dirname "$0")/.."

: "${DB_NAME:=sc-cpe}"
FLAG=${LOCAL:+--local}
FLAG=${FLAG:---remote}

echo "[init] applying db/schema.sql to $DB_NAME ($FLAG)"
npx wrangler d1 execute "$DB_NAME" $FLAG --file=db/schema.sql

echo "[init] applying db/seed.sql to $DB_NAME ($FLAG)"
npx wrangler d1 execute "$DB_NAME" $FLAG --file=db/seed.sql

echo "[init] done"
