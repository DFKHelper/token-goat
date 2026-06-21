#!/usr/bin/env bash
# Single entry point for all pre-push checks. Runs typecheck, Windows tests,
# and WSL tests in parallel via bash background jobs to avoid lefthook's
# parallel-mode stdin race on Windows (EvalSymlinks canonicalize failures).
set -euo pipefail

# Always anchor to git root so this script works whether lefthook invokes it
# in-place or copies it to a temp location.
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.lefthook-scripts"

bash "$SCRIPT_DIR/run-typecheck.sh" &
TYPECHECK_PID=$!

bash "$SCRIPT_DIR/run-test.sh" &
TEST_PID=$!

bash "$SCRIPT_DIR/wsl-test.sh" &
WSL_PID=$!

FAIL=0
wait "$TYPECHECK_PID" || { echo "pre-push: typecheck FAILED"; FAIL=1; }
wait "$TEST_PID"       || { echo "pre-push: tests FAILED"; FAIL=1; }
wait "$WSL_PID"        || { echo "pre-push: wsl-test FAILED"; FAIL=1; }
exit $FAIL
