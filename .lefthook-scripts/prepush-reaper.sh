#!/usr/bin/env bash
# The pre-push cleanup process: started once by prepush-cap.sh (cap_reaper_start), it outlives the hook only as long as a leg does, and ends every leg tree the hook registered. usage: prepush-reaper.sh <hook pid> <reap dir> <record file> <life limit in seconds, 0 for none> <grace seconds> <kill window seconds>. The hook appends leg pids to <reap dir>/pids and kill requests ("kill <pid>" or "kill all") to <reap dir>/requests; this process reads both on every 1 s tick. It ends a tree with taskkill (cut at the kill window), then ends what is left directly, descendants of a leg included: they are found on every tick while a leg is alive, since taskkill /T leaves an msys child behind and an orphan has lost its parent link. When the hook is gone it ends everything once and exits when nothing is left or the grace has passed; the record file names each pid it ended and each it could not ("left running: <pid>"). Bash 3.2 compatible (tests/guards/lefthook_scripts_run_on_bash_3_2.test.ts).

OWNER=${1:-}
DIR=${2:-}
RECORD=${3:-}
LIFE=${4:-0}
GRACE=${5:-30}
WIN=${6:-5}
case "$OWNER$LIFE$GRACE$WIN" in '' | *[!0-9]*) exit 2 ;; esac
[[ -n "$DIR" && -d "$DIR" && -n "$RECORD" ]] || exit 2
# The hook's directory may be removed under a test or a push; nothing here holds one as its working directory.
cd / || exit 2
trap '' INT HUP

# Known processes: the registered legs (top = own pid), their descendants (top = the leg's pid), and this process's own taskkill jobs (job = 1). A gone entry stays gone.
K_PID=()
K_TOP=()
K_JOB=()
K_GONE=()
K_N=0
PIDS_SEEN=0
REQ_SEEN=0
TK_JOBS=" "
OWNER_W=""
GONE_AT=""
GONE_ENDED=""
DID_ALL=""
# The work after the hook is gone stops one second short of the grace, so the exit stamp (taken after builtin work and a tick that may run long) is still within GRACE of the gone stamp.
GRACE_WORK=$(( GRACE > 1 ? GRACE - 1 : 0 ))
FINISHED=""
SEL=" "
F=""
W=""
START=$SECONDS

rec() { printf '%s\n' "$*" >>"$RECORD" 2>/dev/null || true; }

winpid_of() {
  W=""
  if [[ -r "/proc/$1/winpid" ]]; then read -r W <"/proc/$1/winpid" 2>/dev/null || W=""; fi
}

# One second with no fork: a timed read on a fifo that is never written and that no child inherits (every child starts with 9<&-). Only a timeout (status above 128) means a second passed: a read that returns at once (a closed or broken descriptor, an EOF) would make the loop spin on one core, so any other status sleeps the second instead.
tick_open() {
  local fifo="$DIR/tick"
  mkfifo "$fifo" 2>/dev/null || return 1
  exec 9<>"$fifo" || return 1
  rm -f -- "$fifo"
}
tick() {
  local rc=0
  backstop
  read -r -t 1 -u 9 _ 2>/dev/null || rc=$?
  (( rc > 128 )) || sleep 1 </dev/null 9<&- 2>/dev/null || true
}

# The reaper's own bounds, checked inside every loop and not only at the top of the main one: a pass that never reaches the main loop's life and grace tests (a stuck or runaway inner loop) must still end this process. The bound is the life limit plus the grace and the kill window plus slack, or, once the hook is gone, the grace plus the kill window plus slack from the stamp of its death.
backstop() {
  [[ -z "$FINISHED" && -n "$START" ]] || return 0
  if [[ -n "$GONE_AT" ]]; then
    (( SECONDS - GONE_AT < GRACE + WIN + 5 )) || exit 0
  elif (( LIFE > 0 )); then
    (( SECONDS - START < LIFE + GRACE + WIN + 5 )) || exit 0
  fi
}

ent_alive() {
  local i=$1
  backstop
  [[ -z "${K_GONE[$i]}" ]] || return 1
  if kill -0 "${K_PID[$i]}" 2>/dev/null; then return 0; fi
  K_GONE[$i]=1
  return 1
}

# Sets F to the index of the live entry for pid $1.
find_known() {
  local i
  F=""
  for (( i = 0; i < K_N; i++ )); do
    if [[ "${K_PID[$i]}" == "$1" ]] && ent_alive "$i"; then F=$i; return 0; fi
  done
  return 1
}

# $1: pid, $2: the leg it belongs to, $3: 1 for this process's own taskkill job.
add_known() {
  if find_known "$1"; then return 0; fi
  K_PID[$K_N]=$1
  K_TOP[$K_N]=$2
  K_JOB[$K_N]=${3:-}
  K_GONE[$K_N]=""
  K_N=$((K_N + 1))
  if [[ "$1" != "$2" && -z "${3:-}" ]]; then rec "tracking: $1 under leg $2"; fi
}

