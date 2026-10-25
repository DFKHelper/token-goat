#!/usr/bin/env bash
# Single entry point for all pre-push checks. Typecheck, ts-checks and the Windows suite run concurrently; the WSL (Linux) suite follows the Windows suite unless PREPUSH_PARALLEL_WSL=1 starts it at once, and it runs only when wsl-gate.sh says so (TG_PREPUSH_WSL=1 or a pushed path listed in wsl-paths.txt) and the Windows leg passed. Each suite leg runs only the tests the pushed range touches plus every guard test (prepush-focus.sh, scripts/prepush-select.mjs), and the full suite in any doubt; PREPUSH_FULL=1 forces the full leg, and CI runs the full suite after the push. The WSL leg runs from its own Linux-side copy in a separate VM, so its files and node_modules never overlap the Windows run; both suites then share the workstation's CPU, which is why serial is the default: concurrent, they were slower and flaky.
set -euo pipefail

# Always anchor to git root so this script works whether lefthook invokes it
# in-place or copies it to a temp location.
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.lefthook-scripts"
source "$SCRIPT_DIR/tmp-base.sh"
source "$SCRIPT_DIR/wsl-gate.sh"
LOG_DIR="$(mktemp -d "${TMP_BASE}/token-goat-pre-push.XXXXXX")"
ROOT_DIR="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git rev-parse HEAD)"
source "$SCRIPT_DIR/prepush-focus.sh"

# The ref lines git gives a pre-push hook (lefthook passes them on with use_stdin). The read is bounded so a stdin that never closes cannot hang the push; no lines means the pushed range is unknown and the WSL leg runs.
PUSH_STDIN=""
if [[ ! -t 0 ]]; then
  while IFS= read -r -t 5 push_line; do PUSH_STDIN+="$push_line"$'\n'; done || true
fi

PIDS=()
WSL_PID=""
declare -A START=() END=() PID_OF=() FAILED=() ABORTED=()

run_check() {
  local name=$1
  shift
  # Truncate once, then append: with `>` every child of the check shares one file offset and they overwrite each other's lines.
  : >"$LOG_DIR/$name.log"
  "$@" >>"$LOG_DIR/$name.log" 2>&1 &
  RUN_PID=$!
  PIDS+=("$RUN_PID")
  PID_OF[$name]=$RUN_PID
  START[$name]=$SECONDS
}

# Waits for the named legs in the order they finish, so each leg's end time is its own and not the moment a slower earlier leg released the wait. Marks FAILED[name] for each leg that exited non-zero.
wait_legs() {
  local -A pid_of=()
  local name left=0 fin rc
  for name in "$@"; do pid_of[$name]=${PID_OF[$name]}; left=$((left + 1)); done
  while [[ "$left" -gt 0 ]]; do
    rc=0
    wait -n -p fin "${pid_of[@]}" || rc=$?
    for name in "${!pid_of[@]}"; do
      if [[ "${pid_of[$name]:-}" == "$fin" ]]; then
        END[$name]=$SECONDS
        [[ "$rc" -eq 0 ]] || FAILED[$name]=1
        unset "pid_of[$name]"
        left=$((left - 1))
        # Lint or typecheck red: the push is lost already, so end the Windows suite's tree instead of waiting for it.
        if [[ "$rc" -ne 0 && "$name" != "tests" && -n "${pid_of[tests]:-}" ]]; then
          echo "pre-push: $name failed, stopping the Windows suite"
          kill_tree "${pid_of[tests]}"
          wait "${pid_of[tests]}" 2>/dev/null || true
          ABORTED[tests]=1
          unset "pid_of[tests]"
          left=$((left - 1))
        fi
      fi
    done
  done
}

# Seconds a leg took, or "skipped" when it never started.
leg_secs() {
  if [[ -n "${ABORTED[$1]:-}" ]]; then
    printf 'aborted'
  elif [[ -n "${START[$1]:-}" && -n "${END[$1]:-}" ]]; then
    printf '%ss' "$((END[$1] - START[$1]))"
  else
    printf 'skipped'
  fi
}

