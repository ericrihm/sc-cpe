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
    workers/poller/src/race-detection.test.mjs \
    workers/purge/src/heartbeat-staleness.test.mjs \
    scripts/test_chain_parity.mjs \
    scripts/test_source_parity.mjs
