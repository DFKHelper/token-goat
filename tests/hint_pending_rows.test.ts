/** A hint emission waiting on its verdict has not been scored yet, in either direction. It must stay out of the efficacy rate and out of the suppression gate until its window closes, and a session that dies with rows still pending must not leave them counting against the category for good. FIXTURE PROVENANCE `LIVE_*` are CAPTURE: a read-only query against the author's real global ledger on 2026-09-29, SELECT category, harness, SUM(displayed = 1 AND observable = 1), SUM(CASE WHEN displayed = 1 AND observable = 1 THEN acted_on ELSE 0 END), SUM(displayed = 1 AND observable = 1 AND resolved = 0) FROM hint_emissions GROUP BY 1, 2 returned bash_redirect / claudecode at 11 scored-or-pending rows, 1 acted on, 5 pending. The five pending rows (ids 23399 to 23407) were all emitted between 16:41:28 and 16:41:43 on 2026-09-28 with 6 calls of window left, by a session that ended without another tool call reaching the hook. Read as 1 in 11 that is 9.1%, under the 15% bar, so the category was muted; read as 1 in the 6 that were actually scored it is 16.7%, over it. They are asserted only to keep the reason for this change checkable against the data that motivated it, never as a spec for behavior. Everything else is HAND-DERIVED: each test's counts follow from the emissions it makes itself, independently of how the implementation aggregates them. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { logHintEmission, resetHintStats, resolvePendingHintsForEvent } from '../src/hint_stats.js'
import { getHintStatsSummary } from '../src/hint_stats_read.js'
import { getHarnessName } from '../src/bridges/registry.js'
import { configPath, globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'
import type { HintCategory } from '../src/hint_stats.js'

const LIVE_REDIRECT_ROWS = 11
const LIVE_REDIRECT_ACTED_ON = 1
const LIVE_REDIRECT_PENDING = 5
/** The shipped default for `hint_stats.suppress_threshold_pct`. */
const SUPPRESS_THRESHOLD_PCT = 15

/** A redirect category: it asks the agent to run a named command, and only that counts. */
const REDIRECT: HintCategory = 'bash_redirect'
/** A suppression category: inverted polarity, an expiring window counts as compliance. */
const SUPPRESSION: HintCategory = 'edit_reread_suggest'

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

