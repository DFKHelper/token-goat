#!/usr/bin/env bash
# Single entry point for all pre-push checks. Typecheck, ts-checks and the Windows suite run concurrently; the WSL (Linux) suite follows the Windows suite unless PREPUSH_PARALLEL_WSL=1 starts it at once, and it runs only when wsl-gate.sh says so (TG_PREPUSH_WSL=1 or a pushed path listed in wsl-paths.txt) and the Windows leg passed. Each suite leg runs the tests the pushed range touches plus every guard test, cut to a time budget with the cut files printed (prepush-focus.sh, scripts/prepush-select.mjs), and the full suite in any doubt; PREPUSH_FULL=1 forces the full leg, and CI runs the full suite after the push. The WSL leg runs from its own Linux-side copy in a separate VM, so its files and node_modules never overlap the Windows run; both suites then share the workstation's CPU, which is why serial is the default: concurrent, they were slower and flaky.
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
source "$SCRIPT_DIR/prepush-cap.sh"

# The ref lines git gives a pre-push hook (lefthook passes them on with use_stdin). The read is bounded so a stdin that never closes cannot hang the push; no lines means the pushed range is unknown and the WSL leg runs.
PUSH_STDIN=""
# The remote name git gives the hook as its first argument (lefthook {1}); empty when the script is run by hand.
PUSH_REMOTE="${1:-}"
if [[ ! -t 0 ]]; then
  while (( SECONDS < 5 )) && IFS= read -r -t 5 push_line; do PUSH_STDIN+="$push_line"$'\n'; done || true
fi

PIDS=()
WSL_PID=""
declare -A START=() END=() PID_OF=() FAILED=() ABORTED=() STOPPED=() GREEN_TREE_OF=() GREEN_FOCUS_OF=()

run_check() {
  local name=$1
  shift
  # Truncate once, then append: with `>` every child of the check shares one file offset and they overwrite each other's lines.
  : >"$LOG_DIR/$name.log"
  "$@" >>"$LOG_DIR/$name.log" 2>&1 9<&- &
  RUN_PID=$!
  PIDS+=("$RUN_PID")
  cap_register "$RUN_PID"
  PID_OF[$name]=$RUN_PID
  START[$name]=$SECONDS
}

# Waits for the named legs in the order they finish, so each leg's end time is its own and not the moment a slower earlier leg released the wait. Marks FAILED[name] for each leg that exited non-zero. The hard-stop watchdog is waited on too: when it fires, every leg still running is ended and reported (prepush-cap.sh), and a leg ended by the stop is not a failure.
wait_legs() {
  local -A pid_of=()
  local name left=0 fin rc
  for name in "$@"; do
    # A leg the hard stop kept from starting has no pid, and a leg already finished or ended by the stop is not waited on again.
    [[ -n "${PID_OF[$name]:-}" && -z "${END[$name]:-}" && -z "${ABORTED[$name]:-}" ]] || continue
    pid_of[$name]=${PID_OF[$name]}; left=$((left + 1))
  done
  if [[ -n "$HARD_PID" ]]; then pid_of[hardstop]=$HARD_PID; fi
  while [[ "$left" -gt 0 ]]; do
    rc=0
    wait -n -p fin "${pid_of[@]}" || rc=$?
    if [[ -n "$HARD_PID" && "$fin" == "$HARD_PID" ]]; then
      wait "$HARD_PID" 2>/dev/null || true
      HARD_PID=""
      HARD_FIRED=1
      stop_all_legs
      cap_stop_time
      cap_report_stop "$CAP_STOP_AT" "${STOP_ENDED[@]}"
      break
    fi
    for name in "${!pid_of[@]}"; do
      if [[ "${pid_of[$name]:-}" == "$fin" ]]; then
        END[$name]=$SECONDS
        [[ "$rc" -eq 0 || -n "${STOPPED[$name]:-}" ]] || FAILED[$name]=1
        unset "pid_of[$name]"
        left=$((left - 1))
        # Lint or typecheck red: the push is lost already, so end the Windows suite's tree instead of waiting for it.
        if [[ "$rc" -ne 0 && -z "${STOPPED[$name]:-}" && "$name" != "tests" && -n "${pid_of[tests]:-}" ]]; then
          echo "pre-push: $name failed, stopping the Windows suite"
          cap_request_kill "${pid_of[tests]}"
          # Polled, not waited on: a tree that will not die must not hold the hook past a stop; the exit trap ends it again.
          cap_reap_wait "${pid_of[tests]}" "$TERM_WAIT_S"
          ABORTED[tests]=1
          unset "pid_of[tests]"
          left=$((left - 1))
        fi
      fi
    done
  done
}

