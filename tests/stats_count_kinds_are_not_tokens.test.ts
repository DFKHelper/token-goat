/**
 * A count recorded in the tokens column must never reach a token total.
 *
 * `secret_redacted` has no numeric slot of its own, so it passes the number of redaction
 * placeholders it emitted as the third `recordStat` argument -- the tokens argument. That is a
 * unit-less quantity sitting in the one headline number this project asks readers to believe, which
 * is the same defect class as pricing an image shrink in bytes: a credit denominated in something
 * that does not bill. The codebase had already reached half of this conclusion, excluding the kind
 * from the renderer's groups because "a redaction removes secret bytes, it does not save a read",
 * and then kept adding it to `total_tokens_saved` anyway.
 *
 * Provenance: HAND-DERIVED. Every number below is chosen here and summed by hand; nothing is read
 * back out of `summarize` and asserted against itself. The two figures are deliberately co-prime
 * multiples so a test that accidentally added them would not land on either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from '../src/sqlite_driver.js'
import { COUNT_ONLY_KINDS, GLOBAL_SCHEMA_SQL, SOURCE_IMAGE, SOURCE_OTHER, kindToSource, summarize } from '../src/stats.js'

/** Production's own DDL, for the reason tests/stats.test.ts gives: a restated schema drifts in silence. */
function openStatsDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.exec(GLOBAL_SCHEMA_SQL)
  return db
}

describe('a count recorded in the tokens column stays out of every token total', () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-count-kinds-'))
    db = openStatsDb(path.join(tempDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** One real saving of 4000 bytes / 1000 tokens under a registered kind, and 37 redaction placeholders, in the same window. The saving kind is deliberately mapped to a different source from secret_redacted, so a source bucket carrying the count would be visible rather than blended into the same row. */
  function seed(): void {
    const now = Math.floor(Date.now() / 1000)
    const insert = db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, harness) VALUES (?, ?, ?, ?, ?)')
    insert.run(now, 'image_shrink', 4000, 1000, 'claude_code')
    insert.run(now, 'secret_redacted', 0, 37, 'claude_code')
  }

  it('reports the real saving as the token total and the placeholder count separately', () => {
    seed()
    const summary = summarize(30, db)

    // 1000, not 1037. The redaction row contributes an event and no tokens.
    expect(summary.total_tokens_saved, 'a placeholder count must not be summed into the token total').toBe(1000)
    expect(summary.total_events).toBe(2)
    expect(summary.counts['secret_redacted'], 'the count is still reported, just not as tokens').toBe(37)
  })

  it('keeps the count out of the per-kind, per-source, per-day and per-harness buckets too', () => {
    seed()
    const summary = summarize(30, db)

    // Excluding a kind from the headline while leaving it in the buckets underneath would leave the
    // parts disagreeing with the whole, which is how the renderer's own exclusion missed this: it
    // stopped at grouping and never reached aggregation.
    expect(summary.by_kind['secret_redacted']?.tokens_saved).toBe(0)
    expect(summary.by_kind['secret_redacted']?.events, 'the event itself is still counted').toBe(1)
    expect(kindToSource('secret_redacted')).toBe(SOURCE_OTHER)
    expect(summary.by_source[SOURCE_OTHER]?.tokens_saved, 'the source bucket the redaction lands in carries no tokens').toBe(0)
    expect(summary.by_source[SOURCE_IMAGE]?.tokens_saved, 'the real saving is untouched').toBe(1000)
    expect(summary.by_day[0]?.tokens_saved).toBe(1000)
    expect(summary.by_harness['claude_code']?.tokens_saved).toBe(1000)
  })

  it('omits the count entirely when nothing was redacted, rather than reporting a zero', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)').run(now, 'image_shrink', 4000, 1000)

    const summary = summarize(30, db)
    expect(summary.counts['secret_redacted']).toBeUndefined()
    expect(summary.total_tokens_saved).toBe(1000)
  })

  it('pins the set of count kinds, so a new one cannot be added without deciding it is one', () => {
    // Structural half. A future kind that puts a count in the tokens column is invisible: it does not
    // fail anything, it just quietly inflates the total by however many things it counted. This is
    // the same shape as the guard below, from the other end.
    expect([...COUNT_ONLY_KINDS].sort()).toEqual(['secret_redacted'])
  })

  it('finds no producer recording a non-zero tokens value against zero bytes outside that set', () => {
    // A source scan, because the defect is a callsite shape rather than a value: `recordStat(kind, 0,
    // someCount)` is what a count-in-the-tokens-column looks like at the point it is written. Kinds
    // that legitimately save tokens without saving bytes do not exist here (a token saving comes from
    // emitting fewer bytes), so this pattern is a reliable flag rather than a heuristic.
    const offenders: string[] = []
    const srcDir = path.join(process.cwd(), 'src')
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          for (const m of fs.readFileSync(full, 'utf8').matchAll(/recordStat\(\s*'([a-z_]+)'\s*,\s*0\s*,\s*([^,)]+)/g)) {
            const value = (m[2] ?? '').trim()
            if (value === '0' || COUNT_ONLY_KINDS.has(m[1] ?? '')) continue
            offenders.push(`${path.relative(process.cwd(), full)}: ${m[1]}`)
          }
        }
      }
    }
    walk(srcDir)
    expect(offenders, 'each of these records a non-zero number in the tokens column against zero bytes: if that number is a count, add its kind to COUNT_ONLY_KINDS in src/stats.ts').toEqual([])
  })
})
