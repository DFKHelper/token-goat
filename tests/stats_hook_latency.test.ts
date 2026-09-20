import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { dataDirForHome } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import {
  recordStat,
  pruneHookStats,
  GLOBAL_SCHEMA_SQL,
  HOOK_STATS_RETENTION_DAYS,
} from '../src/stats.js'
import { hookLatencyBreakdown } from '../src/hook_latency.js'

/**
 * The `stats` table exactly as it existed before this change added `duration_ms` -- same
 * FORMAT-DERIVED provenance as `stats_harness_column.test.ts`'s `PRE_HARNESS_SCHEMA_SQL`: read
 * off `GLOBAL_SCHEMA_SQL` as it stood immediately before this commit, so an install created by
 * any earlier release is exercised without waiting for one to actually exist.
 */
const PRE_DURATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  harness TEXT,
  traceparent TEXT,
  tg_version TEXT
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

describe('stats duration_ms column and hook latency (Batch S)', () => {
  const homes: string[] = []

  afterEach(() => {
    closeAllDbs()
    clearModuleCaches()
    while (homes.length > 0) {
      const dir = homes.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds duration_ms to a database an older release created, instead of leaving it unwritable', () => {
    const { customHome, dbPath } = makeHome('tg-duration-migrate-')
    homes.push(customHome)

    const old = new Database(dbPath)
    old.exec(PRE_DURATION_SCHEMA_SQL)
    old.close()

    expect(columnNames(dbPath)).not.toContain('duration_ms')

    hookLatencyBreakdown(undefined, customHome)
    closeAllDbs()

    expect(columnNames(dbPath)).toContain('duration_ms')
  })

  it('degrades to recording without a duration on a table that still lacks the column, rather than dropping the row', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-legacy-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(PRE_DURATION_SCHEMA_SQL)

    recordStat('hook:pre_tool_use', 0, 0, db, undefined, undefined, 42)

    const rows = db.prepare('SELECT kind FROM stats').all() as { kind: string }[]
    expect(rows).toEqual([{ kind: 'hook:pre_tool_use' }])
    db.close()
  })

  it('stores the measured duration on a fully migrated table', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-write-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)

    recordStat('hook:post_tool_use', 0, 0, db, undefined, undefined, 12.7)

    const row = db.prepare('SELECT duration_ms FROM stats').get() as { duration_ms: number | null }
    // Rounded, not truncated or fudged: recordStat rounds the caller's fractional millisecond figure to the nearest whole one it stores.
    expect(row.duration_ms).toBe(13)
    db.close()
  })

  it('leaves duration_ms NULL when the caller has no measurement for this event, rather than manufacturing a zero', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-omit-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)

    recordStat('read_replacement', 400, 100, db)

    const row = db.prepare('SELECT duration_ms FROM stats').get() as { duration_ms: number | null }
    expect(row.duration_ms).toBeNull()
    db.close()
  })

  // HAND-DERIVED: durations below are literal test constants chosen to have a known, hand-computed median/p95, independent of any percentile implementation in stats.ts.
  it('computes count, median, p95, max and newest_ts per (event, harness) group', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-breakdown-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const now = Math.floor(Date.now() / 1000)
    const durations = [10, 20, 30, 40, 100] // sorted; p95 (nearest-rank, ceil(0.95*5)-1=4) -> 100; median (index 2) -> 30
    const ins = db.prepare(
      `INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, harness, duration_ms) VALUES (?, 'hook:pre_tool_use', 0, 0, NULL, 'claudecode', ?)`,
    )
    durations.forEach((d, i) => ins.run(now - i, d))
    // A different harness must not be folded into the same group.
    db.prepare(
      `INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, harness, duration_ms) VALUES (?, 'hook:pre_tool_use', 0, 0, NULL, 'copilot_cli', 5)`,
    ).run(now)

    const rows = hookLatencyBreakdown(db)
    const claude = rows.find((r) => r.harness === 'claudecode')!
    expect(claude.event).toBe('pre_tool_use')
    expect(claude.count).toBe(5)
    expect(claude.median_ms).toBe(30)
    expect(claude.p95_ms).toBe(100)
    expect(claude.max_ms).toBe(100)
    expect(claude.newest_ts).toBe(now)

    const copilot = rows.find((r) => r.harness === 'copilot_cli')!
    expect(copilot.count).toBe(1)
    expect(copilot.median_ms).toBe(5)
    db.close()
  })

  it('sorts the breakdown worst-p95-first, so a bad tail is the first row', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-sort-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, harness, duration_ms) VALUES (?, 'hook:notification', 0, 0, 'claudecode', 5)`,
    ).run(now)
    db.prepare(
      `INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, harness, duration_ms) VALUES (?, 'hook:pre_tool_use', 0, 0, 'claudecode', 900)`,
    ).run(now)

    const rows = hookLatencyBreakdown(db)
    expect(rows[0]!.event).toBe('pre_tool_use')
    expect(rows[1]!.event).toBe('notification')
    db.close()
  })

  it('excludes non-hook kinds from the breakdown', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-exclude-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    db.prepare(
      `INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, duration_ms) VALUES (?, 'read_replacement', 400, 100, 999)`,
    ).run(Math.floor(Date.now() / 1000))

    expect(hookLatencyBreakdown(db)).toEqual([])
    db.close()
  })

  it('prunes hook: rows older than the retention window, leaving recent hook rows and same-age non-hook rows untouched', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-duration-prune-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const now = Math.floor(Date.now() / 1000)
    const old = now - (HOOK_STATS_RETENTION_DAYS + 1) * 86400
    db.prepare(`INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, duration_ms) VALUES (?, 'hook:pre_tool_use', 0, 0, 30)`).run(old)
    db.prepare(`INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, duration_ms) VALUES (?, 'hook:pre_tool_use', 0, 0, 40)`).run(now)
    // A non-hook kind the same age as the pruned row must survive: pruneHookStats is scoped to `hook:%` only, not a blanket age-based delete.
    db.prepare(`INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, 'read_replacement', 400, 100)`).run(old)

    pruneHookStats(db)

    const remaining = db.prepare('SELECT kind, duration_ms FROM stats ORDER BY kind').all() as {
      kind: string
      duration_ms: number | null
    }[]
    expect(remaining).toEqual([
      { kind: 'hook:pre_tool_use', duration_ms: 40 },
      { kind: 'read_replacement', duration_ms: null },
    ])
    db.close()
  })
})
