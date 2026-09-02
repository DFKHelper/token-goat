import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { recordStat, GLOBAL_SCHEMA_SQL } from '../src/stats.js'
import { cappedSourceBytesSaved, PER_FILE_COUNTERFACTUAL_CEILING } from '../src/util.js'
import { VERSION } from '../src/version.js'

/**
 * Provenance: HAND-DERIVED. Every expected number below is computed from the inputs by the
 * arithmetic the cap is specified as (min(source, ceiling) - emitted, floored at 1), not read off
 * `cappedSourceBytesSaved`'s implementation. The structural guard at the bottom is FORMAT-DERIVED
 * from the shape the 13 call sites had before this change (`Math.max(1, fullSourceBytes -
 * Buffer.byteLength(x, 'utf8'))`, cited at src/cli.ts and src/config_commands.ts in the commit
 * that introduced the cap), and it scans src/ while living in tests/, so it can never match
 * itself.
 */

function openStatsDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.exec(GLOBAL_SCHEMA_SQL)
  return db
}

/**
 * The `stats` table as it stood before `tg_version` existed, derived from production's own DDL by
 * removing that one column rather than restating the schema by hand -- a restated copy drifts
 * from the real one silently (see the comment on `openStatsDb` in tests/stats.test.ts).
 */
function openLegacyStatsDb(dbPath: string): Database.Database {
  const legacyDdl = GLOBAL_SCHEMA_SQL.replace(/,\s*\n\s*tg_version TEXT/, '')
  if (legacyDdl === GLOBAL_SCHEMA_SQL) {
    throw new Error('legacy DDL derivation matched nothing -- GLOBAL_SCHEMA_SQL no longer declares tg_version the way this helper strips it, so this test would silently stop testing the legacy shape')
  }
  const db = new Database(dbPath)
  db.exec(legacyDdl)
  return db
}

describe('stats provenance column and capped credit', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stats-version-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('stamps the running token-goat version onto every stat row it writes', () => {
    const db = openStatsDb(path.join(tempDir, 'global.db'))
    try {
      recordStat('pdf_meta', 1234, 300, db)
      const row = db.prepare('SELECT kind, bytes_saved, tg_version FROM stats').get() as {
        kind: string
        bytes_saved: number
        tg_version: string | null
      }
      expect(row.kind).toBe('pdf_meta')
      expect(row.bytes_saved).toBe(1234)
      // Without the stamp, a change to how a kind computes bytes_saved mixes two accountings in
      // one column with nothing to separate them by afterwards.
      expect(row.tg_version).toBe(VERSION)
      expect(row.tg_version).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('still records the row on a database predating the column, instead of silently writing nothing', () => {
    // recordStat swallows every failure by design, so naming a column the table lacks would not
    // throw -- it would stop telemetry dead for every existing install, invisibly. This is the
    // exact degradation path statsHasVersionColumn exists for.
    const db = openLegacyStatsDb(path.join(tempDir, 'legacy.db'))
    try {
      const cols = (db.prepare('PRAGMA table_info(stats)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).not.toContain('tg_version')

      recordStat('image_meta', 77, 19, db)
      const row = db.prepare('SELECT kind, bytes_saved FROM stats').get() as {
        kind: string
        bytes_saved: number
      }
      expect(row).toBeDefined()
      expect(row.kind).toBe('image_meta')
      expect(row.bytes_saved).toBe(77)
    } finally {
      db.close()
    }
  })

  it('caps the counterfactual at the per-file ceiling instead of crediting a whole binary', () => {
    // A 40 MB scan surfaced through pdf-meta: the emitted metadata is a few hundred bytes, and the
    // pre-cap formula credited ~40 MB against it. No Read of that file could have cost that.
    const fortyMb = 40 * 1024 * 1024
    const emitted = 400
    expect(cappedSourceBytesSaved(fortyMb, emitted)).toBe(PER_FILE_COUNTERFACTUAL_CEILING - emitted)
    // Explicitly: the uncapped answer must not survive.
    expect(cappedSourceBytesSaved(fortyMb, emitted)).not.toBe(fortyMb - emitted)
    expect(cappedSourceBytesSaved(fortyMb, emitted)).toBeLessThanOrEqual(PER_FILE_COUNTERFACTUAL_CEILING)
  })

  it('leaves a source already under the ceiling credited at its true size', () => {
    // The cap must not quietly under-credit the ordinary case it was not aimed at.
    expect(cappedSourceBytesSaved(10_000, 400)).toBe(9_600)
    expect(cappedSourceBytesSaved(PER_FILE_COUNTERFACTUAL_CEILING, 0)).toBe(PER_FILE_COUNTERFACTUAL_CEILING)
  })

  it('keeps the floor of 1 so an over-emitting command still counts as an event', () => {
    // Floor preserved from the call sites' original Math.max(1, ...): the row count for a kind is
    // a usage count, and dropping to 0 or negative would make an unprofitable call look identical
    // to one that never happened.
    expect(cappedSourceBytesSaved(500, 5_000)).toBe(1)
    expect(cappedSourceBytesSaved(0, 0)).toBe(1)
  })

  it('leaves no uncapped whole-file counterfactual behind in src/', () => {
    // Structural guard against reintroduction: the defect was one expression repeated at 13 call
    // sites, so fixing the instances without pinning the shape invites the 14th.
    const roots = ['src']
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const src = fs.readFileSync(full, 'utf8')
          if (/Math\.max\(\s*1\s*,\s*fullSourceBytes\s*-\s*Buffer\.byteLength\(/.test(src)) {
            offenders.push(full)
          }
        }
      }
    }
    for (const r of roots) walk(r)
    expect(offenders).toEqual([])
  })
})
