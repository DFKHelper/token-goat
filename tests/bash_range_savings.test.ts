/**
 * A line-range hint may only spend context when its own proposal is measurably cheaper than the
 * read it objects to.
 *
 * FIXTURE PROVENANCE
 *
 * The standing reason for the gate is CAPTURE, from the shipped global binary on 2026-09-20 in
 * this repository:
 *   sed -n '1,30p' CHANGELOG.md | wc -c                   -> 10572
 *   token-goat section "CHANGELOG.md::Unreleased" | wc -c  -> 15150
 * The proposal the old hint made was 43% larger than the read it objected to. Those two numbers are
 * a measurement of one day's CHANGELOG.md and are recorded here rather than asserted: the file is
 * rewritten at every release, so pinning its byte count would fail on the edit rather than on the
 * defect, and re-capturing it each time turns the check into a rubber stamp. What the tests below
 * assert instead is the invariant the capture was evidence for, which holds at any file size: the
 * gate's own accounting of the requested window matches the bytes on disk, and the regions it would
 * substitute cost more than the window they replace.
 *
 * SED_WINDOW_LINES is CAPTURE: the mean `sed -n 'N,Mp'` window across 50,033 range reads mined from
 * 3,525 real Claude Code transcripts on this machine (191,710 Bash tool_use commands) was 47.2
 * lines, p50 30, p90 100. 43 is the concrete window from the session that prompted this work.
 *
 * The region-span comparisons are HAND-DERIVED: computed here from the file on disk and the
 * index's own line spans, independently of the gate's arithmetic.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { rangeSubstituteFor } from '../src/bash_range_savings.js'
import { sedRangeHint } from '../src/bash_extractors.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { resolveLineRegions } from '../src/read_spec.js'
import { querySymbols } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { resetHintStats } from '../src/hint_stats.js'
import { indexFileSync } from '../src/parser.js'
import { getFileEntry } from '../src/index_reader.js'
import { globalDbPath } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import { configPath } from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const SED_WINDOW_LINES = 43

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

const REPO = process.cwd()

function preBashEvent(command: string): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: `rs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    agentId: undefined,
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command } },
  }
}

/** The gate reads real line spans out of the index, so the files it prices have to actually be in the isolated test index -- an unindexed file is declined, which would make every "emits nothing" assertion below pass for the wrong reason. */
function indexed(filePath: string): void {
  const resolved = resolveIndexPath(filePath, REPO)
  indexFileSync(resolved, globalDbPath())
  expect(getFileEntry(resolved)).not.toBeNull()
  expect(querySymbols({ filePath: resolved, limit: -1 }).length).toBeGreaterThan(0)
}

