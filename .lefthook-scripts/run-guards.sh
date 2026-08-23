#!/usr/bin/env bash
# Pre-commit guard suite, silent on success.
#
# `npm run test:guards` passes ~530 tests in a couple of seconds, but the
# commands those guards exercise print their own stdout as they run, so a clean
# run still emits ~150 lines nobody reads. Switching vitest reporters does not
# fix it -- roughly half that output is the tests' own console writes, which
# every reporter passes through. That is merely untidy for a human and
# genuinely expensive for an agent, which puts all of it into a model's context
# on every single commit.
#
# So the output is captured and replayed in full only when the suite fails. The
# failure path is strictly unchanged: same lines, same order, same exit code.
# Mirrors the capture-then-report-on-failure shape of run-all-checks.sh, which
# does the same thing for the pre-push tier.
set -euo pipefail

LOG="$(mktemp "${TMPDIR:-/tmp}/token-goat-guards.XXXXXX")"

if npm run test:guards >"$LOG" 2>&1; then
  rm -f -- "$LOG"
  exit 0
fi

# Kept on disk as well as printed: a failure here blocks a commit, and the log
# outliving the hook run is what makes it inspectable afterwards.
echo "pre-commit: guards FAILED (full output below; log: $LOG)"
cat "$LOG"
exit 1
