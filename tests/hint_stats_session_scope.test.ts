import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runHintStatsCommand } from '../src/cli_hint_stats.js'
import { cmdHintStats } from '../src/cli_session.js'
import { CliError } from '../src/cli.js'
import { getHintSpendTotals, getHintStatsSummary, getHintStatsTotals, logHintEmission, markCategoryEffective, resetHintStats, type CategoryEfficacy } from '../src/hint_stats.js'
import { tokenGoatHome } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

function nonce(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

function row(rows: readonly CategoryEfficacy[], category: string): CategoryEfficacy {
  const found = rows.find((r) => r.category === category)
  if (found === undefined) throw new Error(`no row for ${category}`)
  return found
}

// HAND-DERIVED: synthetic hint_emissions rows written through the production logHintEmission; session A gets three bash_redirect emissions (100 + 200 + 0 bytes) and one bash_recall (40 bytes), session B one bash_redirect (50 bytes), so A=3/1 emitted, B=1/0, the sum 4/1, and spend A=340, B=50, all=390, all computed by hand from these calls.
function seedTwoSessions(): { a: string; b: string } {
  const a = nonce('hssA')
  const b = nonce('hssB')
  logHintEmission('bash_redirect', a, 'src/a1.ts', false, 100)
  logHintEmission('bash_redirect', a, 'src/a2.ts', false, 200)
  logHintEmission('bash_redirect', a, 'src/a3.ts', false, 0)
  logHintEmission('bash_recall', a, 'id-a', false, 40)
  logHintEmission('bash_redirect', b, 'src/b1.ts', false, 50)
  return { a, b }
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('hint-stats --session-id scoping', () => {
  it('gives each session its own emission rows, and the unscoped view is their sum', () => {
    const { a, b } = seedTwoSessions()
    const rowsA = getHintStatsSummary(a)
    const rowsB = getHintStatsSummary(b)
    const all = getHintStatsSummary()
    expect(row(rowsA, 'bash_redirect').emitted).toBe(3)
    expect(row(rowsB, 'bash_redirect').emitted).toBe(1)
    expect(row(all, 'bash_redirect').emitted).toBe(4)
    expect(row(rowsA, 'bash_recall').emitted).toBe(1)
    expect(row(rowsB, 'bash_recall').emitted).toBe(0)
    expect(row(all, 'bash_recall').emitted).toBe(1)
    expect(row(rowsA, 'bash_redirect').bytesEmitted).toBe(300)
    expect(row(rowsB, 'bash_redirect').bytesEmitted).toBe(50)
    for (const r of all) {
      expect(r.emitted).toBe(row(rowsA, r.category).emitted + row(rowsB, r.category).emitted)
    }

    const json = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true, sessionId: a }))) as { session: string; rows: CategoryEfficacy[] }
    expect(json.session).toBe(a)
    expect(row(json.rows, 'bash_redirect').emitted).toBe(3)
  })

  it('scopes spent-bytes to the session and never prints the all-time saved-bytes as that session\'s', () => {
    const { a, b } = seedTwoSessions()
    expect(getHintSpendTotals(a).spentBytes).toBe(340)
    expect(getHintSpendTotals(b).spentBytes).toBe(50)
    expect(getHintSpendTotals().spentBytes).toBe(390)
    expect(getHintStatsTotals().spentBytes).toBe(390)

    const json = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true, sessionId: b }))) as { totals: { savedBytes: unknown; spentBytes: number }; scope: { unavailable: string[]; allTime: string[] } }
    expect(json.totals.spentBytes).toBe(50)
    expect(json.totals.savedBytes).toBeNull()
    expect(json.scope.unavailable).toContain('totals.savedBytes')
    expect(json.scope.allTime).toContain('suppressed')

    const text = captureStdout(() => runHintStatsCommand({ sessionId: a }))
    expect(text).toContain(`Session: ${a}`)
    expect(text).toContain('TOTAL (this session)   spent-bytes=340 (hint_emissions ledger only)')
    expect(text).not.toContain('saved-bytes=')
    expect(text).toContain('saved-bytes: not available per session')
  })

  it('keeps suppression and manual marks all-time in the session view, and says so', () => {
    const sid = nonce('hssM')
    // HAND-DERIVED: one manual "effective" vote, which carries no session, so it must show in any session's row.
    markCategoryEffective('bash_recall')
    const text = captureStdout(() => runHintStatsCommand({ sessionId: sid }))
    expect(row(getHintStatsSummary(sid), 'bash_recall').manualEffective).toBe(1)
    expect(text).toContain('suppressed, manual+ and manual- are all-time, across every session')
  })

  it.each([
    [{ reset: true }, '--reset'],
    [{ markEffective: 'bash_redirect' }, '--mark-effective'],
    [{ markIneffective: 'bash_redirect' }, '--mark-ineffective'],
  ])('rejects --session-id with a flag that mutates cross-session state (%o), before writing anything', (flags, name) => {
    const { a } = seedTwoSessions()
    expect(() => cmdHintStats({ sessionId: a, ...flags })).toThrow(CliError)
    expect(() => cmdHintStats({ sessionId: a, ...flags })).toThrow(`--session-id cannot be combined with ${name}`)
    const all = getHintStatsSummary()
    expect(row(all, 'bash_redirect').emitted).toBe(4)
    expect(row(all, 'bash_redirect').manualEffective).toBe(0)
    expect(row(all, 'bash_redirect').manualIneffective).toBe(0)
  })

  it('prints a table of zeros and a no-emissions line for a session with no rows, without failing', () => {
    seedTwoSessions()
    const unknown = nonce('hssNone')
    const text = captureStdout(() => cmdHintStats({ sessionId: unknown }))
    expect(text).toContain(`Session: ${unknown}`)
    expect(text).toContain('No hint emissions were recorded for this session')
    expect(text).not.toContain('No hint emissions recorded yet')
    expect(text).toContain('bash_redirect')
    expect(text).toContain('TOTAL (this session)   spent-bytes=n/a')
    for (const r of getHintStatsSummary(unknown)) expect(r.emitted).toBe(0)
  })

  it('resolves `latest` to the newest session state on disk', () => {
    const { a } = seedTwoSessions()
    const sessionsDir = path.join(tokenGoatHome(), 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const file = path.join(sessionsDir, `${a}.json`)
    // HAND-DERIVED: an empty session state whose mtime is pushed an hour ahead so it is the newest in the directory; findLatestSessionId only stats the file.
    fs.writeFileSync(file, '{}')
    const future = new Date(Date.now() + 3_600_000)
    fs.utimesSync(file, future, future)
    try {
      const json = JSON.parse(captureStdout(() => cmdHintStats({ json: true, sessionId: 'latest' }))) as { session: string; rows: CategoryEfficacy[] }
      expect(json.session).toBe(a)
      expect(row(json.rows, 'bash_redirect').emitted).toBe(3)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it('rejects an empty --session-id value', () => {
    expect(() => cmdHintStats({ sessionId: '  ' })).toThrow('--session-id needs a session id')
  })
})
