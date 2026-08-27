/**
 * `symbol NAME --kind K` (or `--file F`) narrows in SQL, so when the scope removes the only row
 * the lookup returns zero and runSymbol falls into its "No matches" branch. That branch then runs
 * an UNSCOPED near-name scan and ranks it for typos -- and the exact name the caller typed is in
 * that scan, because only the scope removed it. The result was a suggestion identical to the
 * query:
 *
 *   $ token-goat symbol alphaOne --kind class
 *   No matches for 'alphaOne'
 *   Did you mean:
 *     - alphaOne
 *
 * Confirmed against the shipped binary before the fix. Both lines are wrong in the same direction:
 * "No matches" reads as "this symbol is not indexed" and the correction is byte-identical to the
 * input, so the caller concludes the symbol does not exist and falls back to a full-file Read --
 * the exact spend this tool exists to avoid. The symbol was indexed the whole time.
 *
 * Nothing caught it because every existing near-name test in tests/read_commands.test.ts mocks
 * querySymbols to return [] for ANY call carrying a `name`, so the scan can never contain an exact
 * match: the scoped-miss-with-exact-match state was unreachable in the test world. These tests
 * drive the real parser, the real index and the real (test-isolated) global.db instead.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'

function withIndexedProject(prefix: string, fn: (root: string, file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    const file = join(root, 'alpha.ts')
    writeFileSync(file, 'export function alphaScopeFn9k(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(file))
    fn(normalizePath(root), normalizePath(file))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('runSymbol: a scope filter that hides an indexed symbol must not read as absence', () => {
  it('names the scope and the real location instead of suggesting the query back to itself (--kind)', () => {
    withIndexedProject('tg-symscope-kind-', (root) => {
      const { text, code } = runSymbol({ name: 'alphaScopeFn9k', kind: 'class', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(
        `No matches for 'alphaScopeFn9k'\n'alphaScopeFn9k' IS indexed (function at alpha.ts:1) -- drop --kind to see it`,
      )
    })
  })

  it('names --file when an indexed symbol is looked up in the wrong file', () => {
    withIndexedProject('tg-symscope-file-', (root) => {
      const other = join(root, 'other.ts')
      writeFileSync(other, 'export function otherScopeFn9k(): number {\n  return 2\n}\n')
      indexFileSync(normalizePath(other))
      const { text, code } = runSymbol({ name: 'alphaScopeFn9k', file: normalizePath(other), projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(
        `No matches for 'alphaScopeFn9k'\n'alphaScopeFn9k' IS indexed (function at alpha.ts:1) -- drop --file to see it`,
      )
    })
  })

  it('names both flags when both are set', () => {
    withIndexedProject('tg-symscope-both-', (root) => {
      const other = join(root, 'other.ts')
      writeFileSync(other, 'export function otherScopeFn9k(): number {\n  return 2\n}\n')
      indexFileSync(normalizePath(other))
      const { text, code } = runSymbol({ name: 'alphaScopeFn9k', kind: 'class', file: normalizePath(other), projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(
        `No matches for 'alphaScopeFn9k'\n'alphaScopeFn9k' IS indexed (function at alpha.ts:1) -- drop --kind/--file to see it`,
      )
    })
  })

  // The over-fix control: a genuine typo has NO exact match in the scan, so the near-name ranking
  // must still run and still produce its suggestion. A fix that replaced the didYouMean block
  // outright rather than branching on an exact match would go red here.
  it('still emits the near-name suggestion for a real typo, unchanged', () => {
    withIndexedProject('tg-symscope-typo-', (root) => {
      const { text, code } = runSymbol({ name: 'alphaScopeFn9', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for 'alphaScopeFn9'\nDid you mean:\n  - alphaScopeFn9k`)
    })
  })
})
