#!/usr/bin/env bash
# Reject a commit message that credits the tool that helped write it.
#
# A commit message is a permanent public artifact of this project. A `Co-Authored-By:` trailer credits a program as a person, and a session URL is a private link that resolves for nobody. Assistants are instructed by their own harness to append both, every session, so this has to be enforced here rather than remembered: the hook is the only thing that sees the message before it becomes history.
#
# `tests/guards/commit_messages_carry_no_tool_attribution.test.ts` is the other half, and covers the paths this hook does not see -- a rebase, an amend made with --no-verify, a merge, or a commit pushed from a clone with no hooks installed. `tests/commit_msg_hook_denylist.test.ts` runs this script for the confidential-name half.
set -euo pipefail

MSG_FILE="${1:-}"
if [[ -z "$MSG_FILE" || ! -f "$MSG_FILE" ]]; then
  exit 0
fi

# grep exits 0 when a line matched and 1 when none did; anything higher means it never searched, and reading that as "no match" would pass every message unchecked.
refuse_on_grep_error() {
  if (( $1 > 1 )); then
    echo "commit-msg: grep exited $1 while reading this message, so it was not checked. Refusing the commit." >&2
    exit 1
  fi
}

# Comment lines are stripped by git before the message is stored, so a template or a `git commit -v` diff must not be able to fail the check.
status=0
BODY="$(grep -v '^#' -- "$MSG_FILE")" || status=$?
refuse_on_grep_error "$status"

status=0
OFFENDING="$(printf '%s\n' "$BODY" | grep -n -i -E '^[[:space:]]*co-authored-by:|^[[:space:]]*claude-session:|claude\.ai/code/session')" || status=$?
refuse_on_grep_error "$status"

if [[ -n "$OFFENDING" ]]; then
  echo "commit-msg: this message credits a tool. Remove these lines:" >&2
  printf '%s\n' "$OFFENDING" >&2
  echo >&2
  echo "State what the change is. Attribution trailers and session URLs never ship." >&2
  exit 1
fi

# Reject a commit message that contains any name from the confidential denylist.
DENYLIST="${TOKEN_GOAT_CONFIDENTIAL_NAMES:-$HOME/.token-goat/confidential-names.txt}"
if [[ ! -f "$DENYLIST" && -n "${USERPROFILE:-}" ]]; then
  DENYLIST="$USERPROFILE/.token-goat/confidential-names.txt"
fi

if [[ -f "$DENYLIST" ]]; then
  # A literal, case-blind substring test in bash itself: quoting the pattern keeps regex and glob characters in a name literal, and nocasematch dates from bash 3.1 where `${var,,}` needs bash 4, which macOS does not ship. It replaces `grep -qi -F`, which the GNU grep 3.0 bundled with Git for Windows aborts on (exit 134); inside the `if`, that abort read as "no match" for every name.
  shopt -s nocasematch
  while IFS= read -r line || [[ -n "$line" ]]; do
    clean_name="${line%%#*}"
    clean_name="$(echo "$clean_name" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -n "$clean_name" ]]; then
      if [[ "$BODY" == *"$clean_name"* ]]; then
        echo "commit-msg: this commit message contains a confidential name. Remove it before committing." >&2
        exit 1
      fi
    fi
  done < "$DENYLIST"
fi

exit 0
