/** The stamp-authority gate must keep every freshness decision honest, not only stop two builds from re-marking each other's rows. A non-owner build accepts a foreign non-empty parser stamp as current, but a content change still reparses, an explicit `token-goat index` takes the authority so a same-version rebuild converges, and a failure to read the authority never caches an answer. Provenance: HAND-DERIVED. The fingerprints and versions are written by this file; the expectations (rows rebuilt vs left alone, who owns the stamps) are computed from the rule in src/stamp_authority.ts's header and the review that found each gap, not read back from a matcher. */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { foldDelivery } from '../src/fold_delivery.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import type { SqliteDatabase } from '../src/sqlite_driver.js'
import { claimAuthorityForIndex, claimStampAuthority, compareVersions, holdsStampAuthority, parserStampCurrent } from '../src/stamp_authority.js'
import { normalizePath } from '../src/util.js'
import { VERSION } from '../src/version.js'
import { makeIndexer } from '../src/worker.js'

const FOREIGN_STAMP = 'f0f0f0f0f0f0f0f0'
const NEWER = { version: '999.0.0', fingerprint: 'newer/newer' }

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function symbolNames(dbPath: string): string[] {
  return (getDb(dbPath).prepare('SELECT name FROM symbols ORDER BY name').all() as { name: string }[]).map((r) => r.name)
}

/** Index `file`, restamp its row as written by a newer build that owns the stamps, and return the db path. */
function seedOwnedByNewerBuild(dbPath: string, file: string): void {
  indexFileSync(file, dbPath)
  const db = getDb(dbPath)
  db.prepare('UPDATE files SET parser_sha = ?').run(FOREIGN_STAMP)
  claimStampAuthority(db, NEWER)
}

beforeEach(() => {
  clearModuleCaches()
})

describe('compareVersions orders prereleases per semver', () => {
  it('sorts a prerelease before its release and compares prerelease identifiers', () => {
    expect(compareVersions('2.9.35-rc1', '2.9.35')).toBe(-1)
    expect(compareVersions('2.9.35', '2.9.35-rc1')).toBe(1)
    expect(compareVersions('2.9.35-rc.2', '2.9.35-rc.10')).toBe(-1)
    expect(compareVersions('2.9.35-1', '2.9.35-alpha')).toBe(-1)
    expect(compareVersions('2.9.35-rc', '2.9.35-rc.1')).toBe(-1)
    expect(compareVersions('2.9.35+build5', '2.9.35')).toBe(0)
    expect(compareVersions('2.9.36-rc1', '2.9.35')).toBe(1)
  })
})

describe('a non-owner build and the content key', () => {
  it('skips a row whose content is unchanged but reparses one whose content changed', () => {
    const dir = tmpDir('tg-auth-content-')
    const file = normalizePath(path.join(dir, 'Widget.ts'))
    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\n')
    const dbPath = path.join(dir, 'idx.db')
    seedOwnedByNewerBuild(dbPath, file)
    getDb(dbPath).prepare('DELETE FROM symbols').run()

    makeIndexer(dbPath)(file, fingerprintFile(file) as string)
    expect(symbolNames(dbPath), 'unchanged bytes under a foreign stamp must not be reparsed by a non-owner').toEqual([])

    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\nexport function gadget(): number {\n  return 2\n}\n')
    makeIndexer(dbPath)(file, fingerprintFile(file) as string)
    expect(symbolNames(dbPath), 'a content change is stale for every build, owner or not').toEqual(['gadget', 'widget'])
  })
})

describe('the fold gate honours the stamp authority', () => {
  it('trusts rows an owning build stamped instead of treating them as stale', () => {
    const dir = tmpDir('tg-auth-fold-')
    const file = normalizePath(path.join(dir, 'Big.ts'))
    const body = Array.from({ length: 40 }, (_, i) => `  total += ${i}`).join('\n')
    fs.writeFileSync(file, `export function indexedName(): number {\n  let total = 0\n${body}\n  return total\n}\n`)
    const dbPath = globalDbPath()
    seedOwnedByNewerBuild(dbPath, file)
    // The index and the disk now disagree on the name, which is the only way to tell an index-served span from one parsed off the disk.
    getDb(dbPath).prepare("UPDATE symbols SET name = 'fromIndexName'").run()

    const text = fs.readFileSync(file, 'utf8').split('\n')
    const rows = text.map((t, i) => ({ no: i + 1, text: t, raw: `${String(i + 1).padStart(6, ' ')}\t${t}` }))
    const folded = foldDelivery(rows, file, file)
    expect(folded?.numbered.join('\n'), 'a non-owner must serve spans from rows the owning build stamped').toContain('fromIndexName')
  })
})

describe('an explicit index takes the authority', () => {
  function freshDb(): SqliteDatabase {
    return getDb(path.join(tmpDir('tg-auth-explicit-'), 'global.db'))
  }

  it('a same-version build with other fingerprints converges after an explicit index and then stays put', () => {
    const db = freshDb()
    const other = { version: VERSION, fingerprint: 'other/other' }
    expect(claimStampAuthority(db, other)).toBe(true)
    expect(holdsStampAuthority(db), 'a same-version build never takes the authority on its own').toBe(false)

    claimAuthorityForIndex(db, false)
    expect(holdsStampAuthority(db)).toBe(true)
    expect(claimStampAuthority(db, other), 'the build that lost does not take it back by itself').toBe(false)
    expect(claimStampAuthority(db, other)).toBe(false)
    expect(holdsStampAuthority(db)).toBe(true)
  })

  it('an owner reparses a foreign stamp while a non-owner accepts it', () => {
    const dir = tmpDir('tg-auth-explicit-gate-')
    const dbPath = path.join(dir, 'global.db')
    const db = getDb(dbPath)
    claimStampAuthority(db, { version: VERSION, fingerprint: 'other/other' })
    expect(parserStampCurrent(dbPath, FOREIGN_STAMP, 'typescript'), 'non-owner: the foreign stamp is current').toBe(true)
    claimAuthorityForIndex(db, false)
    expect(parserStampCurrent(dbPath, FOREIGN_STAMP, 'typescript'), 'owner: the foreign stamp is stale and gets reparsed').toBe(false)
  })

  it('an older build wins only with force', () => {
    const db = freshDb()
    claimStampAuthority(db, NEWER)
    claimAuthorityForIndex(db, false)
    expect(holdsStampAuthority(db), 'a plain index from an older build must not undo a newer owner').toBe(false)
    claimAuthorityForIndex(db, true)
    expect(holdsStampAuthority(db), 'index --force takes it whatever is recorded').toBe(true)
  })
})

describe('a failed authority read', () => {
  it('answers that this build is not the owner and is not cached', () => {
    const real = getDb(path.join(tmpDir('tg-auth-fail-'), 'global.db'))
    let failing = true
    const flaky = {
      exec: (sql: string) => {
        if (failing) throw new Error('SQLITE_BUSY: database is locked')
        return real.exec(sql)
      },
      prepare: (sql: string) => real.prepare(sql),
      transaction: <A extends unknown[], R>(fn: (...a: A) => R) => real.transaction(fn),
    } as unknown as SqliteDatabase
    expect(holdsStampAuthority(flaky), 'an unreadable authority must not flip rows: treat stamps as current').toBe(false)
    failing = false
    expect(holdsStampAuthority(flaky), 'the failure was not cached, so the next ask reads the real answer').toBe(true)
  })
})
