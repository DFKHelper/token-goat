#!/usr/bin/env bash
# Single entry point for all pre-push checks. Runs typecheck, Windows tests,
# and WSL tests in parallel via bash background jobs to avoid lefthook's
# parallel-mode stdin race on Windows (EvalSymlinks canonicalize failures).
set -euo pipefail

# Always anchor to git root so this script works whether lefthook invokes it
# in-place or copies it to a temp location.
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.lefthook-scripts"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/token-goat-pre-push.XXXXXX")"

run_check() {
  local name=$1
  shift
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  RUN_PID=$!
}

report_failure() {
  local name=$1
  echo "pre-push: $name FAILED (last 120 lines; full log: $LOG_DIR/$name.log)"
  tail -n 120 "$LOG_DIR/$name.log"
}

run_check typecheck bash "$SCRIPT_DIR/run-typecheck.sh"
TYPECHECK_PID=$RUN_PID
run_check tests bash "$SCRIPT_DIR/run-test.sh"
TEST_PID=$RUN_PID
run_check wsl-test bash "$SCRIPT_DIR/wsl-test.sh"
WSL_PID=$RUN_PID
run_check ts-checks bash "$SCRIPT_DIR/run-ts-checks.sh"
TS_PID=$RUN_PID

FAIL=0
wait "$TYPECHECK_PID" || { report_failure typecheck; FAIL=1; }
wait "$TEST_PID"       || { report_failure tests; FAIL=1; }
wait "$WSL_PID"        || { report_failure wsl-test; FAIL=1; }
wait "$TS_PID"         || { report_failure ts-checks; FAIL=1; }

if [[ "$FAIL" -eq 0 ]]; then
  rm -rf -- "$LOG_DIR"
fi
exit "$FAIL"
