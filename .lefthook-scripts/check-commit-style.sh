#!/usr/bin/env bash
# Reject a commit message whose prose is hard-wrapped, or that carries a verification checklist.
#
# GitHub, `git log` and every release note built from history show a message exactly as written, so a paragraph broken at 72 columns reads as lines that stop mid-sentence, and one edited after wrapping reads worse. Here each paragraph and each list item is one line, and the viewer wraps it. The checklist headings below are how a session's working notes leak into history; what was tested belongs in the tests. `tests/commit_msg_style.test.ts` runs this script.
set -euo pipefail

MSG_FILE="${1:-}"
if [[ -z "$MSG_FILE" || ! -f "$MSG_FILE" ]]; then
  exit 0
fi

# Two non-blank lines in a row are one paragraph broken in two, unless the second starts a list item or a table row, both are trailers, or both are indented code. Fenced blocks are skipped whole. Git drops comment lines, and with `git commit -v` everything from the scissors line down, so neither is checked.
read -r -d '' PROGRAM <<'AWK' || true
function is_item(s) { return s ~ /^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]/ }
function is_table(s) { return s ~ /^[[:space:]]*[|]/ }
function is_trailer(s) { return s ~ /^[A-Za-z][A-Za-z0-9-]*: / }
function is_code(s) { return s ~ /^(    |\t)/ }
{ sub(/\r$/, "") }
/^# -+ >8 -+$/ { exit }
/^#/ { next }
/^[[:space:]]*(```|~~~)/ { fence = !fence; prev = ""; next }
fence { next }
/^[[:space:]]*$/ { prev = ""; next }
{
  if (tolower($0) ~ /^[[:space:]]*(why didn't a test catch|what prevents a regression|mutation check|dogfood:)/) {
    checklist = checklist "  line " NR ": " $0 "\n"
  } else if (prev != "" && !is_item($0) && !is_table($0) && !(is_trailer(prev) && is_trailer($0)) && !(is_code(prev) && is_code($0) && !is_item(prev))) {
    wrapped = wrapped "  line " NR ": " $0 "\n"
  }
  prev = $0
}
END {
  if (wrapped != "") printf "commit-msg: these lines continue the line above them, so the paragraph is hard-wrapped:\n%sWrite each paragraph and each list item on one line, with a blank line between paragraphs.\n", wrapped
  if (checklist != "") printf "commit-msg: these lines are a verification checklist, not a description of the change:\n%sSay what changed and why. The tests record what was checked.\n", checklist
}
AWK

# BINMODE=1 stops Git for Windows' gawk from dropping the CR of a CRLF line before the program sees it, so the program meets the same bytes there as under Linux and macOS awk, where it is only an unused variable.
status=0
REPORT="$(awk -v BINMODE=1 "$PROGRAM" "$MSG_FILE")" || status=$?
if (( status != 0 )); then
  echo "commit-msg: awk exited $status while reading this message, so it was not checked. Refusing the commit." >&2
  exit 1
fi

if [[ -n "$REPORT" ]]; then
  printf '%s\n' "$REPORT" >&2
  exit 1
fi
exit 0
