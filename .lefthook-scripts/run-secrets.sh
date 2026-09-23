#!/usr/bin/env bash
# Pre-commit secret scan, silent on success.
#
# Mirrors the `secrets` job in .github/workflows/ci.yml: same binary, same
# config, same flags, so a commit that passes here cannot be the one that turns
# that job red. It was the last CI gate with no local counterpart -- lint,
# typecheck and the suites all had one, and a secret is the single thing worst
# suited to being caught only after it has been pushed, because by then it is
# in the remote's history and rotating the credential is the only real fix.
#
# Missing binary is a hard failure, not a skip. A skip would restore exactly the
# gap this closes while reporting success, and the install is two commands.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks is not installed, so the secret scan cannot run."
  echo "Install it, then commit again:"
  echo "  scoop install gitleaks        # Windows"
  echo "  brew install gitleaks         # macOS"
  echo "Other platforms, and the version and checksum CI pins, are in the"
  echo "'Install gitleaks' step of .github/workflows/ci.yml."
  exit 1
fi

LOG="$(mktemp "${TMPDIR:-/tmp}/token-goat-secrets.XXXXXX")"

if gitleaks dir . --config=.gitleaks.toml --redact --exit-code 1 --no-banner >"$LOG" 2>&1; then
  rm -f -- "$LOG"
  exit 0
fi

# --redact is already on, so findings print their location without the secret
# itself. Kept on disk as well as printed for the same reason run-guards.sh
# does it: a failure here blocks the commit, and the log outliving the hook run
# is what makes it inspectable afterwards.
echo "pre-commit: gitleaks FOUND SOMETHING (full output below; log: $LOG)"
cat "$LOG"
exit 1
