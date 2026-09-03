/**
 * Regression: `refs` credited itself the full on-disk size of every file a reference lands in
 * (sumFileSizes over results, src/read_commands.ts), as if the alternative to running `refs` were
 * reading all forty of those files end to end. Nobody does that; the alternative to `refs foo` is
 * a plain search for `foo`, which prints one line per hit. On a real ledger this counter reported
 * ~466KB saved per `refs` event. The credit is now bounded by the search-shaped counterfactual.
 *
 * Fixture provenance: HAND-DERIVED. The two bounds this test asserts against are computed by the
 * test from its own on-disk fixture files -- `statSync().size` for the old whole-file baseline and
 * a `grep -n`-shaped `path:line: line` rendering of the reference lines the test itself wrote for
 * the search baseline -- never read off read_commands.ts's own accounting.
 */
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRefs } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'

describe('refs symbol_read credit is bounded by a search-shaped counterfactual', () => {
  it('credits a multi-file refs result far below the sum of the files it matched in', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-refsbaseline-'))
    try {
      const target = 'refsBaselineTargetFn7q4'
      const defFile = join(root, 'def.ts')
      writeFileSync(defFile, `export function ${target}(): number {\n  return 1\n}\n`)
      indexFileSync(normalizePath(defFile))

      // Four callers, each padded to ~40KB so the whole-file baseline (~160KB) sits far above the
      // per-file 100KB ceiling's reach: that ceiling bounds each file, never the sum, which is
      // exactly why a multi-file result escaped it.
      const filler = `// ${'x'.repeat(78)}\n`.repeat(500)
      const callerFiles: string[] = []
      for (const name of ['c1.ts', 'c2.ts', 'c3.ts', 'c4.ts']) {
        const f = join(root, name)
        writeFileSync(f, `${filler}export const v = ${target}()\n`)
        indexFileSync(normalizePath(f))
        callerFiles.push(f)
      }

      const wholeFileBaseline = callerFiles.reduce((n, f) => n + statSync(f).size, 0)
      // One `grep -n`-shaped hit line per caller file, generously over-measured: the absolute path
      // (longer than the relative path refs prints) plus the whole matched source line.
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
