import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import {
  summarize,
  renderStats as _renderStats,
  kindToSource,
  recordStat,
  toLocalDateKey,
  formatLocalTimestamp,
  SOURCE_IMAGE,
  SOURCE_HINT,
  SOURCE_READ,
  SOURCE_BASH,
  SOURCE_WEB,
  SOURCE_MCP,
  SOURCE_SKILL,
  SOURCE_OTHER,
} from '../src/stats.js'

describe('stats', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('toLocalDateKey / formatLocalTimestamp', () => {
    const originalTz = process.env['TZ']

    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    })

    it('renders the local calendar day, not the UTC day, near a UTC day-boundary crossing', () => {
      process.env['TZ'] = 'Etc/GMT+5' // fixed UTC-5, no DST
      const d = new Date(Date.UTC(2026, 0, 16, 3, 0, 0)) // 2026-01-15T22:00:00 local
      expect(toLocalDateKey(d)).toBe('2026-01-15')
    })

    it('renders local wall-clock time in formatLocalTimestamp, matching toLocalDateKey plus HH:MM:SS', () => {
      process.env['TZ'] = 'Etc/GMT+5'
      const d = new Date(Date.UTC(2026, 0, 16, 3, 30, 15))
      expect(formatLocalTimestamp(d)).toBe('2026-01-15T22:30:15')
    })
  })

  describe('kindToSource', () => {
    it('maps known kinds to their source', () => {
      expect(kindToSource('image_shrink')).toBe(SOURCE_IMAGE)
      expect(kindToSource('session_hint')).toBe(SOURCE_HINT)
      expect(kindToSource('read_replacement')).toBe(SOURCE_READ)
      expect(kindToSource('diff_hint')).toBe(SOURCE_HINT)
    })

    it('maps overhead kinds to their base source', () => {
      expect(kindToSource('image_shrink_overhead')).toBe(SOURCE_IMAGE)
      expect(kindToSource('session_hint_overhead')).toBe(SOURCE_HINT)
    })

    it('maps prefix-based kinds', () => {
      expect(kindToSource('bash_compress:filter')).toBe(SOURCE_BASH)
      expect(kindToSource('webfetch:output')).toBe(SOURCE_WEB)
      expect(kindToSource('mcp:read')).toBe(SOURCE_MCP)
      expect(kindToSource('skill_body:compact')).toBe(SOURCE_SKILL)
    })

    it('falls back to SOURCE_OTHER for unknown kinds', () => {
      expect(kindToSource('unknown_kind')).toBe(SOURCE_OTHER)
      expect(kindToSource('future_kind_v2')).toBe(SOURCE_OTHER)
    })
  })

  describe('summarize', () => {
    it('returns empty summary when no stats exist', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const summary = summarize(30, db)
      db.close()

      expect(summary.total_events).toBe(0)
      expect(summary.total_bytes_saved).toBe(0)
      expect(summary.total_tokens_saved).toBe(0)
      expect(Object.keys(summary.by_kind)).toHaveLength(0)
    })

    it('aggregates stats by kind', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(now, 'image_shrink', 100, 500)
      insert.run(now, 'image_shrink', 150, 750)
      insert.run(now, 'symbol_read', 50, 200)

      const summary = summarize(30, db)
      db.close()

      expect(summary.total_events).toBe(3)
      expect(summary.total_bytes_saved).toBe(1450)
      expect(summary.total_tokens_saved).toBe(300)

      expect(summary.by_kind['image_shrink']).toEqual({
        events: 2,
        bytes_saved: 1250,
        tokens_saved: 250,
      })
      expect(summary.by_kind['symbol_read']).toEqual({
        events: 1,
        bytes_saved: 200,
        tokens_saved: 50,
      })
    })

    it('aggregates stats by source', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(now, 'image_shrink', 100, 500)
      insert.run(now, 'session_hint', 50, 200)
      insert.run(now, 'read_replacement', 75, 300)

      const summary = summarize(30, db)
      db.close()

      expect(summary.by_source[SOURCE_IMAGE]).toEqual({
        events: 1,
        bytes_saved: 500,
        tokens_saved: 100,
      })
      expect(summary.by_source[SOURCE_HINT]).toEqual({
        events: 1,
        bytes_saved: 200,
        tokens_saved: 50,
      })
      expect(summary.by_source[SOURCE_READ]).toEqual({
        events: 1,
        bytes_saved: 300,
        tokens_saved: 75,
      })
    })

    it('aggregates stats by day', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const yesterday = now - 24 * 60 * 60
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(now, 'image_shrink', 100, 500)
      insert.run(now, 'image_shrink', 50, 250)
      insert.run(yesterday, 'symbol_read', 75, 300)

      const summary = summarize(30, db)
      db.close()

      expect(summary.by_day.length).toBeGreaterThanOrEqual(2)
      const todayRow = summary.by_day.find((row) => row.date.includes(toLocalDateKey(new Date())))
      expect(todayRow).toBeDefined()
      if (todayRow) {
        expect(todayRow.events).toBe(2)
        expect(todayRow.bytes_saved).toBe(750)
        expect(todayRow.tokens_saved).toBe(150)
      }
    })

    it('buckets an evening-local timestamp into the local day, not the later UTC day it rolls into', () => {
      // Regression test for a bug where stats appeared to happen "tomorrow": summarize() used
      // to derive dateKey via toISOString() (always UTC), so any event recorded in the evening
      // in a negative UTC-offset zone (UTC is already past local midnight) got bucketed into
      // the next calendar day. Etc/GMT+5 is a fixed UTC-5 zone with no DST, so this is
      // deterministic regardless of the host machine's real timezone.
      const originalTz = process.env['TZ']
      process.env['TZ'] = 'Etc/GMT+5'
      try {
        // 2026-01-16T03:00:00Z == 2026-01-15T22:00:00 local (UTC-5): local day is the 15th,
        // UTC day is already the 16th.
        const ts = Math.floor(Date.UTC(2026, 0, 16, 3, 0, 0) / 1000)

        const dbPath = path.join(tempDir, 'test.db')
        const db = new Database(dbPath)
        db.exec(`
          CREATE TABLE stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            kind TEXT NOT NULL,
            tokens_saved INTEGER NOT NULL DEFAULT 0,
            bytes_saved INTEGER NOT NULL DEFAULT 0,
            detail TEXT
          );
          CREATE INDEX idx_stats_ts ON stats(ts);
          CREATE INDEX idx_stats_kind ON stats(kind);
        `)
        db.prepare('INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)').run(
          ts,
          'image_shrink',
          100,
          500,
        )

        const summary = summarize(0, db)
        db.close()

        const localRow = summary.by_day.find((row) => row.date === '2026-01-15')
        const utcRow = summary.by_day.find((row) => row.date === '2026-01-16')
        expect(localRow).toBeDefined()
        expect(localRow?.events).toBe(1)
        expect(utcRow).toBeUndefined()
      } finally {
        if (originalTz === undefined) delete process.env['TZ']
        else process.env['TZ'] = originalTz
      }
    })

    it('respects windowDays filter', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const old = now - 100 * 24 * 60 * 60
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(old, 'image_shrink', 100, 500)
      insert.run(now, 'symbol_read', 50, 200)

      const summary = summarize(30, db)
      db.close()

      expect(summary.total_events).toBe(1)
      expect(summary.by_kind['image_shrink']).toBeUndefined()
      expect(summary.by_kind['symbol_read']).toBeDefined()
    })

    it('aggregates stats by command', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(now, 'symbol_lookup', 100, 500)
      insert.run(now, 'read_replacement', 50, 200)
      insert.run(now, 'section_replacement', 75, 300)
      insert.run(now, 'section_read', 25, 100)

      const summary = summarize(30, db)
      db.close()

      const symbolCmd = summary.by_command.find((r) => r.command === 'symbol')
      expect(symbolCmd).toBeDefined()
      if (symbolCmd) {
        expect(symbolCmd.events).toBe(1)
        expect(symbolCmd.tokens_saved).toBe(100)
      }

      const sectionCmd = summary.by_command.find((r) => r.command === 'section')
      expect(sectionCmd).toBeDefined()
      if (sectionCmd) {
        expect(sectionCmd.events).toBe(2)
        expect(sectionCmd.tokens_saved).toBe(100)
        expect(sectionCmd.bytes_saved).toBe(400)
      }
    })

    it('handles NULL bytes_saved and tokens_saved', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      db.exec(`INSERT INTO stats (ts, kind) VALUES (${now}, 'symbol_lookup')`)

      const summary = summarize(30, db)
      db.close()

      expect(summary.total_events).toBe(1)
      expect(summary.total_bytes_saved).toBe(0)
      expect(summary.total_tokens_saved).toBe(0)
    })
  })

  describe('renderStats', () => {
    it('prints "No stats recorded yet" when empty', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      let output = ''
      const originalLog = console.log
      console.log = (msg: string) => {
        output += msg + '\n'
      }

      try {
        const summary = summarize(30, db)
        if (summary.total_events === 0) {
          console.log('No stats recorded yet.')
        }
      } finally {
        console.log = originalLog
        db.close()
      }

      expect(output).toContain('No stats recorded yet')
    })

    it('formats and prints stats summary', () => {
      const dbPath = path.join(tempDir, 'test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      const now = Math.floor(Date.now() / 1000)
      const insert = db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      )

      insert.run(now, 'image_shrink', 1000, 5000)
      insert.run(now, 'symbol_read', 500, 2000)

      let output = ''
      const originalLog = console.log
      console.log = (msg: string) => {
        output += msg + '\n'
      }

      try {
        const summary = summarize(30, db)
        const fmtBytes = (n: number): string => {
          if (n < 1024) return `${n}B`
          if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
          return `${(n / (1024 * 1024)).toFixed(1)}MB`
        }

        const lines: string[] = [
          '# token-goat stats',
          `Total events:   ${summary.total_events}`,
          `Bytes saved:    ${fmtBytes(summary.total_bytes_saved)}`,
          `Tokens saved:   ${summary.total_tokens_saved}`,
          `Window:         ${summary.window_days} days`,
        ]

        if (Object.keys(summary.by_source).length > 0) {
          lines.push('', '## By Source')
        }

        if (summary.by_command.length > 0) {
          lines.push('', '## By Command')
        }

        console.log(lines.join('\n'))
      } finally {
        console.log = originalLog
        db.close()
      }

      expect(output).toContain('# token-goat stats')
      expect(output).toContain('Total events:   2')
      expect(output).toContain('Tokens saved:   1500')
      expect(output).toContain('## By Source')
      expect(output).toContain('## By Command')
    })
  })

  describe('recordStat', () => {
    it('inserts a row into the stats table and summarize picks it up', () => {
      const dbPath = path.join(tempDir, 'record-test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      recordStat('session_hint', 1024, 50, db)

      const summary = summarize(30, db)
      db.close()

      expect(summary.total_events).toBe(1)
      expect(summary.total_bytes_saved).toBe(1024)
      expect(summary.total_tokens_saved).toBe(50)
      expect(summary.by_kind['session_hint']).toMatchObject({ events: 1, bytes_saved: 1024, tokens_saved: 50 })
      expect(summary.by_source[SOURCE_HINT]).toMatchObject({ events: 1 })
    })

    it('silently no-ops when the stats table is missing', () => {
      // An in-memory DB with no stats table — recordStat must not throw.
      expect(() => recordStat('session_hint', 0, 0, new Database(':memory:'))).not.toThrow()
    })

    it('web_fetch maps to SOURCE_WEB and skill_load maps to SOURCE_SKILL', () => {
      const dbPath = path.join(tempDir, 'source-mapping-test.db')
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          tokens_saved INTEGER NOT NULL DEFAULT 0,
          bytes_saved INTEGER NOT NULL DEFAULT 0,
          detail TEXT
        );
        CREATE INDEX idx_stats_ts ON stats(ts);
        CREATE INDEX idx_stats_kind ON stats(kind);
      `)

      recordStat('web_fetch', 0, 0, db)
      recordStat('skill_load', 0, 0, db)

      const summary = summarize(30, db)
      db.close()

      expect(summary.by_source[SOURCE_WEB]).toMatchObject({ events: 1 })
      expect(summary.by_source[SOURCE_SKILL]).toMatchObject({ events: 1 })
    })
  })
})
