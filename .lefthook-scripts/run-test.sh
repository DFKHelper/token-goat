#!/usr/bin/env bash
# TOKEN_GOAT_NO_WORKER_SPAWN and TOKEN_GOAT_HARNESS_OVERRIDE are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push and CI run under the same defaults. Don't re-export them here.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# TG_PREPUSH_FOCUS names a file listing the tests to re-run (see prepush-focus.sh); without it the whole suite runs.
if [[ -n "${TG_PREPUSH_FOCUS:-}" ]]; then
  # The list is read whole before any chunk runs, so vitest never shares the file's stdin. A read loop stands in for `mapfile -t`, which bash 3.2 (macOS /bin/bash) lacks.
  focus=()
  while IFS= read -r f || [[ -n "$f" ]]; do focus+=("$f"); done <"$TG_PREPUSH_FOCUS"
  # Node runs vitest directly: on Windows npx is npx.cmd, and cmd.exe refuses a command line past about 8191 characters. CreateProcess stops at 32767, so the list is also split into chunks of at most 20000 characters, run one after another; every chunk runs even after a red one so the log names all the failing files, and the leg fails if any chunk did.
  chunk=() size=0 status=0 ran=0
  run_chunk() {
    node node_modules/vitest/vitest.mjs related --run ${chunk[@]+"${chunk[@]}"} || status=1
    chunk=() size=0 ran=1
  }
  for f in ${focus[@]+"${focus[@]}"}; do
    [[ -n "$f" ]] || continue
    if (( ${#chunk[@]} > 0 && size + ${#f} + 1 > 20000 )); then run_chunk; fi
    chunk+=("$f")
    size=$(( size + ${#f} + 1 ))
  done
  if (( ${#chunk[@]} > 0 || ran == 0 )); then run_chunk; fi
  exit "$status"
fi
npm test
