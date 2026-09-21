/**
 * An emission that carried no correlator names nothing a later command could match, so no verdict
 * about it is ever observed. It must not be scored, in either direction.
 *
 * FIXTURE PROVENANCE
 *
 * `LIVE_*` are CAPTURE: a read-only query against the author's real global ledger on 2026-09-21 --
 *   SELECT category, COUNT(*), SUM(CASE WHEN correlator IS NULL THEN 1 ELSE 0 END), SUM(acted_on)
 *   FROM hint_emissions GROUP BY 1
 * returned bash_redirect 698 rows / 174 with a NULL correlator / 6 acted on, and
 * edit_reread_suggest 5113 / 5 / 5095. The 174 were booked as failures and the 5 as successes,
 * which is the asymmetry these tests pin. They are asserted only to keep the *reason* for this
 * change checkable against the data that motivated it, never as a spec for behavior.
 *
 * Everything else here is HAND-DERIVED: the counts are computed from the emissions each test
 * makes itself, independently of how the implementation aggregates them.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { logHintEmission, resolvePendingHintsForEvent, getHintStatsSummary, resetHintStats } from '../src/hint_stats.js'
import { getDb } from '../src/db.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'
import type { HintCategory } from '../src/hint_stats.js'

const LIVE_REDIRECT_ROWS = 698
const LIVE_REDIRECT_NULL_CORRELATOR = 174
const LIVE_REDIRECT_ACTED_ON = 6
const LIVE_SUPPRESSION_NULL_CORRELATOR = 5

/** A redirect category: it asks the agent to run a named command, and only that counts. */
const REDIRECT: HintCategory = 'bash_redirect'
/** A suppression category: inverted polarity, an expiring window counts as compliance. */
const SUPPRESSION: HintCategory = 'edit_reread_suggest'

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

function nonce(): string {
  return `uo${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

function summaryFor(category: HintCategory) {
  const row = getHintStatsSummary().find((r) => r.category === category)
  expect(row, `no summary row for ${category}`).toBeDefined()
  return row!
}

function rawRows(sessionId: string): Array<{ correlator: string | null; acted_on: number; observable: number }> {
  return getDb(globalDbPath())
    .prepare(`SELECT correlator, acted_on, observable FROM hint_emissions WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as Array<{ correlator: string | null; acted_on: number; observable: number }>
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('an emission with no correlator is unobservable, not a verdict', () => {
  it('the live ledger figures this change was made against are internally consistent', () => {
    expect(LIVE_REDIRECT_NULL_CORRELATOR).toBeLessThan(LIVE_REDIRECT_ROWS)
    // The whole point: a quarter of the category could never have been credited, and it was being
    // divided into a numerator of 6 that came entirely from the other three quarters.
    expect(LIVE_REDIRECT_NULL_CORRELATOR / LIVE_REDIRECT_ROWS).toBeGreaterThan(0.2)
    expect(LIVE_REDIRECT_ACTED_ON).toBeGreaterThan(0)
    expect(LIVE_SUPPRESSION_NULL_CORRELATOR).toBeGreaterThan(0)
  })

  it('a correlator-less redirect emission is marked unobservable and left unscored', () => {
    const session = nonce()
    logHintEmission(REDIRECT, session, null, false, 300)

    const rows = rawRows(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.observable).toBe(0)

    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(0)
    expect(row.actedOn).toBe(0)
    expect(row.unobservable).toBe(1)
    // Not 0%: there is no measured rate to report when nothing was measured.
    expect(row.efficacyPct).toBeNull()
  })

  it('a correlator-less suppression emission is unscored too, not booked as compliance', () => {
    const session = nonce()
    logHintEmission(SUPPRESSION, session, null, false, 300)

    expect(rawRows(session)[0]!.observable).toBe(0)
    const row = summaryFor(SUPPRESSION)
    expect(row.emitted).toBe(0)
    // This is the assertion that fails against the old behavior, which booked acted_on = 1 here.
    expect(row.actedOn).toBe(0)
    expect(row.unobservable).toBe(1)
    expect(row.efficacyPct).toBeNull()
  })

  it('unobservable rows do not dilute the rate of the rows that were observed', () => {
    const session = nonce()
    // One observable hint, followed through on. Three that could never have been matched.
    logHintEmission(REDIRECT, session, 'src/paths.ts', false, 100)
    for (let i = 0; i < 3; i++) logHintEmission(REDIRECT, session, null, false, 100)
    resolvePendingHintsForEvent(bashEvent(session, 'token-goat read "src/paths.ts::resolveIndexPath"'))

    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(1)
    expect(row.actedOn).toBe(1)
    expect(row.unobservable).toBe(3)
    // 1/1 observed, not 1/4. The old denominator of 4 would have reported 25%.
    expect(row.efficacyPct).toBe(100)
  })

  it('spend still counts every emission, observable or not', () => {
    const session = nonce()
    logHintEmission(REDIRECT, session, 'src/paths.ts', false, 100)
    logHintEmission(REDIRECT, session, null, false, 400)

    // An unobservable hint reached the agent and cost it those bytes; excluding it from the spend
    // figure would hide exactly the waste this whole change exists to expose.
    expect(summaryFor(REDIRECT).bytesEmitted).toBe(500)
  })

  it('negative control: an observable emission nobody followed is still scored as a failure', () => {
    const session = nonce()
    logHintEmission(REDIRECT, session, 'src/paths.ts', false, 100)
    for (let i = 0; i < 8; i++) {
      resolvePendingHintsForEvent(bashEvent(session, 'token-goat read "src/db.ts::getDb"'))
    }

    const rows = rawRows(session)
    expect(rows[0]!.observable).toBe(1)
    expect(rows[0]!.acted_on).toBe(0)
    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(1)
    expect(row.actedOn).toBe(0)
    expect(row.unobservable).toBe(0)
    expect(row.efficacyPct).toBe(0)
  })

  it('a row that goes unobservable at resolve time is marked there too, not only at insert', () => {
    const session = nonce()
    // Insert a row that looks observable, then blank its correlator behind the resolver's back --
    // the shape a row written by an older binary has after this migration. The resolver's own
    // branch, not logHintEmission's, is what must mark it.
    logHintEmission(REDIRECT, session, 'src/paths.ts', false, 100)
    getDb(globalDbPath())
      .prepare(`UPDATE hint_emissions SET correlator = NULL, observable = 1, resolved = 0 WHERE session_id = ?`)
      .run(session)

    resolvePendingHintsForEvent(bashEvent(session, 'ls'))

    const rows = rawRows(session)
    expect(rows[0]!.observable).toBe(0)
    expect(rows[0]!.acted_on).toBe(0)
  })
})
