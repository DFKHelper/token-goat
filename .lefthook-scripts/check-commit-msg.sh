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

# The two scans below match in bash itself rather than through a grep each: every process this hook starts costs a fork and exec, which on Git Bash under load took 1 to 2.5 s apiece and pushed the hook's tests past their timeout. Case-blind like `grep -i`; a pattern bash cannot apply returns 2 from `[[ =~ ]]`, which an `if` would read as "no match", so it is refused the way a grep that could not search is. Output matches `grep -n`: the line number, a colon, the line.
shopt -s nocasematch
HITS=""
scan_body() {
  local pattern="$1" line n=0 rc
  HITS=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    rc=0
    [[ "$line" =~ $pattern ]] || rc=$?
    if (( rc == 0 )); then
      HITS+="${n}:${line}"$'\n'
    elif (( rc > 1 )); then
      echo "commit-msg: the pattern failed to apply (status $rc) while reading this message, so it was not checked. Refusing the commit." >&2
      exit 1
    fi
  done <<< "$BODY"
  HITS="${HITS%$'\n'}"
}

scan_body '^[[:space:]]*co-authored-by:|^[[:space:]]*claude-session:|claude\.ai/code/session'
OFFENDING="$HITS"

if [[ -n "$OFFENDING" ]]; then
  echo "commit-msg: this message credits a tool. Remove these lines:" >&2
  printf '%s\n' "$OFFENDING" >&2
  echo >&2
  echo "State what the change is. Attribution trailers and session URLs never ship." >&2
  exit 1
fi

# The model-name pattern lives in model-name-pattern.txt, which tests/guards/commit_messages_carry_no_tool_attribution.test.ts reads too, so the two cannot drift. Host products (Gemini, Codex, Claude Code, Copilot, Qwen, OpenClaw) are features of this tool and never match.
SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" == */* ]]; then
  SCRIPT_DIR="${SCRIPT_PATH%/*}"
else
  SCRIPT_DIR="."
fi
if [[ -z "$SCRIPT_DIR" ]]; then
  SCRIPT_DIR="/"
fi
PATTERN_FILE="$SCRIPT_DIR/model-name-pattern.txt"
if [[ ! -f "$PATTERN_FILE" ]]; then
  echo "commit-msg: $PATTERN_FILE is missing, so the message was not checked for AI model names. Refusing the commit." >&2
  exit 1
fi
# The first line, as `head -n 1` gave it; a last line with no newline still fills the variable.
MODEL_PATTERN=""
IFS= read -r MODEL_PATTERN < "$PATTERN_FILE" || true

scan_body "$MODEL_PATTERN"
MODEL_HITS="$HITS"

if [[ -n "$MODEL_HITS" ]]; then
  echo "commit-msg: this message names an AI model. Remove it from these lines:" >&2
  printf '%s\n' "$MODEL_HITS" >&2
  echo >&2
  echo "Write \"review findings\", not \"<model> review findings\". Model names never ship in a commit message." >&2
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
    # Parameter expansion only: the echo | tr | sed it replaces started four processes per listed name, which on Git Bash under load pushed the denylist test past its timeout.
    clean_name="${clean_name//$'\r'/}"
    clean_name="${clean_name#"${clean_name%%[![:space:]]*}"}"
    clean_name="${clean_name%"${clean_name##*[![:space:]]}"}"
    if [[ -n "$clean_name" ]]; then
      if [[ "$BODY" == *"$clean_name"* ]]; then
        echo "commit-msg: this commit message contains a confidential name. Remove it before committing." >&2
        exit 1
      fi
    fi
  done < "$DENYLIST"
fi

exit 0
