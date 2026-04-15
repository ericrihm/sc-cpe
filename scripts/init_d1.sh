#!/usr/bin/env bash
# Apply schema + seed to the SC-CPE D1 database.
# Usage:
#   DB_NAME=sc-cpe ./scripts/init_d1.sh              # remote
#   DB_NAME=sc-cpe LOCAL=1 ./scripts/init_d1.sh      # local wrangler dev

set -euo pipefail

# wrangler resolves D1 DB names from the nearest wrangler.toml, so run this
# from a dir that has one. Default: pages/. Override with WRANGLER_DIR for
# seeding a worker's local D1 (e.g. workers/purge for --local smoke tests).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER_DIR="${WRANGLER_DIR:-$REPO/pages}"
SCHEMA="$REPO/db/schema.sql"
SEED="$REPO/db/seed.sql"

: "${DB_NAME:=sc-cpe}"
FLAG=${LOCAL:+--local}
FLAG=${FLAG:---remote}

cd "$WRANGLER_DIR"
echo "[init] applying $SCHEMA to $DB_NAME ($FLAG) from $WRANGLER_DIR"
npx wrangler d1 execute "$DB_NAME" $FLAG --file="$SCHEMA"

echo "[init] applying $SEED to $DB_NAME ($FLAG) from $WRANGLER_DIR"
npx wrangler d1 execute "$DB_NAME" $FLAG --file="$SEED"

echo "[init] done"
