#!/usr/bin/env bash
# Sourced by run-all-checks.sh. The hard stop: the pre-push hook ends every leg still running at HARD_STOP_S seconds on its $SECONDS clock (HOOK_LIMIT_S is the hook's limit; both come from scripts/prepush-budget.mjs). Each stopped suite leg gets a notice that says what it did not finish and records those files as owed in owed-<leg>.txt beside the failed-store; a stopped lint or typecheck fails the push. PREPUSH_FULL=1 starts no watchdog. Needs ROOT_DIR, LOG_DIR, FAILED_STORE and PIDS from the caller; defines kill_tree, which the test suite sources. Bash 3.2 compatible: no associative arrays and no wait -n here (tests/guards/lefthook_scripts_run_on_bash_3_2.test.ts).

# The cleanup process (prepush-reaper.sh) does every kill. It is started once, outlives the hook only while a registered leg is alive, and ends each leg's whole tree on a request or when the hook is gone; the hook only registers pids and sends requests. REAP_GRACE_S is how long after the hook exits it may keep ending legs.
REAP_GRACE_S=30
# The default hard stop in seconds; scripts/prepush-budget.mjs derives the same value (HARD_STOP_DEFAULT_S) and a test fails if the two differ.
HARD_STOP_DEFAULT_S=540
REAP_DIR=""
REAP_PID=""
REAP_RECORD=""
CAP_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAP_BOUNDED_N=0

# True when process $1 is alive and, where /proc has winpid and $2 is given, still carries Windows pid $2: a reused pid is not the process.
cap_proc_is() {
  kill -0 "$1" 2>/dev/null || return 1
  [[ -n "${2:-}" ]] || return 0
  local cur=""
  if [[ -r "/proc/$1/winpid" ]]; then read -r cur <"/proc/$1/winpid" 2>/dev/null || cur=""; fi
  [[ -z "$cur" || "$cur" == "$2" ]]
}

