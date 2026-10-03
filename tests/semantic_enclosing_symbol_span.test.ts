// A semantic hit's "inside <symbol>" label came from the chunk's start line alone, so a window chunk that opens on the first symbol of a small file and runs on through the next ones (chunkFile folds short ranges together; mergeNearbyHits joins nearby hits) was reported as sitting inside that first symbol. The fixture is indexed for real through indexFileSync and searchSemantic is mocked so each hit's line range is exact, the same split tests/semantic_enclosing_symbol.test.ts uses.
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

const { runSemantic } = await import('../src/read_semantic.js')

// HAND-DERIVED: a class holding two methods, then a top-level function, each line placed by hand so the ranges below are known without reading the indexer.
const FIXTURE_SOURCE = [
  'export class Store {', // 1
  '  load() {', // 2
  '    return 1', // 3
  '  }', // 4
  '', // 5
  '  save() {', // 6
  '    return 2', // 7
  '  }', // 8
  '}', // 9
  '', // 10
  'export function reset() {', // 11
  '  return 3', // 12
  '}', // 13
  '',
].join('\n')

let TMP: string
let fixtureFile: string
let prevEmbedEnv: string | undefined

beforeEach(() => {
  prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-span-'))
  fixtureFile = path.join(TMP, 'store.ts')
  fs.writeFileSync(fixtureFile, FIXTURE_SOURCE, 'utf8')
  indexFileSync(fixtureFile, globalDbPath())
  searchSemanticMock.mockReset()
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
})

async function labelFor(startLine: number, endLine: number, filePath = fixtureFile): Promise<{ name: unknown; kind: unknown }> {
  const hits: SearchHit[] = [{ filePath, startLine, endLine, kind: 'window', distance: 0.1, text: 'return' }]
  searchSemanticMock.mockResolvedValue(hits)
  const { text, code } = await runSemantic('store', { json: true, projectRoot: TMP })
  expect(code).toBe(0)
  const item = (JSON.parse(text) as { items: Array<{ name: unknown; kind: unknown }> }).items[0]
  return { name: item?.name, kind: item?.kind }
}

describe('semantic enclosing symbol for a chunk spanning several symbols', () => {
  it('indexes the fixture at the hand-placed lines (sanity check)', () => {
    const at = (name: string): [number, number] | undefined => {
      const s = querySymbols({ filePath: fixtureFile, name }, globalDbPath())[0]
      return s === undefined ? undefined : [s.lineStart, s.lineEnd]
    }
    expect(at('Store')).toEqual([1, 9])
    expect(at('load')).toEqual([2, 4])
    expect(at('save')).toEqual([6, 8])
    expect(at('reset')).toEqual([11, 13])
  })

  it('names no symbol for a chunk running from the class through the function after it', async () => {
    expect(await labelFor(1, 13)).toEqual({ name: null, kind: null })
  })

  it('names the class, not the first method, for a chunk covering both methods', async () => {
    expect(await labelFor(2, 8)).toEqual({ name: 'Store', kind: 'class' })
  })

  it('names no symbol for a chunk starting in a method and running into the next top-level symbol', async () => {
    expect(await labelFor(6, 12)).toEqual({ name: null, kind: null })
  })

  it('drops the method label when the chunk ends on the opening line of the next method', async () => {
    expect(await labelFor(2, 6)).toEqual({ name: 'Store', kind: 'class' })
  })

  it('keeps the method label when the chunk only adds the blank line chunkFile folds onto it', async () => {
    expect(await labelFor(2, 5)).toEqual({ name: 'load', kind: 'method' })
  })

  it('keeps the label in text output and drops it for the spanning chunk', async () => {
    searchSemanticMock.mockResolvedValue([{ filePath: fixtureFile, startLine: 11, endLine: 13, kind: 'window', distance: 0.1, text: 'return 3' }])
    expect((await runSemantic('reset', { json: false, projectRoot: TMP })).text).toContain('— inside reset (function)')
    searchSemanticMock.mockResolvedValue([{ filePath: fixtureFile, startLine: 1, endLine: 13, kind: 'window', distance: 0.1, text: 'return' }])
    expect((await runSemantic('store', { json: false, projectRoot: TMP })).text).not.toContain('— inside')
  })
})

function indexExtra(name: string, lines: string[]): string {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  indexFileSync(file, globalDbPath())
  return file
}

