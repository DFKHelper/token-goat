/** The hint suppression gate (suppressesAt, wilsonInterval in src/hint_stats.ts) and the eval that measures it (scripts/eval-hints.ts). Every expected figure is HAND-DERIVED: Wilson bounds from the closed form worked by hand (0 of 5: centre and margin both 1.96^2/10 = 0.38416 over 1 + 1.96^2/5 = 1.76832, so 0.4345), first-mute counts from the Wilson table (0 of 21 has an upper bound of 15.46%, 0 of 22 of 14.87%), probe counts from the default schedule [1, 3, 10, 30] by counting occasions, and the multi-step probabilities from a separate Python dynamic program written for this test, not from the script. The one closed-form case, 0.7^5 = 0.16807, checks that program. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getDefaultConfig } from '../src/config_defaults.js'
import { closeDb, getDb } from '../src/db.js'
import Database from '../src/sqlite_driver.js'
import { suppressesAt, wilsonInterval } from '../src/hint_stats.js'
import type { HintStatsConfig } from '../src/config_types.js'
import { countGate, everSuppressedProbability, exposure, firstSuppressionAtZero, readLedger, shippedGate } from '../scripts/eval-hints.js'

/** The shipped defaults, written out so a change to them shows up here as a deliberate edit. */
const DEFAULTS: HintStatsConfig = { min_sample_size: 5, suppress_threshold_pct: 15, defiance_threshold_pct: 85 }
const PROBES = [1, 3, 10, 30]

it('writes out the shipped defaults, so the figures below describe what users run', () => {
  expect(getDefaultConfig('hint_stats')).toEqual(DEFAULTS)
  expect((getDefaultConfig('hints') as { backoff_thresholds: number[] }).backoff_thresholds).toEqual(PROBES)
})

describe('wilsonInterval', () => {
  it('gives 0 of 5 an upper bound of 43.45%, not the 0% a raw rate reports', () => {
    const { lo, hi } = wilsonInterval(0, 5)
    expect(lo).toBe(0)
    expect(hi).toBeCloseTo(0.4345, 4)
  })

  it('brackets a middling rate symmetrically about the Wilson centre: 5 of 10 is [23.66%, 76.34%]', () => {
    const { lo, hi } = wilsonInterval(5, 10)
    expect(lo).toBeCloseTo(0.2366, 4)
    expect(hi).toBeCloseTo(0.7634, 4)
  })

  it('pins the ends exactly at k = 0 and k = n', () => {
    expect(wilsonInterval(0, 22).lo).toBe(0)
    expect(wilsonInterval(22, 22).hi).toBe(1)
    expect(wilsonInterval(22, 22).lo).toBeCloseTo(1 - 0.1487, 4)
  })

  it('says nothing is known about an empty sample', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 })
  })
})

describe('suppressesAt', () => {
  it('mutes a never-followed category at 22 scored emissions and not at 21', () => {
    expect(suppressesAt(21, 0, DEFAULTS, false)).toBe(false)
    expect(suppressesAt(22, 0, DEFAULTS, false)).toBe(true)
  })

  it('keeps a category whose raw rate is under the bar but whose sample cannot show it: 1 of 7 is 14.3%', () => {
    expect(suppressesAt(7, 1, DEFAULTS, false)).toBe(false)
  })

  it('judges a suppression category on its defiance lower bound: 0 complied of 22 mutes, 22 complied of 22 does not', () => {
    expect(suppressesAt(22, 0, DEFAULTS, true)).toBe(true)
    expect(suppressesAt(22, 22, DEFAULTS, true)).toBe(false)
  })

  it('reads the defiance bar, not the suppress bar, for an inverted category', () => {
    // 0 of 5 complied: upper bound 43.45%. Against a defiance bar of 50 the compliance bar is 50, so it mutes; the suppress bar of 15 would not.
    const cfg = { ...DEFAULTS, defiance_threshold_pct: 50 }
    expect(suppressesAt(5, 0, cfg, true)).toBe(true)
    expect(suppressesAt(5, 0, cfg, false)).toBe(false)
  })

  it('never mutes below min_sample_size, even when the interval already would', () => {
    // 0 of 4 has an upper bound of 48.99%, under a 50% bar.
    const cfg = { ...DEFAULTS, suppress_threshold_pct: 50 }
    expect(suppressesAt(4, 0, cfg, false)).toBe(false)
    expect(suppressesAt(4, 0, { ...cfg, min_sample_size: 4 }, false)).toBe(true)
  })

  it('never mutes a category whose every hint was followed, even with the bar at 100%', () => {
    // The upper bound at k = n is exactly 1, which is not under a 100% bar. Unpinned, the formula lands 12 of 12 at 1 - 2^-52 in floating point, which is.
    expect(suppressesAt(5, 5, { ...DEFAULTS, suppress_threshold_pct: 100 }, false)).toBe(false)
    expect(suppressesAt(12, 12, { ...DEFAULTS, suppress_threshold_pct: 100 }, false)).toBe(false)
  })

  it('treats an upper bound equal to the bar as not under it', () => {
    // 0 of 5 sits at 43.45%: a bar just above mutes, a bar just below does not.
    expect(suppressesAt(5, 0, { ...DEFAULTS, suppress_threshold_pct: 43.46 }, false)).toBe(true)
    expect(suppressesAt(5, 0, { ...DEFAULTS, suppress_threshold_pct: 43.44 }, false)).toBe(false)
  })
})

