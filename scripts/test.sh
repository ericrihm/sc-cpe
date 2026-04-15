#!/usr/bin/env bash
# Runs every node --test suite in the repo. Add new test files here as they
# land — node's runner doesn't auto-discover, so silent drift is easy.
set -e
cd "$(dirname "$0")/.."
node --test \
    pages/functions/_lib.test.mjs \
    workers/poller/src/race-detection.test.mjs
