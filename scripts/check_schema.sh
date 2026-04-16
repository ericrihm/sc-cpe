#!/usr/bin/env bash
# Schema drift check. Dumps the live D1 schema, canonicalises it, and
# diffs against db/schema.sql. Exits non-zero on mismatch so CI can gate
# it. Catches out-of-band `wrangler d1 execute` migrations that don't
# land in schema.sql — a silent way the prod DB drifts from the repo.
#
# Runs locally (operator's wrangler auth) or in CI (needs CLOUDFLARE_
# API_TOKEN). CI mode pulls via the D1 HTTP API; local mode uses wrangler.
#
# Usage:
#   scripts/check_schema.sh                      # local, via wrangler
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... D1_DATABASE_ID=... \
#       scripts/check_schema.sh --http            # CI / api mode
#
# Canonicalisation: lowercase keywords, strip comments, collapse whitespace,
# sort statements. Good enough to catch real drift without chasing every
# SQLite-version formatting quirk.

set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-wrangler}"

canonicalise() {
    # Strip SQL line comments, drop blank lines, collapse runs of whitespace,
    # sort statements so order doesn't drive diffs.
    #
    # Must use `python3 -c` (not `python3 - <<HEREDOC`): with heredoc, python
    # consumes stdin as the script source, so sys.stdin.read() reads empty and
    # canonicalise silently returned "" for every call — the drift check was
    # comparing "" == "" and reporting OK without actually checking anything.
    python3 -c '
import re, sys
src = sys.stdin.read()
src = re.sub(r"--[^\n]*", "", src)
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
stmts = [re.sub(r"\s+", " ", s).strip().lower() for s in src.split(";")]
# Drop pragmas — they are session-level, never appear in sqlite_master,
# and would otherwise always false-positive as drift in --http mode.
stmts = [s for s in stmts if s and not s.startswith("pragma ")]
stmts.sort()
sys.stdout.write("\n".join(stmts) + "\n")
'
}

expected=$(canonicalise < db/schema.sql)

case "$MODE" in
    wrangler)
        cd pages
        live=$(wrangler d1 execute sc-cpe --remote \
            --command ".schema" 2>/dev/null | \
            sed -n '/CREATE/,$p' | canonicalise)
        cd ..
        ;;
    --http)
        : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
        : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
        : "${D1_DATABASE_ID:?set D1_DATABASE_ID}"
        body='{"sql":"SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name NOT LIKE '\''sqlite_%'\'' AND tbl_name NOT LIKE '\''_cf_%'\'' AND tbl_name NOT LIKE '\''d1_migrations'\''","params":[]}'
        live=$(curl -fsS \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$D1_DATABASE_ID/query" \
            -d "$body" | \
            python3 -c 'import json,sys; d=json.load(sys.stdin); print(";\n".join(r["sql"] for r in d["result"][0]["results"]))' | \
            canonicalise)
        ;;
    *)
        echo "unknown mode: $MODE (expected 'wrangler' or '--http')" >&2
        exit 2
        ;;
esac

if [[ "$expected" == "$live" ]]; then
    echo "schema check: OK"
    exit 0
fi

echo "schema check: DRIFT DETECTED" >&2
diff <(echo "$expected") <(echo "$live") | head -100 >&2
exit 1
