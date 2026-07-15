// Bespoke `go test` output filter — a faithful port of the Python `GoTestFilter`.
//
// Go test emits a `=== RUN` / `--- PASS:` pair per testcase plus a final summary; failures interleave stderr blocks. This is its own filter (not the Node test-runner family) because of two Go-specific concerns the family can't model: * `go test -json` must pass through UNTOUCHED (compressing it corrupts the machine-readable stream that gotestsum and friends parse). * `go test -race` emits `==========` / `WARNING: DATA RACE` fence blocks that are critical signal — kept verbatim, but with deep goroutine stacks collapsed to the first five frames.
//
// Compression model: * Keep — FAIL/ERROR blocks (the stderr captured under the RUN line), the final summary (`ok …`, `FAIL …`, coverage %), and race blocks. * Drop — `=== RUN/PAUSE/CONT/NAME` lines outside FAIL blocks, `--- PASS:` lines, and `go: downloading …` lines (counted in notes). * Collapse — `--- SKIP:` lines (counted separately from PASS).

import { ToolFilter } from './base.js'
import { maybeNote, positionalArgs } from './helpers.js'

const TEST_RUN_RE = /^=== (RUN|PAUSE|CONT|NAME)\s/
const RACE_FENCE_RE = /^={10,}\s*$/
const RACE_WARNING_RE = /^WARNING: DATA RACE/
const RACE_PENDING_FENCE_MAX_LINES = 5
const TEST_PASS_RE = /^\s*--- PASS:\s/
const TEST_FAIL_RE = /^\s*--- FAIL:\s/
const TEST_RPC_RE = /^=== (RUN|PAUSE|CONT)\s/
const SKIP_RE = /^\s*--- SKIP:\s/
const GOROUTINE_HEADER_RE = /^(?:Goroutine \d+|Previous|Current|Write at|Read at)\s/
const OK_PKG_RE = /^ok\s+\S+\s+(?:\d|\(cached\))/
const FAIL_PKG_RE = /^FAIL\t\S+/
// A panic or runtime fatal aborts the test binary before any `--- FAIL:` line, so the most recent `=== RUN/NAME` line is the only marker of which (sub)test was executing. Emit that buffered line ahead of the panic so it survives.
const PANIC_RE = /^(?:panic:|fatal error:)/

const MAX_RACE_GOROUTINE_FRAMES = 5

export class GoTestFilter extends ToolFilter {
  readonly name = 'go-test'
  override readonly binaries: ReadonlySet<string> = new Set(['go'])