root_alive() {
  local i
  for (( i = 0; i < K_N; i++ )); do
    if [[ "${K_PID[$i]}" == "$1" && "${K_TOP[$i]}" == "$1" ]]; then
      ent_alive "$i"
      return
    fi
  done
  return 1
}

# Reads the legs the hook registered since the last tick. A pid is a number above 1; a line still being written has no newline yet and is read on the next tick.
sync_pids() {
  local n=0 l
  [[ -r "$DIR/pids" ]] || return 0
  while IFS= read -r l; do
    n=$((n + 1))
    (( n > PIDS_SEEN )) || continue
    case "$l" in '' | *[!0-9]*) continue ;; esac
    (( l > 1 )) || continue
    add_known "$l" "$l"
  done <"$DIR/pids"
  PIDS_SEEN=$n
}

# Sets REQ_ALL and REQ_LIST from the requests added since the last tick.
sync_requests() {
  local n=0 verb arg
  REQ_ALL=""
  REQ_LIST=" "
  [[ -r "$DIR/requests" ]] || return 0
  while read -r verb arg; do
    n=$((n + 1))
    (( n > REQ_SEEN )) || continue
    [[ "$verb" == "kill" ]] || continue
    case "$arg" in
      all) REQ_ALL=1 ;;
      '' | *[!0-9]*) ;;
      *) REQ_LIST+="$arg " ;;
    esac
  done <"$DIR/requests"
  REQ_SEEN=$n
}

# Adds every live descendant of a known live process to its leg's entries. Where /proc has ppid (Git Bash) the process table is read with builtins, no fork; elsewhere one ps -A listing is written to a file in the reap dir (not forked into a pipe) and read the same way.
ingest() {
  local d p pp i j np=0 changed=1 set=" " RP RPP
  RP=()
  RPP=()
  if [[ -r "/proc/$$/ppid" ]]; then
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      pp=""
      read -r pp <"$d/ppid" 2>/dev/null || continue
      RP[$np]=$p
      RPP[$np]=$pp
      np=$((np + 1))
    done
  else
    ps -A -o pid= -o ppid= >"$DIR/ps" 2>/dev/null || true
    while read -r p pp; do
      case "$p$pp" in '' | *[!0-9]*) continue ;; esac
      RP[$np]=$p
      RPP[$np]=$pp
      np=$((np + 1))
    done <"$DIR/ps" 2>/dev/null
    rm -f -- "$DIR/ps"
  fi
  for (( i = 0; i < K_N; i++ )); do
    if ent_alive "$i"; then set+="${K_PID[$i]} "; fi
  done
  while (( changed )); do
    backstop
    changed=0
    for (( j = 0; j < np; j++ )); do
      case "$set" in *" ${RP[$j]} "*) continue ;; esac
      case "$set" in *" ${RPP[$j]} "*) ;; *) continue ;; esac
      [[ "${RP[$j]}" != "$$" ]] || continue
      find_known "${RPP[$j]}" || continue
      add_known "${RP[$j]}" "${K_TOP[$F]}" "${K_JOB[$F]}"
      set+="${RP[$j]} "
      changed=1
    done
  done
}

# Sets SEL to the indexes of the live leg entries (descendants included, taskkill jobs not) that $1 asks for: "all" or " <leg pid> <leg pid> ".
select_alive() {
  local i
  SEL=" "
  for (( i = 0; i < K_N; i++ )); do
    [[ -z "${K_JOB[$i]}" ]] || continue
    if [[ "$1" != "all" ]]; then
      case "$1" in *" ${K_TOP[$i]} "*) ;; *) continue ;; esac
    fi
    if ent_alive "$i"; then SEL+="$i "; fi
  done
}

kill_entries() {
  local i
  for i in $SEL; do kill -KILL "${K_PID[$i]}" 2>/dev/null || true; done
}

# Ends this batch's taskkill jobs and whatever they started: a hung taskkill is cut here, and a native taskkill under its msys job does not die with it.
cut_jobs() {
  local j i
  ingest
  for j in $TK_JOBS; do
    for (( i = 0; i < K_N; i++ )); do
      [[ "${K_TOP[$i]}" == "$j" ]] || continue
      if ent_alive "$i"; then kill -KILL "${K_PID[$i]}" 2>/dev/null || true; fi
    done
  done
}

