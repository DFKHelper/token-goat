#!/usr/bin/env bash
# Sourced by run-all-checks.sh. The hard stop: the pre-push hook ends every leg still running at HARD_STOP_S seconds on its $SECONDS clock (HOOK_LIMIT_S is the hook's limit; both come from scripts/prepush-budget.mjs). Each stopped suite leg gets a notice that says what it did not finish and records those files as owed in owed-<leg>.txt beside the failed-store; a stopped lint or typecheck fails the push. PREPUSH_FULL=1 starts no watchdog. Needs ROOT_DIR, LOG_DIR, FAILED_STORE and PIDS from the caller; defines kill_tree, which the test suite sources. Bash 3.2 compatible: no associative arrays and no wait -n here (tests/guards/lefthook_scripts_run_on_bash_3_2.test.ts).

# Reads HARD_STOP_S, HOOK_LIMIT_S and HARD_STOP_SRC once, before any leg starts. A budget module that cannot be read fails the hook, since a run with no stop would be uncapped.
cap_read_limits() {
  local out
  if ! out="$(node "$ROOT_DIR/scripts/prepush-budget.mjs" hard-stop)"; then
    echo "pre-push: cannot read the hard stop from scripts/prepush-budget.mjs, so the push fails unchecked"
    exit 1
  fi
  read -r HARD_STOP_S HOOK_LIMIT_S HARD_STOP_SRC <<<"$out"
}

# Runs as a child of the hook. It sleeps in one-second steps until the stop time, then writes the stop time to the flag file and exits, which is the event wait_legs sees. It exits at once when the hook pid is gone. $1: the hook's pid, $2: the stop in seconds, $3: the flag file.
cap_watch() {
  local hook=$1 stop=$2 flag=$3
  trap 'exit 0' TERM INT
  while (( SECONDS < stop )); do
    sleep 1 &
    wait $!
    kill -0 "$hook" 2>/dev/null || exit 0
  done
  printf '%s\n' "$SECONDS" >"$flag"
}

