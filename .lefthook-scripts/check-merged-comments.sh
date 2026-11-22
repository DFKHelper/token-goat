#!/bin/sh
# Refuses staged source files under src, tests or scripts whose staged blob has a multi-line comment run.
# Exit 0 clean, 1 a comment finding, 2 git or the checker crashed (the output says which).
root=$PWD
tmp=$(mktemp -d) || { echo "merged-comments: cannot create a temp directory, so nothing was checked"; exit 2; }
trap 'rm -rf "$tmp"' EXIT
trap 'exit 2' INT TERM HUP
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
if ! git diff --cached --no-renames --name-only -z --diff-filter=AM -- src tests scripts > "$tmp/list"; then
  echo "merged-comments: git diff --cached failed, so the staged files are unknown; commit refused"
  exit 2
fi
tr '\0' '\n' < "$tmp/list" > "$tmp/names"
set --
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.ts|*.mts|*.js|*.jsx|*.mjs|*.cjs) ;;
    *) continue ;;
  esac
  mkdir -p "$tmp/$(dirname "$f")" || exit 2
  if ! git show ":$f" > "$tmp/$f"; then
    echo "merged-comments: git show failed for the staged blob of $f; commit refused"
    exit 2
  fi
  set -- "$@" "$f"
done < "$tmp/names"
[ $# -gt 0 ] || exit 0
out=$(cd "$tmp" && node "$root/scripts/merge-comments.mjs" --check "$@" 2>&1)
rc=$?
printf '%s\n' "$out" > "$tmp/out"
found=0
other=0
while IFS= read -r line; do
  case "$line" in
    "") ;;
    *" line(s) folded"|*": REFUSED, "*|*": SKIPPED, "*) found=1 ;;
    *) other=1 ;;
  esac
done < "$tmp/out"
if [ "$other" -eq 1 ] || [ "$rc" -gt 1 ] || { [ "$rc" -eq 0 ] && [ "$found" -eq 1 ]; } || { [ "$rc" -eq 1 ] && [ "$found" -eq 0 ]; }; then
  echo "merged-comments: the checker crashed (node exit $rc), so this is not a comment finding. Output:"
  cat "$tmp/out"
  echo "merged-comments: if the output names a missing package, run npm ci"
  exit 2
fi
[ "$found" -eq 1 ] || exit 0
while IFS= read -r line; do
  case "$line" in
    *" line(s) folded")
      name=${line%%: *}
      echo "multi-line comment run in staged file: $name"
      echo "  fix: node scripts/merge-comments.mjs $(quote "$name")"
      echo "  then stage it: git add $(quote "$name")"
      ;;
    *": REFUSED, "*|*": SKIPPED, "*)
      name=${line%%: *}
      echo "multi-line comment run in staged file: $name"
      echo "  fold it by hand: merge-comments cannot fold this file (${line#*: })"
      ;;
  esac
done < "$tmp/out"
exit 1
