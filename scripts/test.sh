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
    scripts/test_audit_pii_scrub.mjs