function nonce(): string {
  return `pd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

function summaryFor(category: HintCategory) {
  const row = getHintStatsSummary().find((r) => r.category === category)
  expect(row, `no summary row for ${category}`).toBeDefined()
  return row!
}

/** Closes the window on every pending row in `sessionId` without following any of them: more unrelated calls than any row's window holds. */
function expireWindow(sessionId: string): void {
  for (let i = 0; i < 8; i++) resolvePendingHintsForEvent(bashEvent(sessionId, 'ls'))
}

/** Emissions a session made and then died on: logged, never followed by another tool call, so never resolved. */
function abandon(category: HintCategory, count: number): void {
  const dead = nonce()
  for (let i = 0; i < count; i++) logHintEmission(category, dead, 'src/paths.ts', false, 100)
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('an emission still waiting on its verdict is not scored', () => {
  it('the live ledger figures this change was made against straddle the threshold', () => {
    const scored = LIVE_REDIRECT_ROWS - LIVE_REDIRECT_PENDING
    expect((100 * LIVE_REDIRECT_ACTED_ON) / LIVE_REDIRECT_ROWS).toBeLessThan(SUPPRESS_THRESHOLD_PCT)
    expect((100 * LIVE_REDIRECT_ACTED_ON) / scored).toBeGreaterThan(SUPPRESS_THRESHOLD_PCT)
  })

  it('a redirect category is judged on its scored rows, not muted by an abandoned session', () => {
    // The live shape: one hint followed, five that ran out their window unfollowed, five left pending by a session that died.
    const followed = nonce()
    logHintEmission(REDIRECT, followed, 'src/paths.ts', false, 100)
    resolvePendingHintsForEvent(bashEvent(followed, 'token-goat read "src/paths.ts::resolveIndexPath"'))
    const ignored = nonce()
    for (let i = 0; i < 5; i++) logHintEmission(REDIRECT, ignored, 'src/db.ts', false, 100)
    expireWindow(ignored)
    abandon(REDIRECT, 5)

    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(6)
    expect(row.actedOn).toBe(1)
    expect(row.pending).toBe(5)
    // 1 in 6 is 16.7%. Counting the five pending rows as failures made it 1 in 11, 9.1%, and muted the category.
    expect(row.efficacyPct).toBe(16.7)
    expect(row.suppressed).toBe(false)
  })

  it('pending rows in a suppression category are not booked as defiance', () => {
    // Five hints complied with (the window ran out with no re-read), thirty left pending by a session that died.
    const complied = nonce()
    for (let i = 0; i < 5; i++) logHintEmission(SUPPRESSION, complied, 'docs/guide.md', false, 100)
    expireWindow(complied)
    abandon(SUPPRESSION, 30)

    const row = summaryFor(SUPPRESSION)
    expect(row.emitted).toBe(5)
    expect(row.actedOn).toBe(5)
    expect(row.pending).toBe(30)
    expect(row.efficacyPct).toBe(100)
    // Pooled, 5 of 35 is 85.7% defiance, over the 85% bar: a category every scored row says works would have been muted.
    expect(row.suppressed).toBe(false)
  })

  it('a hint whose verdict is still open is counted as pending until the window settles it', () => {
    const session = nonce()
    logHintEmission(REDIRECT, session, 'src/paths.ts', false, 100)

    let row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(0)
    expect(row.pending).toBe(1)
    expect(row.efficacyPct).toBeNull()

    resolvePendingHintsForEvent(bashEvent(session, 'token-goat read "src/paths.ts::resolveIndexPath"'))
    row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(1)
    expect(row.actedOn).toBe(1)
    expect(row.pending).toBe(0)
  })

  it('spend still counts a pending emission, which reached the agent whatever its verdict', () => {
    abandon(REDIRECT, 2)
    expect(summaryFor(REDIRECT).bytesEmitted).toBe(200)
  })

  it('negative control: once enough scored rows fail, the category is still suppressed', () => {
    // The gate reads the 95% Wilson upper bound on the follow rate, which at zero followed drops under the 15% bar at 22 scored rows (0 of 21 bounds it at 15.46%, 0 of 22 at 14.87%). 25 clears that with room.
    const ignored = nonce()
    for (let i = 0; i < 25; i++) logHintEmission(REDIRECT, ignored, 'src/db.ts', false, 100)
    expireWindow(ignored)
    abandon(REDIRECT, 3)

    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(25)
    expect(row.actedOn).toBe(0)
    expect(row.pending).toBe(3)
    expect(row.suppressed).toBe(true)
  })

  it('a row marked acted on but not yet resolved stays out of the numerator as well as the denominator', () => {
    // No writer in hint_stats.ts produces this state (every UPDATE that sets acted_on = 1 also sets resolved = 1), so it is written raw: a ledger edited by hand or by another version must still never read above 100%.
    const scored = nonce()
    logHintEmission(REDIRECT, scored, 'src/db.ts', false, 100)
    expireWindow(scored)
    getDb(globalDbPath())
      .prepare(
        `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining, bytes_emitted, observable)
         VALUES (?, ?, ?, 'src/paths.ts', ?, 0, 1, 3, 100, 1)`,
      )
      .run(REDIRECT, nonce(), getHarnessName(), Date.now())

    const row = summaryFor(REDIRECT)
    expect(row.emitted).toBe(1)
    expect(row.pending).toBe(1)
    expect(row.actedOn).toBe(0)
    expect(row.efficacyPct).toBe(0)
  })
})
