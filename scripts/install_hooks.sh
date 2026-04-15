#!/usr/bin/env bash
# Points this repo's git hook path at .githooks/ so the tracked pre-push
# hook runs. Per-clone (not a commit), so every contributor runs this once.
set -e
cd "$(git rev-parse --show-toplevel)"
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
echo "hooks installed: core.hooksPath=$(git config core.hooksPath)"
