/** Unit coverage for src/note_anchor.ts, and the label project_memory.ts renders from its result: whether an anchored project note's symbol still has the body it had when the note was set. Fixtures are HAND-DERIVED: symbol rows are inserted directly into a throwaway DB (the notes.test.ts convention), keyed by the same resolveIndexPath() form the indexer writes, and each expected status follows from the rows inserted, not from the code under test. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { anchorStatus } from '../src/note_anchor.js'
import { resolveIndexPath } from '../src/paths.js'
import { anchorLabel } from '../src/project_memory.js'
import { clearModuleCaches } from '../src/reset.js'

const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-anchor-'))
  tmpDirs.push(dir)
  return dir
}

function seedSymbol(dbPath: string, filePath: string, name: string, body: string): void {
  getDb(dbPath)
    .prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(filePath, name, 'function', 1, 1, body, '')
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir === undefined) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; WAL sidecars may briefly linger on Windows
    }
  }
})

describe('anchorStatus', () => {
  const body = 'function login() { return 1 }'

  function fixture(): { root: string; dbPath: string; key: string } {
    const root = tmpDir()
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'auth.ts'), body + '\n')
    return { root, dbPath: path.join(tmpDir(), 'global.db'), key: resolveIndexPath('src/auth.ts', root) }
  }

  it('is current while the indexed body still hashes to the recorded sha', () => {
    const { root, dbPath, key } = fixture()
    seedSymbol(dbPath, key, 'login', body)
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, dbPath)).toBe('current')
  })

  it('is changed once the indexed body hashes to anything else', () => {
    const { root, dbPath, key } = fixture()
    seedSymbol(dbPath, key, 'login', 'function login() { return 2 }')
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, dbPath)).toBe('changed')
  })

  it('is gone when the file still has indexed symbols but not this one', () => {
    const { root, dbPath, key } = fixture()
    seedSymbol(dbPath, key, 'logout', 'function logout() {}')
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, dbPath)).toBe('gone')
  })

  it('is gone when the anchored file no longer exists', () => {
    const { root, dbPath, key } = fixture()
    seedSymbol(dbPath, key, 'login', body)
    fs.rmSync(path.join(root, 'src', 'auth.ts'))
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, dbPath)).toBe('gone')
  })

  it('is unknown, not gone, when the index has no rows for the file at all', () => {
    const { root, dbPath } = fixture()
    seedSymbol(dbPath, resolveIndexPath('src/other.ts', root), 'login', body)
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, dbPath)).toBe('unknown')
  })

  it('is unknown when the index cannot be opened', () => {
    const { root } = fixture()
    // A directory where the DB file should be: opening it throws.
    expect(anchorStatus(root, { file: 'src/auth.ts', symbol: 'login', sha: fingerprintContent(body) }, tmpDir())).toBe('unknown')
  })
})

describe('anchorLabel', () => {
  it('marks changed and gone, and says nothing otherwise', () => {
    expect(anchorLabel('changed')).toBe(' (changed since note)')
    expect(anchorLabel('gone')).toBe(' (anchored symbol gone)')
    expect(anchorLabel('current')).toBe('')
    expect(anchorLabel('unknown')).toBe('')
  })
})
