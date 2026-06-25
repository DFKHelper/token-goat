#!/usr/bin/env bash
set -euo pipefail
export TOKEN_GOAT_NO_WORKER_SPAWN=1
export TOKEN_GOAT_HARNESS_OVERRIDE=claudecode
export TOKEN_GOAT_MEMORY_PRESSURE_MB=99999
cd "$(git rev-parse --show-toplevel)"
npm test
