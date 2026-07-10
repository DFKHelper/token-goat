#!/usr/bin/env bash
# Run the test suite on Linux via WSL to catch platform-specific failures.
# Requires Node.js installed in WSL (Ubuntu). Skips gracefully if unavailable.
set -euo pipefail

if ! command -v wsl.exe &>/dev/null && ! wsl.exe --status &>/dev/null 2>&1; then
    echo "wsl-test: WSL not available, skipping"
    exit 0
fi

# Check if Node.js is available in WSL.
if ! wsl.exe -d Ubuntu -- bash -l -c 'command -v node' &>/dev/null 2>&1; then
    echo "wsl-test: Node.js not found in WSL Ubuntu, skipping"
    exit 0
fi

# Normalize path to WSL mount form (/mnt/c/...).
GIT_ROOT="$(git rev-parse --show-toplevel)"
if [[ "$GIT_ROOT" =~ ^[A-Za-z]:/ ]]; then
    drive="${GIT_ROOT:0:1}"
    rest="${GIT_ROOT:3}"
    GIT_ROOT="/${drive,,}/$rest"
fi
WSL_ROOT="$(echo "$GIT_ROOT" | sed 's|^/\([a-zA-Z]\)/|/mnt/\1/|')"

# TOKEN_GOAT_NO_WORKER_SPAWN / TOKEN_GOAT_HARNESS_OVERRIDE / TOKEN_GOAT_MEMORY_PRESSURE_MB
# are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push
# and CI run under the same defaults. Don't re-export them here.
wsl.exe -d Ubuntu -- bash -l -c "
  set -euo pipefail
  cd '$WSL_ROOT'
  npm test
"
