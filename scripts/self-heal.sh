#!/usr/bin/env bash
# Self-healing playbook for SC-CPE. Attempts safe, idempotent remediation
# for known failure modes. Called by the watchdog workflow after detection,
# or manually for testing.
#
# Usage:
#   ADMIN_TOKEN=... WATCHDOG_SECRET=... ./scripts/self-heal.sh <source> [<source>...]
#
# Sources: purge, security_alerts, link_enrichment, cert_nudge, renewal_nudge,
#          weekly_digest, monthly_digest, email_sender, poller, canary,
#          warn:email_queue_stalled, warn:certs_pending_stalled
#
# Safety:
#   - Max 1 heal per source per 2 hours (cooldown in watchdog KV)
#   - Max 3 total heals per day (global limit)
#   - All actions are idempotent (re-triggering safe workers)
#   - Unknown sources escalate immediately (no blind retry)

set -euo pipefail

: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"
: "${WATCHDOG_SECRET:?set WATCHDOG_SECRET}"
ORIGIN="${ORIGIN:-https://sc-cpe-web.pages.dev}"
PURGE_URL="${PURGE_URL:-https://sc-cpe-purge.ericrihm.workers.dev}"
WATCHDOG_STATE_URL="${WATCHDOG_STATE_URL:-$ORIGIN/api/watchdog-state}"
COOLDOWN_S="${COOLDOWN_S:-7200}"
DAILY_MAX="${DAILY_MAX:-3}"

healed=0; failed=0; skipped=0; escalated=0

post_discord() {
    [[ -z "${DISCORD_ALERT_WEBHOOK:-}" ]] && return 0
    jq -cn --arg c "$1" '{content: $c, username: "SC-CPE Healer"}' \
      | curl -fsS --max-time 20 \
            -H "Content-Type: application/json" \
            -X POST -d @- "$DISCORD_ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

get_state() {
    curl -fsS --max-time 10 \
        -H "X-Watchdog-Secret: $WATCHDOG_SECRET" \
        "$WATCHDOG_STATE_URL" 2>/dev/null || echo '{"alerted":{}}'
}

set_state() {
    local body="$1"
    echo "$body" | curl -fsS --max-time 10 \
        -H "X-Watchdog-Secret: $WATCHDOG_SECRET" \
        -H "Content-Type: application/json" \
        -X POST -d @- "$WATCHDOG_STATE_URL" >/dev/null 2>&1 || true
}

check_cooldown() {
    local source="$1" state="$2"
    local heal_key="heal:${source}"
    local last_heal
    last_heal=$(echo "$state" | jq -r --arg k "$heal_key" '.alerted[$k] // ""')
    if [[ -n "$last_heal" ]]; then
        local last_epoch now_epoch diff
        last_epoch=$(date -d "$last_heal" +%s 2>/dev/null || echo 0)
        now_epoch=$(date +%s)
        diff=$((now_epoch - last_epoch))
        if (( diff < COOLDOWN_S )); then
            echo "  cooldown: healed ${diff}s ago (need ${COOLDOWN_S}s)"
            return 1
        fi
    fi
    return 0
}

check_daily_limit() {
    local state="$1"
    local today
    today="heal.daily.$(date -u +%Y%m%d)"
    local count
    count=$(echo "$state" | jq -r --arg k "$today" '.alerted[$k] // "0"')
    if (( count >= DAILY_MAX )); then
        echo "  daily limit: $count/$DAILY_MAX heals today"
        return 1
    fi
    echo "$count"
    return 0
}

record_attempt() {
    local source="$1" daily_count="$2"
    set_state "$(jq -cn --arg s "heal:${source}" '{source: $s}')"
    local today new_count
    today="heal.daily.$(date -u +%Y%m%d)"
    new_count=$((daily_count + 1))
    set_state "$(jq -cn --arg s "$today" --arg v "$new_count" '{source: $s, alert_start: $v}')"
}

trigger_purge_block() {
    local block="$1"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$PURGE_URL/?only=$block")
    if [[ "$code" == "200" ]]; then
        echo "  purge trigger returned 200"
        return 0
    else
        echo "  purge trigger returned $code"
        return 1
    fi
}

check_source_recovered() {
    local source="$1" wait_s="${2:-30}"
    echo "  waiting ${wait_s}s then re-checking health..."
    sleep "$wait_s"
    local health stale
    health=$(curl -fsS --max-time 10 "$ORIGIN/api/health" 2>/dev/null || echo '{}')
    stale=$(echo "$health" | jq -r --arg s "$source" \
        '.sources[] | select(.source==$s) | .stale // "true"')
    [[ "$stale" == "false" ]]
}

heal_source() {
    local source="$1"
    echo "[$source] attempting heal..."

    case "$source" in
        purge|security_alerts|link_enrichment|cert_nudge|renewal_nudge|weekly_digest|monthly_digest)
            local block="$source"
            [[ "$source" == "purge" ]] && block="purge"
            if trigger_purge_block "$block"; then
                if check_source_recovered "$source" 15; then
                    return 0
                fi
                echo "  trigger succeeded but source still stale"
                return 1
            fi
            return 1
            ;;

        email_sender|warn:email_queue_stalled)
            echo "  email-sender is a CF Worker cron (no HTTP trigger)"
            echo "  checking if staleness is transient..."
            if check_source_recovered "email_sender" 60; then
                echo "  transient — recovered on its own"
                return 0
            fi
            echo "  still stale after 60s — likely stuck"
            return 2
            ;;

        poller)
            echo "  poller is a CF Worker cron (no HTTP trigger)"
            echo "  checking auth method and circuit breaker..."
            local ops auth_method
            ops=$(curl -fsS --max-time 10 \
                -H "Authorization: Bearer $ADMIN_TOKEN" \
                "$ORIGIN/api/admin/ops-stats" 2>/dev/null || echo '{}')
            local detail
            detail=$(curl -fsS --max-time 10 "$ORIGIN/api/health" 2>/dev/null \
                | jq -r '.sources[] | select(.source=="poller") | .detail // {}')
            auth_method=$(echo "$detail" | jq -r '.auth_method // "unknown"' 2>/dev/null || echo "unknown")
            echo "  auth_method=$auth_method"
            if [[ "$auth_method" == "api_key" ]]; then
                echo "  poller fell back to API key — OAuth may need refresh"
            fi
            if check_source_recovered "poller" 90; then
                echo "  transient — recovered"
                return 0
            fi
            return 2
            ;;

        canary)
            echo "  canary = smoke test; re-running won't fix underlying issue"
            return 2
            ;;

        warn:certs_pending_stalled)
            echo "  pending certs stalled — cert-sign-pending workflow may need re-run"
            echo "  (requires PAT with actions:write — cannot auto-trigger)"
            return 2
            ;;

        warn:resend_quota_95pct)
            echo "  Resend quota near limit — no automated fix, throttle sending"
            return 2
            ;;

        *)
            echo "  no playbook for '$source'"
            return 2
            ;;
    esac
}