const spanOf = (file: string, name: string): [number, number] | undefined => {
  const s = querySymbols({ filePath: file, name }, globalDbPath())[0]
  return s === undefined ? undefined : [s.lineStart, s.lineEnd]
}

describe('semantic enclosing symbol when the next symbol starts on the same line', () => {
  // HAND-DERIVED: the second function opens on the line that closes the first, so both ranges hold line 3; a chunk over lines 1-5 covers two whole functions and sits inside neither.
  const PAIR = ['export function first() {', '  return 1', '} export function second() {', '  return 2', '}', '']

  it('indexes the two functions sharing line 3 (sanity check)', () => {
    const file = indexExtra('pair.ts', PAIR)
    expect(spanOf(file, 'first')).toEqual([1, 3])
    expect(spanOf(file, 'second')).toEqual([3, 5])
  })

  it('names no symbol for a chunk covering both functions', async () => {
    expect(await labelFor(1, 5, indexExtra('pair.ts', PAIR))).toEqual({ name: null, kind: null })
  })

  it('names the second function for a chunk starting on the shared line and ending with it', async () => {
    expect(await labelFor(3, 5, indexExtra('pair.ts', PAIR))).toEqual({ name: 'second', kind: 'function' })
  })

  // HAND-DERIVED: lines 1-3 hold all of first but also the opening of second on line 3, the same case as a chunk ending on the next method's opening line above.
  it('names no symbol for a chunk ending on the shared line', async () => {
    expect(await labelFor(1, 3, indexExtra('pair.ts', PAIR))).toEqual({ name: null, kind: null })
  })
})

describe('semantic enclosing symbol when a method opens on its class line', () => {
  // HAND-DERIVED: the method opens on line 1 with the class, so the class is an ancestor starting inside the chunk; it holds the method rather than sitting beside it.
  const SAME = ['export class Box { open() {', '    return 1', '  }', '}', '']

  it('keeps the method label for a chunk that ends with the method', async () => {
    const file = indexExtra('same.ts', SAME)
    expect(spanOf(file, 'Box')).toEqual([1, 4])
    expect(spanOf(file, 'open')).toEqual([1, 3])
    expect(await labelFor(1, 3, file)).toEqual({ name: 'open', kind: 'method' })
  })
})

describe('semantic enclosing symbol when the hit file cannot be read', () => {
  // HAND-DERIVED: with the file gone after indexing, the trailing lines cannot be checked, so the label the index supports is kept rather than dropped on a guess.
  it('keeps the label from the index', async () => {
    const file = indexExtra('gone.ts', ['export function setup() {', '  return 1', '}', '// trailing note', ''])
    fs.rmSync(file)
    expect(await labelFor(1, 4, file)).toEqual({ name: 'setup', kind: 'function' })
  })
})

describe('semantic enclosing symbol when top-level code follows the symbol', () => {
  // HAND-DERIVED: `main()` on line 6 is a top-level call outside setup (lines 1-3); the comment and blank lines between are not code, so only a chunk reaching line 6 leaves the function.
  const RUN = ['export function setup() {', '  return 1', '}', '// trailing note', '', 'main()', '']

  it('names no symbol for a chunk running on into the top-level call', async () => {
    const file = indexExtra('run.ts', RUN)
    expect(spanOf(file, 'setup')).toEqual([1, 3])
    expect(await labelFor(1, 6, file)).toEqual({ name: null, kind: null })
  })

  it('keeps the function label when the chunk adds only the trailing comment and blank line', async () => {
    expect(await labelFor(1, 5, indexExtra('run.ts', RUN))).toEqual({ name: 'setup', kind: 'function' })
  })

  // HAND-DERIVED: a block comment of three lines after the function is still not code; the call on line 8 is.
  it('treats a trailing block comment as not code', async () => {
    const file = indexExtra('block.ts', ['export function setup() {', '  return 1', '}', '/*', '  main()', ' */', '', 'main()', ''])
    expect(await labelFor(1, 7, file)).toEqual({ name: 'setup', kind: 'function' })
    expect(await labelFor(1, 8, file)).toEqual({ name: null, kind: null })
  })

  // HAND-DERIVED: a method followed by a class field (not a symbol) falls back to the class, which still holds the whole chunk.
  it('falls back to the class when code after a method is still inside the class', async () => {
    const file = indexExtra('field.ts', ['export class Box {', '  open() {', '    return 1', '  }', '  size = 2', '}', ''])
    expect(await labelFor(2, 5, file)).toEqual({ name: 'Box', kind: 'class' })
  })
})
