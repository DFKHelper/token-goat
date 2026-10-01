/**
 * `sqlite-schema`, `sqlite-tables` and `describe` against a database holding a sqlite-vec `vec0` virtual table, the shape of token-goat's own index DBs. The CLI never loads sqlite-vec for a read, so asking SQLite about the virtual table's columns fails with "no such module: vec0"; one such table used to abort the whole listing and hide every ordinary table beside it.
 *
 * Provenance: the vec0 DDL is FORMAT-DERIVED (sqlite-vec README, `CREATE VIRTUAL TABLE vec_examples USING vec0(sample_embedding float[8])`); the error text `no such module: vec0` is CAPTURE (stderr of the pre-fix bundle against this fixture); the notes row is HAND-DERIVED.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import Database from '../src/sqlite_driver.js'

const require = createRequire(import.meta.url)

let dir: string
let dbPath: string
let vecLoaded = false

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vec-schema-'))
  dbPath = path.join(dir, 'vec_fixture.db')
  const db = new Database(dbPath)
  try {
    try {
      ;(require('sqlite-vec') as { load: (d: unknown) => void }).load(db)
      vecLoaded = true
    } catch {
      return
    }
    db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)')
    db.exec('CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[4])')
    db.exec("INSERT INTO notes(body) VALUES ('hello')")
  } finally {
    db.close()
  }
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env, TOKEN_GOAT_HOME: home, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, XDG_DATA_HOME: home }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd: dir })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('a sqlite-vec virtual table does not abort schema discovery', () => {
  it('sqlite-schema lists the ordinary table and labels the virtual one', (ctx) => {
    if (!vecLoaded) return ctx.skip()
    const r = run(['sqlite-schema', dbPath])
    expect(r.stderr).not.toContain('no such module')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/notes {2}\(table, 1 row\)/)
    expect(r.stdout).toMatch(/\n {2}id INTEGER {2}PK/)
    expect(r.stdout).toMatch(/\n {2}body TEXT/)
    expect(r.stdout).toContain('chunk_vectors  (virtual table: vec0; module not loaded)')
    expect(r.stdout).toContain('CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[4])')
  })

  it('sqlite-schema --json marks the virtual table and keeps the ordinary one', (ctx) => {
    if (!vecLoaded) return ctx.skip()
    const r = run(['sqlite-schema', dbPath, '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tables: Array<{ name: string; kind: string; module?: string; rowCount: number | null; columns: Array<{ name: string }> }> }
    const notes = parsed.tables.find((t) => t.name === 'notes')
    const vec = parsed.tables.find((t) => t.name === 'chunk_vectors')
    expect(notes?.columns.map((c) => c.name)).toEqual(['id', 'body'])
    expect(vec?.kind).toBe('virtual')
    expect(vec?.module).toBe('vec0')
    expect(vec?.rowCount).toBeNull()
  })

  it('sqlite-tables lists both and does not count the virtual table', (ctx) => {
    if (!vecLoaded) return ctx.skip()
    const r = run(['sqlite-tables', dbPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('notes  (table, 1 row, 2 cols)')
    expect(r.stdout).toContain('chunk_vectors  (virtual table: vec0)')
  })

  it('describe takes the same path and exits 0', (ctx) => {
    if (!vecLoaded) return ctx.skip()
    const r = run(['describe', dbPath])
    expect(r.stdout).not.toContain('no such module')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/\n {2}body TEXT/)
    expect(r.stdout).toContain('chunk_vectors  (virtual table: vec0; module not loaded)')
  })

  it('describe <db> <virtual table> prints the CREATE statement instead of erroring', (ctx) => {
    if (!vecLoaded) return ctx.skip()
    const r = run(['describe', dbPath, 'chunk_vectors'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[4])')
  })
})