# ── main ──────────────────────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
    echo "Usage: $0 <source> [<source>...]"
    exit 1
fi

state=$(get_state)
daily_count_str=$(check_daily_limit "$state" 2>&1) || {
    echo "Daily heal limit reached — all sources skipped"
    post_discord ":stop_sign: **SC-CPE healer: daily limit reached** ($DAILY_MAX heals today). Remaining failures need manual attention."
    exit 0
}
daily_count="$daily_count_str"

escalation_sources=()

for source in "$@"; do
    echo ""
    echo "=== heal: $source ==="

    if ! check_cooldown "$source" "$state"; then
        echo "  SKIP (cooldown)"
        skipped=$((skipped + 1))
        continue
    fi

    heal_source "$source"
    rc=$?
    record_attempt "$source" "$daily_count"
    daily_count=$((daily_count + 1))

    if [[ $rc -eq 0 ]]; then
        echo "  HEALED"
        healed=$((healed + 1))
        post_discord ":adhesive_bandage: **SC-CPE self-healed: $source** — automated remediation succeeded."
        set_state "$(jq -cn --arg s "$source" '{source: $s, clear: true}')"
    elif [[ $rc -eq 1 ]]; then
        echo "  FAILED (action ran but didn't fix it)"
        failed=$((failed + 1))
        escalation_sources+=("$source")
        post_discord ":x: **SC-CPE self-heal failed: $source** — automated fix ran but source still stale."
    else
        echo "  ESCALATE (no automated fix)"
        escalated=$((escalated + 1))
        escalation_sources+=("$source")
    fi

    if (( daily_count >= DAILY_MAX )); then
        echo "Daily limit reached mid-run — stopping"
        break
    fi
done

echo ""
echo "=== summary: healed=$healed failed=$failed escalated=$escalated skipped=$skipped ==="

if [[ ${#escalation_sources[@]} -gt 0 ]]; then
    echo ""
    echo "Sources needing manual attention: ${escalation_sources[*]}"
    echo "ESCALATE_SOURCES=${escalation_sources[*]}" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 1
fi

exit 0