# Starts the watchdog and adds it to PIDS, so cleanup ends it on every exit path. PREPUSH_FULL=1 starts none: that run is uncapped by request.
cap_start() {
  HARD_FLAG="$LOG_DIR/hard-stop.flag"
  HARD_PID=""
  if [[ "${PREPUSH_FULL:-0}" == "1" ]]; then
    echo "pre-push: PREPUSH_FULL=1, so this run has no hard stop"
    return 0
  fi
  echo "pre-push: hard stop at ${HARD_STOP_S}s (pre-push limit ${HOOK_LIMIT_S}s; $HARD_STOP_SRC)"
  cap_watch "$$" "$HARD_STOP_S" "$HARD_FLAG" &
  HARD_PID=$!
  PIDS+=("$HARD_PID")
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

# Exit status of cap_run_stoppable when the hard stop ended the command.
CAP_STOP_RC=125

# Runs a foreground step (the test selection, the green filter) in the background, so the hard stop can end it. $1: directory to run in, $2: file that receives its stdout, $3...: the command. Returns the command's status, or CAP_STOP_RC when the stop ended it with its whole tree. Polls the flag once a second and waits on the child's own pid, so a step that runs past the stop is cut at the stop, not at the next leg wait.
cap_run_stoppable() {
  local dir=$1 out=$2 p rc=0
  shift 2
  (cd "$dir" && "$@") >"$out" 2>/dev/null &
  p=$!
  PIDS+=("$p")
  while kill -0 "$p" 2>/dev/null; do
    if [[ -n "$HARD_FLAG" && -e "$HARD_FLAG" ]]; then
      kill_tree "$p"
      wait "$p" 2>/dev/null || true
      return "$CAP_STOP_RC"
    fi
    sleep 1 &
    wait $!
  done
  wait "$p" || rc=$?
  return "$rc"
}

# The second at which the watchdog fired, as it wrote the flag. Notices report this, not the moment they print: ending a tree takes taskkill time after the stop.
cap_stop_time() {
  cat "$HARD_FLAG" 2>/dev/null || echo "$SECONDS"
}

# $1: leg (win or wsl). Printed when the hard stop passed while the leg was being planned: the leg does not start, and its files are not recorded as owed, since no selection ran for it.
cap_planning_stopped() {
  echo "pre-push: the $1 leg did not start, because the ${HARD_STOP_S}s hard stop passed while it was being planned ($(cap_stop_time)s); this push does not run its files, and they are not recorded as owed. CI runs the full suite on pushes to main and on pull requests."
}

# A leg that finished on its own clears the owed list an earlier stop left: its own run has now covered those files or reported them.
cap_clear_owed() {
  rm -f -- "$(dirname "$FAILED_STORE")/owed-$1.txt"
}

# $1: leg (win or wsl), $2: the leg's log name (tests or wsl-test), $3: elapsed seconds at the stop. Prints the notice for a suite leg and writes its owed list when the leg had a file list.
cap_suite_notice() {
  local leg=$1 name=$2 elapsed=$3 plan out rc=0 first n owed_path body f k=0
  plan="$LOG_DIR/focus-$leg.txt"
  if [[ ! -e "$plan" ]]; then
    echo "pre-push: stopped the $leg leg after ${elapsed}s at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). It ran the whole suite with no file list, so the files it did not reach are not known; CI runs the full suite on pushes to main and on pull requests."
    return 0
  fi
  out="$(node "$ROOT_DIR/scripts/prepush-failed.mjs" owed "$FAILED_STORE" "$leg" "$plan" "$LOG_DIR/$name.log")" || rc=$?
  first="${out%%$'\n'*}"
  n="${first%%$'\t'*}"
  owed_path="${first#*$'\t'}"
  body=""
  if [[ "$out" == *$'\n'* ]]; then body="${out#*$'\n'}"; fi
  if [[ ! "$n" =~ ^[0-9]+$ ]]; then
    echo "pre-push: stopped the $leg leg after ${elapsed}s at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). It ran the whole suite with no file list, so the files it did not reach are not known; CI runs the full suite on pushes to main and on pull requests."
    return 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "pre-push: stopped the $leg leg after ${elapsed}s: it was still running at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). $n test file(s) did not finish; the files owed could not be recorded; CI runs the full suite on pushes to main and on pull requests."
    return 0
  fi
  echo "pre-push: stopped the $leg leg after ${elapsed}s: it was still running at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). $n test file(s) did not finish and are owed to the next push; CI runs the full suite on pushes to main and on pull requests:"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    k=$((k + 1))
    if (( k <= 25 )); then echo "  $f"; fi
  done <<<"$body"
  if (( n > 25 )); then echo "  ... and $((n - 25)) more in $owed_path"; fi
}

# $1: elapsed seconds at the stop; the rest: the log names of the legs the stop ended. Prints one notice for each of them, each saying what that leg did not finish.
cap_report_stop() {
  local elapsed=$1 name
  shift
  for name in "$@"; do
    case "$name" in
      typecheck) echo "pre-push: typecheck was still running at the ${HARD_STOP_S}s hard stop (${elapsed}s); the push fails because it was not verified." ;;
      ts-checks) echo "pre-push: lint was still running at the ${HARD_STOP_S}s hard stop (${elapsed}s); the push fails because it was not verified." ;;
      tests) cap_suite_notice win tests "$elapsed" ;;
      wsl-test) cap_suite_notice wsl wsl-test "$elapsed" ;;
    esac
  done
}

# The WSL leg follows the Windows leg; when the hard stop has already passed it is not started, and this says so. Its files are not recorded as owed, since no selection ran for it.
cap_wsl_not_started() {
  echo "pre-push: the wsl-test leg did not start, because the ${HARD_STOP_S}s hard stop had already passed; this push does not run its files, and they are not recorded as owed. CI runs the full suite on pushes to main and on pull requests."
}
