import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { indexFile, isTreeSitterAvailable, parseFile } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parser-'))
})

afterEach(() => {
  // Close cached SQLite handles first; on Windows an open WAL file blocks the
  // recursive rmSync with EPERM.
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

describe('parseFile', () => {
  it('extracts function declarations from a .ts file', async () => {
    const file = write(
      'a.ts',
      'export function foo(x: number): string { return String(x); }\n' +
        'function bar() { return 1; }\n',
    )
    const result = await parseFile(file)
    expect(result.language).toBe('typescript')
    const names = result.symbols.filter((s) => s.kind === 'function').map((s) => s.name)
    expect(names).toContain('foo')
    expect(names).toContain('bar')
  })

  it('extracts class definitions from a .py file', async () => {
    const file = write('b.py', 'class Widget:\n    def render(self):\n        pass\n')
    const result = await parseFile(file)
    expect(result.language).toBe('python')
    const cls = result.symbols.find((s) => s.kind === 'class')
    expect(cls?.name).toBe('Widget')
    // The method inside the class is recorded as a method, not a function.
    const method = result.symbols.find((s) => s.name === 'render')
    expect(method?.kind).toBe('method')
  })

  it('returns empty symbols for an unknown extension', async () => {
    const file = write('notes.unknownext', 'just some text\nnot code at all\n')
    const result = await parseFile(file)
    expect(result.language).toBe('unknown')
    expect(result.symbols).toEqual([])
  })

  it('returns a numeric duration and never throws on a missing file', async () => {
    const result = await parseFile(path.join(TMP, 'does-not-exist.ts'))
    expect(result.symbols).toEqual([])
    expect(typeof result.duration).toBe('number')
  })
})

describe('indexFile', () => {
  it('upserts symbols into the DB so they can be queried back', async () => {
    const file = write('svc.ts', 'export function login(user: string) { return user; }\n')
    const db = path.join(TMP, 'index.db')

    await indexFile(file, db)
    const hits = querySymbols({ name: 'login' }, db)
    expect(hits.length).toBe(1)
    expect(hits[0]?.kind).toBe('function')
    expect(hits[0]?.filePath).toBe(file)
  })

  it('replaces stale rows on re-index rather than duplicating', async () => {
    const file = write('svc.ts', 'export function login() {}\nexport function logout() {}\n')
    const db = path.join(TMP, 'index.db')

    await indexFile(file, db)
    expect(querySymbols({ filePath: file }, db).length).toBe(2)

    // Rewrite the file with fewer symbols, then re-index.
    fs.writeFileSync(file, 'export function login() {}\n')
    await indexFile(file, db)
    const after = querySymbols({ filePath: file }, db)
    expect(after.map((s) => s.name)).toEqual(['login'])
  })
})

describe('isTreeSitterAvailable', () => {
  it('returns a boolean without throwing for every language case', () => {
    expect(typeof isTreeSitterAvailable('typescript')).toBe('boolean')
    expect(typeof isTreeSitterAvailable('python')).toBe('boolean')
    expect(typeof isTreeSitterAvailable('javascript')).toBe('boolean')
    // A language with no bundled grammar is always false.
    expect(isTreeSitterAvailable('rust')).toBe(false)
    expect(isTreeSitterAvailable('unknown')).toBe(false)
  })
})