describe('eval gates', () => {
  it('finds the first mute at zero uptake: 22 under the shipped gate, 5 under the raw-rate baseline', () => {
    expect(firstSuppressionAtZero(shippedGate(DEFAULTS))).toBe(22)
    expect(firstSuppressionAtZero(countGate(DEFAULTS))).toBe(5)
    expect(firstSuppressionAtZero(countGate({ ...DEFAULTS, min_sample_size: 20 }))).toBe(20)
  })

  it('reports never when no count mutes', () => {
    expect(firstSuppressionAtZero(countGate({ ...DEFAULTS, suppress_threshold_pct: 0 }), 50)).toBeNull()
  })

  it('computes the chance of a first mute exactly', () => {
    const baseline = countGate(DEFAULTS)
    // Only 0 of 5 is under 15% at n = 5, so the chance is 0.7^5.
    expect(everSuppressedProbability(0.3, 5, baseline)).toBeCloseTo(0.16807, 5)
    expect(everSuppressedProbability(0.05, 10, baseline)).toBeCloseTo(0.9576, 4)
    expect(everSuppressedProbability(0.2, 20, baseline)).toBeCloseTo(0.6448, 4)
    expect(everSuppressedProbability(0.2, 200, baseline)).toBeCloseTo(0.7388, 4)
    expect(everSuppressedProbability(1, 200, shippedGate(DEFAULTS))).toBe(0)
  })

  it('counts probes on top of the unmuted run for a hint nobody follows', () => {
    // Raw-rate gate: 5 shown, then 95 muted occasions probe at streaks 1, 3, 10, 30, 60 and 90.
    const baseline = exposure(0, 100, countGate(DEFAULTS), PROBES)
    expect(baseline.shown).toBeCloseTo(11, 10)
    expect(baseline.followed).toBe(0)
    expect(baseline.suppressedAtEnd).toBeCloseTo(1, 10)
    // Shipped gate: 22 shown, then 78 muted occasions probe at 1, 3, 10, 30 and 60.
    expect(exposure(0, 100, shippedGate(DEFAULTS), PROBES).shown).toBeCloseTo(27, 10)
  })

  it('shows every hint and mutes nothing when every hint is followed', () => {
    const e = exposure(1, 40, shippedGate(DEFAULTS), PROBES)
    expect(e.shown).toBeCloseTo(40, 10)
    expect(e.followed).toBeCloseTo(40, 10)
    expect(e.suppressedAtEnd).toBe(0)
  })
})

describe('readLedger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evalhints-'))
  const dbPath = path.join(dir, 'global.db')

  afterAll(() => {
    closeDb(dbPath)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('splits displayed, observable rows into scored, followed and pending, and leaves the file unchanged', () => {
    const insert = getDb(dbPath).prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, emitted_at, resolved, acted_on, observable, displayed) VALUES (?, 's', ?, 0, ?, ?, ?, ?)`,
    )
    // bash_redirect on claudecode: 2 scored (1 followed), 1 pending, plus one unobservable and one undisplayed row that must not count.
    insert.run('bash_redirect', 'claudecode', 1, 1, 1, 1)
    insert.run('bash_redirect', 'claudecode', 1, 0, 1, 1)
    insert.run('bash_redirect', 'claudecode', 0, 0, 1, 1)
    insert.run('bash_redirect', 'claudecode', 1, 1, 0, 1)
    insert.run('bash_redirect', 'claudecode', 1, 1, 1, 0)
    insert.run('read_batch', 'codex', 1, 0, 1, 1)
    closeDb(dbPath)
    const before = fs.readFileSync(dbPath)

    expect(readLedger(dbPath)).toEqual([
      { category: 'bash_redirect', harness: 'claudecode', scored: 2, followed: 1, pending: 1 },
      { category: 'read_batch', harness: 'codex', scored: 1, followed: 0, pending: 0 },
    ])
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('reads a ledger whose WAL still holds commits without checkpointing them into the main file', () => {
    // The state a copied or crashed live ledger is in. A read-write connection that closes last folds the WAL into global.db; a read-only one leaves it alone.
    const walDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evalhints-wal-'))
    const source = path.join(walDir, 'source.db')
    getDb(source)
    closeDb(source)
    const writer = new Database(source)
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    writer
      .prepare(`INSERT INTO hint_emissions (category, session_id, harness, emitted_at, resolved, acted_on, observable, displayed) VALUES ('read_batch', 's', 'codex', 0, 1, 1, 1, 1)`)
      .run()
    const copy = path.join(walDir, 'global.db')
    fs.copyFileSync(source, copy)
    fs.copyFileSync(`${source}-wal`, `${copy}-wal`)
    writer.close()
    const before = fs.readFileSync(copy)

    try {
      expect(readLedger(copy)).toEqual([{ category: 'read_batch', harness: 'codex', scored: 1, followed: 1, pending: 0 }])
      expect(fs.readFileSync(copy).equals(before)).toBe(true)
    } finally {
      fs.rmSync(walDir, { recursive: true, force: true })
    }
  })

  it('refuses a path with no ledger rather than creating one', () => {
    const missing = path.join(dir, 'absent.db')
    expect(() => readLedger(missing)).toThrow()
    expect(fs.existsSync(missing)).toBe(false)
  })
})
