/** `symbol --kind K` filters in SQL on the exact stored kind, and every stored kind is lower-case (`method`, `function`), so `--kind Method` empties the scope by itself. The miss then printed only "No matches for '.'" for `--grep .`, which reads as "this project has no symbols" when the one thing wrong was the kind's spelling; `dead --kind` already names an unrecognized kind with a suggestion. These drive the real parser and the real (test-isolated) index. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_symbol.js'

function withIndexedProject(prefix: string, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    // HAND-DERIVED: one class with one method and one function, so the index holds exactly the kinds `class`, `method` and `function`.
    const file = join(root, 'kinds.ts')
    writeFileSync(file, 'export class KindBox9q {\n  open(): void {}\n}\n\nexport function kindFree9q(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(file))
    fn(normalizePath(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('runSymbol: a --kind no indexed symbol carries is named, not hidden behind "No matches"', () => {
  it('names a mis-cased kind and suggests the stored one (--grep)', () => {
    withIndexedProject('tg-symkind-grep-', (root) => {
      const { text, code } = runSymbol({ grep: '.', kind: 'Method', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for '.'\nno indexed symbol has kind 'Method'\nDid you mean:\n  - method`)
    })
  })

  it('names it on an exact-name lookup too, beside the IS indexed note', () => {
    withIndexedProject('tg-symkind-name-', (root) => {
      const { text, code } = runSymbol({ name: 'open', kind: 'Method', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for 'open'\nno indexed symbol has kind 'Method'\nDid you mean:\n  - method\n'open' IS indexed (method at kinds.ts:2) -- drop --kind to see it`)
    })
  })

  it('suggests the recognized spelling of a mis-cased kind this project has none of', () => {
    withIndexedProject('tg-symkind-recase-', (root) => {
      const { text, code } = runSymbol({ grep: '.', kind: 'Interface', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for '.'\nno indexed symbol has kind 'Interface'\nDid you mean:\n  - interface`)
    })
  })

  it('ranks a misspelled kind against the kinds this project stores', () => {
    withIndexedProject('tg-symkind-typo-', (root) => {
      const { text, code } = runSymbol({ grep: '.', kind: 'functon', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for '.'\nno indexed symbol has kind 'functon'\nDid you mean:\n  - function`)
    })
  })

  // The over-fix control: a recognized kind that this project simply has none of is an ordinary miss, already covered by the IS indexed note, and must stay byte-identical.
  it('adds nothing for a recognized kind the project has none of', () => {
    withIndexedProject('tg-symkind-known-', (root) => {
      const { text, code } = runSymbol({ grep: '.', kind: 'interface', projectRoot: root })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for '.'`)
    })
  })

  it('still lists the symbols when the kind is spelled as stored', () => {
    withIndexedProject('tg-symkind-ok-', (root) => {
      const { text, code } = runSymbol({ grep: '.', kind: 'method', projectRoot: root })
      expect(code).toBe(0)
      expect(text).toContain('open')
    })
  })
})
