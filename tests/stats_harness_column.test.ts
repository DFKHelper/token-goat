import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { dataDirForHome } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import { summarize, recordStat, GLOBAL_SCHEMA_SQL, HARNESS_UNRECORDED } from '../src/stats.js'
import { renderStats as richRenderStats } from '../src/render/stats_renderer.js'
import { _buildStatsDataForTest } from '../src/stats.js'
import { stripAnsi } from '../src/render/ansi.js'
import type { HarnessStat, StatsData } from '../src/render/types.js'

/**
 * The `stats` table exactly as releases up to 2.8.0 created it.
 *
 * Restating a schema in a test is normally the drift bug `GLOBAL_SCHEMA_SQL` is exported to
 * prevent, and this is the one case where it is the point: what has to be exercised here is a
 * database created by an *older* release, which by definition cannot be built from today's DDL.
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a column added to
 * the shipping DDL reaches new installs only -- and an INSERT naming a column an existing user's
 * table does not have throws, which `recordStat` swallows on purpose. The visible symptom of
 * getting this wrong is not an error: it is every existing user's telemetry silently stopping.
 */
const PRE_HARNESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0,
  detail TEXT
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

describe('stats harness column', () => {
  const homes: string[] = []
  const originalOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']

  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    closeAllDbs()
    if (originalOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = originalOverride
    clearModuleCaches()
    while (homes.length > 0) {
      const dir = homes.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds the column to a database an older release created, instead of leaving it unwritable', () => {
    const { customHome, dbPath } = makeHome('tg-harness-migrate-')
    homes.push(customHome)

    const old = new Database(dbPath)
    old.exec(PRE_HARNESS_SCHEMA_SQL)
    old
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Math.floor(Date.now() / 1000), 'read_replacement', 400, 100, null)
    old.close()

    expect(columnNames(dbPath)).not.toContain('harness')

    // Any read through the module's own accessor is enough to trigger the migration; it is not
    // deferred until the first write, because the first write is exactly what would fail.
    summarize(0, undefined, customHome)
    closeAllDbs()

    expect(columnNames(dbPath)).toContain('harness')
  })

  it('keeps recording against a table that still lacks the column, rather than silently dropping every stat', () => {
    // The independent guard: a database this module never migrated (a caller's injected handle)
    // must degrade to "harness not recorded", never to "nothing recorded". recordStat swallows
    // its own errors, so an unguarded INSERT naming a missing column loses the row with no signal.
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-legacy-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(PRE_HARNESS_SCHEMA_SQL)

    recordStat('read_replacement', 400, 100, db)

    const rows = db.prepare('SELECT kind, bytes_saved FROM stats').all() as { kind: string; bytes_saved: number }[]
    expect(rows).toEqual([{ kind: 'read_replacement', bytes_saved: 400 }])
    db.close()
  })

  it('stamps each row with the harness that was active when it was recorded', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-write-')), 'g.db')
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)

    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
    clearModuleCaches()
    recordStat('read_replacement', 400, 100, db)

    const row = db.prepare('SELECT harness FROM stats').get() as { harness: string | null }
    expect(row.harness).toBe('copilot_cli')
    db.close()
  })

  it('buckets rows that predate the column as unrecorded instead of crediting them to the current harness', () => {
    const { customHome, dbPath } = makeHome('tg-harness-mixed-')
    homes.push(customHome)

    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    const ins = db.prepare(
      'INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, harness) VALUES (?, ?, ?, ?, ?, ?)',
    )
    ins.run(ts, 'read_replacement', 400, 100, null, null)
    ins.run(ts, 'read_replacement', 800, 200, null, 'copilot_cli')
    db.close()

    const summary = summarize(0, undefined, customHome)

    expect(summary.by_harness['copilot_cli']).toEqual({ events: 1, bytes_saved: 800, tokens_saved: 200 })
    expect(summary.by_harness[HARNESS_UNRECORDED]).toEqual({ events: 1, bytes_saved: 400, tokens_saved: 100 })
    // Every row lands in exactly one bucket: a dropped NULL row would make the per-harness
    // events silently undercount the total printed above it.
    const bucketed = Object.values(summary.by_harness).reduce((n, b) => n + b.events, 0)
    expect(bucketed).toBe(summary.total_events)
  })
})

/**
 * The harness breakdown reaching `--json` and the plain-text renderer is not the same thing as it
 * reaching users. `renderStats` picks the rich renderer on a terminal, and that is the output almost
 * every human sees. Dogfooding caught this section missing there while every other surface had it --
 * a breakdown computed, stored, serialized, and invisible. That is the same dead-feature shape the
 * unmapped-tool detector exists to catch, so it gets pinned on the path that actually renders.
 */
describe('the harness breakdown on the renderer users actually see', () => {
  const homes: string[] = []
  afterEach(() => {
    closeAllDbs()
    clearModuleCaches()
    while (homes.length > 0) {
      const dir = homes.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function statsDataWith(byHarness: HarnessStat[]): StatsData {
    return {
      period_start: new Date(0),
      period_end: new Date(86_400_000),
      totals: {
        events: byHarness.reduce((n, h) => n + h.events, 0),
        bytes: byHarness.reduce((n, h) => n + h.bytes, 0),
        tokens: byHarness.reduce((n, h) => n + h.tokens, 0),
        sparklines: null,
      },
      by_kind: [],
      by_day: [],
      by_project: [],
      by_harness: byHarness,
    }
  }

  it('renders a By harness section once two harnesses have been seen', () => {
    const out = stripAnsi(
      richRenderStats(
        statsDataWith([
          { harness: 'claudecode', bytes: 900, tokens: 220, events: 4 },
          { harness: 'copilot_cli', bytes: 300, tokens: 70, events: 2 },
        ]),
      ),
    )
    expect(out, 'the rich renderer is what a terminal user sees; the section must exist there').toContain(
      'By harness',
    )
    expect(out).toContain('claudecode')
    expect(out).toContain('copilot_cli')
  })

  it('carries the breakdown from the real summary through the real builder into the rendered page', () => {
    // The two cases above hand `StatsData` to the renderer directly, so they cannot see
    // `_buildStatsData` dropping the field on the way -- the same whitelist-builder shape that
    // shipped `by_harness` dead in `--json`. This drives the whole chain: recorded rows ->
    // summarize -> _buildStatsData -> rich renderer.
    const { customHome, dbPath } = makeHome('tg-harness-e2e-')
    homes.push(customHome)
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    const ins = db.prepare(
      'INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, harness) VALUES (?, ?, ?, ?, ?, ?)',
    )
    ins.run(ts, 'read_replacement', 900, 220, null, 'claudecode')
    ins.run(ts, 'read_replacement', 300, 70, null, 'copilot_cli')
    db.close()
    closeAllDbs()

    const summary = summarize(30, undefined, customHome)
    const rendered = stripAnsi(richRenderStats(_buildStatsDataForTest(summary, 30)))
    expect(rendered, 'the builder must forward by_harness, not silently drop it').toContain(
      'By harness',
    )
    expect(rendered).toContain('claudecode')
    expect(rendered).toContain('copilot_cli')
  })

  it('stays silent when only one harness has ever been recorded', () => {
    const out = stripAnsi(
      richRenderStats(statsDataWith([{ harness: 'claudecode', bytes: 900, tokens: 220, events: 4 }])),
    )
    expect(out, 'a one-row breakdown equal to the total is noise, not information').not.toContain(
      'By harness',
    )
  })
})
