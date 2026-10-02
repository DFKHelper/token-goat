// Provenance: HAND-DERIVED. Inputs are the two spellings of one path a case-insensitive volume treats as the same file (`Src/A.ts`, `src/a.ts`); the case-insensitive branch is forced with TOKEN_GOAT_CASE_INSENSITIVE_FS (read off src/path_containment.ts::isCaseInsensitiveFs) so the test does not depend on the host platform. Every database lives in an os.tmpdir() directory; the real notes store is never opened.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { getNote, upsertNote } from '../src/notes.js'
import { clearModuleCaches } from '../src/reset.js'

const tmpDirs: string[] = []
let savedFlag: string | undefined

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-notes-fold-'))
  tmpDirs.push(dir)
  return path.join(dir, 'index.db')
}

function noteRows(dbPath: string): Array<{ file_path: string; content: string }> {
  return getDb(dbPath).prepare('SELECT file_path, content FROM notes ORDER BY id').all() as Array<{ file_path: string; content: string }>
}

beforeEach(() => {
  savedFlag = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
  else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = savedFlag
  clearModuleCaches()
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('upsertNote on a case-insensitive volume', () => {
  it('updates the existing note when the path differs only in case, instead of adding a second row', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const dbPath = tmpDbPath()

    upsertNote('Src/A.ts', 'run', 'first', 'fp1', dbPath)
    upsertNote('src/a.ts', 'run', 'second', 'fp2', dbPath)

    expect(noteRows(dbPath)).toEqual([{ file_path: 'Src/A.ts', content: 'second' }])
    expect(getNote('SRC/A.TS', 'run', dbPath)?.content).toBe('second')
  })

  it('keeps notes for different symbols or different files apart', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const dbPath = tmpDbPath()

    upsertNote('Src/A.ts', 'run', 'a-run', 'fp', dbPath)
    upsertNote('src/a.ts', 'stop', 'a-stop', 'fp', dbPath)
    upsertNote('src/b.ts', 'run', 'b-run', 'fp', dbPath)

    expect(noteRows(dbPath).map((r) => r.content)).toEqual(['a-run', 'a-stop', 'b-run'])
  })

  it('refreshes every row of a store that already holds case-variant duplicates, so getNote cannot return a stale one', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const dbPath = tmpDbPath()
    const insert = getDb(dbPath).prepare('INSERT INTO notes (file_path, symbol, content, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
    insert.run('Src/A.ts', 'run', 'stale-1', 'old')
    insert.run('src/a.ts', 'run', 'stale-2', 'old')

    upsertNote('SRC/A.TS', 'run', 'fresh', 'new', dbPath)

    expect(noteRows(dbPath).map((r) => r.content)).toEqual(['fresh', 'fresh'])
    expect(getNote('src/a.ts', 'run', dbPath)?.content).toBe('fresh')
  })
})

describe('upsertNote on a case-sensitive volume', () => {
  it('still treats paths that differ in case as different files', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '0'
    const dbPath = tmpDbPath()

    upsertNote('Src/A.ts', 'run', 'upper', 'fp', dbPath)
    upsertNote('src/a.ts', 'run', 'lower', 'fp', dbPath)
    upsertNote('src/a.ts', 'run', 'lower-2', 'fp', dbPath)

    expect(noteRows(dbPath)).toEqual([
      { file_path: 'Src/A.ts', content: 'upper' },
      { file_path: 'src/a.ts', content: 'lower-2' },
    ])
  })
})
