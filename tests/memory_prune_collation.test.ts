import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UtilModule from '../src/util.js'

// pruneIndex's duplicate-target detection folds entry.target via foldPath() for a
// case-insensitive-filesystem-correct comparison. foldPath and isCaseInsensitiveFs are both
// defined in util.ts and call each other in-module, so mocking isCaseInsensitiveFs's export
// alone would NOT affect foldPath's real behavior (same-module calls bypass the export/import
// indirection vi.mock hooks into). Mock foldPath itself instead -- memory_prune.ts's import of
// it IS a cross-module live binding vi.mock controls -- with a toggle so both platform branches
// are exercised regardless of the host OS (CI Linux is case-sensitive; this test's own host may
// not be). Both target files are written to disk regardless of platform so fs.existsSync
// succeeds either way -- this isolates the dedup-comparison logic under test from the host OS's
// own filesystem casing rules.
let simulateCaseInsensitiveFs = false
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    foldPath: (p: string) => (simulateCaseInsensitiveFs ? p.toLowerCase() : p),
  }
})

const { pruneIndex } = await import('../src/memory_prune.js')

let tempDir: string

beforeEach(() => {
  simulateCaseInsensitiveFs = false
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-prune-collation-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('pruneIndex duplicate-target detection case-folding', () => {
  it('case-insensitive FS: flags two links as duplicates when their target differs only in case', () => {
    simulateCaseInsensitiveFs = true

    const memoryMd = `- [First](feedback_foo.md)
- [Second](Feedback_Foo.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    // Both casings written to disk so existence checks succeed regardless of host FS
    // case-sensitivity -- what's under test here is only the dedup comparison itself.
    fs.writeFileSync(path.join(tempDir, 'feedback_foo.md'), 'content')
    fs.writeFileSync(path.join(tempDir, 'Feedback_Foo.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.removedDup).toHaveLength(1)
    expect(result.removedDup[0]?.title).toBe('Second')
    expect(result.kept).toBe(1)
  })

  it('case-sensitive FS: treats differently-cased targets as distinct files (no dedup)', () => {
    simulateCaseInsensitiveFs = false

    const memoryMd = `- [First](feedback_foo.md)
- [Second](Feedback_Foo.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'feedback_foo.md'), 'content')
    fs.writeFileSync(path.join(tempDir, 'Feedback_Foo.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.removedDup).toHaveLength(0)
    expect(result.kept).toBe(2)
  })
})
