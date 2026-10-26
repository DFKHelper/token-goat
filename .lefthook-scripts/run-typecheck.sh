#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node scripts/prepush-green.mjs run typecheck -- npm run typecheck
node scripts/prepush-green.mjs run typecheck:tests -- npm run typecheck:tests
