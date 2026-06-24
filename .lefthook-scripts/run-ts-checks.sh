#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/packages/token-goat-ts"
npm run typecheck
npm run lint
npm run test