# Ends the legs $1 asks for. taskkill first, side by side, for at most WIN seconds; a descendant whose leg is already gone is ended at once, since taskkill is done with that tree; what is alive at the window's end is ended directly at once, hook gone or not (a gate on the hook being gone left a leg whose taskkill hung alive for the hook's whole tail, 41.7 s after the stop in a stamped run), and confirmed for up to 3 ticks; one still alive after that is left for the hook to report.
do_kill() {
  local want=$1 i j k winpid have_tk=0 cut_at initial list=""
  sync_pids
  ingest
  select_alive "$want"
  [[ "$SEL" != " " ]] || return 0
  initial=$SEL
  for i in $initial; do list+=" ${K_PID[$i]}"; done
  rec "ending:$list"
  TK_JOBS=" "
  for i in $initial; do
    [[ "${K_TOP[$i]}" == "${K_PID[$i]}" ]] || continue
    winpid_of "${K_PID[$i]}"
    winpid=$W
    [[ -n "$winpid" ]] || continue
    taskkill //T //F //PID "$winpid" &>/dev/null </dev/null 9<&- &
    j=$!
    add_known "$j" "$j" 1
    TK_JOBS+="$j "
    have_tk=1
  done
  cut_at=$((SECONDS + WIN))
  while (( have_tk )); do
    ingest
    select_alive "$want"
    [[ "$SEL" != " " ]] || break
    for i in $SEL; do
      if ! root_alive "${K_TOP[$i]}"; then kill -KILL "${K_PID[$i]}" 2>/dev/null || true; fi
    done
    (( SECONDS < cut_at )) || break
    ! grace_over || break
    tick
    note_owner
  done
  cut_jobs
  for (( k = 0; k < 3; k++ )); do
    ingest
    select_alive "$want"
    [[ "$SEL" != " " ]] || break
    kill_entries
    ! grace_over || break
    tick
    note_owner
  done
  cut_jobs
  for i in $initial; do
    if ! ent_alive "$i"; then rec "ended: ${K_PID[$i]}"; fi
  done
}

# True while a registered leg or one of its descendants is alive.
any_alive() {
  select_alive all
  [[ "$SEL" != " " ]]
}

# The hook is alive while its pid answers and, where /proc has winpid, still carries the Windows pid read at start: a reused pid is not the hook.
owner_alive() {
  kill -0 "$OWNER" 2>/dev/null || return 1
  [[ -n "$OWNER_W" ]] || return 0
  winpid_of "$OWNER"
  [[ -n "$W" ]] || return 0
  [[ "$W" == "$OWNER_W" ]]
}

# True once the work allowed after the hook's death is used up, on the reaper's clock from the stamp of the hook's death.
grace_over() {
  [[ -n "$GONE_AT" ]] && (( SECONDS - GONE_AT >= GRACE_WORK ))
}

# Stamps the hook's death once, in the record, so a test reads the grace off the reaper's own clock.
mark_gone() {
  [[ -z "$GONE_AT" ]] || return 0
  GONE_AT=$SECONDS
  rec "hook gone: $GONE_AT"
}

# Stamps the moment the hook is first seen gone, from inside do_kill's waits as well as from the main loop: the grace runs from the hook's death, and a request being ended when the hook exited (up to 5 s window plus 3 confirm ticks) must not push the stamp, and so the exit, that far late.
note_owner() {
  [[ -n "$GONE_AT" ]] || owner_alive || mark_gone
}

finish() {
  local i
  [[ -z "$FINISHED" ]] || return 0
  FINISHED=1
  rec "exit: $SECONDS"
  for (( i = 0; i < K_N; i++ )); do
    if [[ -n "${K_JOB[$i]}" ]] && ent_alive "$i"; then kill -KILL "${K_PID[$i]}" 2>/dev/null || true; fi
  done
  for (( i = 0; i < K_N; i++ )); do
    [[ -z "${K_JOB[$i]}" ]] || continue
    if ent_alive "$i"; then rec "left running: ${K_PID[$i]}"; fi
  done
  rm -rf -- "$DIR" 2>/dev/null || true
}
# A test sources the functions without running the loop.
[[ -z "${REAP_SOURCE_ONLY:-}" ]] || return 0
trap finish EXIT
trap 'exit 143' TERM

tick_open || exit 1
winpid_of "$OWNER"
OWNER_W=$W
owner_alive || exit 1
winpid_of "$$"
printf '%s %s\n' "$$" "$W" >"$DIR/up" || exit 1
rec "reaper: pid=$$ winpid=$W owner=$OWNER life=$LIFE grace=$GRACE"

START=$SECONDS
while :; do
  tick
  sync_pids
  sync_requests
  DID_ALL=""
  if [[ -n "$REQ_ALL" ]]; then
    do_kill all
    DID_ALL=1
  elif [[ "$REQ_LIST" != " " ]]; then
    do_kill "$REQ_LIST"
  fi
  if [[ -z "$GONE_ENDED" ]] && ! owner_alive; then
    mark_gone
    GONE_ENDED=1
    [[ -n "$DID_ALL" ]] || do_kill all
  fi
  if (( LIFE > 0 && SECONDS - START >= LIFE )); then
    [[ -n "$GONE_ENDED" ]] || do_kill all
    break
  fi
  if [[ -n "$GONE_AT" ]]; then
    any_alive || break
    ! grace_over || break
  else
    ingest
  fi
done
