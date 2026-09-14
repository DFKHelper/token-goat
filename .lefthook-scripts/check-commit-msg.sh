#!/usr/bin/env bash
# Reject a commit message that credits the tool that helped write it.
#
# A commit message is a permanent public artifact of this project. A
# `Co-Authored-By:` trailer credits a program as a person, and a session URL is
# a private link that resolves for nobody. Assistants are instructed by their
# own harness to append both, every session, so this has to be enforced here
# rather than remembered: the hook is the only thing that sees the message
# before it becomes history.
#
# `tests/guards/commit_messages_carry_no_tool_attribution.test.ts` is the other
# half, and covers the paths this hook does not see -- a rebase, an amend made
# with --no-verify, a merge, or a commit pushed from a clone with no hooks
# installed.
set -euo pipefail

MSG_FILE="${1:-}"
if [[ -z "$MSG_FILE" || ! -f "$MSG_FILE" ]]; then
  exit 0
fi

# Comment lines are stripped by git before the message is stored, so a template
# or a `git commit -v` diff must not be able to fail the check.
BODY="$(grep -v '^#' -- "$MSG_FILE" || true)"

OFFENDING="$(printf '%s\n' "$BODY" | grep -n -i -E '^[[:space:]]*co-authored-by:|^[[:space:]]*claude-session:|claude\.ai/code/session' || true)"

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
  while IFS= read -r line || [[ -n "$line" ]]; do
    clean_name="${line%%#*}"
    clean_name="$(echo "$clean_name" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -n "$clean_name" ]]; then
      if printf '%s\n' "$BODY" | grep -qi -F "$clean_name"; then
        echo "commit-msg: this commit message contains a confidential name. Remove it before committing." >&2
        exit 1
      fi
    fi
  done < "$DENYLIST"
fi

exit 0
