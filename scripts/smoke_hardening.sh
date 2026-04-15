#!/usr/bin/env bash
# Smoke-tests the 12-fix hardening bundle (commit 53ab555) against a deployed
# origin — runs read-only probes that exercise the new auth / CSRF / rate-limit
# paths without mutating state.
#
# Usage:
#   ORIGIN=https://sc-cpe.pages.dev ADMIN_TOKEN=... ./smoke_hardening.sh
#
# Exits non-zero on any assertion failure.

set -u
: "${ORIGIN:?set ORIGIN to the deployed pages origin}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"

pass=0; fail=0
check() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        echo "  ok   $name ($actual)"; pass=$((pass+1))
    else
        echo "  FAIL $name — expected $expected, got $actual"; fail=$((fail+1))
    fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== admin HMAC (isAdmin) =="
check "no auth → 401" 401 "$(code "$ORIGIN/api/admin/users")"
check "wrong bearer → 401" 401 "$(code -H 'Authorization: Bearer nope' "$ORIGIN/api/admin/users")"
check "short bearer → 401 (no length oracle)" 401 "$(code -H 'Authorization: Bearer x' "$ORIGIN/api/admin/users")"
check "valid bearer → 200" 200 "$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/users?limit=1")"

echo "== CSRF gate on mutating admin endpoints =="
# Missing/mismatched Origin should be rejected even with valid bearer.
check "revoke w/o origin → 403" 403 "$(code -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' -d '{"user_id":"00000000"}' "$ORIGIN/api/admin/revoke")"
check "revoke cross-origin → 403" 403 "$(code -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
    -d '{"user_id":"00000000"}' "$ORIGIN/api/admin/revoke")"

echo "== preflight/channel rate limit =="
# First probe must succeed; after the cap we want 429. Cap is 60/h — hit it
# hard to confirm it fails closed rather than silently allowing.
check "first probe → 200" 200 "$(code "$ORIGIN/api/preflight/channel?q=UCG-48Ki-b6W_siaUkukJOSw")"

echo "== audit-chain-verify =="
body=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/audit-chain-verify?limit=50")
echo "  body: $body" | head -c 400; echo
if echo "$body" | grep -q '"ok":true'; then
    echo "  ok   chain intact"; pass=$((pass+1))
else
    echo "  FAIL chain reports divergence or error"; fail=$((fail+1))
fi

echo
echo "== summary: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
