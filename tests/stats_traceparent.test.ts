import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { dataDirForHome } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import { summarize, recordStat } from '../src/stats.js'

const LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  harness TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_ts ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_kind ON stats(kind);
`

function makeHome(prefix: string): { customHome: string; dbPath: string } {
  const customHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const homeDataDir = dataDirForHome(customHome)
  fs.mkdirSync(homeDataDir, { recursive: true })
  return { customHome, dbPath: path.join(homeDataDir, 'global.db') }
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath)
  try {
    return (db.prepare('PRAGMA table_info(stats)').all() as { name: string }[]).map((c) => c.name)
  } finally {
    db.close()
  }
}

describe('stats traceparent column and telemetry correlation', () => {
  const homes: string[] = []
  let origTraceparent: string | undefined

  beforeEach(() => {
    clearModuleCaches()
    origTraceparent = process.env['TRACEPARENT']
    delete process.env['TRACEPARENT']
  })

  afterEach(() => {
    closeAllDbs()
    if (origTraceparent === undefined) delete process.env['TRACEPARENT']
    else process.env['TRACEPARENT'] = origTraceparent
    clearModuleCaches()
    while (homes.length > 0) {
      const dir = homes.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates older global.db to include traceparent column', () => {
    const { customHome, dbPath } = makeHome('tg-trace-migrate-')
    homes.push(customHome)

    const old = new Database(dbPath)
    old.exec(LEGACY_SCHEMA_SQL)
    old
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, harness) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Math.floor(Date.now() / 1000), 'read_replacement', 200, 50, null, 'copilot_cli')
    old.close()

    expect(columnNames(dbPath)).not.toContain('traceparent')

    summarize(0, undefined, customHome)
    closeAllDbs()

    expect(columnNames(dbPath)).toContain('traceparent')
  })

  it('persists traceparent from explicit parameter in recordStat', () => {
    const { customHome, dbPath } = makeHome('tg-trace-explicit-')
    homes.push(customHome)

    summarize(0, undefined, customHome)

    const testDb = new Database(dbPath)
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    recordStat('symbol_read', 400, 100, testDb, 'test detail', tp)

    const row = testDb.prepare('SELECT kind, traceparent FROM stats WHERE kind = ?').get('symbol_read') as {
      kind: string
      traceparent: string | null
    }
    expect(row).toBeDefined()
    expect(row.traceparent).toBe(tp)
    testDb.close()
  })

  it('persists traceparent from process.env.TRACEPARENT fallback', () => {
    const { customHome, dbPath } = makeHome('tg-trace-env-')
    homes.push(customHome)

    summarize(0, undefined, customHome)

    const testDb = new Database(dbPath)
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    process.env['TRACEPARENT'] = tp

    recordStat('section_read', 300, 75, testDb, 'test section')

    const row = testDb.prepare('SELECT kind, traceparent FROM stats WHERE kind = ?').get('section_read') as {
      kind: string
      traceparent: string | null
    }
    expect(row).toBeDefined()
    expect(row.traceparent).toBe(tp)
    testDb.close()
  })

  it('gracefully handles legacy databases lacking traceparent without throwing or dropping rows', () => {
    const { customHome, dbPath } = makeHome('tg-trace-legacy-')
    homes.push(customHome)

    const legacyDb = new Database(dbPath)
    legacyDb.exec(LEGACY_SCHEMA_SQL)

    process.env['TRACEPARENT'] = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'
    expect(() => {
      recordStat('read_replacement', 500, 125, legacyDb, 'legacy read')
    }).not.toThrow()

    const count = (legacyDb.prepare('SELECT COUNT(*) as c FROM stats').get() as { c: number }).c
    expect(count).toBe(1)
    legacyDb.close()
  })
})
