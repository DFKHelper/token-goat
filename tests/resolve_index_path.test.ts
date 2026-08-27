/**
 * Regression coverage for reader path keying.
 *
 * The symbol index keys every row by `normalizePath(absolutePath)`, but the
 * read commands receive paths exactly as the user typed them ("src/worker.ts",
 * "src\\worker.ts", "./src/worker.ts"). The DB lookup is exact equality
 * (`file_path = ?`), so a raw relative or backslash path silently returns
 * nothing. `resolveIndexPath` converts user input to the stored key form before
 * querying. These tests pin both the pure mapping and the real-DB contract: the
 * raw relative path MUST miss (the pre-fix bug) and the resolved key MUST hit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { normalizePath, resolveIndexPath, shellMountToWindowsPath } from '../src/paths.js'
import { indexFileSync } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'
import { closeDb } from '../src/db.js'

describe('resolveIndexPath', () => {
  it('maps a relative path to normalizePath(absolute)', () => {
    const rel = path.join('src', 'worker.ts')
    expect(resolveIndexPath(rel)).toBe(normalizePath(path.resolve(process.cwd(), rel)))
  })

  it('is idempotent: resolving an already-resolved key returns the same key', () => {
    const key = resolveIndexPath(path.join('src', 'worker.ts'))
    expect(resolveIndexPath(key)).toBe(key)
  })

  it('resolves backslash and forward-slash input to the same key', () => {
    const base = process.cwd()
    expect(resolveIndexPath('a\\b\\c.ts', base)).toBe(resolveIndexPath('a/b/c.ts', base))
  })

  it('honors an explicit base directory over process.cwd()', () => {
    const base = path.join(os.tmpdir(), 'tg-base-fixture')
    expect(resolveIndexPath('x.ts', base)).toBe(normalizePath(path.resolve(base, 'x.ts')))
  })
})

describe('index lookup contract: raw relative misses, resolved hits', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-resolve-'))
    dbPath = path.join(dir, 'global.db')
    const sub = path.join(dir, 'src')
    fs.mkdirSync(sub)
    const abs = path.join(sub, 'mod.ts')
    fs.writeFileSync(
      abs,
      'export function alpha(): number {\n  return 1\n}\nexport function beta(): number {\n  return 2\n}\n',
    )
    // Index exactly as the real indexer does: key = normalizePath(absolute).
    indexFileSync(normalizePath(abs), dbPath)
  })

  afterEach(() => {
    closeDb(dbPath)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a raw relative filePath returns nothing (the pre-fix behaviour)', () => {
    expect(querySymbols({ filePath: 'src/mod.ts', limit: 100 }, dbPath)).toHaveLength(0)
  })

  it('resolveIndexPath maps the relative path onto the stored rows', () => {
    const key = resolveIndexPath('src/mod.ts', dir)
    const rows = querySymbols({ filePath: key, limit: 100 }, dbPath)
    expect(rows.length).toBe(2)
    expect(rows.map((s) => s.name)).toEqual(expect.arrayContaining(['alpha', 'beta']))
  })

  it('resolves a Windows-style backslash path to the same stored rows', () => {
    const rows = querySymbols({ filePath: resolveIndexPath('src\\mod.ts', dir), limit: 100 }, dbPath)
    expect(rows.map((s) => s.name)).toEqual(expect.arrayContaining(['alpha', 'beta']))
  })
})

describe('shellMountToWindowsPath', () => {
  it('rewrites a WSL mount path to drive-letter form on every platform', () => {
    expect(shellMountToWindowsPath('/mnt/c/proj/a.ts')).toBe('c:/proj/a.ts')
  })

  it('leaves an ordinary POSIX path alone', () => {
    expect(shellMountToWindowsPath('/usr/local/bin/tool')).toBe('/usr/local/bin/tool')
  })
})

describe.runIf(process.platform === 'win32')('shell mount paths resolve to a real index key (Windows)', () => {
  it('a Git Bash absolute path does not get the current drive grafted onto it', () => {
    expect(resolveIndexPath('/c/proj/a.ts')).toBe('c:/proj/a.ts')
  })

  it('a WSL absolute path does not get the current drive grafted onto it', () => {
    expect(resolveIndexPath('/mnt/c/proj/a.ts')).toBe('c:/proj/a.ts')
  })

  it('a Git Bash cwd as base resolves a relative file onto that drive', () => {
    expect(resolveIndexPath('a.ts', '/c/proj')).toBe('c:/proj/a.ts')
  })
})

describe.runIf(process.platform === 'win32')('index lookup contract: a Git Bash path hits the stored rows', () => {
  let dir: string
  let dbPath: string
  let msysDir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-msys-'))
    dbPath = path.join(dir, 'global.db')
    const sub = path.join(dir, 'src')
    fs.mkdirSync(sub)
    const abs = path.join(sub, 'mod.ts')
    fs.writeFileSync(abs, 'export function alpha(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(abs), dbPath)
    const key = normalizePath(dir)
    msysDir = `/${key[0] as string}${key.slice(2)}`
  })

  afterEach(() => {
    closeDb(dbPath)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a Git Bash absolute path onto the stored rows', () => {
    const key = resolveIndexPath(`${msysDir}/src/mod.ts`)
    expect(key).toBe(normalizePath(path.join(dir, 'src', 'mod.ts')))
    expect(querySymbols({ filePath: key, limit: 100 }, dbPath).map((s) => s.name)).toEqual(['alpha'])
  })

  it('resolves a relative path against a Git Bash base onto the stored rows', () => {
    const key = resolveIndexPath('src/mod.ts', msysDir)
    expect(key).toBe(normalizePath(path.join(dir, 'src', 'mod.ts')))
    expect(querySymbols({ filePath: key, limit: 100 }, dbPath).map((s) => s.name)).toEqual(['alpha'])
  })
})
