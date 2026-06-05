#!/usr/bin/env bash
# Run the test suite on Linux via WSL to catch platform-specific failures
# before they hit CI. Mirrors the CI ubuntu-latest gate exactly (-n auto,
# not slow). Runs in parallel with the Windows test step so total hook time
# is unchanged.
set -euo pipefail

# Skip gracefully when WSL is not available (e.g. CI itself, or non-WSL dev machines).
if ! command -v wsl.exe &>/dev/null && ! wsl.exe --status &>/dev/null 2>&1; then
    echo "wsl-test: WSL not available, skipping Linux run"
    exit 0
fi

# git rev-parse gives a Git-bash Unix path (/c/Projects/...) on Windows.
# Convert to WSL mount form (/mnt/c/Projects/...).
GIT_ROOT="$(git rev-parse --show-toplevel)"
WSL_ROOT="$(echo "$GIT_ROOT" | sed 's|^/\([a-z]\)/|/mnt/\1/|')"

wsl.exe -d Ubuntu -- bash -l -c "
  set -euo pipefail
  cd '$WSL_ROOT'
  export TOKEN_GOAT_NO_WORKER_SPAWN=1
  export TOKEN_GOAT_HARNESS_OVERRIDE=claudecode
  # Isolate the Linux venv from the Windows .venv to avoid cross-OS corruption.
  export UV_PROJECT_ENVIRONMENT=/tmp/tg-linux-venv
  exec uv run pytest -n auto -m 'not slow' -q --tb=short
"