# The hard stop passed: every leg of this run that has not finished is ended, not only the legs the current wait named (a parallel WSL leg is not in the first wait). A leg that exited in the same second as the stop keeps its own result. The WSL leg gets TERM first, since its Linux-side tree ends only on TERM; then each stopped leg's whole tree. The stopped legs get POST_STOP_S seconds to exit; any still alive is reported by pid in one line and not waited on. Sets STOP_ENDED to the stopped leg names.
stop_all_legs() {
  local name rc=0 stop_until alive_list kill_pids=()
  STOP_ENDED=()
  stop_until=$((SECONDS + POST_STOP_S))
  cap_tail_open_now
  for name in "${!PID_OF[@]}"; do
    [[ -z "${END[$name]:-}" && -z "${ABORTED[$name]:-}" ]] || continue
    if ! kill -0 "${PID_OF[$name]}" 2>/dev/null; then
      wait "${PID_OF[$name]}" 2>/dev/null || rc=$?
      END[$name]=$SECONDS
      [[ "$rc" -eq 0 ]] || FAILED[$name]=1
      rc=0
      continue
    fi
    STOPPED[$name]=1
    ABORTED[$name]=1
    STOP_ENDED+=("$name")
  done
  for name in "${STOP_ENDED[@]}"; do
    if [[ "$name" == "wsl-test" ]]; then cap_term_wait "${PID_OF[$name]}"; fi
  done
  # The trees are ended side by side, so a slow fork delays them once, not once per leg; every one is ended and reaped.
  for name in "${STOP_ENDED[@]}"; do kill_pids+=("${PID_OF[$name]}"); done
  # The legs get the post-stop allowance to exit, not the kill room: one still alive then is named below, and the cleanup process keeps ending it.
  cap_kill_all "$(( stop_until < CAP_KILL_END ? stop_until : CAP_KILL_END ))" "${kill_pids[@]}"
  while :; do
    alive_list=""
    for name in "${STOP_ENDED[@]}"; do
      if kill -0 "${PID_OF[$name]}" 2>/dev/null; then alive_list+=" $name=${PID_OF[$name]}"; else wait "${PID_OF[$name]}" 2>/dev/null || true; fi
    done
    [[ -n "$alive_list" && "$SECONDS" -lt "$stop_until" ]] || break
    cap_tick
  done
  if [[ -n "$alive_list" ]]; then echo "pre-push: stopped legs still running ${POST_STOP_S}s after the hard stop, not waited on (name=pid):$alive_list"; fi
}

# Sets LEG_SECS to a leg's seconds, or "aborted" or "skipped". A plain assignment, not a $() call: each subshell is a fork that costs seconds on a loaded host, and this runs after the stop.
leg_secs() {
  if [[ -n "${ABORTED[$1]:-}" ]]; then
    LEG_SECS='aborted'
  elif [[ -n "${START[$1]:-}" && -n "${END[$1]:-}" ]]; then
    LEG_SECS="$((END[$1] - START[$1]))s"
  else
    LEG_SECS='skipped'
  fi
}

