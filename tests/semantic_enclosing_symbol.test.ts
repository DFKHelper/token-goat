// runSemantic's --json and text output hardcoded name/kind to null for every hit even though
// the enclosing symbol is a join over data the indexer already stores (symbols.line_start/
// line_end). This proves the fix resolves the real enclosing symbol from an indexed fixture,
// with three cases that matter most:
//   - a hit whose line range falls inside a known function/method reports that exact name/kind
//   - a top-of-file hit (before any symbol starts) reports null/null, not the symbol below it
//   - a hit inside a method nested in a class resolves to the method (innermost), not the class
//
// searchSemantic is mocked (same pattern as tests/semantic_json_embeddings_source.test.ts) so
// the hit's line ranges are exact and deterministic; the fixture file is indexed for real via
// indexFileSync so the symbols table backing resolveEnclosingSymbol is genuine, not stubbed.
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

const FIXTURE_SOURCE = [
  "import { helper } from './helper.js'",
  '',
  'export class Foo {',
  '  bar() {',
  '    return helper(1)',
  '  }',
  '}',
  '',
  'export function baz() {',
  '  return 2',
  '}',
  '',
].join('\n')

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-enclosing-'))
  fixtureFile = path.join(TMP, 'fixture.ts')
  fs.writeFileSync(fixtureFile, FIXTURE_SOURCE, 'utf8')
  indexFileSync(fixtureFile, globalDbPath())
  searchSemanticMock.mockReset()
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('runSemantic enclosing-symbol resolution', () => {
  it('indexes the fixture with the expected function/method/class symbols at known lines (sanity check)', () => {
    const syms = querySymbols({ filePath: fixtureFile }, globalDbPath())
    const bar = syms.find((s) => s.name === 'bar')
    const baz = syms.find((s) => s.name === 'baz')
    const foo = syms.find((s) => s.name === 'Foo')
    expect(bar?.kind).toBe('method')
    expect(baz?.kind).toBe('function')
    expect(foo?.kind).toBe('class')
  })

  it('reports the exact enclosing function name/kind for a hit inside that function (text output)', async () => {
    const bazSym = querySymbols({ filePath: fixtureFile, name: 'baz' }, globalDbPath())[0]
    expect(bazSym).toBeDefined()
    const start = bazSym!.lineStart
    const end = bazSym!.lineEnd
    const hits: SearchHit[] = [
      { filePath: fixtureFile, startLine: start, endLine: end, kind: 'window', distance: 0.1, text: 'return 2' },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('baz', { json: false, projectRoot: TMP })
    expect(code).toBe(0)
    expect(text).toContain('— inside baz (function)')
  })

  it('reports exact name/kind:"function" in JSON for a hit inside baz', async () => {
    const bazSym = querySymbols({ filePath: fixtureFile, name: 'baz' }, globalDbPath())[0]
    expect(bazSym).toBeDefined()
    const hits: SearchHit[] = [
      { filePath: fixtureFile, startLine: bazSym!.lineStart, endLine: bazSym!.lineEnd, kind: 'window', distance: 0.1, text: 'return 2' },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('baz', { json: true, projectRoot: TMP })
    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: Array<{ name: unknown; kind: unknown }> }
    expect(payload.items[0]?.name).toBe('baz')
    expect(payload.items[0]?.kind).toBe('function')
  })

  it('resolves innermost-wins: a hit inside method bar resolves to bar, not class Foo', async () => {
    const barSym = querySymbols({ filePath: fixtureFile, name: 'bar' }, globalDbPath())[0]
    expect(barSym).toBeDefined()
    const hits: SearchHit[] = [
      { filePath: fixtureFile, startLine: barSym!.lineStart, endLine: barSym!.lineEnd, kind: 'window', distance: 0.1, text: 'return helper(1)' },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('bar', { json: true, projectRoot: TMP })
    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: Array<{ name: unknown; kind: unknown }> }
    expect(payload.items[0]?.name).toBe('bar')
    expect(payload.items[0]?.kind).toBe('method')
  })

  it('reports name:null, kind:null for a top-of-file hit (import line, before any symbol) -- NOT the symbol below it', async () => {
    // Line 1 is the import statement, strictly above every symbol's line_start in the fixture.
    // A "nearest symbol by start line" shortcut would wrongly attribute this to Foo or baz;
    // the correct containment check must report null here.
    const hits: SearchHit[] = [
      { filePath: fixtureFile, startLine: 1, endLine: 1, kind: 'window', distance: 0.2, text: "import { helper } from './helper.js'" },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('import helper', { json: true, projectRoot: TMP })
    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: Array<{ name: unknown; kind: unknown }> }
    expect(payload.items[0]?.name).toBeNull()
    expect(payload.items[0]?.kind).toBeNull()

    const textResult = await runSemantic('import helper', { json: false, projectRoot: TMP })
    expect(textResult.text).not.toContain('— inside')
  })
})
