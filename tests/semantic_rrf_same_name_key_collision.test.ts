// resolveEnclosingSymbol's fusion key in runSemantic (src/read_commands.ts) was `${filePath}::${name}`
// -- the enclosing symbol's NAME alone, with no line/position component. Two distinct symbols that
// happen to share a name in the same file (e.g. a same-named method on two different classes) resolve
// to the identical key, so a dense-pass hit inside the second symbol silently overwrites the Map entry
// already holding the first symbol's hit (the dense forEach does an unconditional `fused.set`, no
// existing-key check) -- one of the two real, distinct results vanishes from the output with no error,
// no warning, and no indication anything was dropped.
//
// This constructs the exact collision: a fixture with two classes, Alpha and Beta, each defining a
// method named `render` at different, non-overlapping line ranges. Two independent dense hits (one
// per method) are fed to runSemantic via the mocked searchSemantic, exactly as
// tests/semantic_enclosing_symbol.test.ts already does for the non-colliding case. Both hits must
// survive fusion as two separate rows; pre-fix, only the later-inserted one (Beta.render) does.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'

import { closeAllDbs } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { indexFileSync } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { runSemantic } = await import('../src/read_commands.js')

let TMP: string
let fixtureFile: string

// FORMAT-DERIVED: mirrors the class/method shape tests/semantic_enclosing_symbol.test.ts already
// uses for real indexFileSync fixtures, just with the method name repeated across two classes, far
// enough apart (embeddings.ts's mergeNearbyHits default proximity is 20 lines) that the two dense
// hits stay two separate SearchHit windows instead of being legitimately merged into one first.
const PADDING = Array.from({ length: 25 }, (_, i) => `// filler line ${i}`)
const FIXTURE_SOURCE = [
  'export class Alpha {',
  '  render() {',
  "    return 'alpha'",
  '  }',
  '}',
  ...PADDING,
  'export class Beta {',
  '  render() {',
  "    return 'beta'",
  '  }',
  '}',
  '',
].join('\n')

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-samename-'))
  fixtureFile = path.join(TMP, 'fixture.ts')
  fs.writeFileSync(fixtureFile, FIXTURE_SOURCE, 'utf8')
  indexFileSync(fixtureFile, globalDbPath())
  searchSemanticMock.mockReset()
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('runSemantic RRF fusion key does not collapse two distinct same-named symbols', () => {
  it('keeps both Alpha.render and Beta.render as separate hits, not one overwriting the other', async () => {
    const syms = querySymbols({ filePath: fixtureFile }, globalDbPath())
    const renderSyms = syms.filter((s) => s.name === 'render')
    expect(renderSyms).toHaveLength(2)
    const [first, second] = renderSyms.sort((a, b) => a.lineStart - b.lineStart)

    const hits: SearchHit[] = [
      { filePath: fixtureFile, startLine: first!.lineStart, endLine: first!.lineEnd, kind: 'window', distance: 0.1, text: "return 'alpha'" },
      { filePath: fixtureFile, startLine: second!.lineStart, endLine: second!.lineEnd, kind: 'window', distance: 0.2, text: "return 'beta'" },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('render', { json: true, projectRoot: TMP })
    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: Array<{ startLine: number; previewText?: string; text?: string }> }

    // Both distinct source lines must be present -- collapsing to one row is the bug under test.
    const startLines = payload.items.filter((i) => i.startLine === first!.lineStart || i.startLine === second!.lineStart).map((i) => i.startLine)
    expect(startLines).toContain(first!.lineStart)
    expect(startLines).toContain(second!.lineStart)
    expect(new Set(startLines).size).toBe(2)

    // Positive control: the content from BOTH methods must be recoverable in the raw text output too.
    const { text: plain } = await runSemantic('render', { json: false, projectRoot: TMP })
    expect(plain).toContain("return 'alpha'")
    expect(plain).toContain("return 'beta'")
  })
})
