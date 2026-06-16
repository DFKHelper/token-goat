#!/usr/bin/env bash
# Mirror CI fast-tier: serial (-n 0) + marker filter.
# -n 0 overrides the -n auto in pyproject.toml addopts; avoids xdist
# INTERNALERROR worker crashes from Windows C-extension corruption.
export TOKEN_GOAT_NO_WORKER_SPAWN=1
# Mirror CI: ensure detect_harness() returns "claudecode" even when running
# outside a Claude Code session (e.g. plain terminal push).
export TOKEN_GOAT_HARNESS_OVERRIDE=claudecode
# Disable memory-pressure gating so the full test suite (~550 MB RSS with
# xdist workers) never trips the 500 MB threshold that skips indexing.
export TOKEN_GOAT_MEMORY_PRESSURE_MB=99999
exec uv run pytest -n 0 -m "not slow" -q --tb=short
