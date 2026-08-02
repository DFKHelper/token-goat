import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UtilModule from '../src/util.js'

// read_commands.ts calls foldPath (not isCaseInsensitiveFs directly) for its case-fold
// fallback (endsWithPathBoundary and the querySymbols filter). foldPath and
// isCaseInsensitiveFs are both defined in util.ts and call each other in-module, so mocking
// isCaseInsensitiveFs's export alone would NOT affect foldPath's real behavior (same-module
// calls bypass the export/import indirection vi.mock hooks into). Mock foldPath itself
// instead — read_commands.ts's import of it IS a cross-module live binding vi.mock controls
// — with a toggle so both platform branches are exercised regardless of the host OS
// (CI Linux is case-sensitive; this test's own host may not be).
let simulateCaseInsensitiveFs = false
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    foldPath: (p: string) => (simulateCaseInsensitiveFs ? p.toLowerCase() : p),
  }
})

vi.mock('../src/index_reader.js', () => ({
  querySymbols: vi.fn(),
  queryRefs: vi.fn(() => []),
  getFileEntry: vi.fn(() => null),
}))

const { runRead } = await import('../src/read_commands.js')
const { querySymbols } = await import('../src/index_reader.js')

const mockQuerySymbols = vi.mocked(querySymbols)

const SEEDED_SYMBOL = {
  filePath: 'c:/proj/Foo.ts',
  name: 'login',
  kind: 'function',
  lineStart: 1,
  lineEnd: 3,
  body: 'function login() {}',
  docstring: '',
  parent: '',
}

describe('runRead path-collation handling', () => {
  beforeEach(() => {
    mockQuerySymbols.mockReset()
    // First call is the direct { name, filePath, limit: 10 } lookup — simulate it missing
    // (as it would with a case-differing resolved path against a case-sensitive DB key),
    // forcing runRead into its partial-path fallback (the code path this test targets).
    mockQuerySymbols.mockReturnValueOnce([])
    mockQuerySymbols.mockReturnValue([SEEDED_SYMBOL])
    simulateCaseInsensitiveFs = false
  })

  it('case-insensitive FS: resolves a symbol via the fallback when the requested path differs only in case', () => {
    simulateCaseInsensitiveFs = true
    const { code, text: stdout } = runRead({ spec: 'c:/proj/foo.ts::login' })
    expect(code).toBe(0)
    expect(stdout).toContain('function login()')
  })

  it('case-sensitive FS: does not resolve a symbol whose indexed path differs only in case', () => {
    simulateCaseInsensitiveFs = false
    const { code } = runRead({ spec: 'c:/proj/foo.ts::login' })
    expect(code).toBe(1)
  })
})
