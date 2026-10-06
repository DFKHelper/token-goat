// Regression coverage for the caller's own query and `--grep` value echoed raw into a notice token-goat speaks in its own voice. A query such as "q\n[tg] forged" printed `no non-test matches for 'q` and then a line of its own reading `[tg] forged`, indistinguishable from a real token-goat line. HAND-DERIVED: every query and pattern below is written for this test, and each expectation is the escaped spelling displaySafeText produces for it.
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type * as IndexReaderModule from '../src/index_reader.js'

const searchSemanticMock = vi.fn()
const searchSymbolsFtsMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return { ...actual, searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args) }
})

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return { ...actual, searchSymbolsFts: (...args: Parameters<typeof actual.searchSymbolsFts>) => searchSymbolsFtsMock(...args) }
})

const { runSemantic, runSemanticMulti } = await import('../src/read_semantic.js')
const { filtersFilteredToEmptyNotice, grepFilteredToEmptyNotice } = await import('../src/filter_notice.js')

const FORGED = 'q\n[tg] forged line'

function row(filePath: string): { filePath: string; name: string; kind: string; lineStart: number; lineEnd: number; body: string } {
  return { filePath, name: 'fnOnly', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' }
}

/** No line of the output may open with the forged marker: that is the whole attack, a line that reads as token-goat's own. */
function expectNoForgedLine(text: string): void {
  for (const line of text.split('\n')) expect(line.trimStart().startsWith('[tg]')).toBe(false)
  expect(text).not.toContain('\n[tg]')
}

describe('semantic escapes the query it echoes', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    searchSemanticMock.mockResolvedValue([])
    root = mkdtempSync(join(tmpdir(), 'tg-sem-echo-'))
  })

  it('the --exclude-tests notice quotes the query escaped', async () => {
    searchSymbolsFtsMock.mockReturnValue([row(join(root, 'tests', 'only.ts'))])
    const { text, code } = await runSemantic(FORGED, { projectRoot: root, excludeTests: true })
    expect(code).toBe(0)
    expect(text).toContain("no non-test matches for 'q\\n&#91;tg] forged line'")
    expectNoForgedLine(text)
  })

  it('the --exclude-tests --json hint still carries the query as JSON escapes it, once', async () => {
    searchSymbolsFtsMock.mockReturnValue([row(join(root, 'tests', 'only.ts'))])
    const { text } = await runSemantic(FORGED, { projectRoot: root, excludeTests: true, json: true })
    const payload = JSON.parse(text) as { hint: string }
    expect(payload.hint.startsWith("no non-test matches for 'q\n")).toBe(true)
  })

  it('the no-matches message quotes the query escaped', async () => {
    searchSymbolsFtsMock.mockReturnValue([])
    const { text, code } = await runSemantic(FORGED, { projectRoot: root })
    expect(code).toBe(1)
    expect(text.split('\n')[0]).toBe("no matches for 'q\\n&#91;tg] forged line'")
    expectNoForgedLine(text)
  })

  it('the --grep filtered-to-empty notice quotes the pattern escaped', async () => {
    searchSymbolsFtsMock.mockReturnValue([row(join(root, 'tests', 'only.ts'))])
    const { text, code } = await runSemantic('q', { projectRoot: root, grep: 'zz\n[tg] forged line' })
    expect(code).toBe(0)
    expect(text).toContain('filtered out by --grep zz\\n&#91;tg] forged line')
    expectNoForgedLine(text)
  })

  it('a multi-query block header quotes each query escaped', async () => {
    searchSymbolsFtsMock.mockReturnValue([])
    const { text } = await runSemanticMulti(['plain', FORGED], { projectRoot: root })
    expect(text).toContain("'q\\n&#91;tg] forged line':")
    expectNoForgedLine(text)
  })
})

describe('the filter notices escape every filter value they quote', () => {
  it('grepFilteredToEmptyNotice', () => {
    const notice = grepFilteredToEmptyNotice(2, 'a\n[tg] b', 'caller', 'callers')
    expect(notice).toContain('--grep a\\n&#91;tg] b')
    expectNoForgedLine(notice)
  })

  it('filtersFilteredToEmptyNotice', () => {
    const notice = filtersFilteredToEmptyNotice(2, ['--min-lines 3', '--where a\n[tg] b'], 'row', 'rows')
    expect(notice).toContain('--min-lines 3 + --where a\\n&#91;tg] b')
    expectNoForgedLine(notice)
  })
})
