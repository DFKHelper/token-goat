#!/usr/bin/env bash
# Sourced by run-all-checks.sh. After a red pre-push leg the failing test files are recorded under the git common dir; the next push re-runs only those plus the tests related to what changed since, and any doubt about that choice falls back to the full leg. Needs ROOT_DIR, LOG_DIR and HEAD_SHA from the caller.

FAILED_STORE="$(git rev-parse --path-format=absolute --git-common-dir)/token-goat-prepush/last-failed.json"
FAILED_TOOL="$ROOT_DIR/scripts/prepush-failed.mjs"
READERS_TOOL="$ROOT_DIR/scripts/prepush-tree-readers.mjs"

# Paths a focused run can trust vitest's module graph for: TypeScript and JavaScript modules under src/ and tests/, except test setup and fixtures. Anything else (scripts a test spawns, the native client, JSON and Markdown a test reads, config, dependencies) is invisible to `vitest related`, so a change to it means the full leg.
focus_covered() {
  case "$1" in
    tests/setup/* | tests/fixtures/*) return 1 ;;
    src/*.ts | src/*.mts | src/*.cts | src/*.js | src/*.mjs | src/*.cjs) return 0 ;;
    tests/*.ts | tests/*.mts | tests/*.cts | tests/*.js | tests/*.mjs | tests/*.cjs) return 0 ;;
  esac
  return 1
}

# $1: array name, $2: text. Appends each line of the text to the caller's array (a bare name, declared in the caller). Stands in for `mapfile -t`, which bash 3.2 (macOS /bin/bash) lacks; like `mapfile -t <<<"$text"` it yields one empty element for empty text, which callers skip.
focus_read_lines() {
  local _name=$1 _line
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    eval "$_name+=(\"\$_line\")"
  done <<<"$2"
}

# $1: leg (win or wsl). Sets FOCUS_FILE to a list of paths for `vitest related`, or "" for the full leg, and FOCUS_NOTE to the one line that says which and why.
focus_decide() {
  local leg=$1 rec rec_sha f diff_out nl
  local -a failed=() changed=() list=() readers=()
  local readers_out src_changed=0 n_changed=0
  FOCUS_FILE=""
  if [[ "${TG_PREPUSH_FULL:-0}" == "1" ]]; then
    FOCUS_NOTE="$leg leg full: TG_PREPUSH_FULL=1"; return 0
  fi
  if ! rec="$(node "$FAILED_TOOL" read "$FAILED_STORE" "$leg" 2>/dev/null)"; then
    FOCUS_NOTE="$leg leg full: no record of failing test files from an earlier push"; return 0
  fi
  # Plain parameter expansion rather than head and tail on a here-string: no process, no temp file, so nothing for a BSD userland to differ on.
  nl=$'\n'
  rec_sha="${rec%%"$nl"*}"
  focus_read_lines failed "${rec#*"$nl"}"
  if ! git merge-base --is-ancestor "$rec_sha" "$HEAD_SHA" 2>/dev/null; then
    FOCUS_NOTE="$leg leg full: recorded commit ${rec_sha:0:9} is not an ancestor of this push"; return 0
  fi
  if ! diff_out="$(git diff --name-only --no-renames "$rec_sha" "$HEAD_SHA" 2>/dev/null)"; then
    FOCUS_NOTE="$leg leg full: could not list the changes since ${rec_sha:0:9}"; return 0
  fi
  focus_read_lines changed "$diff_out"
  for f in "${changed[@]}"; do
    [[ -n "$f" ]] || continue
    n_changed=$((n_changed + 1))
    if ! focus_covered "$f"; then
      FOCUS_NOTE="$leg leg full: $f changed since ${rec_sha:0:9} and vitest related cannot see it"; return 0
    fi
    [[ "$f" == src/* ]] && src_changed=1
    [[ -f "$ROOT_DIR/$f" ]] && list+=("$f")
  done
  for f in "${failed[@]}"; do
    [[ -f "$ROOT_DIR/$f" ]] && list+=("$f")
  done
  # `vitest related` follows imports only: a src change also needs every test that reads the source tree through fs or spawns the built bundle.
  if [[ "$src_changed" -eq 1 ]]; then
    if ! readers_out="$(node "$READERS_TOOL" "$ROOT_DIR" 2>/dev/null)" || [[ -z "$readers_out" ]]; then
      FOCUS_NOTE="$leg leg full: src changed since ${rec_sha:0:9} and the tree-reading and bundle tests could not be listed"; return 0
    fi
    focus_read_lines readers "$readers_out"
    list+=("${readers[@]}")
  fi
  if [[ "${#list[@]}" -eq 0 ]]; then
    FOCUS_NOTE="$leg leg full: none of the recorded or changed files exists now"; return 0
  fi
  FOCUS_FILE="$LOG_DIR/focus-$leg.txt"
  # /usr/bin/sort by path: under a PATH with C:/Windows/System32 ahead of Git's usr/bin a bare sort is Windows sort.exe, which has no -u.
  local posix_sort=sort
  [[ -x /usr/bin/sort ]] && posix_sort=/usr/bin/sort
  printf '%s\n' "${list[@]}" | "$posix_sort" -u >"$FOCUS_FILE"
  FOCUS_NOTE="$leg leg focused: $(wc -l <"$FOCUS_FILE" | tr -d ' ') file(s) (${#failed[@]} failed before, ${n_changed} changed since ${rec_sha:0:9}, ${#readers[@]} tree-reading or bundle tests); set TG_PREPUSH_FULL=1 for the full leg"
}

# $1: leg, $2: the leg's log. Records the failing files of a red leg; a leg with no parsable failure clears the record so the next run is full.
focus_record_failure() {
  node "$FAILED_TOOL" record "$FAILED_STORE" "$1" "$HEAD_SHA" "$2" || true
}

# $1: leg. A green leg has nothing left to re-run.
focus_clear() {
  node "$FAILED_TOOL" clear "$FAILED_STORE" "$1" || true
}