# True when the last cleanup process named in the record is still running.
cap_record_live() {
  local l f p="" w=""
  while IFS= read -r l; do
    case "$l" in
      "reaper: pid="*)
        f=${l#reaper: pid=}
        p=${f%% *}
        f=${l#*winpid=}
        w=${f%% *}
        ;;
    esac
  done <"$REAP_RECORD"
  [[ -n "$p" ]] && cap_proc_is "$p" "$w"
}

# Starts the cleanup process and waits for it to say it is up or to be gone, never for a fixed count of ticks (bounded by the hard stop, HARD_STOP_DEFAULT_S or the lower PREPUSH_HARD_STOP_S; unbounded under PREPUSH_FULL=1, which is uncapped, so an alive cleanup process that never says it is up holds that run); without it nothing would end a leg, so the push fails. Names the pids an earlier cleanup process could not end, then clears that record. Idempotent. A run with no hard stop (PREPUSH_FULL=1) gives it no life limit of its own.
cap_reaper_start() {
  [[ -z "$REAP_DIR" ]] || return 0
  local base store life stop_at="" l left="" n=0
  base="${TMP_BASE:-${TMPDIR:-/tmp}}"
  store="$base"
  if [[ -n "${FAILED_STORE:-}" ]]; then store="${FAILED_STORE%/*}"; fi
  mkdir -p -- "$store" 2>/dev/null || true
  REAP_RECORD="$store/reaper-last.txt"
  # A record whose cleanup process is still alive belongs to a push running now: it is neither reported nor deleted, and this run's cleanup process appends to it.
  if [[ -r "$REAP_RECORD" ]] && ! cap_record_live; then
    while IFS= read -r l; do
      case "$l" in "left running: "*) left+=" ${l#left running: }" ;; esac
    done <"$REAP_RECORD"
    if [[ -n "$left" ]]; then echo "pre-push: an earlier push's cleanup process could not end these processes (pid:$left); they may still be running, see $REAP_RECORD"; fi
    rm -f -- "$REAP_RECORD"
  fi
  REAP_DIR="$(mktemp -d "$base/tg-reap.XXXXXX")" || { echo "pre-push: cannot make the cleanup process's directory, so the push fails rather than run legs nothing would end"; exit 1; }
  : >"$REAP_DIR/pids"
  : >"$REAP_DIR/requests"
  life=0
  if [[ "${PREPUSH_FULL:-0}" != "1" ]]; then life=$(( ${HOOK_LIMIT_S:-600} + REAP_GRACE_S )); fi
  "$BASH" "$CAP_SELF_DIR/prepush-reaper.sh" "$$" "$REAP_DIR" "$REAP_RECORD" "$life" "$REAP_GRACE_S" "$CAP_KILL_WIN_S" </dev/null >/dev/null 2>&1 9<&- &
  REAP_PID=$!
  disown "$REAP_PID" 2>/dev/null || true
  if [[ "${PREPUSH_FULL:-0}" != "1" ]]; then
    stop_at=$HARD_STOP_DEFAULT_S
    if [[ "${PREPUSH_HARD_STOP_S:-}" =~ ^[0-9]{1,4}$ ]] && (( 10#$PREPUSH_HARD_STOP_S > 0 && 10#$PREPUSH_HARD_STOP_S < stop_at )); then stop_at=$((10#$PREPUSH_HARD_STOP_S)); fi
  fi
  while [[ ! -e "$REAP_DIR/up" ]] && kill -0 "$REAP_PID" 2>/dev/null && { [[ -z "$stop_at" ]] || (( SECONDS < stop_at )); }; do cap_tick; done
  if [[ ! -e "$REAP_DIR/up" ]]; then
    if kill -0 "$REAP_PID" 2>/dev/null; then
      # One TERM can be lost or ignored while the process is still starting: send it each tick until the recorded pid is gone, then KILL it after CAP_KILL_WIN_S ticks; only our own child's pid is signalled.
      while kill -0 "$REAP_PID" 2>/dev/null; do
        if (( n >= CAP_KILL_WIN_S )); then kill -9 "$REAP_PID" 2>/dev/null || true; break; fi
        kill "$REAP_PID" 2>/dev/null || true
        cap_tick
        n=$((n + 1))
      done
      echo "pre-push: the cleanup process was not up by the ${stop_at}s hard-stop budget, so the push fails rather than run legs nothing would end"
    else
      echo "pre-push: the cleanup process exited before it started, so the push fails rather than run legs nothing would end"
    fi
    exit 1
  fi
}

# Tells the cleanup process about a leg, right after it starts; builtins only. $1: the leg's pid.
cap_register() {
  cap_reaper_start
  { printf '%s\n' "$1" >>"$REAP_DIR/pids"; } 2>/dev/null || true
}

# Asks the cleanup process to end the trees of the given pids; "all" asks for every registered leg. It reads requests once a second.
cap_request_kill() {
  [[ -n "$REAP_DIR" ]] || return 0
  local p
  for p in "$@"; do
    { printf 'kill %s\n' "$p" >>"$REAP_DIR/requests"; } 2>/dev/null || true
  done
}

# Printed as the hook exits: a registered leg still alive is now the cleanup process's to end, and the next push reports any it could not.
cap_reaper_notice() {
  [[ -n "$REAP_DIR" && -r "$REAP_DIR/pids" ]] || return 0
  local p list="" up_p="" up_w=""
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    if kill -0 "$p" 2>/dev/null; then list+=" $p"; fi
  done <"$REAP_DIR/pids"
  [[ -n "$list" ]] || return 0
  if [[ -r "$REAP_DIR/up" ]]; then read -r up_p up_w <"$REAP_DIR/up" 2>/dev/null || true; fi
  if [[ -n "$up_p" && "$up_p" == "$REAP_PID" ]] && cap_proc_is "$up_p" "$up_w"; then
    echo "pre-push: still ending after the hook exits (pid:$list); the cleanup process ends them within ${REAP_GRACE_S}s and records any it cannot end in $REAP_RECORD. CI runs the full suite on pushes to main and on pull requests."
  else
    echo "pre-push: still running after the hook exits (pid:$list), and the cleanup process is not running, so nothing will end them; end them by hand, see $REAP_RECORD. CI runs the full suite on pushes to main and on pull requests."
  fi
}

# Reads HARD_STOP_S, HOOK_LIMIT_S, HARD_STOP_SRC, POST_STOP_S, TERM_WAIT_S and STOP_CLEANUP_S once, before any leg starts. A budget module that cannot be read fails the hook, since a run with no stop would be uncapped.
cap_read_limits() {
  local out f p t=0 ok=1
  f="$(mktemp)"
  cap_reaper_start
  node "$ROOT_DIR/scripts/prepush-budget.mjs" hard-stop >"$f" 9<&- &
  p=$!
  PIDS+=("$p")
  cap_register "$p"
  # No watchdog exists yet, so this one read is cut off at 20 s (a node start is seconds on a loaded host); the exit trap ends a node that is still running.
  while kill -0 "$p" 2>/dev/null && (( t < 20 )); do cap_tick; t=$((t + 1)); done
  if kill -0 "$p" 2>/dev/null; then ok=0; elif ! wait "$p"; then ok=0; fi
  out=""
  if [[ "$ok" -eq 1 ]]; then out="$(<"$f")"; fi
  rm -f -- "$f"
  if [[ "$ok" -eq 0 ]]; then
    echo "pre-push: cannot read the hard stop from scripts/prepush-budget.mjs, so the push fails unchecked"
    exit 1
  fi
  read -r HARD_STOP_S HOOK_LIMIT_S POST_STOP_S TERM_WAIT_S STOP_CLEANUP_S HARD_STOP_SRC <<<"$out"
}

# One second on the hook's clock with no fork: a timed read on a fifo that is never written. A fork per second (sleep 1) lags each stop by a whole tick plus the fork's start-up, which reached 7 s on this host under load. The fifo opens once per shell (fd 9), so a subshell inherits it.
cap_tick_open() {
  [[ -z "${CAP_TICK_OPEN:-}" ]] || return 0
  local fifo
  fifo="$(mktemp -u)"
  mkfifo "$fifo"
  exec 9<>"$fifo"
  rm -f -- "$fifo"
  CAP_TICK_OPEN=1
}

cap_tick() {
  cap_tick_open
  read -r -t 1 -u 9 _ || true
}

# Sends TERM to one leg's process and waits up to TERM_WAIT_S seconds on the hook's clock for it to exit, so a leg whose own trap ends a Linux-side tree (wsl-test.sh) can do it; the caller then ends the whole tree with kill_tree. $1: the leg's pid.
cap_term_wait() {
  local pid=$1 deadline
  kill -TERM "$pid" 2>/dev/null || true
  deadline=$((SECONDS + TERM_WAIT_S))
  # After a stop the wait also ends at the tail deadline, so the exit trap cannot run past it.
  if [[ -n "$CAP_TAIL_CLOSE" ]] && (( CAP_TAIL_CLOSE < deadline )); then deadline=$CAP_TAIL_CLOSE; fi
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do cap_tick; done
}

# Runs as a child of the hook. It ticks until the stop time, then writes the stop time to the flag file and exits, which is the event wait_legs sees. It exits at once when the hook pid is gone. $1: the hook's pid, $2: the stop in seconds, $3: the flag file.
cap_watch() {
  local hook=$1 stop=$2 flag=$3
  trap 'exit 0' TERM INT
  # USR1 is the stop as an event for a test: the flag is written as the clock would, then the watchdog exits.
  trap 'printf "%s\n" "$SECONDS" >"$flag"; exit 0' USR1
  while (( SECONDS < stop )); do
    cap_tick
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
  # Opened here so the watchdog subshell inherits the fifo and its first tick forks nothing.
  cap_tick_open
  cap_watch "$$" "$HARD_STOP_S" "$HARD_FLAG" &
  HARD_PID=$!
  PIDS+=("$HARD_PID")
  # The watchdog's pid, for a test that fires the stop as an event: its TERM trap ends it, which wait_legs reads as the stop.
  printf '%s\n' "$HARD_PID" >"$LOG_DIR/hard-stop.pid"
}

# End the whole process tree under one background job. Git Bash pids map to Windows pids through /proc/<pid>/winpid, and taskkill /T takes the node children with them; elsewhere walk the children with pgrep.
kill_tree() {
  local pid=$1 winpid child
  if [[ -r "/proc/$pid/winpid" ]]; then
    winpid=""
    # A builtin read, not cat: a fork per kill is seconds on a loaded host, inside the tail the deadline bounds.
    read -r winpid <"/proc/$pid/winpid" 2>/dev/null || true
    if [[ -n "$winpid" ]]; then taskkill //T //F //PID "$winpid" &>/dev/null || true; fi
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
  (cd "$dir" && "$@") >"$out" 2>/dev/null 9<&- &
  p=$!
  PIDS+=("$p")
  cap_register "$p"
  while kill -0 "$p" 2>/dev/null; do
    if [[ -n "$HARD_FLAG" && -e "$HARD_FLAG" ]]; then
      # The trees are ended and polled for 2 s, not waited on: a hung taskkill must not hold the hook.
      cap_kill_all "$((SECONDS + 2))" "$p"
      # Reaped only when gone: a wait on a step the cut kill left alive would hold the hook for the step's whole run; the exit trap ends it.
      if ! kill -0 "$p" 2>/dev/null; then wait "$p" 2>/dev/null || true; fi
      return "$CAP_STOP_RC"
    fi
    cap_tick
  done
  wait "$p" || rc=$?
  return "$rc"
}

# The one deadline of everything after the stop, on the hook's clock: set when the stop is handled, to the post-stop allowance, the TERM wait and the cleanup room from the budget constants. The TERM wait and the reap are bounded by their own limits within it; work that forks (the notices, the owed record, the outcome records) starts only while it is open, runs under cap_run_by_deadline, and otherwise says in one builtin line what it skipped. Ending the legs is never skipped. Empty before a stop.
# The tail is carved into three deadlines (S = the hard stop, at most 540; END = S + post-stop + TERM_WAIT_S + STOP_CLEANUP_S - CAP_TICK_S, at most 589, and post-stop is 560 - S by default or lower): CAP_TAIL_CLOSE = END - 2*CAP_KILL_WIN_S ends the TERM wait and every fork (cap_bounded forks nothing after it), CAP_KILL_END = END - CAP_KILL_WIN_S ends the stop path's kill poll, and CAP_TAIL_END ends the exit trap's kill poll, so the kill polls own the last 2*CAP_KILL_WIN_S seconds, 5 s each, which a 2-3 s taskkill fits; the one run in flight at CAP_TAIL_CLOSE is ended with a 2 s poll (end <= CLOSE + 2 < CAP_KILL_END). A poll tests its deadline once a tick, so it ends under one tick (CAP_TICK_S) past it: the tick is reserved inside the budget (STOP_CLEANUP_S is 20 s, END counts 19 of them), so the hook ends before 589 + 1 = 590 s and, with the 10 s STARTUP_RESERVE_S, before 600 s for every PREPUSH_HARD_STOP_S and PREPUSH_POST_STOP_S.
CAP_KILL_WIN_S=5
CAP_TICK_S=1
CAP_TAIL_CLOSE=""
CAP_KILL_END=""
CAP_TAIL_END=""
cap_tail_open_now() {
  local base=$SECONDS
  # Anchored to the hard stop, not to when it was handled, so watchdog lag counts against the tail; a stop fired before its time (a test) anchors to now.
  if (( HARD_STOP_S < base )); then base=$HARD_STOP_S; fi
  CAP_TAIL_END=$((base + POST_STOP_S + TERM_WAIT_S + STOP_CLEANUP_S - CAP_TICK_S))
  CAP_KILL_END=$((CAP_TAIL_END - CAP_KILL_WIN_S))
  CAP_TAIL_CLOSE=$((CAP_TAIL_END - 2 * CAP_KILL_WIN_S))
}

# Asks the cleanup process to end the trees of the given pids (the hook does no kill of its own) and polls until every one is gone or $1 seconds on the hook's clock pass; a pid gone is reaped, one still alive then is left to the cleanup process and said so. $1: deadline (SECONDS value), the rest: pids.
cap_kill_all() {
  local until_s=$1 p alive
  shift
  (( $# > 0 )) || return 0
  cap_request_kill "$@"
  while :; do
    alive=""
    for p in "$@"; do
      if kill -0 "$p" 2>/dev/null; then alive+=" $p"; else wait "$p" 2>/dev/null || true; fi
    done
    [[ -n "$alive" ]] || return 0
    if (( SECONDS >= until_s )); then
      echo "pre-push: ending the process trees did not finish in time (pids:$alive); they were not waited on, and the cleanup process keeps ending them"
      return 0
    fi
    cap_tick
  done
}

# Waits for one already-ended leg to be gone, polling the pid until it is, the watchdog flag appears, or $2 seconds pass. A leg still alive then stays in PIDS, which the exit trap ends. $1: pid, $2: seconds.
cap_reap_wait() {
  local pid=$1 until_s=$(( SECONDS + $2 ))
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < until_s )) && [[ ! -e "${HARD_FLAG:-}" ]]; do cap_tick; done
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  wait "$pid" 2>/dev/null || true
}

# True when the tail deadline has not passed (or no stop has happened, so there is none).
cap_tail_left() {
  [[ -z "$CAP_TAIL_CLOSE" ]] || (( SECONDS < CAP_TAIL_CLOSE ))
}

# Like cap_run_stoppable, but ended at the tail deadline instead of the stop flag. $1: file that receives its stdout, $2...: the command. Returns its status, or 124 when the deadline ended it with its whole tree.
cap_run_by_deadline() {
  local out=$1 p rc=0
  shift
  "$@" >"$out" 2>/dev/null 9<&- &
  p=$!
  PIDS+=("$p")
  cap_register "$p"
  while kill -0 "$p" 2>/dev/null; do
    if ! cap_tail_left; then
      # The trees are ended and polled for 2 s, not waited on: a hung taskkill must not hold the hook.
      cap_kill_all "$((SECONDS + 2))" "$p"
      # Reaped only when gone: a wait on a fork the cut kill left alive would hold the hook for the fork's whole run; the exit trap ends it.
      if ! kill -0 "$p" 2>/dev/null; then wait "$p" 2>/dev/null || true; fi
      return 124
    fi
    cap_tick
  done
  wait "$p" || rc=$?
  return "$rc"
}

# Runs bookkeeping that forks so it can always be ended: before a stop under cap_run_stoppable (the watchdog flag ends it), after one under cap_run_by_deadline (the tail deadline ends it). Its output is replayed with builtins when it finishes. A command a limit ended is said so. Always returns 0.
cap_bounded() {
  local rc=0 l out
  CAP_BOUNDED_N=$((CAP_BOUNDED_N + 1))
  out="$LOG_DIR/bounded.$CAP_BOUNDED_N.out"
  # Past the tail close nothing forks, so no call site after it reaches cap_kill_all.
  if ! cap_tail_left; then echo "pre-push: no time left after the hard stop, so '$1' was skipped"; return 0; fi
  if [[ -z "$CAP_TAIL_END" ]]; then
    cap_run_stoppable "$ROOT_DIR" "$out" "$@" || rc=$?
  else
    cap_run_by_deadline "$out" "$@" || rc=$?
  fi
  if [[ -r "$out" ]]; then while IFS= read -r l; do echo "$l"; done <"$out"; fi
  if [[ "$rc" -eq 124 || "$rc" -eq "$CAP_STOP_RC" ]]; then echo "pre-push: the hard stop left no time for '$1', so it was ended before it finished"; fi
  return 0
}

# Sets CAP_STOP_AT to the second at which the watchdog fired, as it wrote the flag (builtins only, no subshell). Notices report this, not the moment they print: ending a tree takes taskkill time after the stop.
cap_stop_time() {
  CAP_STOP_AT=$SECONDS
  if [[ -r "$HARD_FLAG" ]]; then read -r CAP_STOP_AT <"$HARD_FLAG" || CAP_STOP_AT=$SECONDS; fi
}

# $1: leg (win or wsl). Printed when the hard stop passed while the leg was being planned: the leg does not start, and its files are not recorded as owed, since no selection ran for it.
cap_planning_stopped() {
  cap_stop_time
  echo "pre-push: the $1 leg did not start, because the ${HARD_STOP_S}s hard stop passed while it was being planned (${CAP_STOP_AT}s); this push does not run its files, and they are not recorded as owed. CI runs the full suite on pushes to main and on pull requests."
}

# A leg that finished on its own clears the owed list an earlier stop left: its own run has now covered those files or reported them.
cap_clear_owed() {
  rm -f -- "$(dirname "$FAILED_STORE")/owed-$1.txt"
}

# The notice when the tail deadline left no time to work out the unfinished files: builtins only. It names every file the leg was given, which of them did not finish is not known here, and nothing is recorded as owed. $1: leg, $2: elapsed seconds, $3: the leg's file list.
cap_suite_notice_late() {
  local leg=$1 elapsed=$2 plan=$3 why=${4:-there was no time left to work out which of its test files did not finish} f k=0
  echo "pre-push: stopped the $leg leg after ${elapsed}s at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). It was given these test files; ${why}, so none is recorded as owed; the list is every file it was given, and CI runs the full suite on pushes to main and on pull requests:"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    k=$((k + 1))
    if (( k <= 25 )); then echo "  $f"; fi
  done <"$plan"
  if (( k > 25 )); then echo "  ... and $((k - 25)) more in $plan"; fi
}

# $1: leg (win or wsl), $2: the leg's log name (tests or wsl-test), $3: elapsed seconds at the stop. Prints the notice for a suite leg and writes its owed list when the leg had a file list.
cap_suite_notice() {
  local leg=$1 name=$2 elapsed=$3 plan out rc=0 first n owed_path body f k=0
  plan="$LOG_DIR/focus-$leg.txt"
  if [[ ! -e "$plan" ]]; then
    echo "pre-push: stopped the $leg leg after ${elapsed}s at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). It ran the whole suite with no file list, so the files it did not reach are not known; CI runs the full suite on pushes to main and on pull requests."
    return 0
  fi
  if ! cap_tail_left; then cap_suite_notice_late "$leg" "$elapsed" "$plan"; return 0; fi
  cap_run_by_deadline "$LOG_DIR/owed-$leg.out" node "$ROOT_DIR/scripts/prepush-failed.mjs" owed "$FAILED_STORE" "$leg" "$plan" "$LOG_DIR/$name.log" || rc=$?
  if [[ "$rc" -eq 124 ]]; then cap_suite_notice_late "$leg" "$elapsed" "$plan"; return 0; fi
  out=""
  if [[ -r "$LOG_DIR/owed-$leg.out" ]]; then out="$(<"$LOG_DIR/owed-$leg.out")"; fi
  first="${out%%$'\n'*}"
  n="${first%%$'\t'*}"
  owed_path="${first#*$'\t'}"
  body=""
  if [[ "$out" == *$'\n'* ]]; then body="${out#*$'\n'}"; fi
  if [[ ! "$n" =~ ^[0-9]+$ ]]; then
    cap_suite_notice_late "$leg" "$elapsed" "$plan" "the tool that works out which of its test files did not finish printed no file count"
    return 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "pre-push: stopped the $leg leg after ${elapsed}s: it was still running at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). $n test file(s) did not finish; the files owed could not be recorded; CI runs the full suite on pushes to main and on pull requests."
    return 0
  fi
  echo "pre-push: stopped the $leg leg after ${elapsed}s: it was still running at the ${HARD_STOP_S}s hard stop (the pre-push limit is ${HOOK_LIMIT_S}s). $n test file(s) did not finish and are recorded in $owed_path; CI runs the full suite on pushes to main and on pull requests:"
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
