#!/usr/bin/env bash
# TOKEN_GOAT_NO_WORKER_SPAWN and TOKEN_GOAT_HARNESS_OVERRIDE are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push and CI run under the same defaults. Don't re-export them here.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# TG_PREPUSH_FOCUS names a file listing the test files to run (see prepush-focus.sh); without it the whole suite runs.
if [[ -n "${TG_PREPUSH_FOCUS:-}" ]]; then
  # The list is read whole before any chunk runs, so vitest never shares the file's stdin. A read loop stands in for `mapfile -t`, which bash 3.2 (macOS /bin/bash) lacks.
  focus=()
  while IFS= read -r f || [[ -n "$f" ]]; do focus+=("$f"); done <"$TG_PREPUSH_FOCUS"
  # TG_PREPUSH_PLAN names the focused leg's plan: the wall-clock deadline in epoch ms on the first line, then the fill files in priority order. Every other focus file is the floor (guards and the bundle matrix), which runs first and is never cut; the fill files run after it under a vitest reporter that cancels the run at the deadline (scripts/prepush-deadline-reporter.mjs), and the files that did not run to completion are deferred to CI. Without a plan the whole list runs, as before.
  fill=() deadline_ms=0 planned=0
  if [[ -n "${TG_PREPUSH_PLAN:-}" && -s "$TG_PREPUSH_PLAN" ]]; then
    # A split that fails runs the whole list with no deadline, never an empty one.
    if split_out="$(node scripts/prepush-deadline.mjs split "$TG_PREPUSH_FOCUS" "$TG_PREPUSH_PLAN")" && [[ "$split_out" == DEADLINE$'\t'* ]]; then
      planned=1
      floor=()
      while IFS=$'\t' read -r kind f; do
        case "$kind" in
          DEADLINE) deadline_ms="$f" ;;
          FLOOR) floor+=("$f") ;;
          FILL) fill+=("$f") ;;
        esac
      done <<<"$split_out"
      focus=(${floor[@]+"${floor[@]}"})
    else
      echo "pre-push: the leg plan could not be split, so the whole focus list runs with no deadline"
    fi
  fi
  # Node runs vitest directly: on Windows npx is npx.cmd, and cmd.exe refuses a command line past about 8191 characters. CreateProcess stops at 32767, so the list is also split into chunks of at most 20000 characters, run one after another (the list names test files only, so no file runs in two chunks); every chunk runs even after a red one so the log names all the failing files, and the leg fails if any chunk did.
  chunk=() size=0 status=0 ran=0 armed=0 chunk_no=0 cut=()
  cut_dir=""
  if (( planned == 1 )); then
    cut_dir="$(mktemp -d "${TMPDIR:-/tmp}/tg-prepush-cut.XXXXXX")"
    trap 'rm -rf -- "$cut_dir"' EXIT
  fi
  run_armed_chunk() {
    local now_ms out rc=0 verdict=plain kind file
    now_ms=$(( $(date +%s) * 1000 ))
    # Past the deadline no file starts, and neither does vitest.
    if (( now_ms >= deadline_ms )); then cut+=("${chunk[@]}"); return 0; fi
    chunk_no=$((chunk_no + 1))
    out="$cut_dir/out.$chunk_no"
    : >"$out"
    TG_PREPUSH_DEADLINE_AT="$deadline_ms" TG_PREPUSH_DEADLINE_OUT="$out" node node_modules/vitest/vitest.mjs run --reporter=default --reporter=./scripts/prepush-deadline-reporter.mjs "${chunk[@]}" || rc=$?
    while IFS=$'\t' read -r kind file; do
      case "$kind" in
        STATUS) verdict="$file" ;;
        UNFINISHED) cut+=("$file") ;;
      esac
    done < <(node scripts/prepush-deadline.mjs summarize "$out" "${chunk[@]}")
    case "$verdict" in
      plain) [[ "$rc" -eq 0 ]] || status=1 ;;
      red) status=1 ;;
      # A cut run exits 1 by itself; any other code is a crash or a signal, which the file outcomes do not describe.
      green) [[ "$rc" -le 1 ]] || status=1 ;;
    esac
  }
  run_chunk() {
    if [[ "$armed" -eq 1 ]]; then
      run_armed_chunk
    else
      node node_modules/vitest/vitest.mjs run ${chunk[@]+"${chunk[@]}"} || status=1
    fi
    chunk=() size=0 ran=1
  }
  run_list() {
    local f
    for f in "$@"; do
      [[ -n "$f" ]] || continue
      if (( ${#chunk[@]} > 0 && size + ${#f} + 1 > 20000 )); then run_chunk; fi
      chunk+=("$f")
      size=$(( size + ${#f} + 1 ))
    done
    if (( ${#chunk[@]} > 0 )); then run_chunk; fi
  }
  run_list ${focus[@]+"${focus[@]}"}
  # No plan and an empty list is the whole suite, as before; with a plan an empty floor (every guard already green on this tree) just goes on to the fill.
  if (( planned == 0 && ran == 0 )); then run_chunk; fi
  if (( ${#fill[@]} > 0 )); then
    armed=1
    run_list "${fill[@]}"
  fi
  if (( ${#cut[@]} > 0 )); then
    printf '%s\n' "${cut[@]}" >"$cut_dir/cut.txt"
    report="$(node scripts/prepush-deadline.mjs report "$cut_dir/cut.txt")"
    printf '%s\n' "$report"
    if [[ -n "${TG_PREPUSH_CUT_REPORT:-}" ]]; then printf '%s\n' "$report" >>"$TG_PREPUSH_CUT_REPORT"; fi
    # The files that did not finish are not green: drop them from the focus list so a green record never vouches for them.
    cut_text=$'\n'
    for f in "${cut[@]}"; do cut_text+="$f"$'\n'; done
    : >"$TG_PREPUSH_FOCUS"
    for f in ${floor[@]+"${floor[@]}"} "${fill[@]}"; do
      if [[ "$cut_text" != *$'\n'"$f"$'\n'* ]]; then printf '%s\n' "$f" >>"$TG_PREPUSH_FOCUS"; fi
    done
  fi
  exit "$status"
fi
npm test
