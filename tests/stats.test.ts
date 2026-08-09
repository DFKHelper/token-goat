import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import { closeAllDbs } from '../src/db.js'
import {
  summarize,
  renderStats as _renderStats,
  renderShortStats as _renderShortStats,
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

    it('maps the large-file-hint and read-count-deny lifecycle kinds to SOURCE_HINT, not SOURCE_OTHER', () => {
      expect(kindToSource('large_file_hint_followed')).toBe(SOURCE_HINT)
      expect(kindToSource('large_file_hint_ignored')).toBe(SOURCE_HINT)
      expect(kindToSource('read_count_deny')).toBe(SOURCE_HINT)
    })

    it('maps the imports kind to SOURCE_READ, mirroring its exports sibling', () => {
      expect(kindToSource('exports')).toBe(SOURCE_READ)
      expect(kindToSource('imports')).toBe(SOURCE_READ)
    })

    it('maps the dep_docs kind to SOURCE_READ (regression: dep-docs recordStat calls existed but this kind was never registered)', () => {
      expect(kindToSource('dep_docs')).toBe(SOURCE_READ)
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
      // Pin the real aggregated bucket content instead of just presence, so a regression that
      // aggregated the wrong row into this bucket (still "defined") is caught too.
      expect(summary.by_kind['symbol_read']).toEqual({ events: 1, bytes_saved: 200, tokens_saved: 50 })
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

    it('groups imports kind under the imports command bucket, mirroring exports', () => {
      const dbPath = path.join(tempDir, 'test-imports.db')
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
      insert.run(now, 'imports', 60, 240)

      const summary = summarize(30, db)
      db.close()

      const importsCmd = summary.by_command.find((r) => r.command === 'imports')
      expect(importsCmd).toBeDefined()
      if (importsCmd) {
        expect(importsCmd.events).toBe(1)
        expect(importsCmd.tokens_saved).toBe(60)
        expect(importsCmd.bytes_saved).toBe(240)
      }

      // Pin the exact aggregated bucket -- only one 'imports' row was inserted -- instead of
      // just presence, so a regression that double-counted the row into SOURCE_READ is caught.
      expect(summary.by_source[SOURCE_READ]).toEqual({ events: 1, bytes_saved: 240, tokens_saved: 60 })
      expect(summary.by_source[SOURCE_OTHER]).toBeUndefined()
    })

    it('groups dep_docs kind under the dep-docs command bucket (regression: dep_docs was never registered in COMMAND_KINDS/KIND_TO_SOURCE)', () => {
      const dbPath = path.join(tempDir, 'test-dep-docs.db')
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
      insert.run(now, 'dep_docs', 90, 360)

      const summary = summarize(30, db)
      db.close()

      const depDocsCmd = summary.by_command.find((r) => r.command === 'dep-docs')
      expect(depDocsCmd).toBeDefined()
      if (depDocsCmd) {
        expect(depDocsCmd.events).toBe(1)
        expect(depDocsCmd.tokens_saved).toBe(90)
        expect(depDocsCmd.bytes_saved).toBe(360)
      }

      // Pin the exact aggregated bucket -- only one 'dep_docs' row was inserted -- instead of
      // just presence, so a regression that double-counted the row into SOURCE_READ is caught.
      expect(summary.by_source[SOURCE_READ]).toEqual({ events: 1, bytes_saved: 360, tokens_saved: 90 })
      expect(summary.by_source[SOURCE_OTHER]).toBeUndefined()
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
    // These two tests used to reimplement the "No stats recorded yet" / formatted-summary
    // logic inline instead of calling the real renderStats() -- so they always passed
    // regardless of what renderStats() actually does, providing zero coverage of the
    // production code path. Route through a homeDir-threaded temp DB and the real
    // _renderStats(), matching the pattern the other tests in this describe block use.
    it('prints "No stats recorded yet" when empty', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-empty-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.close()

      let output = ''
      const originalLog = console.log
      const origIsTty = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      console.log = (msg: string) => {
        output += msg + '\n'
      }

      try {
        _renderStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).toContain('No stats recorded yet')
    })

    // Regression: a stat row that exists but falls outside the --window-days cutoff used to
    // render byte-identical to "no stats ever recorded" -- the empty-vs-filtered-store trap
    // (see runDead's --exclude-tests handling) applied to the time-window filter.
    it('distinguishes "outside window" from "never recorded" when a stat exists before the cutoff', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-outside-window-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60
      db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)').run(
        sixtyDaysAgo,
        'symbol_read',
        100,
        20,
      )
      db.close()

      let output = ''
      const originalLog = console.log
      const origIsTty = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      console.log = (msg: string) => {
        output += msg + '\n'
      }

      try {
        _renderStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).not.toContain('No stats recorded yet')
      expect(output).toContain('outside this window')
      expect(output).toContain('1 recorded outside this window')
    })

    it('formats and prints stats summary', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-summary-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.close()

      let output = ''
      const originalLog = console.log
      const origIsTty = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      console.log = (msg: string) => {
        output += msg + '\n'
      }

      try {
        _renderStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).toContain('# token-goat stats')
      expect(output).toContain('Total events:   2')
      expect(output).toContain('Tokens saved:   1500')
      expect(output).toContain('## By Source')
      expect(output).toContain('## By Command')
    })

    it('threads a custom homeDir through the human-readable output (not the default global DB)', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 5000)
      db.close()

      const origIsTty = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      let output = ''
      const originalLog = console.log
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      // Without homeDir threading, this would read the (empty, isolated) default
      // global DB and print "No stats recorded yet." instead of the seeded row.
      expect(output).not.toContain('No stats recorded yet')
      expect(output).toContain('Total events:   1')
      expect(output).toContain('Tokens saved:   1000')
    })

    it('flags zero direct command invocations when hints fired but no commands were run', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-hints-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      // Only hint kinds -- no symbol_lookup/read_replacement/outline/etc -- so
      // by_command stays empty while by_source[hint] is non-zero.
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'session_hint', 100, 500)
      db.close()

      let output = ''
      const originalLog = console.log
      const origIsTty = process.stdout.isTTY
      // Force the plain-text (non-TTY) render path deterministically -- ambient
      // TTY detection varies by shell/CI runner and must not decide which code
      // path this test exercises.
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).toContain('0 direct command')
      expect(output).toContain('hint(s) fired but not acted on')
    })
  })

  describe('renderShortStats', () => {
    it('prints only the totals block plus a --full hint, no breakdown sections', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 5000)
      db.close()

      const origIsTty = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      let output = ''
      const originalLog = console.log
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).toContain('Total events:   1')
      expect(output).toContain('Bytes saved:')
      expect(output).toContain('Tokens saved:   1000')
      expect(output).toContain('Window:         30 days')
      expect(output).toContain('--full')
      expect(output).not.toContain('## By Source')
      expect(output).not.toContain('## By Command')
      expect(output).not.toContain('## Last 7 Days')
    })

    it('prints "No stats recorded yet" when empty', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-empty-'))
      let output = ''
      const originalLog = console.log
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome })
      } finally {
        console.log = originalLog
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }
      expect(output).toContain('No stats recorded yet')
    })

    it('uses the rich header + KPI section (no breakdown sections) on a TTY', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-tty-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 5000)
      db.close()

      const origIsTty = process.stdout.isTTY
      const origNoColor = process.env['NO_COLOR']
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      delete process.env['NO_COLOR']

      let output = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string) => {
        output += chunk
        return true
      }) as typeof process.stdout.write

      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome })
      } finally {
        process.stdout.write = origWrite
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        if (origNoColor !== undefined) process.env['NO_COLOR'] = origNoColor
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      expect(output).toContain('token-goat')
      expect(output).toContain('events')
      expect(output).toContain('--full')
      expect(output).not.toContain('By source')
      expect(output).not.toContain('By command')
      expect(output).not.toContain('By day')
      expect(output).not.toContain('Insights')
    })

    it('force:true reaches the rich KPI view even when stdout is not a TTY (piped)', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-force-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 5000)
      db.close()

      const origIsTty = process.stdout.isTTY
      const origNoColor = process.env['NO_COLOR']
      // The key assertion: isTTY is explicitly false, simulating an agent invoking through a
      // pipe (no TTY at all) -- exactly the case `--short`/`force` exists to unblock.
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      delete process.env['NO_COLOR']

      let output = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string) => {
        output += chunk
        return true
      }) as typeof process.stdout.write

      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome, force: true })
      } finally {
        process.stdout.write = origWrite
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
        if (origNoColor !== undefined) process.env['NO_COLOR'] = origNoColor
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }

      // Same shape as the TTY-rich assertions above: the rich KPI view, not the flat totals dump.
      expect(output).toContain('token-goat')
      expect(output).toContain('events')
      expect(output).toContain('--full')
      expect(output).not.toContain('By source')
      expect(output).not.toContain('By command')
      expect(output).not.toContain('By day')
      expect(output).not.toContain('Insights')
    })

    it('force:true still respects an explicit NO_COLOR preference (falls back to flat totals)', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-force-nocolor-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 5000)
      db.close()

      let output = ''
      const originalLog = console.log
      const origNoColor = process.env['NO_COLOR']
      process.env['NO_COLOR'] = '1'
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome, force: true })
      } finally {
        console.log = originalLog
        if (origNoColor === undefined) delete process.env['NO_COLOR']
        else process.env['NO_COLOR'] = origNoColor
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }
      // NO_COLOR wins over force -- the flat plain-text totals path (_renderShortTotals), not
      // the rich KPI renderer.
      expect(output).toContain('Total events:   1')
      expect(output).toContain('--full')
    })

    it('formats a gigabyte-scale total_bytes_saved as GB, not a raw MB figure (regression: stats.ts kept its own fmtBytes capped at the MB tier instead of importing the shared, GB/TB-aware fmtBytes from render/ansi.ts)', () => {
      const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-short-gb-'))
      const platform = process.platform
      const homeDataDir =
        platform === 'win32'
          ? path.join(customHome, 'AppData', 'Local', 'dfk-helper', 'token-goat')
          : platform === 'darwin'
            ? path.join(customHome, 'Library', 'Application Support', 'token-goat')
            : path.join(customHome, '.local', 'share', 'token-goat')
      fs.mkdirSync(homeDataDir, { recursive: true })
      const dbPath = path.join(homeDataDir, 'global.db')
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
      db.prepare(
        'INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)',
      ).run(now, 'image_shrink', 1000, 2_000_000_000)
      db.close()

      let output = ''
      const originalLog = console.log
      const origNoColor = process.env['NO_COLOR']
      process.env['NO_COLOR'] = '1'
      console.log = (msg: string) => {
        output += msg + '\n'
      }
      try {
        _renderShortStats({ windowDays: 30, homeDir: customHome, force: true })
      } finally {
        console.log = originalLog
        if (origNoColor === undefined) delete process.env['NO_COLOR']
        else process.env['NO_COLOR'] = origNoColor
        closeAllDbs()
        fs.rmSync(customHome, { recursive: true, force: true })
      }
      expect(output).toContain('Bytes saved:    1.9GB')
      expect(output).not.toContain('MB')
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
