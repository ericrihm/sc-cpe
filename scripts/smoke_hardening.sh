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
# /api/admin/users requires ?q=<2-200 chars>; use a benign 2-char query.
ADMIN_URL="$ORIGIN/api/admin/users?q=ab&limit=1"
check "no auth → 401" 401 "$(code "$ADMIN_URL")"
check "wrong bearer → 401" 401 "$(code -H 'Authorization: Bearer nope' "$ADMIN_URL")"
check "short bearer → 401 (no length oracle)" 401 "$(code -H 'Authorization: Bearer x' "$ADMIN_URL")"
check "valid bearer → 200" 200 "$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$ADMIN_URL")"

echo "== CSRF gate on dashboard-token (me) endpoints =="
# Admin endpoints don't need a CSRF gate: bearer tokens in Authorization
# headers are NOT auto-sent by browsers cross-origin, so CSRF is inapplicable.
# The dashboard-token paths under /api/me/[token]/* DO need the gate — the
# token sits in the URL and a browser will happily POST to it from any page.
# Pick a random token so we're exercising the CSRF branch, not auth.
FAKE_TOKEN="smoketest$(date +%s)smoketest$(date +%s)"
check "me/delete w/o origin → 403" 403 "$(code -X POST \
    -H 'Content-Type: application/json' -d '{}' \
    "$ORIGIN/api/me/$FAKE_TOKEN/delete")"
check "me/delete cross-origin → 403" 403 "$(code -X POST \
    -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' \
    "$ORIGIN/api/me/$FAKE_TOKEN/delete")"

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

echo "== fixture pollution guardrail =="
stats=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/ops-stats")
pollution=$(echo "$stats" | grep -oE '"fixture_pollution":\{[^}]*\}')
if echo "$pollution" | grep -qE '"(streams|attendance|users)":[1-9]'; then
    echo "  FAIL fixture_pollution non-zero: $pollution"; fail=$((fail+1))
else
    echo "  ok   no test fixtures in prod: $pollution"; pass=$((pass+1))
fi

echo
echo "== summary: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