# Starts a suite leg (win or wsl), focused on the pushed range when prepush-focus.sh can say so safely, otherwise in full. $1: log name, $2: leg, $3: the leg's script.
start_suite_leg() {
  RUN_PID=""
  focus_decide "$2"
  # The planning step can outlast the stop; a leg that would start after the stop is not started, as one planned during it is not.
  if [[ -n "$FOCUS_STOPPED" || -e "$HARD_FLAG" ]]; then cap_planning_stopped "$2"; return 0; fi
  echo "pre-push: $FOCUS_NOTE"
  if [[ -n "$FOCUS_DEFERRED" ]]; then echo "pre-push: $FOCUS_DEFERRED"; fi
  # Test files already green on this exact tree (scripts/prepush-green.mjs) are dropped from the Windows leg's list; an emptied list runs nothing, since no list at all would mean the whole suite.
  if [[ "$2" == "win" && -n "$FOCUS_FILE" ]]; then
    GREEN_TREE_OF[$1]="$LOG_DIR/green-tree-win.txt"
    GREEN_FOCUS_OF[$1]="$FOCUS_FILE"
    local green_rc=0
    cap_run_stoppable "$ROOT_DIR" "$LOG_DIR/green-filter.out" node scripts/prepush-green.mjs filter win "$FOCUS_FILE" "${GREEN_TREE_OF[$1]}" || green_rc=$?
    if [[ "$green_rc" -eq "$CAP_STOP_RC" ]]; then cap_planning_stopped "$2"; return 0; fi
  fi
  if [[ -n "$FOCUS_FILE" && ! -s "$FOCUS_FILE" ]]; then
    echo "pre-push: every selected test file was already green on this tree, so the $2 leg has nothing to run"
    run_check "$1" true
  elif [[ -n "$FOCUS_FILE" ]]; then
    run_check "$1" env TG_PREPUSH_FOCUS="$FOCUS_FILE" TG_PREPUSH_PLAN="$FOCUS_PLAN" TG_PREPUSH_CUT_REPORT="$LOG_DIR/cut-$2.txt" bash "$3"
  else
    run_check "$1" env -u TG_PREPUSH_FOCUS -u TG_PREPUSH_PLAN bash "$3"
  fi
}

# Folds a finished suite leg's per-file timings into the duration table the next selection costs files from, and keeps the failing-files record in step with the leg: a red leg records its failures, a green one clears them, a leg that did not run or was aborted changes nothing. $1: log name, $2: leg.
record_leg_outcome() {
  [[ -n "${END[$1]:-}" && -z "${ABORTED[$1]:-}" ]] || return 0
  # Past the tail deadline the record's forks are not started; the leg's result and its failures still print above.
  if ! cap_tail_left; then echo "pre-push: no time left after the hard stop, so the outcome of the $2 leg was not recorded (the next push plans from the older record)"; return 0; fi
  cap_bounded cap_clear_owed "$2"
  cap_bounded node "$ROOT_DIR/scripts/test-durations.mjs" "$LOG_DIR/$1.log" --record "$FAILED_STORE" "$2"
  # A green leg whose fill the wall-clock deadline cut keeps the record: a file that failed last time may be among the files it did not run.
  if [[ -n "${FAILED[$1]:-}" ]]; then cap_bounded focus_record_failure "$2" "$LOG_DIR/$1.log"; elif [[ ! -s "$LOG_DIR/cut-$2.txt" ]]; then cap_bounded focus_clear "$2"; fi
  if [[ -z "${FAILED[$1]:-}" && -n "${GREEN_TREE_OF[$1]:-}" ]]; then
    cap_bounded bash -c 'cd "$1" && shift && node scripts/prepush-green.mjs record-files "$@"' _ "$ROOT_DIR" "$2" "${GREEN_FOCUS_OF[$1]}" "${GREEN_TREE_OF[$1]}"
  fi
}

# Prints the files a leg's wall-clock deadline cut (written by run-test.sh and wsl-test.sh); they are deferred to the full CI suite like the files the estimate cut. $1: leg.
report_cut() {
  [[ -s "$LOG_DIR/cut-$1.txt" ]] || return 0
  local l
  while IFS= read -r l; do echo "$l"; done <"$LOG_DIR/cut-$1.txt"
}

# Prints the slowest test files of one leg's vitest log. A failure of this report never changes the push result.
report_slowest() {
  local name=$1 title=$2
  [[ -n "${START[$name]:-}" && -z "${ABORTED[$name]:-}" ]] || return 0
  echo "pre-push: 20 slowest test files, $title leg"
  cap_bounded node "$ROOT_DIR/scripts/test-durations.mjs" "$LOG_DIR/$name.log" --top 20
}

