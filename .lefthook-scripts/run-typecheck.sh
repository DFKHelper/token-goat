#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
