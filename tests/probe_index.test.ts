/** withProbeIndex, the read-only opener behind the pre-read hooks' index probe. It must answer null rather than throw for every index it cannot use, and it must still read an index in a directory this process may not write. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, getDb, SCHEMA_VERSION, withProbeIndex } from '../src/db.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { allowWrites, denyWrites } from './helpers/seal-directory.js'

let base: string

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-probe-'))
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

/** A fresh index at the current schema version, closed so its -wal and -shm are gone. */
function makeIndex(name: string): string {
  const dbPath = path.join(base, `${name}.db`)
  getDb(dbPath)
  closeDb(dbPath)
  return dbPath
}

/** Rewrite an index's stored schema version, which is all the probe's version gate reads. */
function stampVersion(dbPath: string, version: number): void {
  const conn = getDb(dbPath)
  conn.pragma(`user_version = ${version}`)
  closeDb(dbPath)
}

describe('withProbeIndex', () => {
  it('runs the callback against an index at this build’s schema version', () => {
    const dbPath = makeIndex('current')
    expect(withProbeIndex((db) => Number(db.pragma('user_version', { simple: true })), dbPath)).toBe(SCHEMA_VERSION)
  })

  it('is null when there is no index', () => {
    expect(withProbeIndex(() => 'ran', path.join(base, 'absent.db'))).toBeNull()
  })

  it('is null for a file that is not a database', () => {
    const dbPath = path.join(base, 'corrupt.db')
    fs.writeFileSync(dbPath, 'this is not a sqlite database, and is long enough to be read as a bad header '.repeat(8))
    expect(withProbeIndex(() => 'ran', dbPath)).toBeNull()
  })

  it('is null, not a throw, when the callback throws', () => {
    const dbPath = makeIndex('throwing')
    expect(
      withProbeIndex(() => {
        throw new Error('boom')
      }, dbPath),
    ).toBeNull()
  })

  it.each([
    ['an older', SCHEMA_VERSION - 1],
    ['a newer', SCHEMA_VERSION + 1],
  ])('is null for an index with %s schema version, without running the callback', (_label, version) => {
    const dbPath = makeIndex(`version-${version}`)
    stampVersion(dbPath, version)
    let ran = false
    expect(
      withProbeIndex(() => {
        ran = true
        return 'ran'
      }, dbPath),
    ).toBeNull()
    expect(ran).toBe(false)
  })

  // The probe used to open the index plainly, which fails on a data directory that is write-denied and has no -wal/-shm beside the database, so the first-read policy silently never fired there. HAND-DERIVED: the module below is written for this test and the assertion names its symbol.
  it('still answers on an index in a directory this process may not write', ({ skip }) => {
    const home = path.join(base, 'denied')
    const project = path.join(home, 'proj')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'widget.ts'), 'export function widgetLabel(name: string): string {\n  return name\n}\n')
    const env = tgIsolatedEnv(home, { TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' })
    const indexed = runBundle(['index', '.', '--walk'], { cwd: project, env, timeout: 120_000 })
    expect(indexed.status, indexed.stderr).toBe(0)
    const dbPath = findGlobalDb(home)
    if (dbPath === null) throw new Error(`no global.db under ${home}`)
    const dataDir = path.dirname(dbPath)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    if (!denyWrites(dataDir)) {
      skip('this runner can still write a directory denied to it, so the index cannot be made unwritable here')
      return
    }
    try {
      expect(withProbeIndex((db) => (db.prepare('SELECT count(*) AS n FROM symbols WHERE name = ?').get('widgetLabel') as { n: number }).n, dbPath)).toBe(1)
    } finally {
      allowWrites(dataDir)
    }
  })
})