report_failure() {
  local name=$1
  echo "pre-push: $name FAILED (last 120 lines; full log: $LOG_DIR/$name.log)"
  cap_bounded tail -n 120 "$LOG_DIR/$name.log"
}

# Runs on every exit path (success, failure, INT, TERM). The WSL script gets TERM first so its own trap can end the Linux-side tree, which taskkill on the Windows side cannot reach; then every job still alive is killed with its tree.
cleanup() {
  trap - EXIT INT TERM
  local pid live=()
  if [[ -n "$WSL_PID" ]] && kill -0 "$WSL_PID" 2>/dev/null; then cap_term_wait "$WSL_PID"; fi
  # The watchdog has no children, so a plain kill ends it; kill_tree would cost two forks (cat, taskkill) after the summary, seconds on a loaded host.
  if [[ -n "${HARD_PID:-}" ]]; then kill "$HARD_PID" 2>/dev/null || true; fi
  live=()
  for pid in "${PIDS[@]}"; do
    if [[ "$pid" != "${HARD_PID:-}" ]] && kill -0 "$pid" 2>/dev/null; then live+=("$pid"); fi
  done
  # Side by side and polled: after a stop to the tail deadline, otherwise for the cleanup room the budget keeps.
  cap_kill_all "${CAP_TAIL_END:-$((SECONDS + STOP_CLEANUP_S))}" "${live[@]}"
  cap_reaper_notice
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cap_read_limits
cap_start

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
HARD_FIRED=""

# Lint, typecheck and the Windows suite finish first; the WSL leg starts only when all three passed, since a red push would otherwise pay for the whole second suite.
wait_legs typecheck ts-checks tests
# A lint or typecheck the hard stop ended was never verified, so the push fails.
if [[ -n "${STOPPED[typecheck]:-}" || -n "${STOPPED[ts-checks]:-}" ]]; then FAIL=1; fi
# A passing check's log is dropped, so what it reused is printed here.
if cap_tail_left; then cap_bounded grep -h '^pre-push: reused' "$LOG_DIR/typecheck.log" "$LOG_DIR/ts-checks.log"; fi
[[ -z "${FAILED[tests]:-}" ]]     || { report_failure tests; FAIL=1; }
[[ -z "${FAILED[typecheck]:-}" ]] || { report_failure typecheck; FAIL=1; }
[[ -z "${FAILED[ts-checks]:-}" ]] || { report_failure ts-checks; FAIL=1; }
record_leg_outcome tests win
report_cut win

if [[ "$WSL_RUN" -eq 1 ]]; then
  if [[ -z "$WSL_PID" && -e "$HARD_FLAG" ]]; then
    cap_wsl_not_started
  elif [[ -z "$WSL_PID" && "$FAIL" -eq 0 ]]; then
    start_suite_leg wsl-test wsl "$SCRIPT_DIR/wsl-test.sh"
    WSL_PID=$RUN_PID
  elif [[ -z "$WSL_PID" ]]; then
    echo "pre-push: WSL leg skipped because the Windows leg failed (lint, typecheck or the Windows suite)"
  fi
  if [[ -n "$WSL_PID" ]]; then
    wait_legs wsl-test
    [[ -z "${FAILED[wsl-test]:-}" ]] || { report_failure wsl-test; FAIL=1; }
    record_leg_outcome wsl-test wsl
    report_cut wsl
  fi
fi

# After a stop only the result matters: the slowest-files report and the log cleanup each fork, and the logs of the stopped legs stay for the reader of the notice.
if [[ -z "$HARD_FIRED" ]]; then
  report_slowest tests Windows
  report_slowest wsl-test WSL
  if [[ "$FAIL" -eq 0 ]]; then cap_bounded rm -rf -- "$LOG_DIR"; fi
fi
# The last output, so total= covers every step that forks; only the exit trap (no forks on this path) follows it.
leg_secs ts-checks; lint_s=$LEG_SECS
leg_secs typecheck; typecheck_s=$LEG_SECS
leg_secs tests; win_s=$LEG_SECS
leg_secs wsl-test; wsl_s=$LEG_SECS
echo "pre-push: legs: lint=$lint_s typecheck=$typecheck_s win=$win_s wsl=$wsl_s total=${SECONDS}s"
exit "$FAIL"
