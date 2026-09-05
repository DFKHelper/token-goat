import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runHintStatsCommand } from '../src/cli_hint_stats.js'
import { logHintEmission, markCategoryEffective, resetHintStats, resolvePendingHintsForEvent } from '../src/hint_stats.js'
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
  // Categories are registered statically, so an untouched store renders a full table of zeros.
  // "0 emitted / 0 acted-on / n/a" reads as measured ineffectiveness, and the action that
  // invites (retire the hints) is the opposite of the correct one (go collect data). The note
  // must appear only while the store is genuinely untouched, and the table must still render --
  // dropping it would narrow existing output.
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

  // A bare "yes" in the suppressed column covered two opposite states: throttled but able to
  // earn its way back on a probe occasion, and off until someone runs --reset. A reader of this
  // table once took the second for a broken suppression path and had to trace four source files
  // and two databases to find out otherwise. The table has to say which one it is.
  function suppressOneCategory(thresholds: number[]): void {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100
    cfg.hints.backoff_thresholds = thresholds
    saveConfig(cfg)
    clearModuleCaches()
    logHintEmission('bash_redirect', nonce(), null)
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
    // Simulate a pre-migration row directly, the same shape db.test.ts's v9->v10 migration test
    // leaves a pre-existing row in: no bytes_emitted value at all.
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null)
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('n/a')
    expect(output).toContain('legacy')
  })

  it('computes a real net figure and marks a legacy row count once at least one emission carries a spend figure', () => {
    const sid1 = nonce()
    logHintEmission('bash_redirect', sid1, null, false, 200) // tracked
    const sid2 = nonce()
    logHintEmission('bash_redirect', sid2, null) // legacy: no spend figure

    const output = captureStdout(() => runHintStatsCommand())
    // Per-category spend column reflects only the tracked row (200), not a blended/fake total.
    const line = output.split('\n').find((l) => l.startsWith('bash_redirect'))
    expect(line).toBeDefined()
    expect(line).toContain('200')
    // 1 legacy row for this category must be visible, not silently dropped.
    expect(output).toContain('1 legacy')
  })

  // Regression: the TOTAL line used to compute net = saved - spent, where `saved` is an all-time
  // aggregate over the entire `stats` table (every kind mapped to SOURCE_HINT -- tens of
  // thousands of events across the codebase) and `spent` sums only the much smaller
  // `hint_emissions` ledger. Those are disjoint populations, so the "net" implied a handful of
  // tracked emissions produced gigabytes of savings. The TOTAL line must report the two figures
  // separately, each labelled with its own population, and never combine them into a difference.
  it('never nets the stats-ledger saved total against the much smaller hint_emissions spend total', () => {
    recordStat('session_hint', 5_000_000_000, 0)
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null, false, 200)

    const output = captureStdout(() => runHintStatsCommand())
    const totalLine = output.split('\n').find((l) => l.startsWith('TOTAL'))
    expect(totalLine).toBeDefined()
    expect(totalLine).toContain('saved=5000000000')
    expect(totalLine).toContain('spent=200')
    expect(totalLine).not.toMatch(/net=/)
  })

  it('--json still returns the per-category array unchanged in shape, now carrying bytesEmitted/legacyEmissions', () => {
    const sid = nonce()
    logHintEmission('bash_redirect', sid, null, false, 77)
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; bytesEmitted: number | null; legacyEmissions: number }>
    expect(parsed.length).toBe(5)
    const row = parsed.find((r) => r.category === 'bash_redirect')
    expect(row?.bytesEmitted).toBe(77)
    expect(row?.legacyEmissions).toBe(0)
  })
})

describe('runHintStatsCommand — --json', () => {
  it('emits a machine-readable array with one entry per category', () => {
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; emitted: number; efficacyPct: number | null; suppressed: boolean }>
    expect(parsed.length).toBe(5)
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
