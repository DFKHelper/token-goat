#!/usr/bin/env bash
# Sourced by run-all-checks.sh. Every push runs a focused suite leg: the files that failed last time, the test files changed in the pushed range, every guard test, when src changed the built-bundle matrix, then the tests importing a changed module nearest first, then the tests that name a changed path as text or (src changed) read src or spawn the bundle, while the estimated time stays within the leg budget; the files the budget cut are printed, and the full suite runs in CI. Any doubt keeps the guards and the matrix and spends the budget on the remaining tests; only PREPUSH_FULL=1, a test tree that cannot be listed, or a selection tool that fails runs the full leg. The choice is made by scripts/prepush-select.mjs, which reads the pushed ref lines from $PUSH_STDIN. After a red leg the failing test files are recorded under the git common dir (PREPUSH_FAILED_STORE names another file) and the next focused leg adds them. Needs ROOT_DIR, LOG_DIR, HEAD_SHA and PUSH_STDIN from the caller, and reads PUSH_REMOTE (the pushed remote's name, empty when unknown) so a tag of a commit that remote already has adds no tests.

FAILED_STORE="${PREPUSH_FAILED_STORE:-$(git rev-parse --path-format=absolute --git-common-dir)/token-goat-prepush/last-failed.json}"
FAILED_TOOL="$ROOT_DIR/scripts/prepush-failed.mjs"
SELECT_TOOL="$ROOT_DIR/scripts/prepush-select.mjs"

# $1: leg (win or wsl). Sets FOCUS_FILE to the list of test files to run, or "" for the full leg, FOCUS_NOTE to the one line that says which and why, and FOCUS_DEFERRED to the report of the files the time budget cut (empty when none).
focus_decide() {
  local leg=$1 sel nl first
  FOCUS_FILE=""
  FOCUS_DEFERRED=""
  printf '%s' "$PUSH_STDIN" >"$LOG_DIR/push-refs.txt"
  if ! sel="$(PREPUSH_ELAPSED_S="$SECONDS" node "$SELECT_TOOL" "$ROOT_DIR" "$leg" "$HEAD_SHA" "$LOG_DIR/push-refs.txt" "$FAILED_STORE" "$LOG_DIR/deferred-$leg.txt" "${PUSH_REMOTE:-}" 2>/dev/null)"; then
    FOCUS_NOTE="$leg leg full: the selection tool failed"; return 0
  fi
  # Plain parameter expansion rather than head and tail on a here-string: no process, no temp file, so nothing for a BSD userland to differ on.
  nl=$'\n'
  first="${sel%%"$nl"*}"
  case "$first" in
    FOCUS$'\t'*)
      FOCUS_FILE="$LOG_DIR/focus-$leg.txt"
      printf '%s\n' "${sel#*"$nl"}" >"$FOCUS_FILE"
      FOCUS_NOTE="${first#FOCUS$'\t'}"
      if [[ -s "$LOG_DIR/deferred-$leg.txt" ]]; then FOCUS_DEFERRED="$(cat "$LOG_DIR/deferred-$leg.txt")"; fi ;;
    FULL$'\t'*) FOCUS_NOTE="${first#FULL$'\t'}" ;;
    *) FOCUS_NOTE="$leg leg full: the selection tool printed nothing usable" ;;
  esac
}

# $1: leg, $2: the leg's log. Records the failing files of a red leg; a leg with no parsable failure clears the record so the next run is full.
focus_record_failure() {
  node "$FAILED_TOOL" record "$FAILED_STORE" "$1" "$HEAD_SHA" "$2" || true
}

# $1: leg. A green leg has nothing left to re-run.
focus_clear() {
  node "$FAILED_TOOL" clear "$FAILED_STORE" "$1" || true
}
