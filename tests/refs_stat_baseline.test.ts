/** Regression: `refs` credited itself the full on-disk size of every file a reference lands in (sumFileSizes over results, src/read_commands.ts), as if the alternative to running `refs` were reading all forty of those files end to end. Nobody does that; the alternative to `refs foo` is a plain search for `foo`, which prints one line per hit. On a real ledger this counter reported ~466KB saved per `refs` event. The credit is now bounded by the search-shaped counterfactual. Fixture provenance: HAND-DERIVED. The two bounds this test asserts against are computed by the test from its own on-disk fixture files -- `statSync().size` for the old whole-file baseline and a `grep -n`-shaped `path:line: line` rendering of the reference lines the test itself wrote for the search baseline -- never read off read_commands.ts's own accounting. */
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRefs } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'
import { CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES, CLAUDE_CODE_PERSISTED_PREVIEW_BYTES } from '../src/delivery_cap.js'

describe('refs symbol_read credit is bounded by a search-shaped counterfactual', () => {
  it('credits a multi-file refs result far below the sum of the files it matched in', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-refsbaseline-'))
    try {
      const target = 'refsBaselineTargetFn7q4'
      const defFile = join(root, 'def.ts')
      writeFileSync(defFile, `export function ${target}(): number {\n  return 1\n}\n`)
      indexFileSync(normalizePath(defFile))

      // Four callers, each padded to ~40KB so the whole-file baseline (~160KB) sits far above the per-file 100KB ceiling's reach: that ceiling bounds each file, never the sum, which is exactly why a multi-file result escaped it.
      const filler = `// ${'x'.repeat(78)}\n`.repeat(500)
      const callerFiles: string[] = []
      for (const name of ['c1.ts', 'c2.ts', 'c3.ts', 'c4.ts']) {
        const f = join(root, name)
        writeFileSync(f, `${filler}export const v = ${target}()\n`)
        indexFileSync(normalizePath(f))
        callerFiles.push(f)
      }

      const wholeFileBaseline = callerFiles.reduce((n, f) => n + statSync(f).size, 0)
      // One `grep -n`-shaped hit line per caller file, generously over-measured: the absolute path (longer than the relative path refs prints) plus the whole matched source line.
      const searchBaseline = callerFiles.reduce(
        (n, f) => n + Buffer.byteLength(`${f}:501: export const v = ${target}()\n`, 'utf8'),
        0,
      )
      expect(wholeFileBaseline).toBeGreaterThan(searchBaseline * 20)

      const before = summarize(30).by_kind['symbol_read']?.bytes_saved ?? 0
      const code = runRefs({ spec: target, projectRoot: root })
      expect(code).toBe(0)
      const delta = (summarize(30).by_kind['symbol_read']?.bytes_saved ?? 0) - before

      expect(
        delta,
        `refs credited ${delta} bytes saved for a 4-file result; the search it replaces would have emitted at most ${searchBaseline} bytes. A credit near the ${wholeFileBaseline}-byte sum of the matched files means the counterfactual is still "read every file whole".`,
      ).toBeLessThanOrEqual(searchBaseline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The bounds below are HAND-DERIVED from the fixture this test writes (a floor of 16 bytes per `path:line: ` hit line plus its newline, before any label), and the two caps are the CAPTURE-derived constants in src/delivery_cap.ts: a Bash result past 20,000 bytes reaches Claude Code's model as a 2KB preview.
describe('refs prices the search it replaces at what the harness would have delivered', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function writeManyCallers(root: string, target: string): number {
    const def = join(root, 'def.ts')
    writeFileSync(def, `export function ${target}(): number {\n  return 1\n}\n`)
    indexFileSync(normalizePath(def))
    let floor = 0
    for (let f = 0; f < 10; f++) {
      const name = `caller_${f}.ts`
      const lines: string[] = []
      for (let i = 0; i < 250; i++) lines.push(`export const v${i} = ${target}()`)
      writeFileSync(join(root, name), lines.join('\n') + '\n')
      indexFileSync(normalizePath(join(root, name)))
      floor += 250 * Buffer.byteLength(`${name}:1: \n`, 'utf8')
    }
    return floor
  }

  function refsCredit(root: string, target: string): number {
    const before = summarize(30).by_kind['symbol_read']?.bytes_saved ?? 0
    // --top lifts the query limit, so the baseline sees every reference while the output is a short summary: the shape that let one real `refs` call claim 2.5M tokens.
    expect(runRefs({ spec: target, projectRoot: root, top: 3 })).toBe(0)
    return (summarize(30).by_kind['symbol_read']?.bytes_saved ?? 0) - before
  }

  it('credits no more than the 2KB preview once the hit list is past the Bash cap', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const root = mkdtempSync(join(tmpdir(), 'tg-refs-delivered-'))
    try {
      const target = 'refsDeliveredTargetFn3m8'
      const floor = writeManyCallers(root, target)
      expect(floor).toBeGreaterThan(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES)
      const delta = refsCredit(root, target)
      expect(delta, `refs credited ${delta} bytes for a hit list of at least ${floor} bytes that Claude Code would have shown as a ${CLAUDE_CODE_PERSISTED_PREVIEW_BYTES}-byte preview`).toBeLessThanOrEqual(CLAUDE_CODE_PERSISTED_PREVIEW_BYTES)
      expect(delta).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the credit uncut under a harness with no measured cap', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'generic')
    const root = mkdtempSync(join(tmpdir(), 'tg-refs-uncapped-'))
    try {
      const target = 'refsUncappedTargetFn3m8'
      const floor = writeManyCallers(root, target)
      // The --top summary is a few hundred bytes, so the whole hit list less that summary stays well above the cap.
      expect(refsCredit(root, target)).toBeGreaterThan(floor - 2_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
