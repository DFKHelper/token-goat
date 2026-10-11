# Sourced by the lefthook scripts that call mktemp. Sets TMP_BASE to the temp directory and creates /tmp when it is the default and missing, as it can be under Git Bash on Windows.
TMP_BASE="${TMPDIR:-/tmp}"
[[ "$TMP_BASE" == "/tmp" && ! -d "/tmp" ]] && mkdir -p -- /tmp 2>/dev/null || true
