/**
 * Unit coverage for src/notes.ts -- the pure DB-layer for the `notes` table (schema in db.ts).
 * Mirrors index_reader.test.ts's convention: a fresh throwaway DB per test, symbol rows
 * inserted directly via raw SQL (no parser/tree-sitter involvement -- that's parser.test.ts's
 * job), and every notes.ts function exercised against it directly.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { clearModuleCaches } from '../src/reset.js'
import {
  WHOLE_FILE_NOTE_SYMBOL,
  computeFileFingerprint,
  computeSymbolFingerprint,
  getNote,
  isNoteStale,
  listNotes,
  resolveSymbolMatch,
  symbolNamesInFile,
  upsertNote,
} from '../src/notes.js'

const tmpDirs: string[] = []

function tmpDbPath(name = 'index.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-notes-'))
  tmpDirs.push(dir)
  return path.join(dir, name)
}

function seedSymbol(
  dbPath: string,
  filePath: string,
  name: string,
  kind: string,
  lineStart: number,
  lineEnd: number,
  body: string,
): void {
  getDb(dbPath)
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(filePath, name, kind, lineStart, lineEnd, body, '')
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

describe('resolveSymbolMatch / symbolNamesInFile', () => {
  it('resolves a uniquely-named symbol', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 20, 'function login() {}')
    const match = resolveSymbolMatch('a.ts', 'login', dbPath)
    expect(match?.name).toBe('login')
    expect(match?.lineStart).toBe(10)
  })

  it('returns null for a symbol name that is not indexed in that file', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 20, 'function login() {}')
    expect(resolveSymbolMatch('a.ts', 'logout', dbPath)).toBeNull()
    expect(resolveSymbolMatch('b.ts', 'login', dbPath)).toBeNull()
  })

  it('picks the earliest-starting-line match when a name is duplicated in one file (e.g. overloads)', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'run', 'function', 40, 45, 'function run(x: number) {}')
    seedSymbol(dbPath, 'a.ts', 'run', 'function', 5, 10, 'function run(x: string) {}')
    const match = resolveSymbolMatch('a.ts', 'run', dbPath)
    expect(match?.lineStart).toBe(5)
    expect(match?.body).toBe('function run(x: string) {}')
  })

  it('symbolNamesInFile returns distinct sorted names scoped to the file', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'zeta', 'function', 1, 2, '')
    seedSymbol(dbPath, 'a.ts', 'alpha', 'function', 3, 4, '')
    seedSymbol(dbPath, 'a.ts', 'alpha', 'function', 5, 6, '') // duplicate name, same file
    seedSymbol(dbPath, 'b.ts', 'other', 'function', 1, 2, '')
    expect(symbolNamesInFile('a.ts', dbPath)).toEqual(['alpha', 'zeta'])
  })
})

describe('computeFileFingerprint / computeSymbolFingerprint', () => {
  it('computeSymbolFingerprint hashes the resolved symbol body and is null when the symbol is absent', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 20, 'function login() {}')
    expect(computeSymbolFingerprint('a.ts', 'login', dbPath)).toBe(fingerprintContent('function login() {}'))
    expect(computeSymbolFingerprint('a.ts', 'missing', dbPath)).toBeNull()
  })

  it('computeFileFingerprint changes when a symbol is added, removed, or moved, but not when body text alone changes', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'foo', 'function', 1, 5, 'function foo() { return 1 }')
    const fp1 = computeFileFingerprint('a.ts', dbPath)

    // Same manifest (name/kind/line-range), different body text -> file fingerprint unchanged.
    // This is deliberate: the file-level fingerprint tracks symbol *shape*, not body content --
    // a whole-file note's staleness anchor is "did the symbol set shift", not "did any single
    // symbol's implementation change" (that finer-grained signal is what a --symbol note gets).
    getDb(dbPath).prepare('DELETE FROM symbols WHERE name = ?').run('foo')
    seedSymbol(dbPath, 'a.ts', 'foo', 'function', 1, 5, 'function foo() { return 2 }')
    expect(computeFileFingerprint('a.ts', dbPath)).toBe(fp1)

    // A genuinely new symbol changes the manifest -> fingerprint changes.
    seedSymbol(dbPath, 'a.ts', 'bar', 'function', 6, 8, 'function bar() {}')
    expect(computeFileFingerprint('a.ts', dbPath)).not.toBe(fp1)
  })

  it('computeFileFingerprint is deterministic regardless of insertion order', () => {
    const dbPathA = tmpDbPath()
    seedSymbol(dbPathA, 'a.ts', 'foo', 'function', 1, 2, '')
    seedSymbol(dbPathA, 'a.ts', 'bar', 'function', 3, 4, '')

    const dbPathB = tmpDbPath()
    seedSymbol(dbPathB, 'a.ts', 'bar', 'function', 3, 4, '')
    seedSymbol(dbPathB, 'a.ts', 'foo', 'function', 1, 2, '')

    expect(computeFileFingerprint('a.ts', dbPathA)).toBe(computeFileFingerprint('a.ts', dbPathB))
  })
})

describe('upsertNote / getNote / listNotes', () => {
  it('round-trips a whole-file note', () => {
    const dbPath = tmpDbPath()
    upsertNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, 'Rationale for this module.', 'fp-1', dbPath)
    const note = getNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, dbPath)
    expect(note).not.toBeNull()
    expect(note?.filePath).toBe('a.ts')
    expect(note?.symbol).toBe('')
    expect(note?.content).toBe('Rationale for this module.')
    expect(note?.fingerprint).toBe('fp-1')
  })

  it('round-trips a symbol-attached note independently of the whole-file note for the same file', () => {
    const dbPath = tmpDbPath()
    upsertNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, 'file-level note', 'fp-file', dbPath)
    upsertNote('a.ts', 'login', 'symbol-level note', 'fp-sym', dbPath)

    expect(getNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, dbPath)?.content).toBe('file-level note')
    expect(getNote('a.ts', 'login', dbPath)?.content).toBe('symbol-level note')
  })

  it('upserting the same (file, symbol) pair again overwrites rather than duplicates', () => {
    const dbPath = tmpDbPath()
    upsertNote('a.ts', 'login', 'first draft', 'fp-1', dbPath)
    upsertNote('a.ts', 'login', 'revised draft', 'fp-2', dbPath)

    const all = listNotes(dbPath)
    expect(all).toHaveLength(1)
    expect(all[0]?.content).toBe('revised draft')
    expect(all[0]?.fingerprint).toBe('fp-2')
  })

  it('getNote returns null when no note exists for that attachment point', () => {
    const dbPath = tmpDbPath()
    expect(getNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, dbPath)).toBeNull()
  })

  it('listNotes orders by file then symbol', () => {
    const dbPath = tmpDbPath()
    upsertNote('b.ts', WHOLE_FILE_NOTE_SYMBOL, 'b whole', 'fp', dbPath)
    upsertNote('a.ts', 'zeta', 'a zeta', 'fp', dbPath)
    upsertNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, 'a whole', 'fp', dbPath)

    const rows = listNotes(dbPath).map((n) => `${n.filePath}::${n.symbol}`)
    expect(rows).toEqual(['a.ts::', 'a.ts::zeta', 'b.ts::'])
  })
})

describe('isNoteStale', () => {
  it('a whole-file note is fresh when the symbol manifest is unchanged, and stale after a symbol is added', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'foo', 'function', 1, 5, 'function foo() {}')
    const fp = computeFileFingerprint('a.ts', dbPath)
    upsertNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, 'module rationale', fp, dbPath)

    const note = getNote('a.ts', WHOLE_FILE_NOTE_SYMBOL, dbPath)!
    expect(isNoteStale(note, dbPath)).toBe(false)

    seedSymbol(dbPath, 'a.ts', 'bar', 'function', 6, 8, 'function bar() {}')
    expect(isNoteStale(note, dbPath)).toBe(true)
  })

  it('a symbol note is fresh when the body is unchanged, and stale after the body changes', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 20, 'function login() { return 1 }')
    const fp = computeSymbolFingerprint('a.ts', 'login', dbPath)!
    upsertNote('a.ts', 'login', 'why login works this way', fp, dbPath)

    const note = getNote('a.ts', 'login', dbPath)!
    expect(isNoteStale(note, dbPath)).toBe(false)

    getDb(dbPath).prepare('DELETE FROM symbols WHERE name = ?').run('login')
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 22, 'function login() { return 2 }')
    expect(isNoteStale(note, dbPath)).toBe(true)
  })

  it('a symbol note is unconditionally stale once the symbol itself is removed/renamed', () => {
    const dbPath = tmpDbPath()
    seedSymbol(dbPath, 'a.ts', 'login', 'function', 10, 20, 'function login() {}')
    const fp = computeSymbolFingerprint('a.ts', 'login', dbPath)!
    upsertNote('a.ts', 'login', 'note', fp, dbPath)
    const note = getNote('a.ts', 'login', dbPath)!

    getDb(dbPath).prepare('DELETE FROM symbols WHERE name = ?').run('login')
    expect(isNoteStale(note, dbPath)).toBe(true)
  })
})
