#!/usr/bin/env bash
# TOKEN_GOAT_NO_WORKER_SPAWN / TOKEN_GOAT_HARNESS_OVERRIDE / TOKEN_GOAT_MEMORY_PRESSURE_MB
# are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push
# and CI run under the same defaults. Don't re-export them here.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm test
