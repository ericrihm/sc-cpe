#!/usr/bin/env bash
# Runs every node --test suite in the repo. Add new test files here as they
# land — node's runner doesn't auto-discover, so silent drift is easy.
set -e
cd "$(dirname "$0")/.."
node --test \
    pages/functions/_lib.test.mjs \
    pages/functions/_heartbeat.test.mjs \
    pages/functions/api/endpoints.test.mjs \
    pages/functions/api/onboarding.test.mjs \
    pages/functions/api/health.test.mjs \
    pages/functions/api/admin/ops-stats.test.mjs \
    pages/functions/api/admin/toggles.test.mjs \
    pages/functions/api/admin/admin-endpoints.test.mjs \
    pages/functions/api/admin/auth/_auth_helpers.test.mjs \
    pages/functions/api/admin/analytics/_helpers.test.mjs \
    pages/functions/api/preflight/channel.test.mjs \
    pages/functions/api/coverage.test.mjs \
    pages/functions/api/new-features.test.mjs \
    workers/poller/src/race-detection.test.mjs \
    workers/poller/src/streak.test.mjs \
    workers/purge/src/heartbeat-staleness.test.mjs \
    workers/purge/src/purge-expired.test.mjs \
    scripts/test_chain_parity.mjs \
    scripts/test_source_parity.mjs \
    pages/functions/api/ob/credential.test.mjs \
    scripts/test_audit_pii_scrub.mjs \
    pages/functions/api/email-webhook.test.mjs \
    scripts/test_e2e.mjs \
    pages/functions/api/admin/analytics/analytics.test.mjs \
    pages/functions/api/admin/new-admin-features.test.mjs \
    pages/functions/api/me/user-features.test.mjs \
    pages/functions/api/admin/audit-chain.test.mjs \
    pages/functions/api/admin/appeals.test.mjs \
    pages/functions/api/admin/revoke.test.mjs \
    pages/functions/api/admin/cert-reissue.test.mjs \
    pages/functions/_lib-security.test.mjs \
    workers/email-sender/src/email-sender.test.mjs