  // Fire only for `go test` (test as the FIRST positional), not `go build`/`run`.
  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = argv[0]!.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '')
    if (stem !== 'go') return false
    return positionalArgs(argv.slice(1)).slice(0, 1)[0] === 'test'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    // `go test -json` is already compact and machine-readable; compressing it would corrupt the JSON stream. Pass through.
    if (argv.includes('-json')) return this.combineOutput(stdout, stderr)

    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let passCount = 0
    let skipCount = 0
    let inFailBlock = false
    let lastRunLine: string | null = null
    let droppedRun = 0
    let droppedDownload = 0
    // Race-detector state: a block spans `==========` (before WARNING) through the closing `==========`.
    let inRaceBlock = false
    let raceBlockLines: string[] = []
    let racePendingFence = false // leading fence seen, WARNING not yet confirmed
    let raceCount = 0

    const flushRaceBlock = (): void => {
      // Walk the block, collapsing goroutine stack frames beyond the limit.
      let inGoroutine = false
      let goroutineFrameCount = 0
      let goroutineFramesDropped = 0
      for (const rline of raceBlockLines) {
        if (GOROUTINE_HEADER_RE.test(rline)) {
          if (goroutineFramesDropped) {
            kept.push(`    [token-goat: +${goroutineFramesDropped} goroutine frames omitted]`)
          }
          inGoroutine = true
          goroutineFrameCount = 0
          goroutineFramesDropped = 0
          kept.push(rline)
          continue
        }
        if (inGoroutine) {
          // Stack frame lines are indented whitespace.
          if ((rline.startsWith(' ') || rline.startsWith('\t')) && rline.trim()) {
            goroutineFrameCount += 1
            if (goroutineFrameCount <= MAX_RACE_GOROUTINE_FRAMES) kept.push(rline)
            else goroutineFramesDropped += 1
            continue
          }
          // Leaving the goroutine section.
          if (goroutineFramesDropped) {
            kept.push(`    [token-goat: +${goroutineFramesDropped} goroutine frames omitted]`)
          }
          inGoroutine = false
          goroutineFrameCount = 0
          goroutineFramesDropped = 0
        }
        kept.push(rline)
      }
      if (goroutineFramesDropped) {
        kept.push(`    [token-goat: +${goroutineFramesDropped} goroutine frames omitted]`)
      }
    }

    for (const line of lines) {
      if (line.startsWith('go: downloading')) {
        droppedDownload += 1
        continue
      }

      // --- Race detector block handling ---
      if (RACE_FENCE_RE.test(line)) {
        if (inRaceBlock) {
          // Closing fence — flush the collected block.
          raceBlockLines.push(line)
          flushRaceBlock()
          raceBlockLines = []
          inRaceBlock = false
          racePendingFence = false
        } else if (!racePendingFence) {
          // Opening fence — hold until we confirm a race block.
          racePendingFence = true
          raceBlockLines = [line]
        } else {
          // Two consecutive fences without WARNING between — not a race block.
          kept.push(...raceBlockLines, line)
          raceBlockLines = []
          racePendingFence = false
        }
        continue
      }

      if (racePendingFence) {
        raceBlockLines.push(line)
        if (RACE_WARNING_RE.test(line)) {
          inRaceBlock = true
          raceCount += 1
          racePendingFence = false
        } else if (!line.trim()) {
          // Blank line right after the fence = not a race block.
          kept.push(...raceBlockLines)
          raceBlockLines = []
          racePendingFence = false
        } else if (raceBlockLines.length > RACE_PENDING_FENCE_MAX_LINES) {
          // No WARNING/blank/second-fence within a bounded lookahead — this was
          // never a race block (a stray `====...` line elsewhere in the output).
          // Give up waiting so the rest of the stream isn't silently buffered
          // out of every other compression rule for the remainder of the file.
          kept.push(...raceBlockLines)
          raceBlockLines = []
          racePendingFence = false
        }
        continue
      }

      if (inRaceBlock) {
        raceBlockLines.push(line)
        continue
      }

      // A panic/fatal aborts before any `--- FAIL:`; surface the buffered `=== RUN/NAME` line first so the panicking (sub)test is identifiable.
      if (PANIC_RE.test(line)) {
        if (lastRunLine !== null) {
          kept.push(lastRunLine)
          droppedRun = Math.max(0, droppedRun - 1)
          lastRunLine = null
        }
        inFailBlock = false
        kept.push(line)
        continue
      }
      // Suppress RUN/PAUSE/CONT both outside and inside fail blocks, but remember the most recent one in case a panic follows.
      if (TEST_RPC_RE.test(line)) {
        if (inFailBlock) inFailBlock = false
        lastRunLine = line
        droppedRun += 1
        continue
      }
      // FAIL opens a multi-line block preserved until the next testcase.
      if (TEST_FAIL_RE.test(line)) {
        inFailBlock = true
        lastRunLine = null
        kept.push(line)
        continue
      }
      if (TEST_PASS_RE.test(line)) {
        inFailBlock = false
        lastRunLine = null
        passCount += 1
        continue
      }
      // SKIP lines — not failures, not passes; count separately.
      if (SKIP_RE.test(line)) {
        lastRunLine = null
        skipCount += 1
        continue
      }
      if (TEST_RUN_RE.test(line)) {
        // `=== RUN/PAUSE/CONT/NAME` inside a FAIL block closes it (keep for structure); outside a FAIL block, drop entirely (but remember it in case a panic follows).
        if (inFailBlock) {
          inFailBlock = false
        } else {
          lastRunLine = line
          droppedRun += 1
          continue
        }
      }
      // Indented continuation lines under a FAIL block — preserve.
      if (inFailBlock && (line.startsWith('    ') || line.startsWith('\t') || !line.trim())) {
        kept.push(line)
        continue
      }
      // Anything else: preserve and exit the fail block.
      inFailBlock = false
      kept.push(line)
    }

    // Flush any unclosed race block (e.g. truncated output).
    if (raceBlockLines.length) flushRaceBlock()

    // Append an aggregate package summary when both ok and FAIL packages present.
    const goOkCount = kept.filter((l) => OK_PKG_RE.test(l)).length
    const goFailCount = kept.filter((l) => FAIL_PKG_RE.test(l)).length
    if (goOkCount + goFailCount >= 2) {
      kept.push(`[${goOkCount} packages passed, ${goFailCount} packages failed]`)
    }

    const notes: string[] = []
    maybeNote(
      notes,
      raceCount,
      `kept ${raceCount} DATA RACE block(s) verbatim (goroutine stacks collapsed)`,
    )
    maybeNote(notes, passCount, `collapsed ${passCount} PASS testcases`)
    maybeNote(notes, skipCount, `collapsed ${skipCount} SKIP testcases`)
    maybeNote(notes, droppedRun, `dropped ${droppedRun} === RUN/PAUSE/CONT lines`)
    maybeNote(notes, droppedDownload, `dropped ${droppedDownload} 'go: downloading' lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const goTestFilter: ToolFilter = new GoTestFilter()
