#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node scripts/prepush-green.mjs run lint -- npm run lint
