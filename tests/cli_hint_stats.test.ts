import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runHintStatsCommand } from '../src/cli_hint_stats.js'
import { HINT_CATEGORIES, logHintEmission, logSuppressedDetection, markCategoryEffective, resetHintStats, resolvePendingHintsForEvent } from '../src/hint_stats.js'
import { defaultConfig, saveConfig } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordStat } from '../src/stats.js'
import type { HookEvent } from '../src/hook_registry.js'

function nonce(): string {
  return `chs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

/** Closes the window on every pending row in `sessionId` without following any of them, so each is scored: more unrelated calls than any row's window holds. A row still inside its window is pending, not emitted, and is in neither the emitted count nor the suppression sample. */
function expireWindow(sessionId: string): void {
  for (let i = 0; i < 8; i++) resolvePendingHintsForEvent(bashEvent(sessionId, 'ls'))
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

describe('runHintStatsCommand — human output', () => {
  // Categories are registered statically, so an untouched store renders a full table of zeros. "0 emitted / 0 acted-on / n/a" reads as measured ineffectiveness, and the action that invites (retire the hints) is the opposite of the correct one (go collect data). The note must appear only while the store is genuinely untouched, and the table must still render -- dropping it would narrow existing output.
  it('says the zeros are absence of data when nothing has been recorded', () => {
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('No hint emissions recorded yet')
    expect(output).toContain('not measured ineffectiveness')
    expect(output).toContain('category')
    expect(output).toContain('bash_redirect')
  })

  it('drops the empty-store note once a single emission exists', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null)
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).not.toContain('No hint emissions recorded yet')
    expect(output).toContain('bash_redirect')
  })

  it('prints a header row and one row per known category, even with no data', () => {
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('category')
    expect(output).toContain('emitted')
    expect(output).toContain('bash_redirect')
    expect(output).toContain('bash_recall')
    expect(output).toContain('read_reread_dedup')
    expect(output).toContain('read_structural_nav')
    expect(output).toContain('edit_reread_suggest')
  })

  it('reflects emission/acted-on/suppression state', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'id-1')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output id-1'))

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_recall'))
    expect(line).toBeDefined()
    expect(line).toContain('1')
    expect(line).toContain('100%')
  })

  // A bare "yes" in the suppressed column covered two opposite states: throttled but able to earn its way back on a probe occasion, and off until someone runs --reset. A reader of this table once took the second for a broken suppression path and had to trace four source files and two databases to find out otherwise. The table has to say which one it is.
  function suppressOneCategory(thresholds: number[]): void {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100
    cfg.hints.backoff_thresholds = thresholds
    saveConfig(cfg)
    clearModuleCaches()
    // A real correlator, because this helper's job is "this category emitted and was never acted on". A null correlator now means the opposite -- nothing a later command could have matched, so no verdict was observed -- and such a row is not part of the sample shouldSuppress judges.
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/suppress.ts')
    expireWindow(sid)
  }

  it('marks a permanently-suppressed category and names the action that clears it', () => {
    suppressOneCategory([])
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('yes (permanent)')
    expect(output).toContain('hints.backoff_thresholds is empty')
    expect(output).toContain('bash_redirect')
    expect(output).toContain('token-goat hint-stats --reset')
  })

  it('leaves a recoverable suppression reading plainly "yes", with no permanence note', () => {
    suppressOneCategory([1, 3, 10, 30])
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('yes')
    expect(output).not.toContain('yes (permanent)')
    expect(output).not.toContain('backoff_thresholds is empty')
  })

  it('adds no permanence note when nothing is suppressed, even with probes disabled', () => {
    const cfg = defaultConfig()
    cfg.hints.backoff_thresholds = []
    saveConfig(cfg)
    clearModuleCaches()
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).not.toContain('yes (permanent)')
    expect(output).not.toContain('backoff_thresholds is empty')
  })

})

describe('runHintStatsCommand — spend/net (bytes emitted)', () => {
  it('shows the spend total as "n/a" (not a fake 0) when the store has zero rows', () => {
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('n/a')
    expect(output).not.toMatch(/net.*saved.*spent.*0.*0.*0/i)
  })

  it('shows the spend total as "n/a" (not a fake 0) when every row predates spend tracking (legacy)', () => {
    // Simulate a pre-migration row directly, the same shape db.test.ts's v9->v10 migration test leaves a pre-existing row in: no bytes_emitted value at all.
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/legacy.ts')
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('n/a')
    expect(output).toContain('legacy')
  })

  it('computes a real net figure and marks a legacy row count once at least one emission carries a spend figure', () => {
    const sid1 = nonce()
    logHintEmission('bash_redirect', sid1, 'C:/x/tracked.ts', false, 200) // tracked
    const sid2 = nonce()
    logHintEmission('bash_redirect', sid2, 'C:/x/legacy.ts') // legacy: no spend figure

    const output = captureStdout(() => runHintStatsCommand())
    // Per-category spend column reflects only the tracked row (200), not a blended/fake total.
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    expect(line).toContain('200')
    // 1 legacy row for this category must be visible, not silently dropped.
    expect(output).toContain('1 legacy')
  })

  // Regression: the TOTAL line used to compute net = saved - spent, where `saved` is an all-time aggregate over the entire `stats` table (every kind mapped to SOURCE_HINT -- tens of thousands of events across the codebase) and `spent` sums only the much smaller `hint_emissions` ledger. Those are disjoint populations, so the "net" implied a handful of tracked emissions produced gigabytes of savings. The TOTAL line must report the two figures separately, each labelled with its own population, and never combine them into a difference.
  it('never nets the stats-ledger saved total against the much smaller hint_emissions spend total', () => {
    recordStat('session_hint', 5_000_000_000, 0)
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null, false, 200)

    const output = captureStdout(() => runHintStatsCommand())
    const totalLine = output.split('\n').find((l) => l.startsWith('TOTAL'))
    expect(totalLine).toBeDefined()
    // Both carry their unit in the name: the values are byte counts, and an unlabelled `spent=200` next to token figures elsewhere in this tool reads as tokens.
    expect(totalLine).toContain('saved-bytes=5000000000')
    expect(totalLine).toContain('spent-bytes=200')
    expect(totalLine).not.toMatch(/net=/)
  })

  it('--json still returns the per-category array unchanged in shape, now carrying bytesEmitted/legacyEmissions', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null, false, 77)
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; bytesEmitted: number | null; legacyEmissions: number }>
    expect(parsed.map((r) => r.category).sort()).toEqual([...HINT_CATEGORIES].sort())
    const row = parsed.find((r) => r.category === 'bash_redirect')
    expect(row?.bytesEmitted).toBe(77)
    expect(row?.legacyEmissions).toBe(0)
  })
})

describe('runHintStatsCommand — --json', () => {
  it('emits a machine-readable array with one entry per category', () => {
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; emitted: number; efficacyPct: number | null; suppressed: boolean }>
    expect(parsed.map((r) => r.category).sort()).toEqual([...HINT_CATEGORIES].sort())
    for (const row of parsed) {
      expect(row.emitted).toBe(0)
      expect(row.efficacyPct).toBe(null)
      expect(row.suppressed).toBe(false)
    }
  })
})

describe('runHintStatsCommand — --reset', () => {
  it('clears tracked stats and prints a confirmation', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)

    const output = captureStdout(() => runHintStatsCommand({ reset: true }))
    expect(output).toContain('cleared')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ emitted: number }>
    expect(parsed.every((row) => row.emitted === 0)).toBe(true)
  })
})

describe('runHintStatsCommand — manual marking', () => {
  it('--mark-effective records a vote and confirms it', () => {
    const output = captureStdout(() => runHintStatsCommand({ markEffective: 'read_reread_dedup' }))
    expect(output).toContain('effective')
    expect(output).toContain('read_reread_dedup')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ category: string; manualEffective: number }>
    expect(parsed.find((row) => row.category === 'read_reread_dedup')?.manualEffective).toBe(1)
  })

  it('--mark-ineffective records a vote and confirms it', () => {
    const output = captureStdout(() => runHintStatsCommand({ markIneffective: 'edit_reread_suggest' }))
    expect(output).toContain('ineffective')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ category: string; manualIneffective: number }>
    expect(parsed.find((row) => row.category === 'edit_reread_suggest')?.manualIneffective).toBe(1)
  })

  it('does not blend manual marks into the automatic efficacy percentage', () => {
    markCategoryEffective('bash_redirect')
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; emitted: number; efficacyPct: number | null }>
    const row = parsed.find((r) => r.category === 'bash_redirect')
    expect(row?.emitted).toBe(0)
    expect(row?.efficacyPct).toBe(null)
  })
})

describe('runHintStatsCommand — efficacy polarity disclosure', () => {
  // hint_stats.ts's module doc says the proxy nature of this measurement is "disclosed here and in the CLI output". Only the first half was true. A suppression category books acted_on = 1 when its window simply expires, so its percentage measures an absence, while a redirect category's measures the agent affirmatively typing a command. Both printed in one bare `efficacy` column with nothing to separate them, and reading 99.4% against 1.6% as "acting beats suggesting" is the natural mistake -- it was made off this exact table and carried into a brief before anyone checked the scoring.
  //
  // FIXTURE PROVENANCE: HAND-DERIVED. The categories come from SUPPRESSION_HINT_CATEGORIES in src/hint_stats.ts (the definition under test, cited deliberately -- this asserts the renderer agrees with the polarity the scorer applies, which is the coupling that broke). The expected output shape is not read off the renderer: it is the minimum a reader needs to avoid the comparison above, written before the assertion was run.
  it('marks a category whose score is an absence, and says so', () => {
    const sid = nonce()
    logHintEmission('edit_reread_suggest', sid, 'C:/x/a.ts')
    logHintEmission('bash_redirect', sid, 'C:/x/b.ts')
    expireWindow(sid)

    const output = captureStdout(() => runHintStatsCommand())
    const line = (cat: string) => output.split('\n').find((l) => l.startsWith(cat)) ?? ''

    expect(
      line('edit_reread_suggest'),
      'A suppression-polarity row must carry a marker in its efficacy cell. Without one its ' +
      'percentage is indistinguishable from an affirmative-action score that means something ' +
      'entirely different.',
    ).toMatch(/\d+(\.\d+)?% \*/)

    expect(
      line('bash_redirect'),
      'An affirmative-action row must NOT be marked, or the marker distinguishes nothing.',
    ).not.toContain('*')

    expect(
      output,
      'The table needs a footnote saying what the marker means. A bare symbol relocates the ' +
      'confusion rather than removing it.',
    ).toContain('Scored on an absence')
  })

  // The footnote is worth nothing if it prints on a store with no suppression-category data, and the marker is worth nothing if it appears on every row. Both halves of the branch are checked because a note that always fires reads as boilerplate and stops being read at all.
  it('stays silent when no suppression category has emitted', () => {
    logHintEmission('bash_redirect', nonce(), 'C:/x/c.ts')
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).not.toContain('Scored on an absence')
  })
})

// Unobservable rows leave the emitted count, which shrinks a number a reader uses to size a category -- bash_redirect reads as 524 where 698 were really pushed at the agent. A count that silently drops a quarter of its population looks like data loss unless the table says otherwise. Both halves of the branch are checked, for the same reason the footnote above checks both.
describe('runHintStatsCommand — unobservable emissions are disclosed, not silently dropped', () => {
  it('marks the emitted cell and explains the marker when a category has unobservable rows', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/seen.ts')
    logHintEmission('bash_redirect', sid, null)
    logHintEmission('bash_redirect', sid, null)
    expireWindow(sid)

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line, 'no bash_redirect row in the table').toBeDefined()
    // One scored emission, two that carried no pointer at all.
    expect(line).toContain('1 ~2')
    expect(output).toContain('carried no correlator')
  })

  it('stays silent, and prints a bare count, when every emission was observable', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/seen.ts')

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    expect(line).not.toContain('~')
    expect(output).not.toContain('carried no correlator')
  })

  it('shows an undisplayed count and explains it when detections were suppressed', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/shown.ts')
    logSuppressedDetection('bash_redirect', sid, 'C:/x/hidden.ts')
    logSuppressedDetection('bash_redirect', sid, 'C:/x/hidden2.ts')
    expireWindow(sid)

    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('undisplayed')
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    // One shown, two never shown. The emitted count stays 1 -- the point of the column is that the two populations are reported side by side, not pooled.
    expect(line).toMatch(/^bash_redirect\s+1\s+2\s/)
    expect(output).toContain('never reached the agent')
  })

  it('prints a dash, not a zero, and stays silent when nothing was suppressed', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/shown.ts')
    expireWindow(sid)

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    // A `0` here would read as a measured absence on a category with no gate to decline at.
    expect(line).toMatch(/^bash_redirect\s+1\s+-\s/)
    expect(output).not.toContain('never reached the agent')
  })

  it('a store holding only undisplayed rows is not reported as absence of data', () => {
    logSuppressedDetection('bash_redirect', nonce(), 'C:/x/hidden.ts')
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).not.toContain('No hint emissions recorded yet')
    expect(output).toContain('never reached the agent')
  })

  it('a store holding only unobservable rows is not reported as absence of data', () => {
    logHintEmission('bash_redirect', nonce(), null)
    const output = captureStdout(() => runHintStatsCommand())
    // The zeros here mean "recorded but unscoreable", which calls for fixing the hint builder that supplies no correlator -- the opposite action from "go collect data".
    expect(output).not.toContain('No hint emissions recorded yet')
    expect(output).toContain('carried no correlator')
  })
})

// A hint still inside its window, or left there by a session that ended, has not been scored either way, so it is out of the emitted count and the suppression sample. It still reached the agent and spent its bytes, so the table has to show where it went: five such rows from one ended session once muted a category whose scored rows put it over the bar, and dropping them from view without a marker would look like data loss instead.
//
// FIXTURE PROVENANCE: HAND-DERIVED. Each expected count and byte figure follows from the emissions the test itself makes.
describe('runHintStatsCommand — pending emissions are disclosed, not silently dropped', () => {
  const PENDING_NOTE = 'still waiting on a verdict'

  it('marks the emitted cell with +N and explains the marker', () => {
    const settled = nonce()
    logHintEmission('bash_redirect', settled, 'C:/x/scored.ts', false, 100)
    expireWindow(settled)
    const open = nonce()
    logHintEmission('bash_redirect', open, 'C:/x/open1.ts', false, 100)
    logHintEmission('bash_redirect', open, 'C:/x/open2.ts', false, 100)

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    expect(line).toMatch(/^bash_redirect\s+1 \+2\s+-\s+0\s/)
    // Spend covers all three rows: the two pending ones reached the agent too.
    expect(line).toMatch(/\s300$/)
    expect(output).toContain(PENDING_NOTE)
  })

  it('stays silent, and prints no +N, when every emission has been scored', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/scored.ts', false, 100)
    expireWindow(sid)

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).not.toContain('+')
    expect(output).not.toContain(PENDING_NOTE)
  })

  it('keeps both markers apart when a category has pending and unobservable rows', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/open.ts')
    logHintEmission('bash_redirect', sid, null)
    const output = captureStdout(() => runHintStatsCommand())
    expect(output.split('\n').find((l) => l.startsWith('bash_redirect'))).toMatch(/^bash_redirect\s+0 \+1 ~1\s/)
  })

  it('shows real spend, not n/a, for a category whose only rows are pending', () => {
    logHintEmission('bash_redirect', nonce(), 'C:/x/open.ts', false, 150)
    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toMatch(/\s150$/)
    expect(line).not.toContain('n/a (legacy)')
    expect(line).not.toMatch(/\sn\/a$/)
  })

  it('shows real spend, not n/a, for a category whose only rows are unobservable', () => {
    logHintEmission('bash_redirect', nonce(), null, false, 90)
    const output = captureStdout(() => runHintStatsCommand())
    expect(output.split('\n').find((l) => l.startsWith('bash_redirect'))).toMatch(/\s90$/)
  })

  it('a store holding only pending rows is not reported as absence of data', () => {
    logHintEmission('bash_redirect', nonce(), 'C:/x/open.ts')
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).not.toContain('No hint emissions recorded yet')
    expect(output).toContain(PENDING_NOTE)
  })

  it('a session holding only pending rows is not reported as having none', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/open.ts')
    const output = captureStdout(() => runHintStatsCommand({ sessionId: sid }))
    expect(output).not.toContain('No hint emissions were recorded for this session')
  })

  it('--json carries the pending count, and --session-id scopes it to that session', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, 'C:/x/open.ts')
    logHintEmission('bash_redirect', nonce(), 'C:/x/other.ts')

    const all = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true }))) as Array<{ category: string; pending: number }>
    expect(all.find((r) => r.category === 'bash_redirect')?.pending).toBe(2)

    const scoped = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true, sessionId: sid }))) as {
      rows: Array<{ category: string; pending: number }>
      scope: { session: string[] }
    }
    expect(scoped.rows.find((r) => r.category === 'bash_redirect')?.pending).toBe(1)
    expect(scoped.scope.session).toContain('pending')
  })
})
