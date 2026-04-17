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
# The per-channel cap (10/day from PR #9) gates enumeration of ONE
# target channel across rotating IPs. Smoke needs to probe the endpoint
# without contributing to that cap, so we generate a FRESH random
# 22-char suffix per run — 11 pushes within an hour each get their own
# channel id, no cap collision. The first-post-deploy-smoke +
# every-hourly-cron + every-push-to-main cadence otherwise piles up in
# a single UTC hour when launch traffic is busy. Random is fine; the
# endpoint only checks format + uniqueness, not YouTube reachability.
SMOKE_CH="UC$(tr -dc '0-9A-Za-z_-' </dev/urandom | head -c 22)"
check "well-formed channel probe → 200" 200 "$(code "$ORIGIN/api/preflight/channel?q=$SMOKE_CH")"

echo "== audit-chain-verify =="
body=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/audit-chain-verify?limit=50")
echo "  body: $body" | head -c 400; echo
if echo "$body" | grep -q '"ok":true'; then
    echo "  ok   chain intact"; pass=$((pass+1))
else
    echo "  FAIL chain reports divergence or error"; fail=$((fail+1))
fi

echo "== watchdog-state: no length oracle =="
# Lock in the constant-time fix: short and same-length-but-wrong must both
# return 401. If a future refactor reintroduces an early-exit on length
# mismatch, this catches it.
WD_URL="$ORIGIN/api/watchdog-state"
check "missing secret → 401" 401 "$(code "$WD_URL")"
check "short wrong → 401" 401 "$(code -H 'X-Watchdog-Secret: short' "$WD_URL")"
SAME_LEN_WRONG=$(printf '%.0s0' $(seq 1 64))
check "same-length wrong → 401" 401 "$(code -H "X-Watchdog-Secret: $SAME_LEN_WRONG" "$WD_URL")"

echo "== download/[token]: rejects garbage tokens =="
# /api/download/[token] is the cert delivery surface — possession of a
# 64-hex public_token is the credential. Short tokens 400, valid-shape but
# unknown tokens 404 (no DB-shape leak in either case).
check "short token → 400" 400 "$(code "$ORIGIN/api/download/short")"
SHAPE_OK_BUT_UNKNOWN=$(printf '%.0s0' $(seq 1 64))
check "valid-shape unknown → 404" 404 "$(code "$ORIGIN/api/download/$SHAPE_OK_BUT_UNKNOWN")"

echo "== heartbeat-status: admin-gated =="
HB_URL="$ORIGIN/api/admin/heartbeat-status"
check "no auth → 401" 401 "$(code "$HB_URL")"
check "valid bearer → 200" 200 "$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$HB_URL")"

echo "== fixture pollution guardrail =="
stats=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/ops-stats")
pollution=$(echo "$stats" | grep -oE '"fixture_pollution":\{[^}]*\}')
if echo "$pollution" | grep -qE '"(streams|attendance|users)":[1-9]'; then
    if [[ "${ALLOW_FIXTURES:-}" == "1" ]]; then
        echo "  WARN fixture_pollution non-zero (allowed): $pollution"; pass=$((pass+1))
    else
        echo "  FAIL fixture_pollution non-zero: $pollution"; fail=$((fail+1))
    fi
else
    echo "  ok   no test fixtures in prod: $pollution"; pass=$((pass+1))
fi

echo
echo "== summary: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
