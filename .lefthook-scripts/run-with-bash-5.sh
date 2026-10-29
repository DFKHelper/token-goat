#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: run-with-bash-5.sh <script> [args...]" >&2
  exit 64
fi

script=$1
shift

supports_required_bash() {
  "$1" -c '(( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) ))' >/dev/null 2>&1
}

if [ -n "${TG_PREPUSH_BASH:-}" ]; then
  if ! supports_required_bash "$TG_PREPUSH_BASH"; then
    echo "pre-push: TG_PREPUSH_BASH must name Bash 5.1 or later" >&2
    exit 2
  fi
  exec "$TG_PREPUSH_BASH" "$script" "$@"
fi

for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
  if [ -x "$candidate" ] && supports_required_bash "$candidate"; then
    exec "$candidate" "$script" "$@"
  fi
done

candidate=$(command -v bash 2>/dev/null || true)
if [ -n "$candidate" ] && supports_required_bash "$candidate"; then
  exec "$candidate" "$script" "$@"
fi

echo "pre-push: Bash 5.1 or later is required; on macOS install it with 'brew install bash' or set TG_PREPUSH_BASH to its executable" >&2
exit 2