/** The requested window's bytes, read off disk rather than off the gate. */
function windowBytes(file: string, start: number, end: number): number {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let total = 0
  for (let l = start; l <= Math.min(end, lines.length); l++) total += Buffer.byteLength(lines[l - 1] ?? '', 'utf8') + 1
  return total
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
  indexed('CHANGELOG.md')
  indexed('src/paths.ts')
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('a range hint must price its own replacement', () => {
  it('positive control: the CHANGELOG window this case rests on is real and non-trivial', () => {
    expect(windowBytes('CHANGELOG.md', 1, 30)).toBeGreaterThan(1000)
  })

  it('the enclosing regions of a real 30-line CHANGELOG window cost more than the window', () => {
    const sub = rangeSubstituteFor('CHANGELOG.md', process.cwd(), [[1, 30]])
    expect(sub).not.toBeNull()
    expect(sub!.requestedBytes).toBe(windowBytes('CHANGELOG.md', 1, 30))
    expect(sub!.replacementBytes).toBeGreaterThan(sub!.requestedBytes)
  })

  it('and so does a 43-line source window, the shape the hint was written for', () => {
    const sub = rangeSubstituteFor('src/paths.ts', process.cwd(), [[10, 10 + SED_WINDOW_LINES - 1]])
    expect(sub).not.toBeNull()
    expect(sub!.requestedBytes).toBe(windowBytes('src/paths.ts', 10, 10 + SED_WINDOW_LINES - 1))
    expect(sub!.replacementBytes).toBeGreaterThan(sub!.requestedBytes)
  })

  it('names the specific region, never just the file', () => {
    const sub = rangeSubstituteFor('src/paths.ts', process.cwd(), [[130, 140]])
    expect(sub).not.toBeNull()
    expect(sub!.commands.length).toBeGreaterThan(0)
    for (const c of sub!.commands) {
      expect(c.startsWith('token-goat read "src/paths.ts:')).toBe(true)
      // A bare `read "file"` -- the file with no region after it -- is the shape that made the old hint unfollowable, so it must not be producible here.
      expect(c).not.toBe('token-goat read "src/paths.ts"')
    }
    expect(sub!.commands.some((c) => c.includes('::normalizePath'))).toBe(true)
  })

  it('the replacement always covers every requested line, which is why it is not smaller', () => {
    // HAND-DERIVED: the containment property the measurement reflects, checked directly rather than inferred from the byte totals.
    const abs = resolveIndexPath('src/paths.ts', process.cwd())
    const total = fs.readFileSync(abs, 'utf8').split('\n').length
    const syms = querySymbols({ filePath: abs, limit: -1 })
    for (const [start, end] of [[10, 52], [1, 30], [130, 140], [200, 320]] as Array<[number, number]>) {
      const regions = resolveLineRegions(syms, total, start, end)
      for (let l = start; l <= Math.min(end, total); l++) {
        expect(regions.some((r) => r.start <= l && r.end >= l)).toBe(true)
      }
    }
  })

  it('emits nothing for the sed window it used to lecture about', () => {
    const out = preBashHandler(preBashEvent(`sed -n '10,52p' src/paths.ts`))
    expect(out.hookType).toBe('pass')
  })

  it('emits nothing for head -30 CHANGELOG.md, the largest measured waste case', () => {
    const out = preBashHandler(preBashEvent(`head -30 CHANGELOG.md`))
    expect(out.hookType).toBe('pass')
  })

  it('still warns when the lines were already served this session, which owes nothing to pricing', () => {
    // Also the positive control for the two "emits nothing" cases above: it proves this same handler, on this same file, in this same run, does still reach a context output -- so their `pass` is the gate declining and not the whole path being inert.
    // Through `sed`, whose ranges the pre-hook records itself; `head`'s ledger entry is written by the post-hook once the command has actually succeeded, which this pre-hook-only test never reaches.
    preBashHandler(preBashEvent(`sed -n '1,40p' CHANGELOG.md`))
    const second = preBashHandler(preBashEvent(`sed -n '1,30p' CHANGELOG.md`))
    expect(second.hookType).toBe('context')
    expect(second.hookType === 'context' ? second.context : '').toContain('already read lines')
  })

  it('does emit, naming the priced commands and both figures, when a replacement is cheaper', () => {
    // The emit half of the gate. Driven through the builder with figures that show a saving, because the containment property above means no real file produces one: without this the suite would only ever exercise the silent branch and a builder that emitted nothing at all would look identical to a working one.
    const text = sedRangeHint('src/paths.ts', [[10, 52]], 'sed', {
      requestedBytes: 4469,
      replacementBytes: 1200,
      commands: ['token-goat read "src/paths.ts::normalizePath"'],
    })
    expect(text).toContain('token-goat read "src/paths.ts::normalizePath"')
    expect(text).toContain('4469')
    expect(text).toContain('1200')
    expect(text).toContain('lines 10-52'.replace('lines ', 'Lines '))
  })

  it('declines to price an unindexed file rather than guessing', () => {
    expect(rangeSubstituteFor('no/such/file/anywhere.ts', process.cwd(), [[1, 10]])).toBeNull()
  })
})
