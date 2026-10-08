/** The read side of `token-goat hint-stats`, kept out of hint_stats.ts so the hook bundle, which loads that module for the write path, does not carry it. A report never creates `global.db`: with no ledger yet it answers from an empty one (no emissions, no marks, nothing suppressed) and leaves the data directory as it found it. `hint_emissions` and `hint_manual_marks` come from db.ts's schema rather than stats.ts's GLOBAL_SCHEMA_SQL, so stats.ts's in-memory `readGlobalDb` stand-in has no such tables and the missing-file case is handled here instead. */
import fs from 'node:fs'
import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { loadConfig } from './config.js'
import { summarize, SOURCE_HINT } from './stats.js'
import { HINT_CATEGORIES, categoryStats, shouldSuppress, type CategoryEfficacy, type HintCategory, type HintStatsTotals } from './hint_stats.js'

const NO_EMISSIONS = { emitted: 0, actedOn: 0, pending: 0, unobservable: 0, detected: 0, bytesEmitted: null, legacyEmissions: 0 }

function hasLedger(): boolean {
  return fs.existsSync(globalDbPath())
}

function manualMarks(category: HintCategory): { effective: number; ineffective: number } {
  try {
    const db = getDb(globalDbPath())
    const row = db.prepare(`SELECT effective_count, ineffective_count FROM hint_manual_marks WHERE category = ?`).get(category) as
      | { effective_count: number; ineffective_count: number }
      | undefined
    return { effective: row?.effective_count ?? 0, ineffective: row?.ineffective_count ?? 0 }
  } catch {
    return { effective: 0, ineffective: 0 }
  }
}

/** Full per-category summary for `token-goat hint-stats`, one row per known category (even categories never emitted this harness get a zeroed row, so the report is a stable, complete shape). With `sessionId`, the emission counts, efficacy and spend cover that session only; `suppressed`, `suppressionPermanent` and the manual marks stay all-time, because suppression is decided on the whole cross-session history and the marks carry no session at all. */
export function getHintStatsSummary(sessionId?: string): CategoryEfficacy[] {
  const ledger = hasLedger()
  const probeThresholds = loadConfig().hints.backoff_thresholds.filter((t) => t > 0)
  return HINT_CATEGORIES.map((category) => {
    const { emitted, actedOn, pending, unobservable, detected, bytesEmitted, legacyEmissions } = ledger ? categoryStats(category, sessionId) : NO_EMISSIONS
    const marks = ledger ? manualMarks(category) : { effective: 0, ineffective: 0 }
    const suppressed = ledger && shouldSuppress(category, '')
    return {
      category,
      emitted,
      actedOn: actedOn ?? 0,
      efficacyPct: emitted === 0 ? null : Math.round((1000 * (actedOn ?? 0)) / emitted) / 10,
      pending,
      unobservable,
      detected,
      suppressed: suppressed,
      suppressionPermanent: suppressed && probeThresholds.length === 0,
      manualEffective: marks.effective,
      manualIneffective: marks.ineffective,
      bytesEmitted,
      legacyEmissions: legacyEmissions ?? 0,
    }
  })
}

/** All-time saved/spent totals for `token-goat hint-stats`'s summary line — see {@link getHintStatsSummary} for the per-category breakdown this rolls up. Deliberately NOT harness-scoped, unlike the per-category rows above it: `savedBytes` comes from the `stats` ledger, which has no `harness` column at all (see stats.ts's GLOBAL_SCHEMA_SQL) and therefore spans every harness. Regression note: this used to also return a `netBytes = savedBytes - spentBytes` figure. `savedBytes` is an all-time aggregate over every kind stats.ts maps to `SOURCE_HINT` (session_hint, diff_hint, evidence_cache_hit, etc. -- tens of thousands of events), while `spentBytes` sums only the much smaller `hint_emissions` ledger (a handful of tracked rows, since that table only started recording spend post-migration). Those are disjoint populations: subtracting one from the other produced a "net" figure in the billions that implied a few dozen tracked emissions netted gigabytes, which they never did. Report the two figures separately, each labelled with its own population, and never combine them into a difference. */
export function getHintStatsTotals(): HintStatsTotals {
  const { spentBytes, legacyEmissions } = getHintSpendTotals()
  const savedBytes = summarize(0).by_source[SOURCE_HINT]?.bytes_saved ?? 0
  return {
    savedBytes,
    spentBytes,
    legacyEmissions,
  }
}

/** The hint_emissions half of {@link getHintStatsTotals}: all-time across every session and harness, or one session's figures when `sessionId` is given. There is no session-scoped `savedBytes` to pair it with, because the `stats` ledger records no session id (see stats.ts's GLOBAL_SCHEMA_SQL). */
export function getHintSpendTotals(sessionId?: string): Omit<HintStatsTotals, 'savedBytes'> {
  if (!hasLedger()) return { spentBytes: null, legacyEmissions: 0 }
  const db = getDb(globalDbPath())
  const sql = `SELECT SUM(bytes_emitted) AS spentBytes, SUM(CASE WHEN bytes_emitted IS NULL THEN 1 ELSE 0 END) AS legacyEmissions
       FROM hint_emissions`
  const stmt = db.prepare(sessionId === undefined ? sql : `${sql} WHERE session_id = ?`)
  const row = (sessionId === undefined ? stmt.get() : stmt.get(sessionId)) as { spentBytes: number | null; legacyEmissions: number | null } | undefined
  return { spentBytes: row?.spentBytes ?? null, legacyEmissions: row?.legacyEmissions ?? 0 }
}
