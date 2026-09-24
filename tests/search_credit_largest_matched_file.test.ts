/** Regression: `symbol NAME` and `semantic` credited the sum of every matched file's size, each capped at 100KB, as if the alternative to one lookup were reading every file that matched. A real ledger booked one `symbol main` lookup at 1.92M tokens this way. The credit is now the largest matched file, under the same per-file cap, less what the command printed. Fixture provenance: HAND-DERIVED. Both files are written here, and the expected credit is computed from their `statSync` sizes and the text each command returned, never from read_commands.ts's own accounting. */
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSemantic, runSymbol } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'

function creditFor(kind: string, run: () => void): number {
  const before = summarize(30).by_kind[kind]?.bytes_saved ?? 0
  run()
  return (summarize(30).by_kind[kind]?.bytes_saved ?? 0) - before
}

/** Two files that both define `name` and mention `term`, padded to different sizes so the largest one is unambiguous and the sum is far above it. */
function writeTwoMatches(root: string, name: string, term: string): { files: string[]; largest: number; sum: number } {
  const files: string[] = []
  for (const [file, padLines] of [['small.ts', 150], ['large.ts', 450]] as const) {
    const p = join(root, file)
    writeFileSync(p, `// ${term}\nexport function ${name}(): number {\n  return 1\n}\n${`// ${'x'.repeat(78)}\n`.repeat(padLines)}`)
    indexFileSync(normalizePath(p))
    files.push(p)
  }
  const sizes = files.map((f) => statSync(f).size)
  return { files, largest: Math.max(...sizes), sum: sizes[0]! + sizes[1]! }
}

describe('a search-shaped read command is credited the largest matched file, not every match', () => {
  it('symbol NAME matching two files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-symbol-largest-'))
    try {
      const name = 'largestMatchSymbolFn5w1'
      const { largest, sum } = writeTwoMatches(root, name, 'unusedTerm')
      let text = ''
      const delta = creditFor('symbol_lookup', () => {
        const result = runSymbol({ name })
        expect(result.code).toBe(0)
        text = result.text
      })
      expect(text).toContain('small.ts')
      expect(text).toContain('large.ts')
      const emitted = Buffer.byteLength(text, 'utf8')
      expect(delta, `credited ${delta}; the sum of both files less the output would be ${sum - emitted}`).toBe(largest - emitted)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('semantic with hits in two files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-semantic-largest-'))
    try {
      const term = 'largestMatchSemanticTerm5w1'
      const { largest, sum } = writeTwoMatches(root, 'largestMatchSemanticFn5w1', term)
      const before = summarize(30).by_kind['semantic_search']?.bytes_saved ?? 0
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      let text = ''
      try {
        const result = await runSemantic(term, {})
        expect(result.code).toBe(0)
        text = result.text
      } finally {
        cwdSpy.mockRestore()
      }
      const delta = (summarize(30).by_kind['semantic_search']?.bytes_saved ?? 0) - before
      // Only meaningful when both files are hits: with one, the largest and the sum are the same number.
      expect(text).toContain('small.ts')
      expect(text).toContain('large.ts')
      const emitted = Buffer.byteLength(text, 'utf8')
      expect(delta, `credited ${delta}; the sum of both files less the output would be ${sum - emitted}`).toBe(largest - emitted)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
