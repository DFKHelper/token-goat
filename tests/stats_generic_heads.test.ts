// HAND-DERIVED: each expected count is the rows the test inserts, counted by hand, never read from summarize.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { statsJsonPayload } from '../src/cli_stats.js'
import Database from '../src/sqlite_driver.js'
import { GLOBAL_SCHEMA_SQL, getGlobalDb, rollupAndPruneStats, summarize } from '../src/stats.js'
import { renderShortStats } from '../src/stats_report.js'

describe('generic bash head rows in the stats summary', () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-generic-heads-'))
    db = new Database(path.join(tempDir, 'test.db'))
    db.exec(GLOBAL_SCHEMA_SQL)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const insert = (kind: string, ts: number, bytes = 0, tokens = 0): void => {
    db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)')
      .run(ts, kind, bytes, tokens)
  }

  it('leaves total, by-day, by-source and by-kind as they were without the rows, and tallies the heads', () => {
    const now = Math.floor(Date.now() / 1000)
    insert('image_shrink', now, 4000, 1000)
    const before = summarize(30, db)

    insert('bash_generic_head:npm', now)
    insert('bash_generic_head:npm', now)
    insert('bash_generic_head:terraform', now)
    const after = summarize(30, db)

    expect(after.total_events).toBe(before.total_events)
    expect(after.by_day.map((d) => d.events)).toEqual(before.by_day.map((d) => d.events))
    expect(after.by_source).toEqual(before.by_source)
    expect(after.by_kind).toEqual(before.by_kind)
    expect(after.by_harness).toEqual(before.by_harness)
    expect(after.generic_heads).toEqual({ npm: 2, terraform: 1 })
    expect(statsJsonPayload(after)['generic_heads']).toEqual({ npm: 2, terraform: 1 })
  })

  it('still counts a head recorded before the rollup pruned its raw row', () => {
    const now = Math.floor(Date.now() / 1000)
    insert('bash_generic_head:npm', now - 3 * 86400)
    insert('bash_generic_head:npm', now - 3 * 86400)
    insert('bash_generic_head:npm', now)
    rollupAndPruneStats(db, 1)

    const raw = db
      .prepare("SELECT COUNT(*) AS n FROM stats WHERE kind LIKE 'bash_generic_head:%'")
      .get() as { n: number }
    expect(raw.n).toBe(1)
    const summary = summarize(30, db)
    expect(summary.generic_heads).toEqual({ npm: 3 })
    expect(summary.total_events).toBe(0)
  })
})

describe('the Commands with no dedicated filter section', () => {
  const origNoColor = process.env['NO_COLOR']

  beforeEach(() => {
    process.env['NO_COLOR'] = '1'
  })

  afterEach(() => {
    if (origNoColor === undefined) delete process.env['NO_COLOR']
    else process.env['NO_COLOR'] = origNoColor
    vi.restoreAllMocks()
  })

  it('prints the ten most-run heads with counts and says they are not savings', () => {
    const now = Math.floor(Date.now() / 1000)
    const global = getGlobalDb()
    const add = global.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, 0, 0)')
    global
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, 100, 25)')
      .run(now, 'image_shrink')
    for (let i = 1; i <= 12; i++) {
      for (let n = 0; n < i; n++) add.run(now, `bash_generic_head:tgsec${String.fromCharCode(96 + i)}`)
    }
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(String(text))
    })

    renderShortStats()

    const out = lines.join('\n')
    expect(out).toContain('Commands with no dedicated filter')
    expect(out).toContain('not savings')
    const rows = out.split('\n').filter((line) => /^\s+tgsec[a-z]\s+\d+ runs$/.test(line))
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatch(/tgsecl\s+12 runs/)
    expect(rows[9]).toMatch(/tgsecc\s+3 runs/)
    expect(out).not.toContain('tgseca ')
  })
})
