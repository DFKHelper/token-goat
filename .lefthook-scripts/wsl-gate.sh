#!/usr/bin/env bash
# Sourced by run-all-checks.sh. Decides whether the WSL (Linux) suite runs: TG_PREPUSH_WSL=1 forces it, TG_PREPUSH_WSL=0 skips it, otherwise it runs when the pushed range touches a path listed in wsl-paths.txt or the range cannot be determined (fail safe). Sets WSL_RUN (1 or 0) and WSL_REASON.
# Input is the text git writes to a pre-push hook's stdin, one `<local ref> <local sha> <remote ref> <remote sha>` line per ref; lefthook passes it through when the command sets use_stdin.

ZERO_SHA="0000000000000000000000000000000000000000"

# Prints the changed paths of every pushed ref and returns 1 when any range cannot be determined. A new branch (remote sha all zeros) is compared with its merge-base against origin/main; a deletion has no commits and adds nothing.
wsl_pushed_paths() {
  local input=$1 lref lsha rref rsha base seen=0
  while read -r lref lsha rref rsha; do
    [[ -n "${lsha:-}" ]] || continue
    seen=1
    [[ "$lsha" == "$ZERO_SHA" ]] && continue
    if [[ "$rsha" == "$ZERO_SHA" ]]; then
      base="$(git merge-base origin/main "$lsha" 2>/dev/null)" || return 1
    else
      base="$rsha"
      git cat-file -e "$base^{commit}" 2>/dev/null || return 1
    fi
    # NUL-separated so a non-ASCII path arrives raw instead of quoted; the subshell keeps a failing git from hiding behind tr.
    ( set -o pipefail; git diff -z --name-only --no-renames "$base" "$lsha" 2>/dev/null | tr '\0' '\n' ) || return 1
  done <<<"$input"
  [[ "$seen" -eq 1 ]]
}

# Prints the first changed path on stdin that matches a glob of the pattern file; returns 1 when none does.
wsl_first_match() {
  local patterns=$1 path glob
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    while IFS= read -r glob; do
      [[ -z "$glob" || "$glob" == \#* ]] && continue
      # shellcheck disable=SC2053
      if [[ "$path" == $glob ]]; then
        printf '%s\n' "$path"
        return 0
      fi
    done <"$patterns"
  done
  return 1
}

# $1: pre-push stdin text, $2: the pattern file.
wsl_decide() {
  local input=$1 patterns=$2 changed hit
  case "${TG_PREPUSH_WSL:-}" in
    1) WSL_RUN=1; WSL_REASON="opt-in (TG_PREPUSH_WSL=1)"; return 0 ;;
    0) WSL_RUN=0; WSL_REASON="opt-out (TG_PREPUSH_WSL=0)"; return 0 ;;
  esac
  if [[ ! -r "$patterns" ]]; then
    WSL_RUN=1; WSL_REASON="pattern file $patterns is missing or unreadable"; return 0
  fi
  if ! changed="$(wsl_pushed_paths "$input")"; then
    WSL_RUN=1; WSL_REASON="pushed range could not be determined"; return 0
  fi
  if hit="$(printf '%s\n' "$changed" | wsl_first_match "$patterns")"; then
    WSL_RUN=1; WSL_REASON="pushed range touches $hit"
  else
    WSL_RUN=0; WSL_REASON="no platform-sensitive change in the pushed range (set TG_PREPUSH_WSL=1 to run it)"
  fi
}
