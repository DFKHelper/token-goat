/**
 * Regression (#defect-4): `summarize()` used to sum every row into `total_tokens_saved`
 * without ever reading `tg_version`, so rows priced under an older/different pricing
 * formula were added to current-formula rows as though they were commensurable, and the
 * headline number never disclosed that it was a mixed-era sum. `tg_version` is NULL for the
 * overwhelming majority of all-time rows on a real ledger, so excluding non-current rows
 * from the headline would discard nearly the whole figure rather than fix anything -- the
 * chosen fix keeps the sum and discloses the mix instead of silently presenting it as
 * single-formula.
 *
 * Provenance: HAND-DERIVED. Rows and expected bucket totals are computed by hand, matching
 * the existing `HARNESS_UNRECORDED` test's structure in tests/stats_harness_column.test.ts
 * (the same disclosure shape, for the `harness` column) rather than read out of summarize().
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import Database from '../src/sqlite_driver.js'
import { closeAllDbs } from '../src/db.js'
import { dataDirForHome } from '../src/constants.js'
import {
  summarize,
  renderShortStats,
  GLOBAL_SCHEMA_SQL,
  PRICING_VERSION_UNRECORDED,
  hasMixedPricingEras,
} from '../src/stats.js'
import { statsJsonPayload } from '../src/cli_stats.js'

function makeHome(prefix: string): { customHome: string; dbPath: string } {
  const customHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const homeDataDir = dataDirForHome(customHome)
  fs.mkdirSync(homeDataDir, { recursive: true })
  return { customHome, dbPath: path.join(homeDataDir, 'global.db') }
}

describe('stats pricing-version disclosure', () => {
  const homes: string[] = []
  afterEach(() => {
    closeAllDbs()
    while (homes.length > 0) {
      const dir = homes.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('buckets rows with no tg_version as unrecorded, never as the running version, and flags the mix', () => {
    const { customHome, dbPath } = makeHome('tg-pricing-mixed-')
    homes.push(customHome)

    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    const ins = db.prepare(
      'INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)',
    )
    ins.run(ts, 'bash_compress:generic', 400, 100, null, null)
    ins.run(ts, 'bash_compress:generic', 800, 200, null, '2.9.4')
    db.close()

    const summary = summarize(0, undefined, customHome)

    expect(summary.by_pricing_version[PRICING_VERSION_UNRECORDED]).toEqual({ events: 1, bytes_saved: 400, tokens_saved: 100 })
    expect(summary.by_pricing_version['2.9.4']).toEqual({ events: 1, bytes_saved: 800, tokens_saved: 200 })
    // Every row lands in exactly one bucket: a dropped row would silently undercount the total.
    const bucketed = Object.values(summary.by_pricing_version).reduce((n, b) => n + b.events, 0)
    expect(bucketed).toBe(summary.total_events)
    // The headline still sums both eras -- excluding the unrecorded majority would gut the figure.
    expect(summary.total_tokens_saved).toBe(300)
    expect(hasMixedPricingEras(summary)).toBe(true)
  })

  it('does not flag a mix when every row was written under one version (or all unrecorded)', () => {
    const { customHome, dbPath } = makeHome('tg-pricing-single-')
    homes.push(customHome)

    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    const ins = db.prepare(
      'INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)',
    )
    ins.run(ts, 'bash_compress:generic', 400, 100, null, '2.9.4')
    ins.run(ts, 'bash_compress:generic', 800, 200, null, '2.9.4')
    db.close()

    const summary = summarize(0, undefined, customHome)
    expect(hasMixedPricingEras(summary)).toBe(false)
  })

  it('prints a mixed-era disclosure line in the plain-text totals only when the mix is real (must-not-happen: silent single-figure headline over mixed eras; must-not-happen: false-positive disclosure over one era)', () => {
    const { customHome: mixedHome, dbPath: mixedDb } = makeHome('tg-pricing-render-mixed-')
    homes.push(mixedHome)
    const db1 = new Database(mixedDb)
    db1.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    db1
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, 'bash_compress:generic', 400, 100, null, null)
    db1
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, 'bash_compress:generic', 800, 200, null, '2.9.4')
    db1.close()

    const origIsTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    let mixedOutput = ''
    const originalLog = console.log
    console.log = (msg: string) => {
      mixedOutput += msg + '\n'
    }
    try {
      renderShortStats({ windowDays: 30, homeDir: mixedHome })
    } finally {
      console.log = originalLog
    }
    expect(mixedOutput, 'a headline spanning two pricing eras must disclose it, not present total_tokens_saved bare').toContain('tg_version era')

    const { customHome: singleHome } = makeHome('tg-pricing-render-single-')
    homes.push(singleHome)
    const singleDbPath = path.join(dataDirForHome(singleHome), 'global.db')
    const db2 = new Database(singleDbPath)
    db2.exec(GLOBAL_SCHEMA_SQL)
    db2
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, 'bash_compress:generic', 400, 100, null, '2.9.4')
    db2.close()

    let singleOutput = ''
    console.log = (msg: string) => {
      singleOutput += msg + '\n'
    }
    try {
      renderShortStats({ windowDays: 30, homeDir: singleHome })
    } finally {
      console.log = originalLog
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTty, configurable: true })
    }
    expect(singleOutput, 'a single-era ledger must not print a mixed-era disclosure -- that would be false noise').not.toContain('tg_version era')
  })

  it('reaches the --json payload, not just the internal summary', () => {
    const { customHome, dbPath } = makeHome('tg-pricing-json-')
    homes.push(customHome)
    const db = new Database(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    const ts = Math.floor(Date.now() / 1000)
    db
      .prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail, tg_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, 'bash_compress:generic', 400, 100, null, null)
    db.close()

    const summary = summarize(0, undefined, customHome)
    const payload = statsJsonPayload(summary)
    expect(payload['by_pricing_version']).toEqual({ [PRICING_VERSION_UNRECORDED]: { events: 1, bytes_saved: 400, tokens_saved: 100 } })
  })
})
