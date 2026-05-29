#!/usr/bin/env bash
# Mirror CI fast-tier: serial (-n 0) + marker filter.
# -n 0 overrides the -n auto in pyproject.toml addopts; avoids xdist
# INTERNALERROR worker crashes from Windows C-extension corruption.
export TOKEN_GOAT_NO_WORKER_SPAWN=1
exec uv run pytest -n 0 -m "not slow" -q --tb=short
