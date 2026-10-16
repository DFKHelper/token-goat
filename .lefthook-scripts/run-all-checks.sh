#!/usr/bin/env bash
# Single entry point for all pre-push checks. Every check runs concurrently: typecheck, ts-checks, the Windows suite and the WSL (Linux) suite. The WSL leg runs from its own Linux-side copy in a separate VM, so its files and node_modules never overlap the Windows run; the cost is that both suites share the workstation's CPU, which is why they were serial before. The suites are meant to hold under that load (a timing-dependent test is the defect, not the load), and the wall time is now that of the slower leg instead of the sum.
set -euo pipefail

# Always anchor to git root so this script works whether lefthook invokes it
# in-place or copies it to a temp location.
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.lefthook-scripts"
source "$SCRIPT_DIR/tmp-base.sh"
LOG_DIR="$(mktemp -d "${TMP_BASE}/token-goat-pre-push.XXXXXX")"

PIDS=()
WSL_PID=""

run_check() {
  local name=$1
  shift
  # Truncate once, then append: with `>` every child of the check shares one file offset and they overwrite each other's lines.
  : >"$LOG_DIR/$name.log"
  "$@" >>"$LOG_DIR/$name.log" 2>&1 &
  RUN_PID=$!
  PIDS+=("$RUN_PID")
}

report_failure() {
  local name=$1
  echo "pre-push: $name FAILED (last 120 lines; full log: $LOG_DIR/$name.log)"
  tail -n 120 "$LOG_DIR/$name.log"
}

# End the whole process tree under one background job. Git Bash pids map to Windows pids through /proc/<pid>/winpid, and taskkill /T takes the node children with them; elsewhere walk the children with pgrep.
kill_tree() {
  local pid=$1 winpid child
  if [[ -r "/proc/$pid/winpid" ]]; then
    winpid="$(cat "/proc/$pid/winpid")"
    taskkill //T //F //PID "$winpid" &>/dev/null || true
  else
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

# Runs on every exit path (success, failure, INT, TERM). The WSL script gets TERM first so its own trap can end the Linux-side tree, which taskkill on the Windows side cannot reach; then every job still alive is killed with its tree.
cleanup() {
  trap - EXIT INT TERM
  local pid
  if [[ -n "$WSL_PID" ]] && kill -0 "$WSL_PID" 2>/dev/null; then
    kill -TERM "$WSL_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      kill -0 "$WSL_PID" 2>/dev/null || break
      sleep 0.5
    done
  fi
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill_tree "$pid"; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_check typecheck bash "$SCRIPT_DIR/run-typecheck.sh"
TYPECHECK_PID=$RUN_PID
run_check ts-checks bash "$SCRIPT_DIR/run-ts-checks.sh"
TS_PID=$RUN_PID
run_check tests bash "$SCRIPT_DIR/run-test.sh"
TEST_PID=$RUN_PID
run_check wsl-test bash "$SCRIPT_DIR/wsl-test.sh"
WSL_PID=$RUN_PID

FAIL=0

wait "$TEST_PID"      || { report_failure tests; FAIL=1; }
wait "$WSL_PID"       || { report_failure wsl-test; FAIL=1; }
wait "$TYPECHECK_PID" || { report_failure typecheck; FAIL=1; }
wait "$TS_PID"        || { report_failure ts-checks; FAIL=1; }

if [[ "$FAIL" -eq 0 ]]; then
  rm -rf -- "$LOG_DIR"
fi
exit "$FAIL"
