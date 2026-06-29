// Filter family factories: shared compression skeletons that multiple per-tool
// filters configure rather than reimplement. The first family is the Node test
// runner (Jest / Mocha / Ava / Tap, Vitest), whose output all shares the same
// shape — per-file PASS/FAIL headers, indented per-test pass ticks, collapsible
// console/stdout blocks, and a trailing summary. The Python port had these as
// separate hand-written `compress` loops; here one loop, parameterised by a few
// regexes and nouns, drives every member so the behaviour stays identical and
// the next runner is a config object, not another loop.

import { ToolFilter } from './base.js'
import { maybeNote } from './helpers.js'

/** `''` for a count of 1, otherwise the plural suffix (default `'s'`). */
export function plural(n: number, suffix = 's'): string {
  return n === 1 ? '' : suffix
}

/**
 * Configuration for a Node test-runner filter (see {@link makeNodeTestRunnerFilter}).
 *
 * The five regexes classify each output line; the two nouns label the collapse
 * notes. `failuresSection` opts into Jest's `--verbose` duplicate-`Failures:`
 * block handling (Vitest has no such section).
 */
export interface NodeTestRunnerConfig {
  /** Filter name (marker + stats key), e.g. `'jest'`. */
  readonly name: string
  /** Command basenames this filter handles. */
  readonly binaries: readonly string[]
  /** File-level PASS header (e.g. `PASS src/foo.test.js` or `✓ file (12ms)`) → counted. */
  readonly passFileRe: RegExp
  /** File-level FAIL header → opens a verbatim fail block. */
  readonly failFileRe: RegExp
  /** Summary line (`Test Suites:`, `Test Files`, `Duration`, …) → always kept. */
  readonly summaryRe: RegExp
  /** Indented per-test pass tick (`✓ should …`) → counted. */
  readonly testTickRe: RegExp
  /** Output-block header (`console.log`, `stdout |`) → block collapsed to a count. */
  readonly outputHdrRe: RegExp
  /** Middle word(s) of the block-collapse note, e.g. `'console output'` or `'stdout'`. */
  readonly outputNoun: string
  /** Singular noun for the pass-file note, e.g. `'PASS file'` or `'passing file'`. */
  readonly passFileNoun: string
  /** When true, drop Jest's `--verbose` duplicate `Failures:` section. */
  readonly failuresSection?: boolean
}

/**
 * Build a {@link ToolFilter} for a Node test runner from `cfg`. The returned
 * filter overrides `compress` directly (test runners exit non-zero on failures,
 * so the base error-passthrough must stay off — FAIL blocks are preserved by the
 * loop, not dumped raw).
 *
 * The loop is a faithful port of the Python `JestFilter` / `VitestFilter`
 * `compress` methods, unified: file PASS headers and per-test ticks collapse to
 * counts, FAIL blocks pass through verbatim until a blank line, summary lines
 * are always kept, and console/stdout blocks collapse to a single count line.
 * All state is per-call (locals), so a single shared instance is concurrency-safe.
 */
export function makeNodeTestRunnerFilter(cfg: NodeTestRunnerConfig): ToolFilter {
  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)

    override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      let passFile = 0
      let tick = 0
      let inFail = false
      let blockLines = 0
      let inBlock = false
      let inFailuresSection = false
      let failuresDropped = 0

      const flush = (): void => {
        if (blockLines) {
          kept.push(`  [token-goat: collapsed ${blockLines} ${cfg.outputNoun} line${plural(blockLines)}]`)
        }
        blockLines = 0
        inBlock = false
      }

      for (const line of lines) {
        // Jest --verbose duplicate "Failures:" section: drop the header and its
        // repeated failure bodies (already shown inline); a summary line ends it.
        if (cfg.failuresSection) {
          if (line.trim() === 'Failures:') {
            flush()
            inFail = false
            inFailuresSection = true
            failuresDropped += 1
            continue
          }
          if (inFailuresSection) {
            if (cfg.summaryRe.test(line)) {
              inFailuresSection = false
              kept.push(line)
            } else {
              failuresDropped += 1
            }
            continue
          }
        }

        // File-level PASS header (outside a fail block) → count, drop.
        if (cfg.passFileRe.test(line) && !inFail) {
          flush()
          passFile += 1
          continue
        }
        // File-level FAIL header → open a verbatim fail block.
        if (cfg.failFileRe.test(line)) {
          flush()
          inFail = true
          kept.push(line)
          continue
        }
        // Summary lines are always kept (and end any open output block).
        if (cfg.summaryRe.test(line)) {
          flush()
          kept.push(line)
          continue
        }
        // Blank line ends a fail block.
        if (!line.trim() && inFail) {
          inFail = false
          kept.push(line)
          continue
        }
        // Inside a fail block: pass everything through verbatim.
        if (inFail) {
          kept.push(line)
          continue
        }
        // Output-block header (console.* / stdout |) → start collapsing.
        if (cfg.outputHdrRe.test(line)) {
          flush()
          inBlock = true
          blockLines = 1
          continue
        }
        if (inBlock) {
          const stripped = line.trim()
          // A blank or non-indented line ends the block; flush then re-handle it.
          if (!stripped || (line.length > 0 && !/^\s/.test(line))) {
            flush()
            // fall through to classify this line normally
          } else {
            blockLines += 1
            continue
          }
        }
        // Indented per-test pass tick → count, drop.
        if (cfg.testTickRe.test(line)) {
          tick += 1
          continue
        }
        kept.push(line)
      }

      flush()
      const notes: string[] = []
      maybeNote(notes, passFile, `collapsed ${passFile} ${cfg.passFileNoun}${plural(passFile)}`)
      maybeNote(notes, tick, `collapsed ${tick} passing tick${plural(tick)}`)
      if (failuresDropped) {
        notes.push(
          `collapsed ${failuresDropped} line${plural(failuresDropped)} from duplicate 'Failures:' section (already shown inline)`,
        )
      }
      this.emitNotes(kept, notes)
      return this.finalize(kept)
    }
  })()
}
