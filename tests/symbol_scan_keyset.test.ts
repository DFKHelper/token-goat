/** The keyset walk in src/symbol_scan.ts rebuilds `querySymbols`'s filters itself, because the builder it would share lives in src/index_reader.ts, which is hashed into EMBED_FINGERPRINT. It also visits rows in the file-path index's order rather than the query's `file_path, line_start, rowid`, and hands callers FirstRows to restore that order. Both are copies of behaviour defined elsewhere, and a copy drifts silently: a filter spelled differently here would make `find` or `symbol --grep` answer from a different set of rows than `symbol NAME` does. These tests hold the walk to `querySymbols` itself, row for row, for every filter its callers pass, on paths chosen to separate the two orders: mixed case (the folded order and the byte order disagree), a stored backslash path, a sibling project whose name extends this one's, a file whose rows cross a page boundary with line numbers running against rowid order, and two non-ASCII names whose UTF-16 and UTF-8 orders disagree. Fixture provenance: HAND-DERIVED. Every row is generated below, and every expectation is `querySymbols`'s own answer on the same database, so nothing here restates the walk's SQL. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { runFind } from '../src/read_inspect.js'
import { runSymbol } from '../src/read_symbol.js'
import { compareBinary, FirstRows, forEachSymbol, type SymbolHead, type SymbolScanScope } from '../src/symbol_scan.js'

/** Rows in the one large file: past a 10,000-row page, so that file's rows straddle a page boundary. */
const BIG_FILE_ROWS = 10_500

let root: string
let other: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function capture(fn: () => number): string {
  let stdout = ''
  const orig = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  ;(process.stderr as any).write = () => true
  try {
    fn()
  } finally {
    ;(process.stdout as any).write = orig
    ;(process.stderr as any).write = origErr
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return stdout
}

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scan-keyset-')))
  other = `${root}-other`
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  const db = getDb(globalDbPath())
  const insert = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const add = (file: string, name: string, kind: string, line: number): void => void insert.run(file, name, kind, line, line + 1, `body of ${name}`, '')
  db.transaction(() => {
    // `Big.ts` sorts before `aaa.ts` by bytes (B is 0x42, a is 0x61) and after it folded; its lines run backwards against rowid.
    for (let i = 0; i < BIG_FILE_ROWS; i++) add(`${root}/Big.ts`, `big${i}`, i % 2 === 0 ? 'function' : 'class', BIG_FILE_ROWS - i)
    // Two rows on one line, so the rowid tie-break decides their order.
    add(`${root}/Big.ts`, 'sharedLine', 'function', 7)
    for (let i = 0; i < 40; i++) add(`${root}/aaa_${String(i).padStart(2, '0')}.ts`, i % 5 === 0 ? 'dupName' : `aaa${i}`, i % 3 === 0 ? 'class' : 'function', i + 1)
    // U+FF5E is one UTF-16 unit above the surrogates; the emoji is a surrogate pair. By UTF-8 bytes, which is SQLite's order, the tilde file sorts first; by UTF-16 units the emoji would.
    add(`${root}/\u{1F600}.ts`, 'dupName', 'function', 1)
    add(`${root}/～.ts`, 'dupName', 'function', 1)
    add(`${root}/sub/win.ts`, 'winForward', 'function', 1)
    add(`${root.replace(/\//g, '\\')}\\sub\\win.ts`, 'winBackslash', 'function', 2)
    add(`${other}/sibling.ts`, 'dupName', 'function', 1)
  })()
})

afterEach(() => {
  cwdSpy.mockRestore()
  getDb(globalDbPath()).exec('DELETE FROM symbols')
  fs.rmSync(root, { recursive: true, force: true })
})

const rowKey = (s: { filePath: string; name: string; kind: string; lineStart: number }): string => `${s.filePath}|${s.lineStart}|${s.name}|${s.kind}`

function scan(scope: SymbolScanScope): SymbolHead[] {
  const rows: SymbolHead[] = []
  forEachSymbol(scope, (s) => rows.push(s))
  return rows
}

describe('keyset walk against querySymbols', () => {
  const scopes = (): Array<[string, SymbolScanScope]> => [
    ['project', { rootDir: root }],
    ['project and kind', { rootDir: root, kind: 'class' }],
    ['project and name', { rootDir: root, name: 'dupName' }],
    ['one file across a page boundary', { filePath: `${root}/Big.ts` }],
    ['one file stored with either separator', { filePath: `${root}/sub/win.ts` }],
    ['name across every project', { name: 'dupName' }],
    ['every row', {}],
  ]

  it('visits exactly the rows querySymbols matches, each once, for every filter', () => {
    for (const [label, scope] of scopes()) {
      const rows = scan(scope)
      const expected = querySymbols({ ...scope, limit: -1 })
      expect(expected.length, label).toBeGreaterThan(0)
      expect(new Set(rows.map((r) => r.id)).size, label).toBe(rows.length)
      expect(rows.map(rowKey).sort(), label).toEqual(expected.map(rowKey).sort())
    }
  })

  it('FirstRows keeps the rows querySymbols returns under the same LIMIT, in the same order', () => {
    for (const [label, scope] of scopes()) {
      const rows = scan(scope)
      for (const cap of [1, 3, 41, 10_001]) {
        const first = new FirstRows<SymbolHead>(cap)
        for (const r of rows) first.offer(r)
        expect(first.rows().map(rowKey), `${label}, first ${cap}`).toEqual(querySymbols({ ...scope, limit: cap }).map(rowKey))
      }
    }
  })

  it('compareBinary orders paths as SQLite does, including where UTF-16 and UTF-8 order disagree', () => {
    const paths = querySymbols({ rootDir: root, limit: -1 }).map((s) => s.filePath)
    const distinct = [...new Set(paths)]
    expect([...distinct].sort(compareBinary)).toEqual(distinct)
    // The case the helper exists for: the tilde file first, which plain `<` gets backwards.
    expect(distinct.indexOf(`${root}/～.ts`)).toBeLessThan(distinct.indexOf(`${root}/\u{1F600}.ts`))
    expect(`${root}/\u{1F600}.ts` < `${root}/～.ts`).toBe(true)
  })
})

describe('callers keep the query order', () => {
  it('find lists matching files in index path order', () => {
    const payload = JSON.parse(capture(() => runFind({ pattern: 'dupName', json: true }))) as { files: string[] }
    const expected = [...new Set(querySymbols({ rootDir: root, name: 'dupName', limit: -1 }).map((s) => s.filePath))]
    expect(payload.files).toEqual(expected)
  })

  it('symbol --grep prints the first rows by file, line and rowid, with their bodies', () => {
    const r = runSymbol({ grep: '^(big1|sharedLine)$', projectRoot: root, json: true, limit: 2 })
    const payload = JSON.parse(r.text) as { items: Array<{ name: string; body?: string; lineStart: number }>; totalCount: number }
    // HAND-DERIVED: big1 is on line 10,499 and sharedLine on line 7 of Big.ts, the only file either name is in, so sharedLine comes first.
    expect(payload.items.map((s) => s.name)).toEqual(['sharedLine', 'big1'])
    expect(payload.totalCount).toBe(2)
    expect(JSON.stringify(payload.items)).toContain('body of sharedLine')
  })
})