# Starts a suite leg (win or wsl), focused on the pushed range when prepush-focus.sh can say so safely, otherwise in full. $1: log name, $2: leg, $3: the leg's script.
start_suite_leg() {
  focus_decide "$2"
  echo "pre-push: $FOCUS_NOTE"
  if [[ -n "$FOCUS_FILE" ]]; then
    run_check "$1" env TG_PREPUSH_FOCUS="$FOCUS_FILE" bash "$3"
  else
    run_check "$1" env -u TG_PREPUSH_FOCUS bash "$3"
  fi
}

# Keeps the failing-files record in step with a finished suite leg: a red leg records its failures, a green one clears them, a leg that did not run or was aborted changes nothing. $1: log name, $2: leg.
record_leg_outcome() {
  [[ -n "${END[$1]:-}" && -z "${ABORTED[$1]:-}" ]] || return 0
  if [[ -n "${FAILED[$1]:-}" ]]; then focus_record_failure "$2" "$LOG_DIR/$1.log"; else focus_clear "$2"; fi
}

# Prints the slowest test files of one leg's vitest log. A failure of this report never changes the push result.
report_slowest() {
  local name=$1 title=$2
  [[ -n "${START[$name]:-}" && -z "${ABORTED[$name]:-}" ]] || return 0
  echo "pre-push: 20 slowest test files, $title leg"
  node "$ROOT_DIR/scripts/test-durations.mjs" "$LOG_DIR/$name.log" --top 20 || true
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

wsl_decide "$PUSH_STDIN" "$SCRIPT_DIR/wsl-paths.txt"
if [[ "$WSL_RUN" -eq 1 ]]; then
  echo "pre-push: WSL leg will run: $WSL_REASON"
else
  echo "pre-push: WSL leg skipped: $WSL_REASON"
fi

run_check typecheck bash "$SCRIPT_DIR/run-typecheck.sh"
run_check ts-checks bash "$SCRIPT_DIR/run-ts-checks.sh"
start_suite_leg tests win "$SCRIPT_DIR/run-test.sh"
# Default is serial, as before: a measured concurrent run took 2150 s against 1423 s serial and failed 21 Windows and 2 Linux test files under the shared CPU. PREPUSH_PARALLEL_WSL=1 starts the WSL leg now instead of after the Windows suite.
if [[ "$WSL_RUN" -eq 1 && "${PREPUSH_PARALLEL_WSL:-0}" == "1" ]]; then
  start_suite_leg wsl-test wsl "$SCRIPT_DIR/wsl-test.sh"
  WSL_PID=$RUN_PID
fi

FAIL=0

# Lint, typecheck and the Windows suite finish first; the WSL leg starts only when all three passed, since a red push would otherwise pay for the whole second suite.
wait_legs typecheck ts-checks tests
[[ -z "${FAILED[tests]:-}" ]]     || { report_failure tests; FAIL=1; }
[[ -z "${FAILED[typecheck]:-}" ]] || { report_failure typecheck; FAIL=1; }
[[ -z "${FAILED[ts-checks]:-}" ]] || { report_failure ts-checks; FAIL=1; }
record_leg_outcome tests win

if [[ "$WSL_RUN" -eq 1 ]]; then
  if [[ -z "$WSL_PID" && "$FAIL" -eq 0 ]]; then
    start_suite_leg wsl-test wsl "$SCRIPT_DIR/wsl-test.sh"
    WSL_PID=$RUN_PID
  elif [[ -z "$WSL_PID" ]]; then
    echo "pre-push: WSL leg skipped because the Windows leg failed (lint, typecheck or the Windows suite)"
  fi
  if [[ -n "$WSL_PID" ]]; then
    wait_legs wsl-test
    [[ -z "${FAILED[wsl-test]:-}" ]] || { report_failure wsl-test; FAIL=1; }
    record_leg_outcome wsl-test wsl
  fi
fi

echo "pre-push: legs: lint=$(leg_secs ts-checks) typecheck=$(leg_secs typecheck) win=$(leg_secs tests) wsl=$(leg_secs wsl-test) total=${SECONDS}s"
report_slowest tests Windows
report_slowest wsl-test WSL

if [[ "$FAIL" -eq 0 ]]; then
  rm -rf -- "$LOG_DIR"
fi
exit "$FAIL"
