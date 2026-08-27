/**
 * End-to-end regression for the partial-path fallback losing a real match to the query's LIMIT.
 *
 * `token-goat read "worker.ts::drain"` (a filename fragment rather than the full indexed path)
 * misses the exact-path lookup and falls back to a name-only `querySymbols({ name, limit: 50 })`,
 * then filters the rows down to the ones whose path suffix-matches what the user typed. That SQL
 * is `ORDER BY file_path, line_start LIMIT 50`, so for a symbol name with more than 50 definitions
 * across the machine-wide index (`run`, `main`, `handler` all have hundreds) the requested file's
 * row was truncated away before the JS filter ever saw it, and the command reported a symbol that
 * is plainly there as "not found" -- purely because its path sorted late alphabetically.
 *
 * Drives the real, unmocked pipeline: real files on disk, real indexFileSync, real (test-isolated)
 * global.db, real runRead.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { runRead } from '../src/read_commands.js'

// Unique so no other test file's rows share the name and perturb the ordering under test.
const SYMBOL = 'partialPathLimitProbe7x'
const FILE_COUNT = 60

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-partial-limit-'))
  for (let i = 1; i <= FILE_COUNT; i++) {
    const name = `p${String(i).padStart(2, '0')}.ts`
    const file = join(root, name)
    writeFileSync(file, `export function ${SYMBOL}() {\n  return ${i}\n}\n`)
    indexFileSync(file)
  }
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort; WAL sidecars may briefly linger on Windows
  }
})

describe('partial-path fallback survives more same-named definitions than the query limit', () => {
  it('resolves a bare filename whose indexed path sorts past the 50-row query limit', () => {
    // p60.ts is the 60th path in `ORDER BY file_path` among the 60 rows sharing this symbol name,
    // so a limit applied before the path filter drops it.
    const { text, code } = runRead({ spec: `p60.ts::${SYMBOL}` })
    expect(code).toBe(0)
    expect(text).toContain('return 60')
  })

  it('still resolves a bare filename that sorts inside the limit', () => {
    const { text, code } = runRead({ spec: `p05.ts::${SYMBOL}` })
    expect(code).toBe(0)
    expect(text).toContain('return 5')
  })

  it('still refuses a bare filename that only shares a non-boundary suffix', () => {
    // `xp60.ts` is not a path-segment suffix of `<root>/p60.ts`; narrowing the query by final
    // segment must not loosen into a raw endsWith match.
    const { code } = runRead({ spec: `xp60.ts::${SYMBOL}` })
    expect(code).toBe(1)
  })
})

describe('querySymbols fileBaseName narrowing keeps every row the path-suffix filter would accept', () => {
  it('matches a longer indexed path and an indexed path equal to the base name alike', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-basename-'))
    try {
      const dbPath = join(dir, 'index.db')
      const db = getDb(dbPath)
      const stmt = db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      stmt.run('a/b/leaf.ts', 'zz', 'function', 1, 2, 'deep', '')
      stmt.run('leaf.ts', 'zz', 'function', 1, 2, 'bare', '')
      stmt.run('a/b/notleaf.ts', 'zz', 'function', 1, 2, 'other', '')

      const rows = querySymbols({ name: 'zz', fileBaseName: 'leaf.ts', limit: 50 }, dbPath)
      expect(rows.map((r) => r.filePath).sort()).toEqual(['a/b/leaf.ts', 'leaf.ts'])
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort; the open DB handle can hold the directory on Windows
      }
    }
  })
})
