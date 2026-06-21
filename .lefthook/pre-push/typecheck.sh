#!/usr/bin/env bash
# Run mypy on the src tree. Uses python -m mypy to avoid "Failed to
# canonicalize script path" on Windows Git Bash with uv run <script>.
export TOKEN_GOAT_NO_WORKER_SPAWN=1
exec uv run python -m mypy src
