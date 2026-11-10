import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../src/db.js'
import { queryFileSymbolsWithIds } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import type { SymbolEntry } from '../src/parser_types.js'
import {
  clearOutlineListingCache,
  getOutlineListingCache,
  setOutlineListingCache,
  type OutlineListingCacheValue,
} from '../src/read_outline_cache.js'

function listing(
  name: string,
  body = 'export function run() {}',
  filePath = `${name}.ts`,
  symbolIds: number[] = [],
): OutlineListingCacheValue {
  const symbol: SymbolEntry = {
    filePath,
    name,
    kind: 'function',
    lineStart: 1,
    lineEnd: 1,
    body,
    docstring: '',
    parent: '',
  }
  return {
    resolved: `${name}.ts`,
    displayRoot: undefined,
    filtered: [symbol],
    symbolIds,
    preFilterCount: 1,
    refCounts: undefined,
    fullSourceBytes: body.length,
    symbolsTruncated: false,
    trueSymbolCount: undefined,
    totalLines: 1,
  }
}

let tempDir: string
let dbPath: string
let sourcePath: string
let indexedFilePath: string
let indexedSymbolId: number

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tg-outline-cache-'))
  dbPath = join(tempDir, 'global.db')
  getDb(dbPath)
  sourcePath = join(tempDir, 'source.ts')
  writeFileSync(sourcePath, 'export function run() { return 1 }\n')
  indexFileSync(sourcePath, dbPath)
  const indexed = queryFileSymbolsWithIds({ filePath: sourcePath }, dbPath)
  const first = indexed[0]
  if (first === undefined) throw new Error('outline cache test source produced no indexed symbols')
  indexedFilePath = first.symbol.filePath
  indexedSymbolId = first.id
})

beforeEach(() => {
  clearOutlineListingCache()
  getDb(dbPath).exec('DELETE FROM outline_listing_cache')
})

afterAll(() => {
  try {
    closeDb(dbPath)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('outline listing cache', () => {
  it('returns copies so callers cannot mutate the cached listing', () => {
    setOutlineListingCache('source-a', listing('run'), { dbPath })

    const first = getOutlineListingCache('source-a')
    const second = getOutlineListingCache('source-a')

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first?.filtered).not.toBe(second?.filtered)
    first?.filtered.pop()
    expect(getOutlineListingCache('source-a')?.filtered).toHaveLength(1)
  })

  it('evicts the least recently used entry when its fixed entry budget is exceeded', () => {
    for (let i = 0; i < 16; i++) setOutlineListingCache(`source-${i}`, listing(`name-${i}`), { dbPath })
    getOutlineListingCache('source-0')
    setOutlineListingCache('source-16', listing('name-16'), { dbPath })

    expect(getOutlineListingCache('source-0')).toBeDefined()
    expect(getOutlineListingCache('source-1')).toBeUndefined()
    expect(getOutlineListingCache('source-16')).toBeDefined()
  })

  it('reloads a redacted, path-free listing from SQLite after the process-local cache clears', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const secret = `ghp_${Array.from(randomBytes(36), (byte) => alphabet.charAt(byte % alphabet.length)).join('')}`
    const ids = [indexedSymbolId]
    const context = { dbPath, resolved: sourcePath, filePath: indexedFilePath, displayRoot: undefined }
    const value = listing('run', secret, 'Legacy.ts', ids)
    value.resolved = sourcePath
    setOutlineListingCache('source-a', value, { dbPath })
    expect(getOutlineListingCache('source-a', context)?.filtered[0]?.filePath).toBe(indexedFilePath)
    clearOutlineListingCache()

    const persisted = JSON.stringify(getDb(dbPath).prepare('SELECT payload FROM outline_listing_cache').all())
    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain(sourcePath)
    expect(persisted).not.toContain(indexedFilePath)
    expect(persisted).not.toContain('Legacy.ts')

    const cached = getOutlineListingCache('source-a', context)
    expect(cached?.resolved).toBe(sourcePath)
    expect(cached?.filtered[0]?.filePath).toBe(indexedFilePath)
    expect(cached?.filtered[0]?.body).not.toContain(secret)
  })

  it('keeps the persistent listing cache within its fixed entry cap', () => {
    for (let i = 0; i < 8; i++) setOutlineListingCache(`persistent-${i}`, listing(`name-${i}`), { dbPath })

    expect(getDb(dbPath).prepare('SELECT payload FROM outline_listing_cache').all()).toHaveLength(5)
  })

  it('does not retain an individual listing that exceeds the byte budget', () => {
    setOutlineListingCache('large', listing('large', 'x'.repeat(60_000)), { dbPath })

    expect(getOutlineListingCache('large')).toBeUndefined()
  })
})
