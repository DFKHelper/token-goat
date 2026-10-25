#!/usr/bin/env bash
# Sourced by run-all-checks.sh. Every push runs a focused suite leg: the files changed in the pushed range, the tests related to them, every guard test and, when src changed, the tree-reading and built-bundle tests; the full suite runs in CI. Any doubt falls back to the full leg. The choice is made by scripts/prepush-select.mjs, which reads the pushed ref lines from $PUSH_STDIN. After a red leg the failing test files are recorded under the git common dir and the next focused leg adds them. Needs ROOT_DIR, LOG_DIR, HEAD_SHA and PUSH_STDIN from the caller.

FAILED_STORE="$(git rev-parse --path-format=absolute --git-common-dir)/token-goat-prepush/last-failed.json"
FAILED_TOOL="$ROOT_DIR/scripts/prepush-failed.mjs"
SELECT_TOOL="$ROOT_DIR/scripts/prepush-select.mjs"

# $1: leg (win or wsl). Sets FOCUS_FILE to a list of paths for `vitest related`, or "" for the full leg, and FOCUS_NOTE to the one line that says which and why.
focus_decide() {
  local leg=$1 sel nl first
  FOCUS_FILE=""
  printf '%s' "$PUSH_STDIN" >"$LOG_DIR/push-refs.txt"
  if ! sel="$(node "$SELECT_TOOL" "$ROOT_DIR" "$leg" "$HEAD_SHA" "$LOG_DIR/push-refs.txt" "$FAILED_STORE" 2>/dev/null)"; then
    FOCUS_NOTE="$leg leg full: the selection tool failed"; return 0
  fi
  # Plain parameter expansion rather than head and tail on a here-string: no process, no temp file, so nothing for a BSD userland to differ on.
  nl=$'\n'
  first="${sel%%"$nl"*}"
  case "$first" in
    FOCUS$'\t'*)
      FOCUS_FILE="$LOG_DIR/focus-$leg.txt"
      printf '%s\n' "${sel#*"$nl"}" >"$FOCUS_FILE"
      FOCUS_NOTE="${first#FOCUS$'\t'}" ;;
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
