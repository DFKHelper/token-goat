#!/bin/sh
# Refuses staged .ts/.mts/.mjs files under src, tests or scripts that hold a multi-line comment run.
files=$(git diff --cached --name-only --diff-filter=AM -- src tests scripts | grep -E '\.(ts|mts|mjs)$')
bad=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! out=$(node scripts/merge-comments.mjs --check "$f" 2>&1); then
    echo "$out"
    echo "multi-line comment run in staged file: $f"
    echo "  fix: node scripts/merge-comments.mjs $f"
    bad=1
  fi
done <<EOF
$files
EOF
exit $bad
